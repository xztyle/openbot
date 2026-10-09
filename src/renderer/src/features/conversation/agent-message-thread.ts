import type { AgentMessage, AgentProfile } from "@openbot/ui/data";
import type { AgentMessageDialogEntry } from "@openbot/ui/features/conversation/AgentMessageDialog";

/**
 * The messages the full-text dialog shows for one agent-to-agent marker: the message itself, the
 * message it answers, and the answers to it. They come from the messages the chat has loaded, so a
 * reply that is not loaded yet is not in the list. Oldest first.
 *
 * `messageId` is the mailbox id that a marker carries (`exchange.messageId`), which both copies of a
 * message share: the outgoing row of the sender and the incoming row of a recipient.
 */
export function agentMessageThread(
  messages: readonly AgentMessage[],
  messageId: string,
  agents: readonly Pick<AgentProfile, "id" | "name">[],
): AgentMessageDialogEntry[] {
  const exchanges = messages.filter((message) => message.exchange !== undefined);
  const opened = exchanges.find((message) => message.exchange?.messageId === messageId);
  if (!opened?.exchange) return [];
  const parentId = opened.exchange.replyToMessageId;
  const related = exchanges.filter(
    (message) =>
      message === opened ||
      (parentId !== null && message.exchange?.messageId === parentId) ||
      message.exchange?.replyToMessageId === messageId,
  );
  const seen = new Set<string>();
  return related
    .filter((message) => {
      const id = message.exchange?.messageId ?? message.id;
      if (seen.has(id)) return false;
      seen.add(id);
      return true;
    })
    .sort((left, right) => (left.createdAt ?? "").localeCompare(right.createdAt ?? ""))
    .map((message) => {
      const exchange = message.exchange;
      const nameOf = (agentId: string) => agents.find((agent) => agent.id === agentId)?.name ?? null;
      return {
        message,
        senderName: exchange ? nameOf(exchange.senderAgentId) : null,
        recipientNames: (exchange?.recipientAgentIds ?? []).map(nameOf),
        status: message.actionMarker?.kind === "agent-message" ? message.actionMarker.status : "unavailable",
      };
    });
}
