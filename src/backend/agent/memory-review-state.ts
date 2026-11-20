import { readFile } from "node:fs/promises";
import { isDynamicRecord, isString } from "@openbot/contracts/runtime-values";
import { createOpenBotLogger } from "@openbot/logging";
import { Effect, Semaphore } from "effect";
import { isEmptyStoredFile, parseStoredJson, writeJsonFileAtomically } from "../atomic-json-file";
import { isMissingFileError } from "../file-errors";

const logger = createOpenBotLogger("memory-review");

/** What the reviews keep of one agent between restarts. */
export interface ReviewedAgent {
  /** The id of the last chat message that a review read. A review reads only what comes after it. */
  cursor: string | null;
  /** When the last review of this agent ran, in epoch milliseconds. */
  reviewedAt: number;
  /** How many skills the reviews made for this agent. A revision does not count. */
  learnedSkills: number;
}

interface StoredReviewState {
  version: 1;
  agents: Record<string, ReviewedAgent>;
  /** The UTC day and the count of reviews in it, for the server's daily limit. */
  day: { date: string; reviews: number };
}

/**
 * The positions and counters of the background memory reviews, in one small JSON file. A file that is
 * missing or damaged reads as empty: a review then reads the latest messages of each agent again,
 * which costs one review and loses nothing.
 */
export class MemoryReviewState {
  readonly #path: string;
  #state: StoredReviewState = { version: 1, agents: {}, day: { date: today(), reviews: 0 } };
  readonly #writes = Semaphore.makeUnsafe(1);
  #loaded = false;

  constructor(path: string) {
    this.#path = path;
  }

  load(): Effect.Effect<void> {
    if (this.#loaded) return Effect.void;
    return Effect.promise(async () => {
      if (this.#loaded) return;
      this.#loaded = true;
      try {
        const contents = await readFile(this.#path, "utf8");
        if (isEmptyStoredFile(contents)) return;
        const parsed = parseStoredJson(this.#path, contents, decodeState);
        if (parsed) this.#state = parsed;
      } catch (error) {
        if (!isMissingFileError(error)) logger.warn("Could not read the memory review state.", { error });
      }
    });
  }

  agent(agentId: string): ReviewedAgent {
    return (
      (Object.hasOwn(this.#state.agents, agentId) ? this.#state.agents[agentId] : undefined) ?? {
        cursor: null,
        reviewedAt: 0,
        learnedSkills: 0,
      }
    );
  }

  /** The reviews already run today (UTC). */
  reviewsToday(): number {
    return this.#state.day.date === today() ? this.#state.day.reviews : 0;
  }

  update(agentId: string, change: Partial<ReviewedAgent>, countsReview = false): Effect.Effect<void> {
    this.#state.agents = {
      ...this.#state.agents,
      ...Object.fromEntries([[agentId, { ...this.agent(agentId), ...change }]]),
    };
    if (countsReview) {
      const date = today();
      this.#state.day = { date, reviews: (this.#state.day.date === date ? this.#state.day.reviews : 0) + 1 };
    }
    return this.#write();
  }

  forgetAgent(agentId: string): Effect.Effect<void> {
    if (!Object.hasOwn(this.#state.agents, agentId)) return Effect.void;
    this.#state.agents = Object.fromEntries(Object.entries(this.#state.agents).filter(([id]) => id !== agentId));
    return this.#write();
  }

  #write(): Effect.Effect<void> {
    return this.#writes
      .withPermit(Effect.suspend(() => writeJsonFileAtomically(this.#path, this.#state, { createDirectory: true })))
      .pipe(
        Effect.catch((failure) =>
          Effect.sync(() => logger.warn("Could not save the memory review state.", { error: failure.cause })),
        ),
      );
  }
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function count(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function decodeState(value: unknown): StoredReviewState | null {
  if (!isDynamicRecord(value) || value.version !== 1 || !isDynamicRecord(value.agents)) return null;
  // `fromEntries` defines each key as an own property, also an id such as `__proto__`.
  const agents = Object.fromEntries(
    Object.entries(value.agents).flatMap(([agentId, entry]): [string, ReviewedAgent][] =>
      isDynamicRecord(entry)
        ? [
            [
              agentId,
              {
                cursor: isString(entry.cursor) ? entry.cursor : null,
                reviewedAt: count(entry.reviewedAt),
                learnedSkills: count(entry.learnedSkills),
              },
            ],
          ]
        : [],
    ),
  );
  const day = isDynamicRecord(value.day) ? value.day : null;
  return {
    version: 1,
    agents,
    day: { date: day && isString(day.date) ? day.date : today(), reviews: count(day?.reviews) },
  };
}
