import { isDynamicRecord } from "@openbot/contracts/runtime-values";
import { Effect } from "effect";
import { isMissingFileError } from "../backend/file-errors";
import { readPreferenceFile, writePreferenceFile } from "./preference-file";

/**
 * A `running` marker in the user data folder. OpenBot writes it at the start and clears it in the
 * last step of the shutdown. A marker that is still set at the next start means the last run ended
 * with no clean shutdown: a crash, a kill, an out-of-memory stop or a power loss. A headless server
 * has nobody to see that, so `openbot status` reports it, with the number of recent starts.
 *
 * The file holds times only: no path, no account and no secret.
 */

const RUN_STATE_VERSION = 1;
const RECENT_WINDOW_MS = 24 * 60 * 60 * 1000;
/** Enough to see a restart loop, and small enough to stay a few hundred bytes. */
const MAX_REMEMBERED_STARTS = 50;

export type LastShutdown = "clean" | "unclean" | "unknown";

export interface RunMarkerState {
  /** How the run before this one ended. `unknown` for the first run, or when the file could not be read. */
  lastShutdown: LastShutdown;
  /** The starts in the last 24 hours, this one included. */
  startsLast24Hours: number;
  startedAt: number;
}

interface StoredRunState {
  version: 1;
  running: boolean;
  startedAt: number;
  stoppedAt: number | null;
  starts: number[];
}

export interface RunMarkerOptions {
  path: string;
  now?: () => number;
  onError: (message: string, error: unknown) => void;
}

function decodeRunState(value: unknown): StoredRunState {
  if (
    !isDynamicRecord(value) ||
    value.version !== RUN_STATE_VERSION ||
    typeof value.running !== "boolean" ||
    typeof value.startedAt !== "number" ||
    !Array.isArray(value.starts)
  ) {
    throw new Error("The run state file has an unknown shape.");
  }
  return {
    version: RUN_STATE_VERSION,
    running: value.running,
    startedAt: value.startedAt,
    stoppedAt: typeof value.stoppedAt === "number" ? value.stoppedAt : null,
    starts: value.starts.filter((entry): entry is number => typeof entry === "number"),
  };
}

export class RunMarker {
  readonly #options: RunMarkerOptions;
  #state: RunMarkerState | null = null;
  #current: StoredRunState | null = null;

  constructor(options: RunMarkerOptions) {
    this.#options = options;
  }

  /** What `begin` found. Null before it ran. */
  get state(): RunMarkerState | null {
    return this.#state;
  }

  /** Reads the last run, then sets the marker for this one. A file that cannot be written is logged, never fatal. */
  readonly begin = Effect.fn("RunMarker.begin")(function* (this: RunMarker) {
    const now = (this.#options.now ?? Date.now)();
    const previous = yield* readPreferenceFile(this.#options.path, decodeRunState).pipe(
      Effect.catch((failure) => {
        // A missing file is the first run. Anything else is a file we cannot trust.
        if (!isMissingFileError(failure.cause))
          this.#options.onError("The run state file is unreadable.", failure.cause);
        return Effect.succeed(null);
      }),
    );
    const starts = [...(previous?.starts ?? []), now].filter((at) => now - at < RECENT_WINDOW_MS);
    this.#state = {
      lastShutdown: previous ? (previous.running ? "unclean" : "clean") : "unknown",
      startsLast24Hours: starts.length,
      startedAt: now,
    };
    this.#current = {
      version: RUN_STATE_VERSION,
      running: true,
      startedAt: now,
      stoppedAt: null,
      starts: starts.slice(-MAX_REMEMBERED_STARTS),
    };
    yield* this.#write(this.#current);
  }).bind(this);

  /** The last step of a shutdown. A run that never reaches it stays marked as running. */
  readonly markClean = Effect.fn("RunMarker.markClean")(function* (this: RunMarker) {
    if (!this.#current) return;
    this.#current = { ...this.#current, running: false, stoppedAt: (this.#options.now ?? Date.now)() };
    yield* this.#write(this.#current);
  }).bind(this);

  #write(state: StoredRunState): Effect.Effect<void> {
    return writePreferenceFile(this.#options.path, state, { createDirectory: true }).pipe(
      Effect.catch((failure) =>
        Effect.sync(() => this.#options.onError("The run state could not be saved.", failure.cause)),
      ),
    );
  }
}
