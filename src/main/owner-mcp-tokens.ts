import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { isDynamicRecord, isNumber, isString } from "@openbot/contracts/runtime-values";
import { sourceText } from "@openbot/i18n/source";
import { createOpenBotLogger, registerSecretValue, toLogValue } from "@openbot/logging";
import { Effect } from "effect";
import { parseStoredJson, writeJsonFileAtomically } from "../backend/atomic-json-file";
import { isMissingFileError } from "../backend/file-errors";

const logger = createOpenBotLogger("owner-mcp-tokens");

/** A token starts with this, so a secret scanner and the owner can tell what it is. */
export const OWNER_MCP_TOKEN_PREFIX = "atm_";
/** More access tokens than this are a leak waiting to happen, not a need. */
export const OWNER_MCP_TOKENS_LIMIT = 10;
export const OWNER_MCP_LABEL_LIMIT = 60;
/** The last-use time is written at most this often, so each call does not rewrite the file. */
const LAST_USED_WRITE_MS = 10 * 60 * 1000;

/** One access token, as settings show it. The token itself is never kept: only its hash. */
export interface OwnerMcpToken {
  id: string;
  label: string;
  createdAt: number;
  lastUsedAt: number | null;
}

interface StoredToken extends OwnerMcpToken {
  /** SHA-256 of the token, in hex. */
  hash: string;
}

interface StoredFile {
  version: 1;
  tokens: StoredToken[];
}

function hashToken(token: string): Buffer {
  return createHash("sha256").update(token).digest();
}

function storedToken(value: unknown): StoredToken | null {
  if (!isDynamicRecord(value)) return null;
  const { id, label, hash, createdAt, lastUsedAt } = value;
  if (!isString(id) || !isString(label) || !isString(hash) || !/^[0-9a-f]{64}$/u.test(hash) || !isNumber(createdAt))
    return null;
  return { id, label, hash, createdAt, lastUsedAt: isNumber(lastUsedAt) ? lastUsedAt : null };
}

/**
 * The owner's revocable access tokens for the Atelier MCP endpoint (`owner-mcp-server.ts`). Each one
 * is shown once, when it is made, and kept only as a hash in a file of the profile. Revoking one
 * removes its hash, so the next call with it is refused.
 */
export class OwnerMcpTokens {
  readonly #file: string;
  readonly #now: () => number;
  #tokens: StoredToken[];
  readonly #listeners = new Set<() => void>();

  constructor(options: { file: string; now?: () => number }) {
    this.#file = options.file;
    this.#now = options.now ?? Date.now;
    this.#tokens = this.#read();
  }

  list(): OwnerMcpToken[] {
    return this.#tokens.map(({ id, label, createdAt, lastUsedAt }) => ({ id, label, createdAt, lastUsedAt }));
  }

  /** At least one token exists, so the endpoint has a reason to listen. */
  any(): boolean {
    return this.#tokens.length > 0;
  }

  /** Called after each create and revoke. */
  onChange(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /** Makes a token. The answer is the only time the token itself exists outside its caller. */
  readonly create = Effect.fn("OwnerMcpTokens.create")(function* (this: OwnerMcpTokens, label: string) {
    if (this.#tokens.length >= OWNER_MCP_TOKENS_LIMIT) return yield* Effect.fail(new OwnerMcpTokenLimit());
    const token = `${OWNER_MCP_TOKEN_PREFIX}${randomBytes(32).toString("base64url")}`;
    registerSecretValue(token);
    const entry: StoredToken = {
      id: randomUUID(),
      label: label.trim().slice(0, OWNER_MCP_LABEL_LIMIT) || "MCP",
      hash: hashToken(token).toString("hex"),
      createdAt: this.#now(),
      lastUsedAt: null,
    };
    const next = [...this.#tokens, entry];
    yield* this.#write(next);
    this.#tokens = next;
    this.#changed();
    const { hash: _hash, ...shown } = entry;
    return { token, entry: shown };
  }).bind(this);

  readonly revoke = Effect.fn("OwnerMcpTokens.revoke")(function* (this: OwnerMcpTokens, id: string) {
    const next = this.#tokens.filter((token) => token.id !== id);
    if (next.length === this.#tokens.length) return false;
    yield* this.#write(next);
    this.#tokens = next;
    this.#changed();
    return true;
  }).bind(this);

  /** The token that `candidate` is, or null. Compares every hash in constant time. */
  verify(candidate: string): OwnerMcpToken | null {
    if (!candidate.startsWith(OWNER_MCP_TOKEN_PREFIX) || candidate.length > 128) return null;
    const hash = hashToken(candidate);
    let found: StoredToken | null = null;
    for (const token of this.#tokens) if (timingSafeEqual(Buffer.from(token.hash, "hex"), hash)) found = token;
    if (!found) return null;
    const now = this.#now();
    if (found.lastUsedAt === null || now - found.lastUsedAt > LAST_USED_WRITE_MS) {
      found.lastUsedAt = now;
      Effect.runFork(
        this.#write(this.#tokens).pipe(
          Effect.catch((error) =>
            Effect.sync(() => logger.warn("The MCP token use time was not saved.", toLogValue(error))),
          ),
        ),
      );
    }
    return { id: found.id, label: found.label, createdAt: found.createdAt, lastUsedAt: found.lastUsedAt };
  }

  #changed(): void {
    for (const listener of this.#listeners) listener();
  }

  #write(tokens: StoredToken[]) {
    return writeJsonFileAtomically<StoredFile>(this.#file, { version: 1, tokens }, { createDirectory: true });
  }

  #read(): StoredToken[] {
    try {
      return parseStoredJson(this.#file, readFileSync(this.#file, "utf8"), (value) =>
        isDynamicRecord(value) && Array.isArray(value.tokens)
          ? value.tokens.map(storedToken).filter((token): token is StoredToken => token !== null)
          : [],
      );
    } catch (error) {
      // No file yet: no token. A damaged file also gives none, so a broken file never lets a caller in.
      if (!isMissingFileError(error)) logger.warn("The MCP token file could not be read.", toLogValue(error));
      return [];
    }
  }
}

export class OwnerMcpTokenLimit extends Error {
  constructor() {
    super(sourceText("error.team.connectorTokenLimit", { limit: OWNER_MCP_TOKENS_LIMIT }));
  }
}
