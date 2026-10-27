import {
  AGENT_INPUT_ESCALATION_CHAIN_LIMIT,
  AGENT_INPUT_ESCALATIONS_LIMIT,
  type AgentEvent,
  type AgentInputEscalation,
  inputEscalationRoot,
} from "@openbot/contracts/ipc";
import { redactText } from "@openbot/logging";
import { Effect } from "effect";
import type { AgentStore } from "../agent-store";
import type { MailboxStore } from "../mailbox-store";
import type { PendingAttentionRequest } from "./attention-registry";
import type { ConversationRuntime } from "./conversation-runtime";
import type { MailboxSync } from "./mailbox-sync";

/** The longest question that a note quotes. The card in the chat holds the rest. */
const NOTE_QUESTION_LIMIT = 300;

/** The events after which the list can change: a request comes or goes, or a turn starts. */
const REFRESH_EVENTS: ReadonlySet<AgentEvent["type"]> = new Set([
  "prompt",
  "approval",
  "browser-takeover-requested",
  "agent-input-resolved",
  "browser-takeover-resolved",
  "turn-started",
  "queue-changed",
]);

export interface InputEscalationsHooks {
  /** Every request that waits for the user now. */
  pendingRequests(): PendingAttentionRequest[];
  scheduleDrain(agentId: string): void;
  /** Sends the event to every listener, past the channel and task routing of the agent events. */
  emit(event: AgentEvent): void;
  emitError(code: string, error: unknown, agentId?: string): void;
}

export interface InputEscalationsOptions {
  store: Pick<AgentStore, "list">;
  mailbox: Pick<MailboxStore, "delegationChain" | "deliveryForKey" | "enqueue">;
  mailboxSync: Pick<MailboxSync, "syncMailboxMessages" | "emitQueue">;
  conversation: Pick<ConversationRuntime, "snapshotToUpdate" | "emitConversation">;
  hooks: InputEscalationsHooks;
}

/**
 * The requests that wait for the user in a turn that another agent asked for, and who learns about
 * them. The user talks to one agent and seldom opens the chats of its teammates, so a question there
 * could wait for hours. Each such request is shown in the chat of each agent of the delegation chain,
 * up to the agent at its root, and that agent gets one short note.
 *
 * Owns the list, which it derives again from the attention registry and the mailbox at each change,
 * and the set of requests already noted. It holds no request state of its own: an answer anywhere
 * goes to the registry, and the next refresh drops the entry. Only a request in the main chat of its
 * agent counts. A channel and a task show their requests in their own views. It never imports the
 * agent service facade.
 */
export class InputEscalations {
  readonly #store: InputEscalationsOptions["store"];
  readonly #mailbox: InputEscalationsOptions["mailbox"];
  readonly #mailboxSync: InputEscalationsOptions["mailboxSync"];
  readonly #conversation: InputEscalationsOptions["conversation"];
  readonly #hooks: InputEscalationsHooks;
  #escalations: AgentInputEscalation[] = [];
  #encoded = "[]";
  /** The requests whose note is sent, by request key. A request that resolves leaves the set. */
  readonly #noted = new Set<string>();
  /** The key of the last note from an agent to a recipient, by the pair. */
  readonly #lastNoteKeys = new Map<string, string>();

  constructor(options: InputEscalationsOptions) {
    this.#store = options.store;
    this.#mailbox = options.mailbox;
    this.#mailboxSync = options.mailboxSync;
    this.#conversation = options.conversation;
    this.#hooks = options.hooks;
  }

  /** The current list, for the runtime snapshot. */
  list(): AgentInputEscalation[] {
    return structuredClone(this.#escalations);
  }

  /**
   * Derives the list again after `event`, and sends `agent-input-escalations-changed` when it
   * changed. Runs before the event goes out, so a client knows the delegators of a request before
   * the request arrives.
   */
  observe(event: AgentEvent): void {
    if (!REFRESH_EVENTS.has(event.type)) return;
    if (this.#escalations.length === 0 && this.#hooks.pendingRequests().length === 0) return;
    this.refresh();
  }

  refresh(): void {
    const pending = this.#hooks.pendingRequests();
    const agents = new Map(this.#store.list().map((agent) => [agent.id, agent]));
    const next: AgentInputEscalation[] = [];
    const entries: Array<{ request: PendingAttentionRequest; escalation: AgentInputEscalation }> = [];
    for (const request of pending) {
      if (next.length >= AGENT_INPUT_ESCALATIONS_LIMIT) break;
      const agent = agents.get(request.agentId);
      if (!agent || agent.threadId !== request.threadId) continue;
      const delegatorAgentIds = this.#mailbox
        .delegationChain(request.agentId, request.turnId, AGENT_INPUT_ESCALATION_CHAIN_LIMIT)
        .filter((agentId) => agents.has(agentId));
      if (delegatorAgentIds.length === 0) continue;
      const escalation: AgentInputEscalation = {
        kind: request.kind,
        requestId: request.requestId,
        agentId: request.agentId,
        threadId: request.threadId,
        turnId: request.turnId,
        delegatorAgentIds,
      };
      next.push(escalation);
      entries.push({ request, escalation });
    }
    const encoded = JSON.stringify(next);
    const keys = new Set(next.map(requestKey));
    for (const key of this.#noted) if (!keys.has(key)) this.#noted.delete(key);
    if (encoded !== this.#encoded) {
      this.#escalations = next;
      this.#encoded = encoded;
      this.#hooks.emit({ type: "agent-input-escalations-changed", escalations: structuredClone(next) });
    }
    for (const { request, escalation } of entries) {
      const key = requestKey(escalation);
      if (this.#noted.has(key)) continue;
      this.#noted.add(key);
      Effect.runFork(this.#note(request, escalation));
    }
  }

  /**
   * One note to the agent at the root of the chain: the agent that the user talks to. It is a message
   * from the agent that waits, which expects no reply and answers no request, so it joins a running
   * turn as other teammate messages do, or starts one. A note that still waits in the queue covers a
   * later request of the same agent, so a row of questions does not become a row of turns.
   */
  #note(request: PendingAttentionRequest, escalation: AgentInputEscalation): Effect.Effect<void> {
    const recipientId = inputEscalationRoot(escalation);
    const agentId = escalation.agentId;
    // No colon: the mailbox reads a turn id from a key with colons, and this note is no turn's message.
    const key =
      `input-escalation/${agentId}/${escalation.turnId}/${request.kind}/${String(request.requestId)}`.replaceAll(
        ":",
        "_",
      );
    return Effect.gen({ self: this }, function* () {
      const agents = this.#store.list();
      if (!agents.some((agent) => agent.id === recipientId)) return;
      if (this.#queuedNoteFrom(agentId, recipientId)) return;
      const name = agents.find((agent) => agent.id === agentId)?.name ?? agentId;
      const text = `OpenBot note: ${name} is blocked waiting for the user: ${noteSummary(request)}. The user can answer it in your chat. Say so first in your next reply to the user, in one line. This note needs no reply to ${name}.`;
      yield* this.#mailbox.enqueue({
        sender: { kind: "agent", agentId },
        recipientAgentIds: [recipientId],
        text,
        replyToMessageId: null,
        expectsReply: false,
        idempotencyKey: key,
      });
      this.#lastNoteKeys.set(`${agentId}\n${recipientId}`, key);
      const senderSnapshot = this.#conversation.snapshotToUpdate(agentId);
      if (senderSnapshot) {
        this.#mailboxSync.syncMailboxMessages(senderSnapshot);
        this.#conversation.emitConversation(senderSnapshot);
      }
      this.#mailboxSync.emitQueue(recipientId);
      this.#hooks.scheduleDrain(recipientId);
    }).pipe(
      Effect.catch((failure) =>
        Effect.sync(() => this.#hooks.emitError("input_escalation_note_failed", failure.cause, agentId)),
      ),
      Effect.catchDefect((defect) =>
        Effect.sync(() => this.#hooks.emitError("input_escalation_note_failed", defect, agentId)),
      ),
    );
  }

  #queuedNoteFrom(agentId: string, recipientId: string): boolean {
    const key = this.#lastNoteKeys.get(`${agentId}\n${recipientId}`);
    return key !== undefined && this.#mailbox.deliveryForKey(key)?.delivery.status === "queued";
  }
}

function requestKey(escalation: Pick<AgentInputEscalation, "kind" | "agentId" | "requestId">): string {
  return `${escalation.kind}\n${escalation.agentId}\n${String(escalation.requestId)}`;
}

/** What the request asks, for the agent. No secret question, and no command of an approval. */
function noteSummary(request: PendingAttentionRequest): string {
  if (request.kind === "browser-takeover") return "the user must take over a browser tab";
  if (request.kind === "approval")
    return request.approvalKind === "command"
      ? "an approval to run a command"
      : request.approvalKind === "file-change"
        ? "an approval of a file change"
        : "an approval of more permissions";
  if (request.questions.some((question) => question.isSecret)) return "a private answer, such as a password or a key";
  const first = request.questions[0]?.question ?? "";
  const characters = Array.from(redactText(first).replace(/\s+/gu, " ").trim());
  const quoted =
    characters.length > NOTE_QUESTION_LIMIT
      ? `${characters.slice(0, NOTE_QUESTION_LIMIT - 1).join("")}…`
      : characters.join("");
  const more = request.questions.length - 1;
  const question = quoted ? `"${quoted}"` : "a question";
  return more > 0 ? `${question} and ${more} more question${more === 1 ? "" : "s"}` : question;
}
