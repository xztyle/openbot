/**
 * How the agents of this fork learn: the nightly memory cleanup ("dreaming"), the lessons that a
 * finished Motion card or loop item proposes, the history of each agent's settings with its rollback,
 * the decision log and customer and product memory of each space, and the forget of what an agent
 * learned from one chat. The host keeps all of it in small files of its own; nothing here is in the
 * agent summary.
 */
import { isBoundedString, isIdentifier } from "./ipc-bounded-values";
import { isBoolean, isDynamicRecord, isOneOf, isString } from "./runtime-values";

// Review items.

/** What a review item changes: memories, the agent's instructions, a role playbook, a skill, or a skill from another space. */
export const LEARNING_KINDS = ["memory", "instructions", "playbook", "skill", "cross-space"] as const;
export type LearningKind = (typeof LEARNING_KINDS)[number];

/** Where an item came from: the nightly cleanup, a finished Motion card, or a loop item that reached an end stage. */
export const LEARNING_SOURCES = ["dreaming", "task", "loop"] as const;
export type LearningSource = (typeof LEARNING_SOURCES)[number];

/**
 * `pending` waits for the owner. `applied` the owner accepted; `auto-applied` the host applied by
 * itself because it was low risk (the owner can still undo it). `dismissed` the owner refused,
 * `reverted` the owner undid, and `stale` could not apply because what it changes changed meanwhile.
 */
export const LEARNING_STATES = ["pending", "applied", "auto-applied", "dismissed", "reverted", "stale"] as const;
export type LearningState = (typeof LEARNING_STATES)[number];

/** `low`: a duplicate merge that applies by itself. `review`: anything else, which waits for the owner. */
export const LEARNING_RISKS = ["low", "review"] as const;
export type LearningRisk = (typeof LEARNING_RISKS)[number];

export const LEARNING_LIMITS = {
  title: 200,
  note: 600,
  ref: 200,
  text: 1_200,
  changes: 20,
  /** The items that the list answers. */
  items: 500,
} as const;

export type LearningChange =
  /** A memory's text becomes `after`; `before` is the text the review read. */
  | { type: "memory-update"; memoryId: string; before: string; after: string }
  /** A memory goes; `before` is its text, which an undo adds back. */
  | { type: "memory-forget"; memoryId: string; before: string }
  /** A rule added at the end of the agent's instructions. */
  | { type: "instructions-add"; text: string }
  /** A lesson added to the "Lessons" part of a role playbook. */
  | { type: "playbook-add"; playbookId: string; slug: string; text: string }
  /** A lesson added to the "Lessons" part of one of the agent's own local skills. */
  | { type: "skill-add"; skillId: string; name: string; text: string }
  /** Installs a local skill of an agent in another space on this agent. */
  | { type: "skill-copy"; fromAgentId: string; skillId: string; name: string };

export interface LearningReviewItem {
  id: string;
  kind: LearningKind;
  source: LearningSource;
  /** The agent it changes; null for a change of the whole space. */
  agentId: string | null;
  spaceId: string | null;
  title: string;
  /** Why, in a sentence or two. */
  note: string;
  /** The Motion ticket key or the loop item that it learned from, or null. */
  ref: string | null;
  changes: LearningChange[];
  risk: LearningRisk;
  state: LearningState;
  createdAt: string;
  decidedAt?: string;
}

export interface LearningSettings {
  /** The nightly memory cleanup of each agent and space. */
  dreaming: boolean;
  /** A lesson proposal after a finished Motion card or loop item. */
  taskLearning: boolean;
}

export interface LearningReviewsInput {
  agentId?: string;
  spaceId?: string;
  /** Only the items that wait for the owner. */
  pendingOnly?: boolean;
  /** Turns the cleanup or the lessons on or off before the list is read. */
  settings?: Partial<LearningSettings>;
}

export interface LearningReviewsPage {
  items: LearningReviewItem[];
  settings: LearningSettings;
}

export const LEARNING_DECISIONS = ["accept", "dismiss", "revert"] as const;
export type LearningDecision = (typeof LEARNING_DECISIONS)[number];

export interface DecideLearningInput {
  itemId: string;
  decision: LearningDecision;
}

// The decision queue: every proposal that waits for the owner, from each source, in one shape.

/** `learning`: an item above. `playbook`: an agent's playbook proposal. `review`: a weekly review's instruction. */
export const DECISION_QUEUE_SOURCES = ["learning", "playbook", "review"] as const;
export type DecisionQueueSource = (typeof DECISION_QUEUE_SOURCES)[number];

export interface DecisionQueueEntry {
  /** `<source>:<id of the item, proposal or review>`, which `/learning/queue/decide` takes. */
  id: string;
  source: DecisionQueueSource;
  /** The learning kind, or `playbook` or `instructions` for the other two sources. */
  kind: LearningKind;
  agentId: string | null;
  spaceId: string | null;
  title: string;
  /** Plain text of what changes, at most 2000 characters: the new lines, or "before → after". */
  detail: string;
  risk: LearningRisk;
  createdAt: string;
}

export interface DecideQueueEntryInput {
  id: string;
  decision: "approve" | "dismiss";
}

// The history of an agent's settings.

export const SETTINGS_AUTHOR_KINDS = ["owner", "agent", "improver"] as const;
export type SettingsAuthorKind = (typeof SETTINGS_AUTHOR_KINDS)[number];

/** Who changed the settings: the owner (or an admin), an agent through its tools, or a review that the owner accepted. */
export interface SettingsAuthor {
  kind: SettingsAuthorKind;
  /** The agent that asked for the change, for `agent`. */
  agentId?: string;
}

export const SETTINGS_FIELDS = [
  "name",
  "title",
  "instructions",
  "provider",
  "model",
  "reasoningEffort",
  "modelPolicy",
  "playbookRole",
  "access",
  "computerUse",
  "backupModels",
  "skill",
  "playbook",
] as const;
export type SettingsField = (typeof SETTINGS_FIELDS)[number];

export interface SettingsFieldChange {
  field: SettingsField;
  /** The skill or playbook it changed, by id, with its name in `label`. */
  ref?: string;
  label?: string;
  /** The value as text: JSON for a list or a record, `null` for unset. */
  before: string | null;
  after: string | null;
}

export interface SettingsCheckpoint {
  id: string;
  agentId: string;
  at: string;
  author: SettingsAuthor;
  changes: SettingsFieldChange[];
  /** The checkpoint that this one rolled back. */
  rollbackOf?: string;
}

export const SETTINGS_HISTORY_LIMIT = 30;

// The knowledge of a space.

export const SPACE_ENTITY_TYPES = ["customer", "product", "supplier", "other"] as const;
export type SpaceEntityType = (typeof SPACE_ENTITY_TYPES)[number];

export const SPACE_KNOWLEDGE_LIMITS = {
  decision: 400,
  why: 600,
  alternatives: 400,
  outcome: 400,
  name: 120,
  fact: 400,
  factsPerEntity: 30,
  decisions: 500,
  entities: 500,
} as const;

export interface SpaceDecision {
  id: string;
  spaceId: string;
  agentId: string | null;
  decision: string;
  why: string;
  alternatives?: string;
  /** What happened after, when an agent or the owner recorded it. */
  outcome?: string;
  outcomeAt?: string;
  channelId?: string;
  createdAt: string;
}

export interface SpaceEntityFact {
  id: string;
  text: string;
  agentId: string | null;
  /** The turn that recorded it, for the forget of one chat. */
  sourceTurnId?: string;
  at: string;
}

export interface SpaceEntity {
  id: string;
  spaceId: string;
  type: SpaceEntityType;
  name: string;
  facts: SpaceEntityFact[];
  updatedAt: string;
}

export interface SpaceKnowledge {
  spaceId: string;
  decisions: SpaceDecision[];
  entities: SpaceEntity[];
}

export interface RemoveSpaceKnowledgeInput {
  spaceId: string;
  kind: "decision" | "entity" | "fact";
  id: string;
  /** For `fact`: the entity that holds it. */
  entityId?: string;
}

// Forget what an agent learned from one chat.

export interface ForgetConversationInput {
  agentId: string;
  /** The chat; absent, the agent's own current chat. */
  threadId?: string;
  /** False or absent: only answers what would go. */
  confirm?: boolean;
}

export interface ForgetConversationResult {
  memories: { id: string; text: string }[];
  facts: { entityId: string; factId: string; text: string }[];
  forgotten: number;
}

// Parsers of the requests.

function fail(what: string): never {
  throw new Error(`Invalid ${what} request.`);
}

export function parseLearningReviewsInput(value: unknown): LearningReviewsInput {
  if (!isDynamicRecord(value)) fail("learning");
  const result: LearningReviewsInput = {};
  if (value.agentId !== undefined) {
    if (!isIdentifier(value.agentId)) fail("learning");
    result.agentId = value.agentId;
  }
  if (value.spaceId !== undefined) {
    if (!isIdentifier(value.spaceId)) fail("learning");
    result.spaceId = value.spaceId;
  }
  if (value.pendingOnly !== undefined) {
    if (!isBoolean(value.pendingOnly)) fail("learning");
    if (value.pendingOnly) result.pendingOnly = true;
  }
  if (value.settings !== undefined) {
    const settings = value.settings;
    if (!isDynamicRecord(settings)) fail("learning");
    const next: Partial<LearningSettings> = {};
    for (const key of ["dreaming", "taskLearning"] as const) {
      if (settings[key] === undefined) continue;
      const flag = settings[key];
      if (!isBoolean(flag)) fail("learning");
      next[key] = flag;
    }
    result.settings = next;
  }
  return result;
}

export function parseDecideLearningInput(value: unknown): DecideLearningInput {
  if (!isDynamicRecord(value) || !isIdentifier(value.itemId) || !isOneOf(LEARNING_DECISIONS, value.decision))
    fail("learning decision");
  return { itemId: value.itemId, decision: value.decision };
}

export function parseDecideQueueEntryInput(value: unknown): DecideQueueEntryInput {
  if (
    !isDynamicRecord(value) ||
    !isBoundedString(value.id, 200) ||
    !/^(?:learning|playbook|review):./u.test(value.id) ||
    !isOneOf(["approve", "dismiss"] as const, value.decision)
  )
    fail("queue decision");
  return { id: value.id, decision: value.decision };
}

export function parseAgentIdInput(value: unknown): { agentId: string } {
  if (!isDynamicRecord(value) || !isIdentifier(value.agentId)) fail("agent");
  return { agentId: value.agentId };
}

export function parseRollbackInput(value: unknown): { checkpointId: string } {
  if (!isDynamicRecord(value) || !isIdentifier(value.checkpointId)) fail("rollback");
  return { checkpointId: value.checkpointId };
}

export function parseSpaceKnowledgeInput(value: unknown): { spaceId: string; query?: string } {
  if (!isDynamicRecord(value) || !isIdentifier(value.spaceId)) fail("knowledge");
  if (value.query !== undefined && !isBoundedString(value.query, 200)) fail("knowledge");
  return {
    spaceId: value.spaceId,
    ...(isString(value.query) && value.query.trim() ? { query: value.query.trim() } : {}),
  };
}

export function parseRemoveSpaceKnowledgeInput(value: unknown): RemoveSpaceKnowledgeInput {
  if (
    !isDynamicRecord(value) ||
    !isIdentifier(value.spaceId) ||
    !isOneOf(["decision", "entity", "fact"] as const, value.kind) ||
    !isIdentifier(value.id) ||
    (value.entityId !== undefined && !isIdentifier(value.entityId)) ||
    (value.kind === "fact" && value.entityId === undefined)
  )
    fail("knowledge");
  return {
    spaceId: value.spaceId,
    kind: value.kind,
    id: value.id,
    ...(isString(value.entityId) ? { entityId: value.entityId } : {}),
  };
}

export function parseForgetConversationInput(value: unknown): ForgetConversationInput {
  if (
    !isDynamicRecord(value) ||
    !isIdentifier(value.agentId) ||
    (value.threadId !== undefined && !isIdentifier(value.threadId)) ||
    (value.confirm !== undefined && !isBoolean(value.confirm))
  )
    fail("forget");
  return {
    agentId: value.agentId,
    ...(isString(value.threadId) ? { threadId: value.threadId } : {}),
    ...(value.confirm === true ? { confirm: true } : {}),
  };
}

/** The lines of `after` that `before` does not have, for a short diff of a text field. */
export function addedLines(before: string | null, after: string | null): string[] {
  const old = new Set((before ?? "").split("\n").map((line) => line.trim()));
  return (after ?? "")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !old.has(line));
}

/** The lines of `before` that `after` does not have. */
export function removedLines(before: string | null, after: string | null): string[] {
  return addedLines(after, before);
}
