import { randomUUID } from "node:crypto";
import {
  type RemoveSpaceKnowledgeInput,
  SPACE_ENTITY_TYPES,
  SPACE_KNOWLEDGE_LIMITS,
  type SpaceDecision,
  type SpaceEntity,
  type SpaceEntityFact,
  type SpaceEntityType,
  type SpaceKnowledge,
} from "@openbot/contracts/agent-learning";
import { isDynamicRecord, isOneOf, isString } from "@openbot/contracts/runtime-values";
import { Effect } from "effect";
import { JsonStore } from "../agent-efficiency/json-store";

/** The file of every space's decision log and entity memory, in the user data folder. */
export const SPACE_KNOWLEDGE_FILE = "space-knowledge-v1.json";

interface StoredKnowledge {
  version: 1;
  decisions: SpaceDecision[];
  entities: SpaceEntity[];
}

const EMPTY: StoredKnowledge = { version: 1, decisions: [], entities: [] };

function isDecision(value: unknown): value is SpaceDecision {
  return (
    isDynamicRecord(value) &&
    isString(value.id) &&
    isString(value.spaceId) &&
    (value.agentId === null || isString(value.agentId)) &&
    isString(value.decision) &&
    isString(value.why) &&
    isString(value.createdAt)
  );
}

function isFact(value: unknown): value is SpaceEntityFact {
  return (
    isDynamicRecord(value) &&
    isString(value.id) &&
    isString(value.text) &&
    (value.agentId === null || isString(value.agentId)) &&
    isString(value.at)
  );
}

function isEntity(value: unknown): value is SpaceEntity {
  return (
    isDynamicRecord(value) &&
    isString(value.id) &&
    isString(value.spaceId) &&
    isOneOf(SPACE_ENTITY_TYPES, value.type) &&
    isString(value.name) &&
    Array.isArray(value.facts) &&
    value.facts.every(isFact) &&
    isString(value.updatedAt)
  );
}

function decodeStored(value: unknown): StoredKnowledge | null {
  if (!isDynamicRecord(value) || value.version !== 1) return null;
  return {
    version: 1,
    decisions: Array.isArray(value.decisions) ? value.decisions.filter(isDecision) : [],
    entities: Array.isArray(value.entities) ? value.entities.filter(isEntity) : [],
  };
}

const COMPANY_SUFFIXES = new Set(["inc", "ltd", "llc", "sl", "sa", "srl", "sas", "gmbh", "bv", "co", "corp", "the"]);

/** The name that two spellings of one customer or product share: no case, accents, punctuation or company suffix. */
export function entityKey(type: SpaceEntityType, name: string): string {
  const words = name
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .match(/[\p{L}\p{N}]+/gu);
  const kept = (words ?? []).filter((word) => !COMPANY_SUFFIXES.has(word));
  return `${type}:${(kept.length > 0 ? kept : (words ?? [])).join(" ")}`;
}

function factKey(text: string): string {
  return (
    text
      .normalize("NFKD")
      .replace(/\p{M}/gu, "")
      .toLowerCase()
      .match(/[\p{L}\p{N}]+/gu)
      ?.join(" ") ?? ""
  );
}

function words(text: string): Set<string> {
  return new Set(
    factKey(text)
      .split(" ")
      .filter((word) => word.length > 2),
  );
}

/** How many words of the query a text has. */
function score(query: Set<string>, text: string) {
  if (query.size === 0) return 0;
  let found = 0;
  for (const word of words(text)) if (query.has(word)) found += 1;
  return found;
}

export interface RememberInput {
  type: SpaceEntityType;
  name: string;
  fact: string;
  sourceTurnId?: string;
}

/**
 * What the agents of a space know together: the decision log (what was decided, why, what else was
 * on the table, and later what came of it) and the memory of its customers, products and suppliers,
 * one entity with its facts each. Every agent of the space reads and writes it through its tools, so
 * a fact about one customer is not split over several agents' own memories.
 */
export class SpaceKnowledgeStore {
  readonly #store: JsonStore<StoredKnowledge>;

  constructor(path: string) {
    this.#store = new JsonStore(path, EMPTY, decodeStored);
  }

  readonly snapshot = Effect.fn("SpaceKnowledge.snapshot")(function* (
    this: SpaceKnowledgeStore,
    spaceId: string,
    query?: string,
  ) {
    const stored = yield* this.#store.load();
    const terms = query ? words(query) : null;
    const decisions = stored.decisions.filter((decision) => decision.spaceId === spaceId);
    const entities = stored.entities.filter((entity) => entity.spaceId === spaceId);
    const result: SpaceKnowledge = {
      spaceId,
      decisions: terms
        ? decisions.filter(
            (decision) => score(terms, `${decision.decision} ${decision.why} ${decision.outcome ?? ""}`) > 0,
          )
        : decisions,
      entities: terms
        ? entities.filter(
            (entity) => score(terms, `${entity.name} ${entity.facts.map((fact) => fact.text).join(" ")}`) > 0,
          )
        : entities,
    };
    return result;
  });

  readonly logDecision = Effect.fn("SpaceKnowledge.logDecision")(function* (
    this: SpaceKnowledgeStore,
    spaceId: string,
    agentId: string | null,
    input: { decision: string; why: string; alternatives?: string | undefined; channelId?: string | undefined },
  ) {
    const decision: SpaceDecision = {
      id: randomUUID(),
      spaceId,
      agentId,
      decision: input.decision.trim().slice(0, SPACE_KNOWLEDGE_LIMITS.decision),
      why: input.why.trim().slice(0, SPACE_KNOWLEDGE_LIMITS.why),
      ...(input.alternatives?.trim()
        ? { alternatives: input.alternatives.trim().slice(0, SPACE_KNOWLEDGE_LIMITS.alternatives) }
        : {}),
      ...(input.channelId ? { channelId: input.channelId } : {}),
      createdAt: new Date().toISOString(),
    };
    yield* this.#store.update((stored) => {
      const mine = [decision, ...stored.decisions.filter((item) => item.spaceId === spaceId)].slice(
        0,
        SPACE_KNOWLEDGE_LIMITS.decisions,
      );
      return { ...stored, decisions: [...mine, ...stored.decisions.filter((item) => item.spaceId !== spaceId)] };
    });
    return decision;
  });

  /** Records what came of a decision. Null when the space has no such decision. */
  readonly setOutcome = Effect.fn("SpaceKnowledge.setOutcome")(function* (
    this: SpaceKnowledgeStore,
    spaceId: string,
    decisionId: string,
    outcome: string,
  ) {
    const stored = yield* this.#store.load();
    const found = stored.decisions.find((decision) => decision.id === decisionId && decision.spaceId === spaceId);
    if (!found) return null;
    const next: SpaceDecision = {
      ...found,
      outcome: outcome.trim().slice(0, SPACE_KNOWLEDGE_LIMITS.outcome),
      outcomeAt: new Date().toISOString(),
    };
    yield* this.#store.update((current) => ({
      ...current,
      decisions: current.decisions.map((decision) => (decision.id === found.id ? next : decision)),
    }));
    return next;
  });

  /**
   * Adds a fact to the entity of that type and name, made when the space has none yet. A fact that the
   * entity already has stays once; an entity at its limit drops its oldest fact. Null when the fact
   * is empty or the space is full.
   */
  readonly remember = Effect.fn("SpaceKnowledge.remember")(function* (
    this: SpaceKnowledgeStore,
    spaceId: string,
    agentId: string | null,
    input: RememberInput,
  ) {
    const name = input.name.trim().slice(0, SPACE_KNOWLEDGE_LIMITS.name);
    const text = input.fact.trim().slice(0, SPACE_KNOWLEDGE_LIMITS.fact);
    if (!name || !text) return null;
    const key = entityKey(input.type, name);
    const now = new Date().toISOString();
    const loaded = yield* this.#store.load();
    const sameKey = (entity: SpaceEntity) => entity.spaceId === spaceId && entityKey(entity.type, entity.name) === key;
    // A full space takes no new entity; the caller says so.
    if (
      !loaded.entities.some(sameKey) &&
      loaded.entities.filter((entity) => entity.spaceId === spaceId).length >= SPACE_KNOWLEDGE_LIMITS.entities
    )
      return null;
    const saved: { entity: SpaceEntity | null } = { entity: null };
    yield* this.#store.update((stored) => {
      const existing = stored.entities.find(sameKey);
      const fact: SpaceEntityFact = {
        id: randomUUID(),
        text,
        agentId,
        ...(input.sourceTurnId ? { sourceTurnId: input.sourceTurnId } : {}),
        at: now,
      };
      const base: SpaceEntity = existing ?? {
        id: randomUUID(),
        spaceId,
        type: input.type,
        name,
        facts: [],
        updatedAt: now,
      };
      const known = base.facts.some((item) => factKey(item.text) === factKey(text));
      const next: SpaceEntity = {
        ...base,
        facts: known ? base.facts : [...base.facts, fact].slice(-SPACE_KNOWLEDGE_LIMITS.factsPerEntity),
        updatedAt: now,
      };
      saved.entity = next;
      return {
        ...stored,
        entities: existing
          ? stored.entities.map((entity) => (entity.id === existing.id ? next : entity))
          : [...stored.entities, next],
      };
    });
    return saved.entity;
  });

  /** The entities and decisions of the space that relate most to the query. */
  readonly recall = Effect.fn("SpaceKnowledge.recall")(function* (
    this: SpaceKnowledgeStore,
    spaceId: string,
    query: string,
    limit = 8,
  ) {
    const stored = yield* this.#store.load();
    const terms = words(query);
    const entities = stored.entities
      .filter((entity) => entity.spaceId === spaceId)
      .map((entity) => ({
        entity,
        score: score(terms, entity.name) * 3 + score(terms, entity.facts.map((fact) => fact.text).join(" ")),
      }))
      .filter((entry) => entry.score > 0)
      .sort((left, right) => right.score - left.score || right.entity.updatedAt.localeCompare(left.entity.updatedAt))
      .slice(0, limit)
      .map((entry) => entry.entity);
    const decisions = stored.decisions
      .filter((decision) => decision.spaceId === spaceId)
      .map((decision) => ({
        decision,
        score: score(
          terms,
          `${decision.decision} ${decision.why} ${decision.alternatives ?? ""} ${decision.outcome ?? ""}`,
        ),
      }))
      .filter((entry) => entry.score > 0)
      .sort(
        (left, right) => right.score - left.score || right.decision.createdAt.localeCompare(left.decision.createdAt),
      )
      .slice(0, limit)
      .map((entry) => entry.decision);
    return { entities, decisions };
  });

  readonly recentDecisions = Effect.fn("SpaceKnowledge.recentDecisions")(function* (
    this: SpaceKnowledgeStore,
    spaceId: string,
    limit = 20,
  ) {
    const stored = yield* this.#store.load();
    return stored.decisions.filter((decision) => decision.spaceId === spaceId).slice(0, limit);
  });

  /** Removes a decision, an entity or one fact. False when the space has no such record. */
  readonly remove = Effect.fn("SpaceKnowledge.remove")(function* (
    this: SpaceKnowledgeStore,
    input: RemoveSpaceKnowledgeInput,
  ) {
    let removed = false;
    yield* this.#store.update((stored) => {
      if (input.kind === "decision") {
        const decisions = stored.decisions.filter(
          (decision) => !(decision.id === input.id && decision.spaceId === input.spaceId),
        );
        removed = decisions.length !== stored.decisions.length;
        return { ...stored, decisions };
      }
      if (input.kind === "entity") {
        const entities = stored.entities.filter(
          (entity) => !(entity.id === input.id && entity.spaceId === input.spaceId),
        );
        removed = entities.length !== stored.entities.length;
        return { ...stored, entities };
      }
      return {
        ...stored,
        entities: stored.entities.flatMap((entity) => {
          if (entity.id !== input.entityId || entity.spaceId !== input.spaceId) return [entity];
          const facts = entity.facts.filter((fact) => fact.id !== input.id);
          removed = facts.length !== entity.facts.length;
          return facts.length > 0 ? [{ ...entity, facts }] : [];
        }),
      };
    });
    return removed;
  });

  /** The facts that an agent recorded in these turns, in every space. */
  readonly factsFromTurns = Effect.fn("SpaceKnowledge.factsFromTurns")(function* (
    this: SpaceKnowledgeStore,
    agentId: string,
    turnIds: ReadonlySet<string>,
  ) {
    const stored = yield* this.#store.load();
    return stored.entities.flatMap((entity) =>
      entity.facts
        .filter((fact) => fact.agentId === agentId && fact.sourceTurnId !== undefined && turnIds.has(fact.sourceTurnId))
        .map((fact) => ({ entityId: entity.id, factId: fact.id, text: fact.text })),
    );
  });

  readonly forgetFacts = Effect.fn("SpaceKnowledge.forgetFacts")(function* (
    this: SpaceKnowledgeStore,
    factIds: ReadonlySet<string>,
  ) {
    if (factIds.size === 0) return 0;
    let forgotten = 0;
    yield* this.#store.update((stored) => ({
      ...stored,
      entities: stored.entities.flatMap((entity) => {
        const facts = entity.facts.filter((fact) => !factIds.has(fact.id));
        forgotten += entity.facts.length - facts.length;
        return facts.length > 0 ? [{ ...entity, facts }] : [];
      }),
    }));
    return forgotten;
  });

  /**
   * The nightly cleanup of a space: entities whose names are one spelling of the same name merge into
   * the oldest, and a fact said twice stays once. Answers how many entities and facts went.
   */
  readonly consolidate = Effect.fn("SpaceKnowledge.consolidate")(function* (
    this: SpaceKnowledgeStore,
    spaceId: string,
  ) {
    let merged = 0;
    let facts = 0;
    yield* this.#store.update((stored) => {
      const byKey = new Map<string, SpaceEntity>();
      const others: SpaceEntity[] = [];
      for (const entity of stored.entities) {
        if (entity.spaceId !== spaceId) {
          others.push(entity);
          continue;
        }
        const key = entityKey(entity.type, entity.name);
        const first = byKey.get(key);
        if (!first) {
          byKey.set(key, entity);
          continue;
        }
        merged += 1;
        byKey.set(key, {
          ...first,
          facts: [...first.facts, ...entity.facts],
          updatedAt: first.updatedAt > entity.updatedAt ? first.updatedAt : entity.updatedAt,
        });
      }
      const mine = [...byKey.values()].map((entity) => {
        const seen = new Set<string>();
        const kept = entity.facts.filter((fact) => {
          const key = factKey(fact.text);
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        });
        facts += entity.facts.length - kept.length;
        return { ...entity, facts: kept.slice(-SPACE_KNOWLEDGE_LIMITS.factsPerEntity) };
      });
      return { ...stored, entities: [...others, ...mine] };
    });
    return { merged, facts };
  });

  /** Drops the records of a space that was deleted. */
  readonly forgetSpace = Effect.fn("SpaceKnowledge.forgetSpace")(function* (
    this: SpaceKnowledgeStore,
    spaceId: string,
  ) {
    yield* this.#store.update((stored) => ({
      ...stored,
      decisions: stored.decisions.filter((decision) => decision.spaceId !== spaceId),
      entities: stored.entities.filter((entity) => entity.spaceId !== spaceId),
    }));
  });
}
