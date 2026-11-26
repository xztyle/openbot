import { createHash } from "node:crypto";
import { INPUT_LIMITS } from "@openbot/contracts/input-limits";

/** The longest kind prefix (such as `user-send:`) that a long key keeps before its digest. */
const KIND_PREFIX_LIMIT = 32;

/**
 * The one form of an idempotency key that the mailbox stores. A key that fits the identifier limit
 * stays as it is, so every stored key keeps its meaning. A longer key, such as one with a Codex call
 * id, becomes the digest of the whole key: the same key gives the same digest, so a retry still finds
 * its message. The digest keeps the kind before the first colon, so `forgetIdempotencyKeys` still
 * finds it, and has no other colon, because the mailbox reads a turn id from a key with two or more.
 */
export function normalizeIdempotencyKey(key: string): string {
  if (key.length <= INPUT_LIMITS.identifier) return key;
  const colon = key.indexOf(":");
  const kind = colon >= 0 && colon < KIND_PREFIX_LIMIT ? key.slice(0, colon + 1) : "";
  return `${kind}sha256-${createHash("sha256").update(key).digest("base64url")}`;
}
