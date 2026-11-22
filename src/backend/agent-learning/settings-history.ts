import { randomUUID } from "node:crypto";
import {
  SETTINGS_AUTHOR_KINDS,
  SETTINGS_FIELDS,
  SETTINGS_HISTORY_LIMIT,
  type SettingsAuthor,
  type SettingsCheckpoint,
  type SettingsField,
  type SettingsFieldChange,
} from "@openbot/contracts/agent-learning";
import type { AgentSummary } from "@openbot/contracts/ipc";
import { isDynamicRecord, isOneOf, isString } from "@openbot/contracts/runtime-values";
import { Effect } from "effect";
import type { SkillLearner } from "../agent/skill-learning";
import { JsonStore } from "../agent-efficiency/json-store";

/** The file of the checkpoints, in the user data folder. */
export const SETTINGS_HISTORY_FILE = "agent-settings-history-v1.json";
/** A skill or playbook text longer than this is kept cut, and its checkpoint cannot roll back. */
const TEXT_KEPT = 64_000;

interface StoredHistory {
  version: 1;
  checkpoints: SettingsCheckpoint[];
}

const EMPTY: StoredHistory = { version: 1, checkpoints: [] };

/** The fields of an agent summary that the history follows, as text. */
export type SettingsSnapshot = Partial<Record<Exclude<SettingsField, "skill" | "playbook">, string | null>>;

/** The followed fields of `agent`: a string stays as it is, anything else is JSON, unset is null. */
export function settingsSnapshot(agent: AgentSummary): SettingsSnapshot {
  const json = (value: unknown) => (value === undefined || value === null ? null : JSON.stringify(value));
  return {
    name: agent.name,
    title: agent.title,
    instructions: agent.description,
    provider: agent.provider,
    model: agent.model,
    reasoningEffort: agent.reasoningEffort,
    modelPolicy: agent.modelPolicy ?? "fixed",
    playbookRole: agent.playbookRole ?? null,
    access: agent.access ?? "full",
    computerUse: agent.computerUse === false ? "off" : "on",
    backupModels: json(agent.backupModels),
  };
}

/** The fields that differ between two snapshots, in the order of `SETTINGS_FIELDS`. */
export function snapshotChanges(before: SettingsSnapshot, after: SettingsSnapshot): SettingsFieldChange[] {
  const changes: SettingsFieldChange[] = [];
  for (const field of SETTINGS_FIELDS) {
    if (field === "skill" || field === "playbook") continue;
    const old = before[field] ?? null;
    const next = after[field] ?? null;
    if (old !== next) changes.push({ field, before: old, after: next });
  }
  return changes;
}

function isChange(value: unknown): value is SettingsFieldChange {
  return (
    isDynamicRecord(value) &&
    isOneOf(SETTINGS_FIELDS, value.field) &&
    (value.before === null || isString(value.before)) &&
    (value.after === null || isString(value.after)) &&
    (value.ref === undefined || isString(value.ref)) &&
    (value.label === undefined || isString(value.label))
  );
}

function isCheckpoint(value: unknown): value is SettingsCheckpoint {
  return (
    isDynamicRecord(value) &&
    isString(value.id) &&
    isString(value.agentId) &&
    isString(value.at) &&
    isDynamicRecord(value.author) &&
    isOneOf(SETTINGS_AUTHOR_KINDS, value.author.kind) &&
    Array.isArray(value.changes) &&
    value.changes.every(isChange)
  );
}

function decodeStored(value: unknown): StoredHistory | null {
  if (!isDynamicRecord(value) || value.version !== 1) return null;
  return { version: 1, checkpoints: Array.isArray(value.checkpoints) ? value.checkpoints.filter(isCheckpoint) : [] };
}

/** A text kept whole, or cut with a mark: a cut text cannot be put back. */
function kept(text: string | null): string | null {
  return text === null || text.length <= TEXT_KEPT ? text : `${text.slice(0, TEXT_KEPT - 20)}\n[…cut]`;
}

export function isCutText(text: string | null): boolean {
  return text !== null && text.length > TEXT_KEPT - 20 && text.endsWith("\n[…cut]");
}

/**
 * The checkpoints of each agent's settings: every change of a followed field, a local skill that a
 * review revised, or a playbook of the agent's role, with the author and the text before and after.
 * The newest `SETTINGS_HISTORY_LIMIT` of each agent are kept. The host applies a rollback; this only
 * keeps the record.
 */
export class SettingsHistory {
  readonly #store: JsonStore<StoredHistory>;
  readonly #listeners = new Set<(checkpoint: SettingsCheckpoint) => void>();

  constructor(path: string) {
    this.#store = new JsonStore(path, EMPTY, decodeStored);
  }

  /** Calls `listener` after each recorded checkpoint, such as the test suite that runs after a change. */
  onRecord(listener: (checkpoint: SettingsCheckpoint) => void): void {
    this.#listeners.add(listener);
  }

  /** The checkpoints of one agent, newest first. */
  readonly list = Effect.fn("SettingsHistory.list")(function* (this: SettingsHistory, agentId: string) {
    const stored = yield* this.#store.load();
    return stored.checkpoints.filter((checkpoint) => checkpoint.agentId === agentId);
  });

  readonly get = Effect.fn("SettingsHistory.get")(function* (this: SettingsHistory, checkpointId: string) {
    const stored = yield* this.#store.load();
    return stored.checkpoints.find((checkpoint) => checkpoint.id === checkpointId) ?? null;
  });

  /** Records the changes as one checkpoint; nothing when there are none. */
  readonly record = Effect.fn("SettingsHistory.record")(function* (
    this: SettingsHistory,
    agentId: string,
    author: SettingsAuthor,
    changes: readonly SettingsFieldChange[],
    rollbackOf?: string,
  ) {
    if (changes.length === 0) return null;
    const checkpoint: SettingsCheckpoint = {
      id: randomUUID(),
      agentId,
      at: new Date().toISOString(),
      author:
        author.kind === "agent" && author.agentId ? { kind: "agent", agentId: author.agentId } : { kind: author.kind },
      changes: changes
        .slice(0, 20)
        .map((change) => ({ ...change, before: kept(change.before), after: kept(change.after) })),
      ...(rollbackOf ? { rollbackOf } : {}),
    };
    yield* this.#store.update((stored) => {
      const mine = [checkpoint, ...stored.checkpoints.filter((item) => item.agentId === agentId)].slice(
        0,
        SETTINGS_HISTORY_LIMIT,
      );
      return { ...stored, checkpoints: [...mine, ...stored.checkpoints.filter((item) => item.agentId !== agentId)] };
    });
    for (const listener of this.#listeners)
      try {
        listener(checkpoint);
      } catch {
        // A listener never fails the record.
      }
    return checkpoint;
  });

  /** Drops the checkpoints of an agent that was deleted. */
  readonly forgetAgent = Effect.fn("SettingsHistory.forgetAgent")(function* (this: SettingsHistory, agentId: string) {
    const stored = yield* this.#store.load();
    if (!stored.checkpoints.some((checkpoint) => checkpoint.agentId === agentId)) return;
    yield* this.#store.update((current) => ({
      ...current,
      checkpoints: current.checkpoints.filter((checkpoint) => checkpoint.agentId !== agentId),
    }));
  });
}

/**
 * The skill library of the reviews with each save in the history: a revision keeps the text before
 * it, so the owner can roll back what a review or an accepted lesson changed.
 */
export function recordedSkillLearner(
  inner: SkillLearner,
  history: SettingsHistory,
  author: SettingsAuthor = { kind: "improver" },
  rollbackOf?: string,
): SkillLearner {
  return {
    read: (skillId) => inner.read(skillId),
    save: (agentId, draft) =>
      Effect.gen(function* () {
        const before =
          draft.action === "update"
            ? yield* inner.read(draft.skillId).pipe(
                Effect.map((skill) => skill.instructions),
                Effect.orElseSucceed(() => null),
              )
            : null;
        const event = yield* inner.save(agentId, draft);
        yield* history.record(
          agentId,
          author,
          [{ field: "skill", ref: event.skillId, label: event.skillName, before, after: draft.instructions }],
          rollbackOf,
        );
        return event;
      }),
  };
}
