import { latestTurnAnswer, type QueueDelivery } from "@openbot/contracts/ipc";
import { redactText } from "@openbot/logging";
import { Effect } from "effect";
import type { AgentStore } from "../agent-store";
import type { DeliveryContext, MailboxStore } from "../mailbox-store";
import type { ConversationRuntime } from "./conversation-runtime";
import type { MailboxSync } from "./mailbox-sync";

/** The longest reason or excerpt a host note quotes. A note says what happened; the chat holds the rest. */
const NOTE_QUOTE_LIMIT = 1_500;

export interface DelegationFollowUpHooks {
  scheduleDrain(agentId: string): void;
  /** Masks the MCP secret values that `redactText` does not know. */
  redactMcp(text: string): string;
  emitError(code: string, error: unknown, agentId?: string): void;
}

export interface DelegationFollowUpOptions {
  store: AgentStore;
  mailbox: MailboxStore;
  mailboxSync: MailboxSync;
  conversation: ConversationRuntime;
  hooks: DelegationFollowUpHooks;
}

/** How a delegated request ended with no result from the agent that got it. */
export type DelegationEnd =
  | { kind: "failed"; reason: string | null }
  /** Stopped by the user, or by something other than the requester. */
  | { kind: "interrupted" }
  /** OpenBot restarted before the turn ended. */
  | { kind: "restarted" }
  /** The turn ended while OpenBot was down, so nothing sent its result on. */
  | { kind: "restarted-completed" }
  /** The turn completed, and its only text was a placeholder. */
  | { kind: "empty" };

export interface FinishedTurn {
  agentId: string;
  turnId: string;
  deliveries: readonly DeliveryContext[];
  terminal: "completed" | "failed" | "interrupted";
  /** The last answer of the turn, or null when it gave none. */
  answer: string | null;
  /** The redacted reason of a failed turn. */
  failure: string | null;
}

/**
 * What an agent that delegated work learns when the work ends, and what the agent that did the
 * work owes back.
 *
 * - A request that ends with no answer (a failed, stopped or restarted turn, or a turn that wrote
 *   nothing) gives the requester one short host note, so it does not wait for a result that will
 *   never come. The note has the shape of an answer: it is linked to the request and asks for no
 *   reply, so it joins the answers a requester holds and starts no loop. A requester that stopped
 *   the work itself, or cancelled it, gets no note.
 * - A turn that ends while its agent waits for answers to requests of its own has only an interim
 *   text. Its result for the sender is deferred (`resultAwaiting` on the delivery) and goes out when
 *   that wave of requests is resolved, with the same idempotency key as the immediate relay.
 *
 * Owns no timer and no durable state of its own: the deferral lives on the delivery row. It never
 * imports the agent service facade.
 */
export class DelegationFollowUp {
  readonly #store: AgentStore;
  readonly #mailbox: MailboxStore;
  readonly #mailboxSync: MailboxSync;
  readonly #conversation: ConversationRuntime;
  readonly #hooks: DelegationFollowUpHooks;
  /** Turns that a requester asked to stop through `interrupt_agent`. They end without a note. */
  readonly #stoppedByRequester = new Set<string>();

  constructor(options: DelegationFollowUpOptions) {
    this.#store = options.store;
    this.#mailbox = options.mailbox;
    this.#mailboxSync = options.mailboxSync;
    this.#conversation = options.conversation;
    this.#hooks = options.hooks;
  }

  /** The requester is about to stop this turn, so its end is no news to the requester. */
  noteRequesterStop(turnId: string): void {
    this.#stoppedByRequester.add(turnId);
  }

  /**
   * Settles the deliveries of a turn that ended: sends the result of each request that wants one,
   * or defers it, or tells the requester that none comes. The turn's own deliveries must already
   * be marked terminal. Never fails: a note that cannot be sent is reported and the turn still ends.
   */
  readonly finishTurn = Effect.fn("DelegationFollowUp.finishTurn")(function* (
    this: DelegationFollowUp,
    turn: FinishedTurn,
  ) {
    const stoppedByRequester = this.#stoppedByRequester.delete(turn.turnId);
    yield* this.#guard(
      turn.agentId,
      Effect.gen({ self: this }, function* () {
        for (const context of turn.deliveries) {
          const { delivery } = context;
          if (delivery.sender.kind !== "agent") continue;
          if (turn.terminal === "completed") {
            if (turn.answer) yield* this.#relayOrDefer(turn, delivery, turn.answer);
            else yield* this.#noteEnd(delivery, { kind: "empty" });
          } else if (turn.terminal === "failed") {
            yield* this.#noteEnd(delivery, { kind: "failed", reason: turn.failure });
          } else if (!stoppedByRequester) {
            yield* this.#noteEnd(delivery, { kind: "interrupted" });
          }
        }
        yield* this.#settleDeferred(turn.agentId, turn);
      }),
    );
    // A requester that waits for the end of this request can finish its own wave now.
    for (const senderAgentId of new Set(
      turn.deliveries.flatMap(({ delivery }) => (delivery.sender.kind === "agent" ? [delivery.sender.agentId] : [])),
    )) {
      yield* this.settle(senderAgentId);
    }
  }, Effect.uninterruptible);

  /**
   * A delivery that never got a turn failed, or a restart ended it. The agent has no turn to
   * report, so the note comes from here.
   */
  readonly noteEnded = Effect.fn("DelegationFollowUp.noteEnded")(function* (
    this: DelegationFollowUp,
    delivery: QueueDelivery,
    end: DelegationEnd,
  ) {
    yield* this.#guard(delivery.recipientAgentId, this.#noteEnd(delivery, end));
    if (delivery.sender.kind === "agent") yield* this.settle(delivery.sender.agentId);
  }, Effect.uninterruptible);

  /**
   * Looks at the deferred results of one agent when no turn of it ended: a request of its wave was
   * cancelled, or a restart left the wave settled. A wave with nothing left to wait for sends a
   * note with the last text of the agent, because no turn comes to write a better one.
   */
  readonly settle = Effect.fn("DelegationFollowUp.settle")(function* (this: DelegationFollowUp, agentId: string) {
    if (this.#mailbox.deferredResults(agentId).length === 0) return;
    // A running turn ends with its own check, and that turn may write the result.
    if (this.#conversation.workingSnapshot(agentId)?.activeTurnId || this.#mailbox.startingDeliveryForAgent(agentId)) {
      return;
    }
    yield* this.#guard(agentId, this.#settleDeferred(agentId, null));
  }, Effect.uninterruptible);

  /** Settles every agent that has a deferred result. Runs at startup, after the restart recovery. */
  readonly settleAll = Effect.fn("DelegationFollowUp.settleAll")(function* (this: DelegationFollowUp) {
    for (const agentId of this.#mailbox.agentsWithDeferredResults()) yield* this.settle(agentId);
  });

  #guard(agentId: string, effect: Effect.Effect<void, { readonly cause: unknown }>): Effect.Effect<void> {
    return effect.pipe(
      Effect.catch((failure) =>
        Effect.sync(() => this.#hooks.emitError("delegation_follow_up_failed", failure.cause, agentId)),
      ),
      Effect.catchDefect((defect) =>
        Effect.sync(() => this.#hooks.emitError("delegation_follow_up_failed", defect, agentId)),
      ),
    );
  }

  /**
   * The result of a completed turn for the agent that asked. The guards are those of the relay
   * that existed before the deferral: nothing goes to a sender that wants no answer, to one that
   * already got a message from this turn, or to the origin of the chain.
   */
  readonly #relayOrDefer = Effect.fn("DelegationFollowUp.relayOrDefer")(function* (
    this: DelegationFollowUp,
    turn: FinishedTurn,
    delivery: QueueDelivery,
    text: string,
  ) {
    if (delivery.sender.kind !== "agent") return;
    const { messageId } = delivery;
    const requesterId = delivery.sender.agentId;
    const originAgentId = this.#mailbox.chainOriginAgentId(messageId);
    if (
      !originAgentId ||
      originAgentId === turn.agentId ||
      // The sender said it wants no answer, so the turn's result stays with this agent. Without
      // this the sender is woken for an echo of work it only wanted to know about.
      !this.#mailbox.expectsReply(messageId) ||
      this.#mailbox.hasReplyFrom(turn.agentId, messageId) ||
      this.#mailbox.hasAgentMessageFromTurnTo(turn.agentId, turn.turnId, requesterId)
    )
      return;
    // The agent asked its own teammates and has only an interim text. Its real result comes when
    // their answers are in, so the requester is not told that the work is done before it is.
    const awaiting = this.#mailbox
      .requestsSentInTurn(turn.agentId, turn.turnId)
      .filter((requestId) => this.#mailbox.requestPending(requestId));
    if (awaiting.length > 0) {
      yield* this.#mailbox.setResultAwaiting(delivery.id, awaiting);
      return;
    }
    yield* this.#sendAnswer(turn.agentId, requesterId, messageId, text, resultKey(turn.turnId, delivery.id, messageId));
  });

  /**
   * Looks at each result this agent owes after an interim turn. `turn` is the turn that just ended,
   * or null when none did. A turn that read answers of the wave continues it: its own requests join
   * the wave, and its answer is the result once the wave is resolved.
   */
  readonly #settleDeferred = Effect.fn("DelegationFollowUp.settleDeferred")(function* (
    this: DelegationFollowUp,
    agentId: string,
    turn: FinishedTurn | null,
  ) {
    for (const owed of this.#mailbox.deferredResults(agentId)) {
      // The agent sent the result itself, in a message that names the request.
      if (this.#mailbox.hasReplyFrom(agentId, owed.messageId)) {
        yield* this.#mailbox.setResultAwaiting(owed.deliveryId, []);
        continue;
      }
      const waveSenders = new Set(owed.awaiting.flatMap((requestId) => this.#mailbox.recipientsOf(requestId)));
      const readWave =
        turn?.deliveries.some(
          ({ delivery }) => delivery.sender.kind === "agent" && waveSenders.has(delivery.sender.agentId),
        ) ?? false;
      if (turn && readWave && turn.terminal !== "completed") {
        // The turn that handled the answers of its teammates broke off, so the result will not come.
        yield* this.#noteDeferredBroken(agentId, owed, turn.terminal, turn.failure);
        continue;
      }
      const awaiting =
        turn && readWave
          ? [...new Set([...owed.awaiting, ...this.#mailbox.requestsSentInTurn(agentId, turn.turnId)])]
          : owed.awaiting;
      const pending = awaiting.filter((requestId) => this.#mailbox.requestPending(requestId));
      if (pending.length > 0) {
        yield* this.#mailbox.setResultAwaiting(owed.deliveryId, pending);
        continue;
      }
      const key = resultKey(owed.turnId, owed.deliveryId, owed.messageId);
      if (turn && readWave && turn.answer) {
        yield* this.#sendAnswer(agentId, owed.senderAgentId, owed.messageId, turn.answer, key);
      } else {
        yield* this.#sendWaveEnded(agentId, owed, key);
      }
      yield* this.#mailbox.setResultAwaiting(owed.deliveryId, []);
    }
  });

  /** A wave that ended with no turn to write a result: the last text of the agent, with a note. */
  readonly #sendWaveEnded = Effect.fn("DelegationFollowUp.sendWaveEnded")(function* (
    this: DelegationFollowUp,
    agentId: string,
    owed: { messageId: string; turnId: string | null; senderAgentId: string },
    key: string,
  ) {
    const name = this.#agentName(agentId);
    const excerpt = this.#lastText(agentId, owed.turnId);
    const text = [
      `OpenBot note: ${name} ended its turn while it waited for its teammates, and no more answers came for your request ${owed.messageId}. ${name} sent no final result.`,
      excerpt ? `The last message of ${name} for your request follows.\n\n${excerpt}` : null,
    ]
      .filter(Boolean)
      .join("\n");
    yield* this.#sendAnswer(agentId, owed.senderAgentId, owed.messageId, text, key);
  });

  readonly #noteDeferredBroken = Effect.fn("DelegationFollowUp.noteDeferredBroken")(function* (
    this: DelegationFollowUp,
    agentId: string,
    owed: { deliveryId: string; messageId: string; senderAgentId: string },
    ended: "failed" | "interrupted",
    reason: string | null,
  ) {
    const name = this.#agentName(agentId);
    const text = [
      `OpenBot note: the turn of ${name} ${ended === "failed" ? "failed" : "was stopped"} while it handled the answers of its own teammates, so ${name} sent no final result for your request ${owed.messageId}.`,
      reason ? `Reason: ${this.#quote(reason)}` : null,
    ]
      .filter(Boolean)
      .join(" ");
    yield* this.#sendAnswer(agentId, owed.senderAgentId, owed.messageId, text, `auto-failure:${owed.deliveryId}`);
    yield* this.#mailbox.setResultAwaiting(owed.deliveryId, []);
  });

  /** Tells the requester that a request ended with no result. */
  readonly #noteEnd = Effect.fn("DelegationFollowUp.noteEnd")(function* (
    this: DelegationFollowUp,
    delivery: QueueDelivery,
    end: DelegationEnd,
  ) {
    if (delivery.sender.kind !== "agent") return;
    const requesterId = delivery.sender.agentId;
    const agentId = delivery.recipientAgentId;
    if (
      requesterId === agentId ||
      // A message that wants no answer, and an answer, end with no news for their sender.
      !this.#mailbox.expectsReply(delivery.messageId) ||
      // The agent did answer, in a message of its own.
      this.#mailbox.hasReplyFrom(agentId, delivery.messageId) ||
      (delivery.turnId !== null && this.#mailbox.hasAgentMessageFromTurnTo(agentId, delivery.turnId, requesterId))
    )
      return;
    const name = this.#agentName(agentId);
    const request = `your request ${delivery.messageId}`;
    const detail =
      end.kind === "failed"
        ? `OpenBot note: the turn of ${name} failed, so it sent no result for ${request}.${end.reason ? ` Reason: ${this.#quote(end.reason)}` : ""}`
        : end.kind === "interrupted"
          ? `OpenBot note: the turn of ${name} was stopped before it sent a result for ${request}.`
          : end.kind === "restarted"
            ? `OpenBot note: OpenBot or its provider restarted while ${name} worked on ${request}. The turn stopped before ${name} sent a result.`
            : end.kind === "restarted-completed"
              ? `OpenBot note: OpenBot or its provider restarted while ${name} worked on ${request}. The turn ended while OpenBot could not see it, so OpenBot did not send you its result. The result is in the chat of ${name}.`
              : `OpenBot note: ${name} finished its turn for ${request} but wrote no result.`;
    yield* this.#sendAnswer(
      agentId,
      requesterId,
      delivery.messageId,
      `${detail}\nNo answer comes for this request. Decide whether to ask again or to tell the user.`,
      `auto-failure:${delivery.id}`,
    );
  });

  /**
   * One message from `agentId` that answers `messageId`: it asks for no reply, so the requester
   * owes none, and it joins the answers the requester holds. A repeated call with the same key
   * finds the first message.
   */
  readonly #sendAnswer = Effect.fn("DelegationFollowUp.sendAnswer")(function* (
    this: DelegationFollowUp,
    agentId: string,
    requesterId: string,
    messageId: string,
    text: string,
    idempotencyKey: string,
  ) {
    if (!this.#store.list().some((agent) => agent.id === requesterId)) return;
    yield* this.#mailbox.enqueue({
      sender: { kind: "agent", agentId },
      recipientAgentIds: [requesterId],
      text,
      replyToMessageId: messageId,
      // The requested result, not a new request. This is what tells the recipient it owes no
      // acknowledgement for one.
      expectsReply: false,
      idempotencyKey,
    });
    const senderSnapshot = this.#conversation.snapshotToUpdate(agentId);
    if (senderSnapshot) {
      this.#mailboxSync.syncMailboxMessages(senderSnapshot);
      this.#conversation.emitConversation(senderSnapshot);
    }
    this.#mailboxSync.emitQueue(requesterId);
    this.#hooks.scheduleDrain(requesterId);
  });

  #agentName(agentId: string): string {
    return this.#store.list().find((agent) => agent.id === agentId)?.name ?? agentId;
  }

  /** A reason or an excerpt with the secrets masked and the length bounded. */
  #quote(text: string): string {
    const safe = this.#hooks.redactMcp(redactText(text)).trim();
    return safe.length > NOTE_QUOTE_LIMIT ? `${safe.slice(0, NOTE_QUOTE_LIMIT - 1)}…` : safe;
  }

  /** The last answer text that an agent wrote in one turn, or null. */
  #lastText(agentId: string, turnId: string | null): string | null {
    const agent = this.#store.list().find((candidate) => candidate.id === agentId);
    if (!agent?.threadId || !turnId) return null;
    const text = latestTurnAnswer(
      this.#store.database.readTurnAssistantMessages(agentId, agent.threadId, turnId),
      turnId,
    )?.text;
    return text ? this.#quote(text) : null;
  }
}

/** The idempotency key of the result of one delivery. The turn id is the delivery's own turn. */
function resultKey(turnId: string | null, deliveryId: string, messageId: string): string {
  return `auto-result:${turnId ?? deliveryId}:${messageId}`;
}
