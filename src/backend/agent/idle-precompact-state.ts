import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { isDynamicRecord } from "@openbot/contracts/runtime-values";
import { createOpenBotLogger } from "@openbot/logging";
import { isMissingFileError } from "../file-errors";

const logger = createOpenBotLogger("idle-precompact-state");

/** What the idle pre-compaction keeps of a provider thread across a restart. */
export interface IdlePrecompactEntry {
  agentId: string;
  /** When the last turn of the agent on this thread ended. */
  lastTurnEndAt: number;
  /** The context at that end, so a check after a restart knows the size before a usage report. */
  usedTokens: number;
  /** The thread compacted once since that turn; it does not compact again until it runs another. */
  precompacted: boolean;
}

function isEntry(value: unknown): value is IdlePrecompactEntry {
  if (!isDynamicRecord(value)) return false;
  const entry = value;
  return (
    typeof entry.agentId === "string" &&
    typeof entry.lastTurnEndAt === "number" &&
    Number.isFinite(entry.lastTurnEndAt) &&
    typeof entry.usedTokens === "number" &&
    Number.isFinite(entry.usedTokens) &&
    typeof entry.precompacted === "boolean"
  );
}

/** A small JSON file in userData, keyed by provider thread id. Writes are whole and synchronous. */
export class IdlePrecompactState {
  readonly #path: string | null;

  /** `null`: nothing is kept, as in tests that need no file. */
  constructor(path: string | null) {
    this.#path = path;
  }

  load(): Map<string, IdlePrecompactEntry> {
    const entries = new Map<string, IdlePrecompactEntry>();
    if (!this.#path) return entries;
    try {
      const parsed = JSON.parse(readFileSync(this.#path, "utf8"));
      const threads = isDynamicRecord(parsed) ? parsed.threads : undefined;
      if (isDynamicRecord(threads))
        for (const [threadId, entry] of Object.entries(threads)) if (isEntry(entry)) entries.set(threadId, entry);
    } catch (error) {
      if (!isMissingFileError(error)) logger.warn("Could not read the idle pre-compaction state.", { error });
    }
    return entries;
  }

  save(entries: ReadonlyMap<string, IdlePrecompactEntry>): void {
    if (!this.#path) return;
    try {
      mkdirSync(dirname(this.#path), { recursive: true });
      const temporary = `${this.#path}.tmp`;
      writeFileSync(temporary, JSON.stringify({ version: 1, threads: Object.fromEntries(entries) }));
      renameSync(temporary, this.#path);
    } catch (error) {
      logger.warn("Could not write the idle pre-compaction state.", { error });
    }
  }
}
