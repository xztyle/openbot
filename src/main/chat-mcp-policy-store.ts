import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { isDynamicRecord } from "@openbot/contracts/runtime-values";
import { decodeMcpChatPolicy, type McpChatPolicy } from "@openbot/contracts/team-protocol/mcp-chat-v1";
import { Effect, Semaphore } from "effect";
import { writeJsonFileAtomically } from "../backend/atomic-json-file";
import { mcpCall, mcpSync } from "../backend/mcp-effects";

/**
 * Owns durable per-chat grants. An unreadable file fails startup closed and is never overwritten.
 *
 * The file once held the key that signed proxy tokens, so anything that could read the file could
 * sign a token for a chat with more rights. The tokens are random and live in memory now, and no
 * code reads a key from the file. The `secret` field stays, filled with a fresh random value that
 * nothing uses, only so that an earlier release can still read the file after a downgrade. Loading
 * replaces the old key with such a value.
 */
export class ChatMcpPolicyStore {
  readonly #queue = Semaphore.makeUnsafe(1);
  #chats: Record<string, McpChatPolicy> = {};
  constructor(readonly path: string) {}
  readonly load = Effect.fn("ChatMcpPolicyStore.load")(function* (this: ChatMcpPolicyStore) {
    const raw = yield* mcpCall(() =>
      readFile(this.path, "utf8").catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return null;
        throw error;
      }),
    );
    if (raw === null) {
      yield* this.#persist(this.#chats);
      return;
    }
    yield* mcpSync(() => this.#decode(raw));
    // Drops the key that an earlier release wrote. A file that cannot be written keeps working.
    yield* this.#persist(this.#chats).pipe(Effect.catch(() => Effect.void));
  });
  #decode(raw: string): void {
    const value = JSON.parse(raw);
    if (!isDynamicRecord(value) || value.version !== 1 || !isDynamicRecord(value.chats))
      throw new Error("Unreadable chat app permissions.");
    const chats = Object.fromEntries(
      Object.entries(value.chats).map(([key, policy]) => [key, decodeMcpChatPolicy(policy)]),
    );
    this.#chats = chats;
  }
  get(key: string): McpChatPolicy {
    return this.#chats[key] ?? { grants: [] };
  }
  save(key: string, policy: McpChatPolicy) {
    return this.#queue.withPermit(
      Effect.gen({ self: this }, function* () {
        const next = { ...this.#chats, [key]: policy };
        yield* this.#persist(next);
        this.#chats = next;
      }),
    );
  }
  #persist(chats: Record<string, McpChatPolicy>) {
    return writeJsonFileAtomically(this.path, { version: 1, secret: randomBytes(32).toString("hex"), chats });
  }
}
