import { readFile } from "node:fs/promises";
import {
  DEFAULT_INSIGHT_BRIEFING,
  decodeInsightDataSource,
  decodeInsightGoal,
  decodeInsightMoneyEntry,
  INSIGHT_ALERT_KINDS,
  INSIGHT_GOAL_LIMIT,
  INSIGHT_MONEY_ENTRY_LIMIT,
  type InsightAlertKind,
  type InsightBriefingSettings,
  type InsightDataSource,
  type InsightGoal,
  type InsightMoneyEntry,
  parseInsightBriefingSettings,
} from "@openbot/contracts/ipc";
import { isDynamicRecord, isOneOf, isString } from "@openbot/contracts/runtime-values";
import { createOpenBotLogger } from "@openbot/logging";
import { Effect, Semaphore } from "effect";
import { isEmptyStoredFile, parseStoredJson, writeJsonFileAtomically } from "../atomic-json-file";
import { isMissingFileError } from "../file-errors";

const logger = createOpenBotLogger("insight");

/** An alert as the host keeps it: `key` names the condition, so the same one is raised once. */
export interface StoredInsightAlert {
  id: string;
  key: string;
  spaceId: string;
  kind: InsightAlertKind;
  text: string;
  createdAt: string;
  /** When the owner dismissed it; the condition then raises it again only after it ended once. */
  dismissedAt: string | null;
}

export interface StoredInsight {
  version: 1;
  goals: InsightGoal[];
  money: InsightMoneyEntry[];
  alerts: StoredInsightAlert[];
  sources: InsightDataSource[];
  briefing: InsightBriefingSettings;
  /** The briefing channel of each scope: `all` or a space id. */
  channels: Record<string, string>;
  /** The local day each scope last got its briefing. */
  sentDays: Record<string, string>;
  lastSentAt: string | null;
  lastText: string | null;
  /** The routines that the briefing paused, so turning it off resumes them and nothing else. */
  pausedRoutineIds: string[];
  /** The local day of the last automatic money sync. */
  syncedDay: string | null;
}

function emptyInsight(): StoredInsight {
  return {
    version: 1,
    goals: [],
    money: [],
    alerts: [],
    sources: [],
    briefing: { ...DEFAULT_INSIGHT_BRIEFING },
    channels: {},
    sentDays: {},
    lastSentAt: null,
    lastText: null,
    pausedRoutineIds: [],
    syncedDay: null,
  };
}

function stringRecord(value: unknown): Record<string, string> {
  if (!isDynamicRecord(value)) return {};
  return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => isString(entry[1])));
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter(isString) : [];
}

/** Reads the stored file item by item, so one damaged goal or row is dropped and the rest is kept. */
function decodeStored(value: unknown): StoredInsight {
  const stored = emptyInsight();
  if (!isDynamicRecord(value) || value.version !== 1) return stored;
  const keep = <T>(items: unknown, decode: (item: unknown) => T): T[] =>
    (Array.isArray(items) ? items : []).flatMap((item) => {
      try {
        return [decode(item)];
      } catch {
        return [];
      }
    });
  stored.goals = keep(value.goals, decodeInsightGoal).slice(0, INSIGHT_GOAL_LIMIT);
  stored.money = keep(value.money, decodeInsightMoneyEntry).slice(-INSIGHT_MONEY_ENTRY_LIMIT);
  stored.sources = keep(value.sources, decodeInsightDataSource);
  stored.alerts = keep(value.alerts, (item): StoredInsightAlert => {
    if (
      !isDynamicRecord(item) ||
      !isString(item.id) ||
      !isString(item.key) ||
      !isString(item.spaceId) ||
      !isOneOf(INSIGHT_ALERT_KINDS, item.kind) ||
      !isString(item.text) ||
      !isString(item.createdAt)
    )
      throw new Error("Invalid alert.");
    return {
      id: item.id,
      key: item.key,
      spaceId: item.spaceId,
      kind: item.kind,
      text: item.text.slice(0, 300),
      createdAt: item.createdAt,
      dismissedAt: isString(item.dismissedAt) ? item.dismissedAt : null,
    };
  });
  try {
    stored.briefing = parseInsightBriefingSettings(value.briefing);
  } catch {
    stored.briefing = { ...DEFAULT_INSIGHT_BRIEFING };
  }
  stored.channels = stringRecord(value.channels);
  stored.sentDays = stringRecord(value.sentDays);
  stored.lastSentAt = isString(value.lastSentAt) ? value.lastSentAt : null;
  stored.lastText = isString(value.lastText) ? value.lastText.slice(0, 4_000) : null;
  stored.pausedRoutineIds = strings(value.pausedRoutineIds);
  stored.syncedDay = isString(value.syncedDay) ? value.syncedDay : null;
  return stored;
}

/**
 * The goals, money rows, alerts and briefing settings of the host, in one JSON file next to the
 * database. A file that is missing reads as empty; a damaged one loses only its damaged items.
 * Changes are written at once, one at a time.
 */
export class InsightStore {
  readonly #path: string;
  #state: StoredInsight = emptyInsight();
  readonly #writes = Semaphore.makeUnsafe(1);
  #loaded = false;

  constructor(path: string) {
    this.#path = path;
  }

  readonly load = Effect.fn("InsightStore.load")(function* (this: InsightStore) {
    if (this.#loaded) return;
    this.#loaded = true;
    const contents = yield* Effect.tryPromise(() => readFile(this.#path, "utf8")).pipe(
      Effect.catch((failure) =>
        Effect.sync(() => {
          if (!isMissingFileError(failure.cause)) logger.warn("Could not read the insight file.", { error: failure });
          return null;
        }),
      ),
    );
    if (contents === null || isEmptyStoredFile(contents)) return;
    this.#state = yield* Effect.try(() => parseStoredJson(this.#path, contents, decodeStored)).pipe(
      Effect.catch((failure) =>
        Effect.sync(() => {
          logger.warn("Could not read the insight file.", { error: failure });
          return emptyInsight();
        }),
      ),
    );
  });

  get state(): Readonly<StoredInsight> {
    return this.#state;
  }

  /** Applies a change to a copy and writes it. A failed write keeps the change in memory and logs it. */
  readonly change = Effect.fn("InsightStore.change")(function* (
    this: InsightStore,
    apply: (draft: StoredInsight) => void,
  ) {
    const draft = structuredClone(this.#state);
    apply(draft);
    this.#state = draft;
    yield* this.#writes
      .withPermit(Effect.suspend(() => writeJsonFileAtomically(this.#path, this.#state, { createDirectory: true })))
      .pipe(
        Effect.catch((failure) =>
          Effect.sync(() => logger.warn("Could not save the insight file.", { error: failure.cause })),
        ),
      );
  });
}
