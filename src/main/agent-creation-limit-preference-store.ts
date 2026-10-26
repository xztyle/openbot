import {
  type AgentCreationLimitPreference,
  DEFAULT_AGENT_CREATION_LIMIT,
  isAgentCreationLimit,
} from "@openbot/contracts/ipc";
import { isDynamicRecord } from "@openbot/contracts/runtime-values";
import { Effect, Result, Semaphore } from "effect";
import { isMissingFileError } from "../backend/file-errors";
import { type PreferenceFileFailure, readPreferenceFile, writePreferenceFile } from "./preference-file";

/**
 * How many agents other agents may create in one window. The backend reads it on each
 * `create_agent` call, so it is held in memory after `load` rather than read from disk each time.
 *
 * A file that is missing, unreadable as JSON or names a value that is not a choice reads as the
 * default: no limit. Writes are chained for the reason `update-preference-store.ts` chains its own.
 */
export class AgentCreationLimitPreferenceStore {
  readonly #path: string;
  #preference: AgentCreationLimitPreference = { limit: DEFAULT_AGENT_CREATION_LIMIT };
  #writes = Semaphore.makeUnsafe(1);

  constructor(path: string) {
    this.#path = path;
  }

  load(): Effect.Effect<void, PreferenceFileFailure> {
    return Effect.gen({ self: this }, function* () {
      const loaded = yield* Effect.result(
        readPreferenceFile(this.#path, (parsed): AgentCreationLimitPreference | null =>
          isDynamicRecord(parsed) && parsed.version === 1 && isAgentCreationLimit(parsed.limit)
            ? { limit: parsed.limit }
            : null,
        ),
      );
      if (Result.isSuccess(loaded)) {
        if (loaded.success) this.#preference = loaded.success;
      } else if (!isMissingFileError(loaded.failure.cause) && !(loaded.failure.cause instanceof SyntaxError))
        return yield* loaded.failure;
    });
  }

  get(): AgentCreationLimitPreference {
    return { ...this.#preference };
  }

  readonly set = Effect.fn("AgentCreationLimitPreference.set")(function* (
    this: AgentCreationLimitPreferenceStore,
    { limit }: AgentCreationLimitPreference,
  ) {
    yield* this.#writes.withPermit(
      Effect.uninterruptible(
        writePreferenceFile(this.#path, { version: 1, limit }).pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              this.#preference = { limit };
            }),
          ),
        ),
      ),
    );
    return this.get();
  });
}
