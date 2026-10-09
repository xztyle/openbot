import type { EventCheck, EventCheckOrigin } from "@openbot/contracts/event-checks";
import type { AgentSummary, ConversationSnapshot } from "@openbot/contracts/ipc";
import { sourceText } from "@openbot/i18n/source";
import { Effect } from "effect";
import type { ConversationRuntime } from "./agent/conversation-runtime";
import type { AgentStore } from "./agent-store";
import type { CheckOutbox } from "./event-check-store";
import type { MailboxStore } from "./mailbox-store";
import { mcpFailure, mcpSync } from "./mcp-effects";

interface Options {
  store: AgentStore;
  mailbox: MailboxStore;
  conversation: ConversationRuntime;
  sync(snapshot: ConversationSnapshot): void;
  changed(agents: AgentSummary[], agentId: string): void;
  drain(agentId: string): void;
}
/** Queues a durable event through the existing mailbox, without starting a routine or test run. */
export class EventCheckDelivery {
  constructor(readonly options: Options) {}
  readonly send = Effect.fn("EventCheckDelivery.send")(function* (
    this: EventCheckDelivery,
    check: EventCheck,
    event: CheckOutbox,
    origin: EventCheckOrigin,
    valid: () => boolean,
  ) {
    const guard = () => {
      if (!valid()) throw new Error(sourceText("error.mcp.chatDenied"));
    };
    yield* mcpSync(guard);
    const agent = this.options.store.list().find((item) => item.id === check.agentId);
    if (!agent)
      return yield* mcpSync(() => {
        throw new Error(sourceText("error.agent.unknown", { id: check.agentId }));
      });
    const receipt = yield* this.options.mailbox
      .enqueue({
        sender: { kind: "user" },
        eventCheck: origin,
        validateBeforeCommit: guard,
        recipientAgentIds: [agent.id],
        text: event.text,
        idempotencyKey: event.id,
      })
      .pipe(Effect.mapError(mcpFailure));
    const deliveryId = receipt.deliveries[0]?.id;
    if (!deliveryId)
      return yield* mcpSync(() => {
        throw new Error("Missing event delivery.");
      });
    yield* mcpSync(() => {
      const snapshot = this.options.conversation.ensureSnapshot(agent.id, agent.threadId);
      this.options.sync(snapshot);
      this.options.conversation.emitConversation(snapshot);
      this.options.changed(this.options.store.list(), agent.id);
      this.options.drain(agent.id);
    });
    return deliveryId;
  }, Effect.uninterruptible);
}
