import type { AgentQuality, QualityPoint, QualitySample, QualitySettings } from "@openbot/contracts/portfolio";
import { isDynamicRecord, isString } from "@openbot/contracts/runtime-values";
import { createOpenBotLogger } from "@openbot/logging";
import { Effect, Schema } from "effect";
import { JsonStore } from "../agent-efficiency/json-store";
import { extractJsonObject } from "../structured-output";
import { LiveScore, liveJudgePrompt, type SandboxProfile } from "./portfolio-prompts";

const logger = createOpenBotLogger("portfolio-quality");

export const LIVE_QUALITY_FILE = "portfolio-quality-v1.json";
const DAY_MS = 86_400_000;
/** The samples kept per agent, newest first: about 30 days at the default rate. */
const SAMPLES_KEPT = 300;
/** The most turns that the host scores in one UTC day, on every agent together. */
const SAMPLES_PER_DAY = 60;
/** An answer shorter than this says nothing a judge can score. */
const MIN_ANSWER = 40;
/** The fall of the weekly average against the week before that is an alert. */
const DROP = 1.5;

interface StoredSample extends QualitySample {
  agentId: string;
}

interface StoredQuality {
  version: 1;
  settings: QualitySettings;
  samples: StoredSample[];
  day: { date: string; count: number };
}

const EMPTY: StoredQuality = {
  version: 1,
  settings: { enabled: true, sampleRate: 0.05 },
  samples: [],
  day: { date: "", count: 0 },
};

function isSample(value: unknown): value is StoredSample {
  return (
    isDynamicRecord(value) &&
    isString(value.agentId) &&
    isString(value.turnId) &&
    isString(value.at) &&
    typeof value.score === "number" &&
    isString(value.note)
  );
}

function decodeStored(value: unknown): StoredQuality | null {
  if (!isDynamicRecord(value) || value.version !== 1) return null;
  const settings = isDynamicRecord(value.settings) ? value.settings : {};
  const day = isDynamicRecord(value.day) ? value.day : {};
  return {
    version: 1,
    settings: {
      enabled: settings.enabled !== false,
      sampleRate:
        typeof settings.sampleRate === "number"
          ? Math.min(Math.max(settings.sampleRate, 0), 0.5)
          : EMPTY.settings.sampleRate,
    },
    samples: Array.isArray(value.samples) ? value.samples.filter(isSample) : [],
    day: { date: isString(day.date) ? day.date : "", count: typeof day.count === "number" ? day.count : 0 },
  };
}

function average(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  return Math.round((values.reduce((sum, value) => sum + value, 0) / values.length) * 10) / 10;
}

/** The 7-day averages, the fall between them and the daily trend of one agent's samples. */
export function agentQuality(agentId: string, samples: readonly QualitySample[], now: number): AgentQuality {
  const week = samples.filter((sample) => Date.parse(sample.at) >= now - 7 * DAY_MS).map((sample) => sample.score);
  const before = samples
    .filter((sample) => {
      const at = Date.parse(sample.at);
      return at < now - 7 * DAY_MS && at >= now - 14 * DAY_MS;
    })
    .map((sample) => sample.score);
  const average7 = average(week);
  const previous7 = average(before);
  const days = new Map<string, number[]>();
  for (const sample of samples) {
    if (Date.parse(sample.at) < now - 30 * DAY_MS) continue;
    const date = sample.at.slice(0, 10);
    days.set(date, [...(days.get(date) ?? []), sample.score]);
  }
  const trend: QualityPoint[] = [...days]
    .sort((left, right) => left[0].localeCompare(right[0]))
    .map(([date, scores]) => ({ date, average: average(scores) ?? 0, count: scores.length }));
  return {
    agentId,
    average7,
    previous7,
    dropped: average7 !== null && previous7 !== null && previous7 - average7 >= DROP,
    trend,
    recent: samples.slice(0, 20),
  };
}

export interface LiveQualityHooks {
  path: string;
  profile(agentId: string): Effect.Effect<SandboxProfile | null>;
  generateSmall(agentId: string, prompt: string): Effect.Effect<string | null>;
  redact(text: string): string;
  /** The random draw, for tests. */
  random?(): number;
}

/**
 * The live score of real work: a few percent of the finished turns that answered a person go to a
 * judge on the small model, which scores the answer from 1 to 10 against the agent's instructions and
 * playbooks. The scores make a trend per agent, and a fall of the weekly average is flagged, so a
 * cheaper model or a new prompt that makes the work worse shows.
 */
export class LiveQuality {
  readonly #hooks: LiveQualityHooks;
  readonly #store: JsonStore<StoredQuality>;
  #busy = false;

  constructor(hooks: LiveQualityHooks) {
    this.#hooks = hooks;
    this.#store = new JsonStore(hooks.path, EMPTY, decodeStored);
  }

  readonly page = Effect.fn("LiveQuality.page")(function* (
    this: LiveQuality,
    change: Partial<QualitySettings> | undefined,
    agentIds: readonly string[],
  ) {
    if (change && Object.keys(change).length > 0)
      yield* this.#store.update((stored) => ({ ...stored, settings: { ...stored.settings, ...change } }));
    const stored = yield* this.#store.load();
    const now = Date.now();
    return {
      settings: stored.settings,
      agents: agentIds.map((agentId) =>
        agentQuality(
          agentId,
          stored.samples.filter((sample) => sample.agentId === agentId),
          now,
        ),
      ),
    };
  });

  /** A finished answer to a person. It is scored at the sample rate, one at a time, within the daily cap. */
  finished(input: { agentId: string; turnId: string; asked: string; answer: string }): void {
    if (this.#busy || input.answer.trim().length < MIN_ANSWER || !input.asked.trim()) return;
    void Effect.runPromise(
      this.#score(input).pipe(
        Effect.catchCause((cause) => Effect.sync(() => logger.warn("A live score failed.", { cause }))),
      ),
    );
  }

  readonly #score = Effect.fn("LiveQuality.score")(function* (
    this: LiveQuality,
    input: { agentId: string; turnId: string; asked: string; answer: string },
  ) {
    const stored = yield* this.#store.load();
    const today = new Date().toISOString().slice(0, 10);
    const count = stored.day.date === today ? stored.day.count : 0;
    if (!stored.settings.enabled || count >= SAMPLES_PER_DAY) return;
    if ((this.#hooks.random?.() ?? Math.random()) >= stored.settings.sampleRate) return;
    this.#busy = true;
    try {
      yield* this.#store.update((current) => ({ ...current, day: { date: today, count: count + 1 } }));
      const profile = yield* this.#hooks.profile(input.agentId);
      if (!profile) return;
      const text = yield* this.#hooks.generateSmall(
        input.agentId,
        liveJudgePrompt(profile, this.#hooks.redact(input.asked), this.#hooks.redact(input.answer)),
      );
      if (text === null) return;
      const verdict = yield* Effect.try(() => extractJsonObject(text)).pipe(
        Effect.flatMap((json) => Schema.decodeUnknownEffect(LiveScore)(json)),
        Effect.orElseSucceed(() => null),
      );
      if (!verdict) return;
      const sample: StoredSample = {
        agentId: input.agentId,
        turnId: input.turnId,
        at: new Date().toISOString(),
        score: Math.round(verdict.score * 10) / 10,
        note: verdict.note.slice(0, 600),
      };
      yield* this.#store.update((current) => {
        const mine = [sample, ...current.samples.filter((entry) => entry.agentId === input.agentId)].slice(
          0,
          SAMPLES_KEPT,
        );
        return {
          ...current,
          samples: [...mine, ...current.samples.filter((entry) => entry.agentId !== input.agentId)],
        };
      });
    } finally {
      this.#busy = false;
    }
  });

  readonly forgetAgent = Effect.fn("LiveQuality.forgetAgent")(function* (this: LiveQuality, agentId: string) {
    yield* this.#store.update((stored) => ({
      ...stored,
      samples: stored.samples.filter((sample) => sample.agentId !== agentId),
    }));
  });
}
