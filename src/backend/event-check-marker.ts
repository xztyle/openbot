import { EVENT_CHECK_ITEM_TYPE_PREFIX, type EventCheckOrigin } from "@openbot/contracts/event-checks";
import type { ConversationMessage } from "@openbot/contracts/ipc";
import { isDynamicRecord } from "@openbot/contracts/runtime-values";
export function isEventCheckOrigin(value: unknown): value is EventCheckOrigin {
  return (
    isDynamicRecord(value) &&
    typeof value.checkId === "string" &&
    value.checkId.length <= 128 &&
    typeof value.executionId === "string" &&
    value.executionId.length <= 128 &&
    typeof value.name === "string" &&
    value.name.length <= 256
  );
}
export function eventCheckMarker(origin: EventCheckOrigin | undefined): Partial<ConversationMessage> {
  return origin
    ? {
        author: "system",
        source: "system",
        text: origin.name,
        itemType: `${EVENT_CHECK_ITEM_TYPE_PREFIX}${origin.checkId}:${origin.executionId}`,
      }
    : {};
}
