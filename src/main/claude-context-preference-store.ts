import { type ClaudeContextSetting, DEFAULT_CLAUDE_CONTEXT, isClaudeCompactWindow } from "@openbot/contracts/ipc";
import { isBoolean, isDynamicRecord } from "@openbot/contracts/runtime-values";
import { Effect, Result, Semaphore } from "effect";
import { isMissingFileError } from "../backend/file-errors";
import { type PreferenceFileFailure, readPreferenceFile, writePreferenceFile } from "./preference-file";

/**
 * What this server's Claude agents load into each request: the user's own Claude Code setup, and the
 * size at which Claude Code compacts a chat. A Claude process reads both when it starts, so a change
 * applies to the next process, not to a running turn.
 *
 * A file that is missing, unreadable as JSON or holds a value that is not a choice reads as the
 * default. Writes are chained for the reason `update-preference-store.ts` chains its own.
 */
export class ClaudeContextPreferenceStore {
  readonly #path: string;
  #setting: ClaudeContextSetting = DEFAULT_CLAUDE_CONTEXT;
  #writes = Semaphore.makeUnsafe(1);

  constructor(path: string) {
    this.#path = path;
  }

  load(): Effect.Effect<void, PreferenceFileFailure> {
    return Effect.gen({ self: this }, function* () {
      const loaded = yield* Effect.result(
        readPreferenceFile(this.#path, (parsed): ClaudeContextSetting | null =>
          isDynamicRecord(parsed) &&
          parsed.version === 1 &&
          isBoolean(parsed.userSetup) &&
          isClaudeCompactWindow(parsed.compactWindow)
            ? { userSetup: parsed.userSetup, compactWindow: parsed.compactWindow }
            : null,
        ),
      );
      if (Result.isSuccess(loaded)) {
        if (loaded.success) this.#setting = loaded.success;
      } else if (!isMissingFileError(loaded.failure.cause) && !(loaded.failure.cause instanceof SyntaxError))
        return yield* loaded.failure;
    });
  }

  get(): ClaudeContextSetting {
    return this.#setting;
  }

  readonly set = Effect.fn("ClaudeContextPreference.set")((setting: ClaudeContextSetting) =>
    this.#writes.withPermit(
      Effect.uninterruptible(
        writePreferenceFile(this.#path, { version: 1, ...setting }).pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              this.#setting = { userSetup: setting.userSetup, compactWindow: setting.compactWindow };
            }),
          ),
          Effect.map(() => this.get()),
        ),
      ),
    ),
  );
}
