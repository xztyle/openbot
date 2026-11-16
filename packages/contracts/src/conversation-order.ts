// The order a conversation's messages are shown in, on every surface that shows them.
//
// The desktop backend sorts a transcript before it stores or sends it, and the mobile app sorts the
// pages it merges. The two copies drifted once already, so there is one.

import type { ConversationMessage } from "./ipc-conversation-messages";

/**
 * Sorts `messages` in place and returns the same array. Turns go by their earliest message, and
 * inside one turn the user's message comes first, then commentary and the plan, then the answer. A message with
 * no valid `createdAt` goes last.
 *
 * A turn can take more messages from the user or from teammates, steers. Each steer starts a new part
 * of the turn, which goes by the time of the steer, and inside it every message goes by time. So the
 * steer comes after the commentary the agent sent before it, Grok's answers to the first message and
 * to the steer stay in the order they came (#1540), and a steer that comes long after the turn started
 * stays below the messages that came in between, such as a routine run or another turn.
 *
 * `database/thread-message-order.ts` stores this order for pages. A change here needs the same change
 * there, and a migration.
 */
export function sortConversationMessages(messages: ConversationMessage[]): ConversationMessage[] {
  const originalIndexes = new Map(messages.map((message, index) => [message, index]));
  const parts = turnParts(messages);
  const groupKeys = new Map<ConversationMessage, string>();
  const groups = new Map<string, { startedAt: number; firstIndex: number }>();

  // In time order, so the first message of a group names its start, as the stored order does.
  const byTime = [...messages].sort(
    (left, right) =>
      messageTime(left) - messageTime(right) || (originalIndexes.get(left) ?? 0) - (originalIndexes.get(right) ?? 0),
  );
  for (const message of byTime) {
    const index = originalIndexes.get(message) ?? 0;
    const groupKey = message.turnId ? `turn:${message.turnId}:${parts.get(message) ?? 1}` : `message:${index}`;
    groupKeys.set(message, groupKey);
    if (!groups.has(groupKey)) groups.set(groupKey, { startedAt: messageTime(message), firstIndex: index });
  }

  messages.sort((left, right) => {
    const leftKey = groupKeys.get(left) ?? "";
    const rightKey = groupKeys.get(right) ?? "";
    const leftGroup = groups.get(leftKey);
    const rightGroup = groups.get(rightKey);
    if (leftGroup && rightGroup && leftGroup !== rightGroup) {
      if (leftGroup.startedAt !== rightGroup.startedAt) return leftGroup.startedAt - rightGroup.startedAt;
      if (leftGroup.firstIndex !== rightGroup.firstIndex) return leftGroup.firstIndex - rightGroup.firstIndex;
    }

    // The first part of a turn goes by role; a later part, from a steer on, goes by time.
    if (leftKey === rightKey && left.turnId && (parts.get(left) ?? 1) === 1) {
      const rankDifference = turnMessageRank(left) - turnMessageRank(right);
      if (rankDifference !== 0) return rankDifference;
    }
    const timeDifference = messageTime(left) - messageTime(right);
    if (timeDifference !== 0) return timeDifference;
    return (originalIndexes.get(left) ?? 0) - (originalIndexes.get(right) ?? 0);
  });
  return messages;
}

/**
 * The part of its turn that each message of a turn is in: the count of the turn's inputs up to it, in
 * time order, and at least 1. A turn's second input, a steer, starts part 2.
 */
function turnParts(messages: readonly ConversationMessage[]): Map<ConversationMessage, number> {
  const turns = new Map<string, { message: ConversationMessage; index: number }[]>();
  for (const [index, message] of messages.entries()) {
    if (!message.turnId) continue;
    const turn = turns.get(message.turnId) ?? [];
    turn.push({ message, index });
    turns.set(message.turnId, turn);
  }
  const parts = new Map<ConversationMessage, number>();
  for (const turn of turns.values()) {
    turn.sort((left, right) => messageTime(left.message) - messageTime(right.message) || left.index - right.index);
    let inputs = 0;
    for (const { message } of turn) {
      if (turnMessageRank(message) === 0) inputs += 1;
      parts.set(message, Math.max(inputs, 1));
    }
  }
  return parts;
}

function messageTime(message: ConversationMessage): number {
  const timestamp = Date.parse(message.createdAt);
  return Number.isFinite(timestamp) ? timestamp : Number.MAX_SAFE_INTEGER;
}

function turnMessageRank(message: ConversationMessage): 0 | 1 | 2 | 3 {
  if (message.exchange?.direction === "incoming" || message.author === "user") return 0;
  if (message.author === "assistant" && (message.itemType === "commentary" || message.itemType === "plan")) return 1;
  if (message.exchange?.direction === "outgoing") return 2;
  if (message.author === "assistant") return 3;
  return 2;
}
