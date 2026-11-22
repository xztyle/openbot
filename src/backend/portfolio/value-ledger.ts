import { randomUUID } from "node:crypto";
import type {
  RateOutcomeInput,
  ValueAgentRow,
  ValueRating,
  ValueReport,
  ValueSpaceRow,
} from "@openbot/contracts/portfolio";
import { PORTFOLIO_LIMITS } from "@openbot/contracts/portfolio";
import { isDynamicRecord, isString } from "@openbot/contracts/runtime-values";
import { Effect } from "effect";
import { JsonStore } from "../agent-efficiency/json-store";

export const VALUE_LEDGER_FILE = "portfolio-value-v1.json";
const DAY_MS = 86_400_000;
const CARDS_KEPT = 5_000;

/**
 * Rough rates to US dollars for the currencies of the money helpers. The report names each currency
 * it converted, so the owner knows the value is approximate.
 */
const USD_RATES: Readonly<Record<string, number>> = {
  USD: 1,
  EUR: 1.08,
  GBP: 1.27,
  BRL: 0.18,
  MXN: 0.055,
  COP: 0.00025,
  ARS: 0.001,
  CLP: 0.0011,
  PEN: 0.27,
  CAD: 0.73,
};

/** Done cards weighted by priority. */
const PRIORITY_POINTS: Readonly<Record<string, number>> = { urgent: 4, high: 3, medium: 2, low: 1 };

export function priorityPoints(priority: string | null | undefined): number {
  return PRIORITY_POINTS[(priority ?? "").toLowerCase()] ?? 1;
}

export interface DoneCard {
  key: string;
  title: string;
  agentIds: string[];
  points: number;
  at: string;
}

interface StoredValue {
  version: 1;
  cards: DoneCard[];
  ratings: ValueRating[];
}

const EMPTY: StoredValue = { version: 1, cards: [], ratings: [] };

function isCard(value: unknown): value is DoneCard {
  return (
    isDynamicRecord(value) &&
    isString(value.key) &&
    isString(value.title) &&
    Array.isArray(value.agentIds) &&
    value.agentIds.every(isString) &&
    typeof value.points === "number" &&
    isString(value.at)
  );
}

function isRating(value: unknown): value is ValueRating {
  return (
    isDynamicRecord(value) &&
    isString(value.id) &&
    isString(value.spaceId) &&
    (value.agentId === null || isString(value.agentId)) &&
    isString(value.title) &&
    typeof value.rating === "number" &&
    isString(value.at)
  );
}

function decodeStored(value: unknown): StoredValue | null {
  if (!isDynamicRecord(value) || value.version !== 1) return null;
  return {
    version: 1,
    cards: Array.isArray(value.cards) ? value.cards.filter(isCard) : [],
    ratings: Array.isArray(value.ratings) ? value.ratings.filter(isRating) : [],
  };
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

/** What the value report reads of the insight report: the cost of each agent and the money rows. */
export interface ValueInputs {
  days: number;
  now: number;
  costs: readonly { agentId: string; spaceId: string; costUsd: number }[];
  money: readonly { spaceId: string; date: string; kind: "spend" | "revenue"; amount: number; currency: string }[];
  agents: readonly { id: string; spaceId: string }[];
  spaces: readonly { id: string }[];
  cards: readonly DoneCard[];
  ratings: readonly ValueRating[];
}

/**
 * The value of each space and agent next to its cost. A space's revenue is shared by its agents in
 * proportion to their done cards weighted by priority, or to their cost when no card was done; the
 * owner's rated outcomes add their dollar value to the agent (or the space) they name.
 */
export function valueReport(input: ValueInputs): ValueReport {
  const since = input.now - input.days * DAY_MS;
  const sinceDate = new Date(since).toISOString().slice(0, 10);
  const converted = new Set<string>();
  const usd = (amount: number, currency: string) => {
    const code = currency.toUpperCase();
    const rate = USD_RATES[code];
    if (rate === undefined) return null;
    if (code !== "USD") converted.add(code);
    return amount * rate;
  };
  const spaceOf = new Map(input.agents.map((agent) => [agent.id, agent.spaceId]));
  const agentRows = new Map<string, ValueAgentRow>();
  const row = (agentId: string): ValueAgentRow | null => {
    const spaceId = spaceOf.get(agentId);
    if (!spaceId) return null;
    let found = agentRows.get(agentId);
    if (!found) {
      found = {
        agentId,
        spaceId,
        revenueUsd: 0,
        cardsDone: 0,
        cardPoints: 0,
        ratedUsd: 0,
        rating: null,
        valueUsd: 0,
        costUsd: 0,
        valuePerDollar: null,
      };
      agentRows.set(agentId, found);
    }
    return found;
  };
  for (const cost of input.costs) {
    const entry = row(cost.agentId);
    if (entry) entry.costUsd += cost.costUsd;
  }
  for (const card of input.cards) {
    if (Date.parse(card.at) < since) continue;
    const share = card.points / Math.max(card.agentIds.length, 1);
    for (const agentId of card.agentIds) {
      const entry = row(agentId);
      if (!entry) continue;
      entry.cardsDone += 1;
      entry.cardPoints += share;
    }
  }
  const spaceRows = new Map<string, ValueSpaceRow>(
    input.spaces.map((space) => [
      space.id,
      {
        spaceId: space.id,
        revenueUsd: 0,
        adSpendUsd: 0,
        cardsDone: 0,
        ratedUsd: 0,
        valueUsd: 0,
        costUsd: 0,
        valuePerDollar: null,
      },
    ]),
  );
  for (const entry of input.money) {
    if (entry.date < sinceDate) continue;
    const space = spaceRows.get(entry.spaceId);
    const amount = usd(entry.amount, entry.currency);
    if (!space || amount === null) continue;
    if (entry.kind === "revenue") space.revenueUsd += amount;
    else space.adSpendUsd += amount;
  }
  const ratings = input.ratings.filter((rating) => Date.parse(rating.at) >= since);
  const stars = new Map<string, number[]>();
  for (const rating of ratings) {
    const space = spaceRows.get(rating.spaceId);
    if (space) space.ratedUsd += rating.valueUsd ?? 0;
    if (rating.agentId) {
      const entry = row(rating.agentId);
      if (!entry) continue;
      entry.ratedUsd += rating.valueUsd ?? 0;
      stars.set(rating.agentId, [...(stars.get(rating.agentId) ?? []), rating.rating]);
    }
  }
  for (const space of spaceRows.values()) {
    const members = [...agentRows.values()].filter((entry) => entry.spaceId === space.spaceId);
    const points = members.reduce((sum, entry) => sum + entry.cardPoints, 0);
    const cost = members.reduce((sum, entry) => sum + entry.costUsd, 0);
    for (const entry of members) {
      const weight = points > 0 ? entry.cardPoints / points : cost > 0 ? entry.costUsd / cost : 0;
      entry.revenueUsd = space.revenueUsd * weight;
    }
    space.cardsDone = members.reduce((sum, entry) => sum + entry.cardsDone, 0);
    space.costUsd = cost;
    space.valueUsd = space.revenueUsd + space.ratedUsd;
    space.valuePerDollar = cost > 0 ? round(space.valueUsd / cost) : null;
  }
  for (const entry of agentRows.values()) {
    const given = stars.get(entry.agentId);
    entry.rating = given ? round(given.reduce((sum, value) => sum + value, 0) / given.length) : null;
    entry.valueUsd = entry.revenueUsd + entry.ratedUsd;
    entry.valuePerDollar = entry.costUsd > 0 ? round(entry.valueUsd / entry.costUsd) : null;
  }
  const finish = <T extends { costUsd: number; valueUsd: number }>(value: T): T => ({
    ...value,
    ...Object.fromEntries(
      Object.entries(value).map(([key, field]) =>
        typeof field === "number" && key !== "valuePerDollar" && key !== "rating" ? [key, round(field)] : [key, field],
      ),
    ),
  });
  return {
    days: input.days,
    spaces: [...spaceRows.values()].map(finish).sort((left, right) => right.valueUsd - left.valueUsd),
    agents: [...agentRows.values()]
      .map((entry) => ({ ...finish(entry), cardPoints: Math.round(entry.cardPoints) }))
      .sort((left, right) => (right.valuePerDollar ?? -1) - (left.valuePerDollar ?? -1)),
    ratings: ratings.slice(0, PORTFOLIO_LIMITS.ratings),
    converted: [...converted].sort(),
  };
}

/** The done cards of each agent and the owner's ratings of outcomes, for the value report. */
export class ValueLedger {
  readonly #store: JsonStore<StoredValue>;

  constructor(path: string) {
    this.#store = new JsonStore(path, EMPTY, decodeStored);
  }

  readonly snapshot = Effect.fn("ValueLedger.snapshot")(function* (this: ValueLedger) {
    return yield* this.#store.load();
  });

  /** A Motion card that reached done. A card done again later counts once, at its last time. */
  readonly cardDone = Effect.fn("ValueLedger.cardDone")(function* (
    this: ValueLedger,
    input: { key: string; title: string; agentIds: readonly string[]; priority?: string | null },
  ) {
    if (input.agentIds.length === 0) return;
    const card: DoneCard = {
      key: input.key.slice(0, 64),
      title: input.title.slice(0, 240),
      agentIds: [...new Set(input.agentIds)].slice(0, 10),
      points: priorityPoints(input.priority),
      at: new Date().toISOString(),
    };
    yield* this.#store.update((stored) => ({
      ...stored,
      cards: [card, ...stored.cards.filter((entry) => entry.key !== card.key)].slice(0, CARDS_KEPT),
    }));
  });

  readonly rate = Effect.fn("ValueLedger.rate")(function* (this: ValueLedger, input: RateOutcomeInput) {
    const rating: ValueRating = {
      id: randomUUID(),
      spaceId: input.spaceId,
      agentId: input.agentId ?? null,
      title: input.title,
      ref: input.ref ?? null,
      rating: input.rating,
      valueUsd: input.valueUsd ?? null,
      at: new Date().toISOString(),
    };
    yield* this.#store.update((stored) => ({
      ...stored,
      ratings: [rating, ...stored.ratings].slice(0, PORTFOLIO_LIMITS.ratings),
    }));
    return rating;
  });
}
