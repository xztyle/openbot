import { INPUT_LIMITS } from "@openbot/contracts/input-limits";
import {
  CONVERSATION_MEMORY_CHANGE_LIMIT,
  CONVERSATION_MEMORY_CHANGES_ITEM_TYPE,
  type ConversationMemoryChange,
  type ConversationMessage,
  countConversationMemoryChanges,
} from "@openbot/contracts/ipc";
import { sourceText } from "@openbot/i18n/source";

/**
 * The chat line that lists the memories a turn or a background review saved, updated and forgot,
 * redacted. Null when nothing changed.
 */
export function memoryChangesMessage(
  turnId: string,
  changes: readonly ConversationMemoryChange[],
  redact: (text: string) => string,
): ConversationMessage | null {
  if (changes.length === 0) return null;
  const memoryChanges = changes.slice(0, CONVERSATION_MEMORY_CHANGE_LIMIT).map((change) => ({
    ...change,
    text: redact(change.text).slice(0, INPUT_LIMITS.agentMemoryText),
    ...(change.previousText === undefined
      ? {}
      : { previousText: redact(change.previousText).slice(0, INPUT_LIMITS.agentMemoryText) }),
  }));
  return {
    id: `${turnId}:memory-changes`,
    turnId,
    author: "system",
    source: "system",
    status: "completed",
    createdAt: new Date().toISOString(),
    itemType: CONVERSATION_MEMORY_CHANGES_ITEM_TYPE,
    text: sourceText("status.agent.memoryChanges", countConversationMemoryChanges(memoryChanges)),
    memoryChanges,
  };
}
