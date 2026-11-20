import { isConversationMessageCondensed } from "../ipc-conversation-messages";
import { isDynamicRecord, isString } from "../runtime-values";
import { withConversationSenders } from "./conversation-sender-v5";
import type { TeamProtocolV7BaseJsonObject, TeamProtocolV7BaseJsonValue } from "./v7-base";

/**
 * `condensed` (`{ original }`, at most 100,000 characters) rides beside the frozen conversation
 * projection of protocols 7 and 8, as `senderMember` does: on an agent's answer that the host made
 * shorter for people, the agent's own text. The message text is the short one, so a client that
 * drops the key shows the answer as the host condensed it, without the way to the original.
 *
 * A present value must decode; the projection removes the key, so an unchecked one would reach the
 * client unbounded. Fail closed instead. Absent means an answer the host did not condense, or an
 * older host.
 */
export function withConversationCondensed(
  projected: TeamProtocolV7BaseJsonValue,
  source: unknown,
): TeamProtocolV7BaseJsonValue {
  if (!isDynamicRecord(projected) || !isDynamicRecord(source)) return projected;
  const originals = new Map<string, string>();
  for (const message of [
    ...(Array.isArray(source.messages) ? source.messages : []),
    ...(isDynamicRecord(source.references) ? Object.values(source.references) : []),
  ]) {
    if (!isDynamicRecord(message) || message.condensed === undefined) continue;
    if (!isConversationMessageCondensed(message.condensed)) throw new Error("Invalid condensed message.");
    if (isString(message.id)) originals.set(message.id, message.condensed.original);
  }
  if (originals.size === 0) return projected;
  const withOriginal = (message: TeamProtocolV7BaseJsonValue): TeamProtocolV7BaseJsonValue => {
    if (!isDynamicRecord(message) || !isString(message.id)) return message;
    const original = originals.get(message.id);
    return original === undefined ? message : { ...message, condensed: { original } };
  };
  const result: TeamProtocolV7BaseJsonObject = { ...projected };
  if (Array.isArray(result.messages)) result.messages = result.messages.map(withOriginal);
  if (isDynamicRecord(result.references)) {
    result.references = Object.fromEntries(
      Object.entries(result.references).map(([id, value]) => [id, withOriginal(value)]),
    );
  }
  return result;
}

/** `withConversationSenders`, then `withConversationCondensed`: the side fields of protocols 7 and 8. */
export function withConversationSendersAndCondensed(
  projected: TeamProtocolV7BaseJsonValue,
  source: unknown,
): TeamProtocolV7BaseJsonValue {
  return withConversationCondensed(withConversationSenders(projected, source), source);
}
