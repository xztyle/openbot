import { randomUUID } from "node:crypto";
import type { RolePlaybooksSnapshot } from "@openbot/contracts/agent-efficiency";
import {
  type DecideLearningInput,
  type ForgetConversationResult,
  LEARNING_KINDS,
  LEARNING_LIMITS,
  LEARNING_RISKS,
  LEARNING_SOURCES,
  LEARNING_STATES,
  type LearningChange,
  type LearningKind,
  type LearningReviewItem,
  type LearningReviewsInput,
  type LearningReviewsPage,
  type LearningRisk,
  type LearningSettings,
} from "@openbot/contracts/agent-learning";
import {
  type AgentMemory,
  type AgentSummary,
  type ConversationMessage,
  isContextResetMarker,
} from "@openbot/contracts/ipc";
import { isDynamicRecord, isOneOf, isString } from "@openbot/contracts/runtime-values";
import { createOpenBotLogger } from "@openbot/logging";
import { Effect, Schema } from "effect";
import type { MemoryReviewBase } from "../agent/agent-memories";
import { isLocalLibrarySkill, type MemoryReviewOperation, type ReviewSkill } from "../agent/memory-review-prompt";
import { JsonStore } from "../agent-efficiency/json-store";
import { extractJsonObject } from "../structured-output";
import {
  type CrossSpaceInput,
  CrossSpaceResult,
  crossSpacePrompt,
  DreamResult,
  dreamPrompt,
  overlap,
  TaskLessonResult,
  taskLessonPrompt,
} from "./learning-prompts";
import { SpaceKnowledgeStore } from "./space-knowledge";

const logger = createOpenBotLogger("agent-learning");

/** The file of the review items, the settings and the positions of the cleanups, in the user data folder. */
export const AGENT_LEARNING_FILE = "agent-learning-v1.json";
/** How often the scheduler looks at the clock. */
const CHECK_INTERVAL_MS = 30 * 60_000;
/** The local hours in which the nightly cleanup starts: from 2 to 6 in the host's time zone. */
const NIGHT_START_HOUR = 2;
const NIGHT_END_HOUR = 6;
/** The most agents that one night cleans up, the agents with the most memories first. */
const DREAM_AGENTS_PER_NIGHT = 25;
/** An agent with fewer memories and no person in its chat since the last cleanup is skipped. */
const DREAM_MIN_MEMORIES = 4;
/** Two words of three shared: a merge this close applies by itself. */
const LOW_RISK_OVERLAP = 0.6;
/** A task lesson waits this long, so the agent's last turn of the task ends first. */
const LESSON_DELAY_MS = 90_000;
/** One lesson per agent in this time, and at most `LESSONS_PER_DAY` on the server. */
const LESSON_GAP_MS = 60 * 60_000;
const LESSONS_PER_DAY = 20;
/** The chat messages that a lesson reads, newest last. */
const LESSON_MESSAGES = 80;
/** Decided items kept, newest first. Pending ones are always kept. */
const DECIDED_KEPT = 300;
/** Memory reviews whose chat turns are kept for the forget of one chat. */
const PROVENANCE_KEPT = 2_000;
const CROSS_SPACE_AGENTS = 60;
const CROSS_SPACE_SKILLS = 10;
const DREAM_TURN_PREFIX = "memory-dream-";

interface Provenance {
  agentId: string;
  turnIds: string[];
  at: number;
}

interface StoredLearning {
  version: 1;
  settings: LearningSettings;
  items: LearningReviewItem[];
  /**
   * The local date of the last nightly run, per agent the last chat message that a cleanup read, and
   * when it ran (epoch milliseconds).
   */
  dream: { date: string | null; cursors: Record<string, string>; at: Record<string, number> };
  /** The UTC date and count of the lessons, for the daily cap, and each agent's last lesson. */
  lessons: { date: string; count: number; last: Record<string, number> };
  /** The chat turns that each background memory review read, by the review's turn id. */
  provenance: Record<string, Provenance>;
}

const EMPTY: StoredLearning = {
  version: 1,
  settings: { dreaming: true, taskLearning: true },
  items: [],
  dream: { date: null, cursors: {}, at: {} },
  lessons: { date: "", count: 0, last: {} },
  provenance: {},
};

function isChange(value: unknown): value is LearningChange {
  if (!isDynamicRecord(value) || !isString(value.type)) return false;
  switch (value.type) {
    case "memory-update":
      return isString(value.memoryId) && isString(value.before) && isString(value.after);
    case "memory-forget":
      return isString(value.memoryId) && isString(value.before);
    case "instructions-add":
      return isString(value.text);
    case "playbook-add":
      return isString(value.playbookId) && isString(value.slug) && isString(value.text);
    case "skill-add":
      return isString(value.skillId) && isString(value.name) && isString(value.text);
    case "skill-copy":
      return isString(value.fromAgentId) && isString(value.skillId) && isString(value.name);
    default:
      return false;
  }
}

function isItem(value: unknown): value is LearningReviewItem {
  return (
    isDynamicRecord(value) &&
    isString(value.id) &&
    isOneOf(LEARNING_KINDS, value.kind) &&
    isOneOf(LEARNING_SOURCES, value.source) &&
    (value.agentId === null || isString(value.agentId)) &&
    (value.spaceId === null || isString(value.spaceId)) &&
    isString(value.title) &&
    isString(value.note) &&
    (value.ref === null || isString(value.ref)) &&
    Array.isArray(value.changes) &&
    value.changes.every(isChange) &&
    isOneOf(LEARNING_RISKS, value.risk) &&
    isOneOf(LEARNING_STATES, value.state) &&
    isString(value.createdAt)
  );
}

function stringRecord(value: unknown): Record<string, string> {
  if (!isDynamicRecord(value)) return {};
  return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => isString(entry[1])));
}

function decodeStored(value: unknown): StoredLearning | null {
  if (!isDynamicRecord(value) || value.version !== 1) return null;
  const settings = isDynamicRecord(value.settings) ? value.settings : {};
  const dream = isDynamicRecord(value.dream) ? value.dream : {};
  const lessons = isDynamicRecord(value.lessons) ? value.lessons : {};
  const last = isDynamicRecord(lessons.last) ? lessons.last : {};
  const provenance = isDynamicRecord(value.provenance) ? value.provenance : {};
  return {
    version: 1,
    settings: { dreaming: settings.dreaming !== false, taskLearning: settings.taskLearning !== false },
    items: Array.isArray(value.items) ? value.items.filter(isItem) : [],
    dream: {
      date: isString(dream.date) ? dream.date : null,
      cursors: stringRecord(dream.cursors),
      at: isDynamicRecord(dream.at)
        ? Object.fromEntries(
            Object.entries(dream.at).filter((entry): entry is [string, number] => typeof entry[1] === "number"),
          )
        : {},
    },
    lessons: {
      date: isString(lessons.date) ? lessons.date : "",
      count: typeof lessons.count === "number" ? lessons.count : 0,
      last: Object.fromEntries(
        Object.entries(last).filter((entry): entry is [string, number] => typeof entry[1] === "number"),
      ),
    },
    provenance: Object.fromEntries(
      Object.entries(provenance).filter(
        (entry): entry is [string, Provenance] =>
          isDynamicRecord(entry[1]) &&
          isString(entry[1].agentId) &&
          Array.isArray(entry[1].turnIds) &&
          entry[1].turnIds.every(isString) &&
          typeof entry[1].at === "number",
      ),
    ),
  };
}

export interface AgentLearningHooks {
  path: string;
  knowledgePath: string;
  agents(): readonly AgentSummary[];
  agentSpace(agentId: string): string;
  spaces(): readonly { id: string; name: string }[];
  /** False while the host starts or stops: the scheduler then waits. */
  running(): boolean;
  timeZone(): string;
  /** Runs a prompt on the agent's small model. Null when no model can run it. */
  generate(agent: AgentSummary, prompt: string): Effect.Effect<{ text: string } | null>;
  memoryBase(agentId: string): MemoryReviewBase;
  /** Applies memory operations as one background review turn, with its checks. */
  applyMemory(agentId: string, base: MemoryReviewBase, operations: MemoryReviewOperation[], turnId: string): void;
  memories(agentId: string): readonly AgentMemory[];
  forgetMemories(agentId: string, memoryIds: readonly string[]): number;
  /** The agent's own chat, without a running turn. */
  chat(agentId: string): readonly ConversationMessage[];
  addInstruction(agentId: string, text: string): Effect.Effect<void, unknown>;
  playbooks(): Effect.Effect<RolePlaybooksSnapshot, unknown>;
  addPlaybookLesson(playbookId: string, text: string): Effect.Effect<void, unknown>;
  skills(agentId: string): Effect.Effect<readonly ReviewSkill[], unknown>;
  addSkillLesson(agentId: string, skillId: string, text: string): Effect.Effect<void, unknown>;
  copySkill(skillId: string, toAgentId: string): Effect.Effect<void, unknown>;
  redact(text: string): string;
  /**
   * Rehearses an item that changes instructions, a playbook or a skill before it applies (the agent's
   * test suite). `block` refuses the accept, `warn` applies it with the note on the item.
   */
  vet?(item: LearningReviewItem): Effect.Effect<{ outcome: "apply" | "warn" | "block"; note: string | null }>;
}

/** A refusal of a decision, which the route answers as 409 with its text. */
export class LearningRefused extends Error {}

type NewItem = Omit<LearningReviewItem, "id" | "createdAt" | "state"> & { state?: LearningReviewItem["state"] };

function localClock(timeZone: string, now: Date): { date: string; hour: number } {
  try {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      hourCycle: "h23",
    }).formatToParts(now);
    const part = (type: string) => parts.find((entry) => entry.type === type)?.value ?? "";
    return { date: `${part("year")}-${part("month")}-${part("day")}`, hour: Number(part("hour")) };
  } catch {
    return { date: now.toISOString().slice(0, 10), hour: now.getUTCHours() };
  }
}

/** The messages after the cursor, or after the last clear of the chat. */
function afterCursor(messages: readonly ConversationMessage[], cursor: string | undefined): ConversationMessage[] {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message && (message.id === cursor || isContextResetMarker(message))) return messages.slice(index + 1);
  }
  return [...messages];
}

function isPersonMessage(message: ConversationMessage): boolean {
  return message.author === "user" && message.source !== "routine" && !message.senderAgentId;
}

function redacted(messages: readonly ConversationMessage[], redact: (text: string) => string): ConversationMessage[] {
  return messages.map((message) => ({
    ...message,
    text: redact(message.text),
    ...(message.trace
      ? {
          trace: {
            ...message.trace,
            steps: message.trace.steps.map((step) => ({
              ...step,
              ...(step.text === undefined ? {} : { text: redact(step.text) }),
              ...(step.command === undefined ? {} : { command: redact(step.command) }),
              ...(step.label === undefined ? {} : { label: redact(step.label) }),
            })),
          },
        }
      : {}),
  }));
}

function cut(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/**
 * How the agents learn by themselves, with the owner in control:
 *
 * - The nightly cleanup ("dreaming"): in the quiet hours of the host's time zone, each agent's memories
 *   and its chat since the last cleanup go to the small model once. Merges of duplicates apply by
 *   themselves and can be undone; anything else (an outdated memory, a rewrite, a rule after a mistake
 *   made twice) waits as a review item. Then each space's customer and product memory is tidied, and one
 *   prompt looks for a skill of one space that would help an agent of another.
 * - A lesson after a finished Motion card or loop item: the small model reads the chat of the work and
 *   may propose one rule for the agent's playbook, skill or instructions, which waits for the owner.
 * - The forget of what an agent learned from one chat, from the memories' source turns and the turns
 *   that each background memory review read.
 *
 * Every change of instructions, playbooks and skills that an item applies goes through the host's
 * own update paths, so it is in the agent's settings history with the improver as its author.
 */
export class AgentLearning {
  readonly #hooks: AgentLearningHooks;
  readonly #store: JsonStore<StoredLearning>;
  readonly knowledge: SpaceKnowledgeStore;
  #timer: ReturnType<typeof setInterval> | null = null;
  #night: Promise<void> | null = null;
  /** The lessons run one at a time. */
  #lessons: Promise<void> = Promise.resolve();
  readonly #lessonTimers = new Set<ReturnType<typeof setTimeout>>();

  constructor(hooks: AgentLearningHooks) {
    this.#hooks = hooks;
    this.#store = new JsonStore(hooks.path, EMPTY, decodeStored);
    this.knowledge = new SpaceKnowledgeStore(hooks.knowledgePath);
  }

  start(): void {
    if (this.#timer) return;
    this.#timer = setInterval(() => void this.tick(), CHECK_INTERVAL_MS);
    this.#timer.unref?.();
    // Memory items of before, which waited for the owner, apply now the way new ones do.
    void Effect.runPromise(this.applyPendingMemory().pipe(Effect.ignore));
    void this.tick();
  }

  /**
   * Applies every memory item that still waits: a memory change applies by itself and the owner
   * keeps or reverts it afterwards (the items of the agent's own memories only; a memory the owner
   * wrote or controls is never in an item). One that no longer applies becomes stale.
   */
  readonly applyPendingMemory = Effect.fn("AgentLearning.applyPendingMemory")(function* (this: AgentLearning) {
    const stored = yield* this.#store.load();
    const waiting = stored.items.filter((item) => item.state === "pending" && item.kind === "memory");
    for (const item of waiting) {
      const applied = this.#autoApply(item);
      yield* this.#settle(item.id, applied ? "auto-applied" : "stale");
    }
    return waiting.length;
  });

  /** Applies a memory item at once. False when nothing of it applies any more. */
  #autoApply(item: Pick<LearningReviewItem, "agentId" | "changes">): boolean {
    const agentId = item.agentId;
    if (!agentId || !this.#hooks.agents().some((agent) => agent.id === agentId)) return false;
    return this.#applyMemory(agentId, item.changes);
  }

  dispose(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
    for (const timer of this.#lessonTimers) clearTimeout(timer);
    this.#lessonTimers.clear();
  }

  /** The space of an agent, for the decision queue. */
  spaceOf(agentId: string): string {
    return this.#hooks.agentSpace(agentId);
  }

  agentName(agentId: string): string {
    return this.#hooks.agents().find((agent) => agent.id === agentId)?.name ?? agentId;
  }

  readonly settings = Effect.fn("AgentLearning.settings")(function* (this: AgentLearning) {
    return (yield* this.#store.load()).settings;
  });

  readonly list = Effect.fn("AgentLearning.list")(function* (this: AgentLearning, input: LearningReviewsInput) {
    if (input.settings && Object.keys(input.settings).length > 0) {
      const change = input.settings;
      yield* this.#store.update((stored) => ({ ...stored, settings: { ...stored.settings, ...change } }));
    }
    const stored = yield* this.#store.load();
    const items = stored.items
      .filter(
        (item) =>
          (!input.agentId || item.agentId === input.agentId) &&
          (!input.spaceId || item.spaceId === input.spaceId) &&
          (!input.pendingOnly || item.state === "pending"),
      )
      .slice(0, LEARNING_LIMITS.items);
    const page: LearningReviewsPage = { items, settings: stored.settings };
    return page;
  });

  /** The items that wait for the owner, newest first. */
  readonly pending = Effect.fn("AgentLearning.pending")(function* (this: AgentLearning) {
    return (yield* this.#store.load()).items.filter((item) => item.state === "pending");
  });

  readonly decide = Effect.fn("AgentLearning.decide")(function* (this: AgentLearning, input: DecideLearningInput) {
    const stored = yield* this.#store.load();
    const item = stored.items.find((candidate) => candidate.id === input.itemId);
    if (!item) return yield* Effect.fail(new LearningRefused("The item does not exist any more."));
    if (input.decision === "dismiss") {
      if (item.state !== "pending") return yield* Effect.fail(new LearningRefused("The item does not wait any more."));
      return yield* this.#settle(item.id, "dismissed");
    }
    if (input.decision === "accept") {
      if (item.state !== "pending") return yield* Effect.fail(new LearningRefused("The item does not wait any more."));
      const verdict = this.#hooks.vet ? yield* this.#hooks.vet(item) : null;
      if (verdict?.outcome === "block")
        return yield* Effect.fail(
          new LearningRefused(
            `${verdict.note ?? "The agent's test suite fails with this change."} Dismiss it or edit the suite.`,
          ),
        );
      if (verdict?.outcome === "warn" && verdict.note) {
        const note = `${item.note} ${verdict.note}`.slice(0, LEARNING_LIMITS.note);
        yield* this.#store.update((stored) => ({
          ...stored,
          items: stored.items.map((entry) => (entry.id === item.id ? { ...entry, note } : entry)),
        }));
      }
      const applied = yield* this.#apply(item);
      return yield* this.#settle(item.id, applied ? "applied" : "stale");
    }
    if (item.state !== "applied" && item.state !== "auto-applied")
      return yield* Effect.fail(new LearningRefused("Only an applied item can be undone."));
    if (item.kind !== "memory")
      return yield* Effect.fail(
        new LearningRefused("Roll this change back in the agent's settings history, which has its checkpoint."),
      );
    const reverted = this.#revertMemory(item);
    return yield* this.#settle(item.id, reverted ? "reverted" : "stale");
  });

  /** Records which chat turns a background memory review read, for the forget of one chat. */
  readonly reviewed = Effect.fn("AgentLearning.reviewed")(function* (
    this: AgentLearning,
    agentId: string,
    reviewTurnId: string,
    turnIds: readonly string[],
  ) {
    const unique = [...new Set(turnIds)].slice(-400);
    if (unique.length === 0) return;
    yield* this.#store.update((stored) => {
      const entries = Object.entries({
        ...stored.provenance,
        ...Object.fromEntries([[reviewTurnId, { agentId, turnIds: unique, at: Date.now() }]]),
      })
        .sort((left, right) => right[1].at - left[1].at)
        .slice(0, PROVENANCE_KEPT);
      return { ...stored, provenance: Object.fromEntries(entries) };
    });
  });

  /**
   * The memories and space facts that the agent learned in these chat turns: saved by the agent in one
   * of them, or by a background review that read one of them. With `confirm` they go.
   */
  readonly forgetConversation = Effect.fn("AgentLearning.forgetConversation")(function* (
    this: AgentLearning,
    agentId: string,
    turnIds: ReadonlySet<string>,
    confirm: boolean,
  ) {
    const stored = yield* this.#store.load();
    const reviews = new Set(
      Object.entries(stored.provenance)
        .filter(([, entry]) => entry.agentId === agentId && entry.turnIds.some((turnId) => turnIds.has(turnId)))
        .map(([reviewTurnId]) => reviewTurnId),
    );
    const memories = this.#hooks
      .memories(agentId)
      .filter((memory) => memory.sourceTurnId !== null && memory.sourceTurnId !== undefined)
      .filter((memory) => {
        const source = memory.sourceTurnId ?? "";
        return memory.origin !== "manual" && (turnIds.has(source) || reviews.has(source));
      });
    const facts = yield* this.knowledge.factsFromTurns(agentId, turnIds);
    let forgotten = 0;
    if (confirm) {
      forgotten += this.#hooks.forgetMemories(
        agentId,
        memories.map((memory) => memory.id),
      );
      forgotten += yield* this.knowledge.forgetFacts(new Set(facts.map((fact) => fact.factId)));
    }
    const result: ForgetConversationResult = {
      memories: memories.map((memory) => ({ id: memory.id, text: memory.text })),
      facts,
      forgotten,
    };
    return result;
  });

  /** A Motion card or loop item that these agents worked on is done; each may get a lesson. */
  taskFinished(agentIds: readonly string[], task: { source: "task" | "loop"; ref: string; title: string }): void {
    for (const agentId of new Set(agentIds)) {
      const timer = setTimeout(() => {
        this.#lessonTimers.delete(timer);
        this.#lessons = this.#lessons
          .then(() => Effect.runPromise(this.#lesson(agentId, task)))
          .catch((error: unknown) => logger.warn("Could not learn from the finished task.", { error }));
      }, LESSON_DELAY_MS);
      timer.unref?.();
      this.#lessonTimers.add(timer);
    }
  }

  /** Runs the night's cleanup when the quiet hours came and it has not run today. */
  tick(): Promise<void> {
    if (this.#night) return this.#night;
    const run = Effect.runPromise(this.#tick())
      .catch((error: unknown) => logger.warn("The nightly memory cleanup failed.", { error }))
      .finally(() => {
        this.#night = null;
      });
    this.#night = run;
    return run;
  }

  readonly #tick = Effect.fn("AgentLearning.tick")(function* (this: AgentLearning) {
    if (!this.#hooks.running()) return;
    const stored = yield* this.#store.load();
    if (!stored.settings.dreaming) return;
    const clock = localClock(this.#hooks.timeZone(), new Date());
    if (clock.hour < NIGHT_START_HOUR || clock.hour >= NIGHT_END_HOUR || stored.dream.date === clock.date) return;
    // Marked first: a night that fails partway does not run again until the next night.
    yield* this.#store.update((current) => ({ ...current, dream: { ...current.dream, date: clock.date } }));
    yield* this.night();
  });

  /** The whole nightly cleanup: each agent, then each space, then the suggestions across spaces. */
  readonly night = Effect.fn("AgentLearning.night")(function* (this: AgentLearning) {
    const agents = this.#hooks
      .agents()
      .filter((agent) => !agent.sleepingSince)
      .map((agent) => ({ agent, count: this.#hooks.memoryBase(agent.id).memories.length }))
      .sort((left, right) => right.count - left.count)
      .slice(0, DREAM_AGENTS_PER_NIGHT);
    for (const { agent } of agents) {
      if (!this.#hooks.running()) return;
      yield* this.dreamAgent(agent.id).pipe(
        Effect.catchCause((cause) =>
          Effect.sync(() => logger.warn("Could not clean up an agent's memories.", { agentId: agent.id, cause })),
        ),
      );
    }
    for (const space of this.#hooks.spaces()) yield* this.knowledge.consolidate(space.id);
    yield* this.#crossSpace().pipe(
      Effect.catchCause((cause) => Effect.sync(() => logger.warn("Could not compare the spaces.", { cause }))),
    );
  });

  /** Cleans up one agent's memories now. Answers the items it made. */
  readonly dreamAgent = Effect.fn("AgentLearning.dreamAgent")(function* (
    this: AgentLearning,
    agentId: string,
    manual = false,
  ) {
    const hooks = this.#hooks;
    const agent = hooks.agents().find((candidate) => candidate.id === agentId);
    if (!agent) return [];
    const stored = yield* this.#store.load();
    const messages = hooks.chat(agentId);
    const excerpt = afterCursor(messages, stored.dream.cursors[agentId]);
    const cursor = messages.at(-1)?.id;
    const base = hooks.memoryBase(agentId);
    const lastRun = stored.dream.at[agentId] ?? 0;
    const saveCursor = this.#store.update((current) => ({
      ...current,
      dream: {
        ...current.dream,
        cursors: cursor
          ? { ...current.dream.cursors, ...Object.fromEntries([[agentId, cursor]]) }
          : current.dream.cursors,
        at: { ...current.dream.at, ...Object.fromEntries([[agentId, Date.now()]]) },
      },
    }));
    // A night pass needs a person in the chat since the last one, or enough memories with one that
    // changed since then: an idle agent whose memories stay the same costs nothing.
    const changedMemory = base.memories.some((entry) => Date.parse(entry.memory.updatedAt) > lastRun);
    const worthIt = manual
      ? base.memories.length > 0 || excerpt.length > 0
      : excerpt.some(isPersonMessage) || (base.memories.length >= DREAM_MIN_MEMORIES && changedMemory);
    if (!worthIt) {
      yield* saveCursor;
      return [];
    }
    const shown = base.memories.map((entry) => ({
      ...entry,
      memory: { ...entry.memory, text: hooks.redact(entry.memory.text) },
    }));
    // A cleanup never changes a memory that it saw only redacted.
    const hidden = new Set(
      shown
        .filter((entry, index) => entry.memory.text !== base.memories[index]?.memory.text)
        .map((entry) => entry.memory.id),
    );
    const answer = yield* hooks.generate(
      agent,
      dreamPrompt(agent, { ...base, memories: shown }, redacted(excerpt, hooks.redact)),
    );
    yield* saveCursor;
    if (!answer) return [];
    const decoded = yield* Effect.try(() => extractJsonObject(answer.text)).pipe(
      Effect.flatMap((json) => Schema.decodeUnknownEffect(DreamResult)(json)),
      Effect.orElseSucceed(() => null),
    );
    if (!decoded) return [];
    const spaceId = hooks.agentSpace(agentId);
    const editable = (memoryId: string) => {
      const entry = base.memories.find((candidate) => candidate.memory.id === memoryId);
      return entry && !entry.userControlled && entry.memory.origin !== "manual" && !hidden.has(memoryId)
        ? entry.memory
        : null;
    };
    const used = new Set<string>();
    const automatic: LearningChange[] = [];
    const items: NewItem[] = [];
    const memoryItem = (title: string, note: string, changes: LearningChange[], risk: LearningRisk): NewItem => ({
      kind: "memory",
      source: "dreaming",
      agentId,
      spaceId,
      title: cut(title, LEARNING_LIMITS.title),
      note: cut(note, LEARNING_LIMITS.note),
      ref: null,
      changes,
      risk,
    });
    for (const merge of decoded.merges ?? []) {
      const keep = editable(merge.keepId);
      const forgetIds = [...new Set(merge.forgetIds)].filter((id) => id !== merge.keepId);
      const forgets = forgetIds.map(editable);
      if (!keep || forgets.length === 0 || used.has(keep.id) || forgetIds.some((id) => used.has(id))) continue;
      if (forgets.some((memory) => memory === null)) continue;
      const others = forgets.filter((memory): memory is AgentMemory => memory !== null);
      used.add(keep.id);
      for (const memory of others) used.add(memory.id);
      const changes: LearningChange[] = [
        ...(merge.text !== keep.text
          ? [{ type: "memory-update" as const, memoryId: keep.id, before: keep.text, after: merge.text }]
          : []),
        ...others.map((memory) => ({ type: "memory-forget" as const, memoryId: memory.id, before: memory.text })),
      ];
      const low =
        overlap(keep.text, merge.text) >= LOW_RISK_OVERLAP &&
        others.every((memory) => overlap(memory.text, keep.text) >= LOW_RISK_OVERLAP);
      if (low) automatic.push(...changes);
      else items.push(memoryItem(`Merge ${others.length + 1} memories`, merge.text, changes, "review"));
    }
    for (const stale of decoded.stale ?? []) {
      const memory = editable(stale.memoryId);
      if (!memory || used.has(memory.id)) continue;
      used.add(memory.id);
      items.push(
        memoryItem(
          `Forget: ${memory.text}`,
          stale.why,
          [{ type: "memory-forget", memoryId: memory.id, before: memory.text }],
          "review",
        ),
      );
    }
    for (const rewrite of decoded.rewrites ?? []) {
      const memory = editable(rewrite.memoryId);
      if (!memory || used.has(memory.id) || memory.text === rewrite.text) continue;
      used.add(memory.id);
      items.push(
        memoryItem(
          `Rewrite: ${memory.text}`,
          rewrite.why,
          [{ type: "memory-update", memoryId: memory.id, before: memory.text, after: rewrite.text }],
          "review",
        ),
      );
    }
    const instructions = agent.description.split("\n");
    for (const mistake of decoded.mistakes ?? []) {
      if (instructions.some((line) => overlap(line, mistake.rule) >= 0.8)) continue;
      items.push({
        kind: "instructions",
        source: "dreaming",
        agentId,
        spaceId,
        title: cut(`Rule after a repeated mistake: ${mistake.rule}`, LEARNING_LIMITS.title),
        note: cut(mistake.why, LEARNING_LIMITS.note),
        ref: null,
        changes: [{ type: "instructions-add", text: cut(mistake.rule, LEARNING_LIMITS.text) }],
        risk: "review",
      });
    }
    if (automatic.length > 0) {
      const forgotten = automatic.filter((change) => change.type === "memory-forget").length;
      const item = memoryItem(
        `Merged ${forgotten} duplicate ${forgotten === 1 ? "memory" : "memories"}`,
        "Near-identical memories were merged by the nightly cleanup. Undo puts them back.",
        automatic.slice(0, LEARNING_LIMITS.changes),
        "low",
      );
      if (this.#applyMemory(agentId, item.changes)) items.unshift({ ...item, state: "auto-applied" });
    }
    return yield* this.#add(items);
  });

  readonly #lesson = Effect.fn("AgentLearning.lesson")(function* (
    this: AgentLearning,
    agentId: string,
    task: { source: "task" | "loop"; ref: string; title: string },
  ) {
    const hooks = this.#hooks;
    if (!hooks.running()) return;
    const stored = yield* this.#store.load();
    if (!stored.settings.taskLearning) return;
    const today = new Date().toISOString().slice(0, 10);
    const count = stored.lessons.date === today ? stored.lessons.count : 0;
    const last = stored.lessons.last[agentId] ?? 0;
    if (count >= LESSONS_PER_DAY || Date.now() - last < LESSON_GAP_MS) return;
    const agent = hooks.agents().find((candidate) => candidate.id === agentId);
    if (!agent || agent.sleepingSince) return;
    const messages = hooks.chat(agentId).slice(-LESSON_MESSAGES);
    if (messages.length === 0) return;
    yield* this.#store.update((current) => ({
      ...current,
      lessons: {
        date: today,
        count: count + 1,
        last: { ...current.lessons.last, ...Object.fromEntries([[agentId, Date.now()]]) },
      },
    }));
    const snapshot = yield* hooks.playbooks().pipe(Effect.orElseSucceed(() => null));
    const playbooks = (snapshot?.playbooks ?? []).filter((playbook) => playbook.agentIds.includes(agentId));
    const skills = (yield* hooks.skills(agentId).pipe(Effect.orElseSucceed(() => []))).filter((skill) =>
      isLocalLibrarySkill(skill.skillId),
    );
    const answer = yield* hooks.generate(
      agent,
      taskLessonPrompt(
        agent,
        {
          source: task.source,
          title: hooks.redact(`${task.ref} ${task.title}`.trim()),
          playbooks: playbooks.map((playbook) => ({ slug: playbook.slug, content: hooks.redact(playbook.content) })),
          skills: skills.map((skill) => ({ ...skill, name: hooks.redact(skill.name) })),
        },
        redacted(messages, hooks.redact),
      ),
    );
    if (!answer) return;
    const decoded = yield* Effect.try(() => extractJsonObject(answer.text)).pipe(
      Effect.flatMap((json) => Schema.decodeUnknownEffect(TaskLessonResult)(json)),
      Effect.orElseSucceed(() => null),
    );
    const proposal = decoded?.proposal;
    if (!proposal) return;
    const text = cut(hooks.redact(proposal.text), LEARNING_LIMITS.text);
    const playbook = proposal.target === "playbook" ? playbooks.find((item) => item.slug === proposal.slug) : undefined;
    const skill = proposal.target === "skill" ? skills.find((item) => item.skillId === proposal.skillId) : undefined;
    const change: LearningChange = playbook
      ? { type: "playbook-add", playbookId: playbook.id, slug: playbook.slug, text }
      : skill
        ? { type: "skill-add", skillId: skill.skillId, name: skill.name, text }
        : { type: "instructions-add", text };
    const kind: LearningKind = playbook ? "playbook" : skill ? "skill" : "instructions";
    if (kind === "instructions" && agent.description.split("\n").some((line) => overlap(line, text) >= 0.8)) return;
    const pending = (yield* this.#store.load()).items.filter(
      (item) => item.state === "pending" && item.agentId === agentId,
    );
    if (pending.some((item) => item.changes.some((other) => "text" in other && overlap(other.text, text) >= 0.8)))
      return;
    const target = playbook ? `playbook ${playbook.slug}` : skill ? `skill ${skill.name}` : "instructions";
    yield* this.#add([
      {
        kind,
        source: task.source,
        agentId,
        spaceId: hooks.agentSpace(agentId),
        title: cut(`Lesson for ${agent.name}'s ${target}: ${text}`, LEARNING_LIMITS.title),
        note: cut(hooks.redact(proposal.why), LEARNING_LIMITS.note),
        ref: cut(hooks.redact(`${task.ref} ${task.title}`.trim()), LEARNING_LIMITS.ref),
        changes: [change],
        risk: "review",
      },
    ]);
  });

  /** One prompt over every space: a skill of an agent in one space that would help an agent of another. */
  readonly #crossSpace = Effect.fn("AgentLearning.crossSpace")(function* (this: AgentLearning) {
    const hooks = this.#hooks;
    const spaces = hooks.spaces();
    if (spaces.length < 2) return;
    const agents = hooks
      .agents()
      .filter((agent) => !agent.sleepingSince)
      .slice(0, CROSS_SPACE_AGENTS);
    const skillsOf = new Map<string, readonly ReviewSkill[]>();
    for (const agent of agents) {
      const skills = yield* hooks.skills(agent.id).pipe(Effect.orElseSucceed(() => []));
      skillsOf.set(agent.id, skills);
    }
    const input: CrossSpaceInput = {
      spaces: spaces
        .map((space) => ({
          id: space.id,
          name: hooks.redact(space.name),
          agents: agents
            .filter((agent) => hooks.agentSpace(agent.id) === space.id)
            .map((agent) => ({
              id: agent.id,
              name: hooks.redact(agent.name),
              title: hooks.redact(agent.title),
              skills: (skillsOf.get(agent.id) ?? [])
                .filter((skill) => isLocalLibrarySkill(skill.skillId))
                .slice(0, CROSS_SPACE_SKILLS)
                .map((skill) => ({
                  skillId: skill.skillId,
                  name: hooks.redact(skill.name),
                  description: skill.description === undefined ? undefined : hooks.redact(skill.description),
                })),
            })),
        }))
        .filter((space) => space.agents.length > 0),
    };
    const withSkills = input.spaces.filter((space) => space.agents.some((agent) => agent.skills.length > 0));
    if (input.spaces.length < 2 || withSkills.length === 0) return;
    const runner = agents.find((agent) => (skillsOf.get(agent.id) ?? []).length > 0) ?? agents[0];
    if (!runner) return;
    const answer = yield* hooks.generate(runner, crossSpacePrompt(input));
    if (!answer) return;
    const decoded = yield* Effect.try(() => extractJsonObject(answer.text)).pipe(
      Effect.flatMap((json) => Schema.decodeUnknownEffect(CrossSpaceResult)(json)),
      Effect.orElseSucceed(() => null),
    );
    const known = (yield* this.#store.load()).items.filter((item) => item.kind === "cross-space");
    const items: NewItem[] = [];
    for (const suggestion of decoded?.suggestions ?? []) {
      const from = agents.find((agent) => agent.id === suggestion.fromAgentId);
      const to = agents.find((agent) => agent.id === suggestion.toAgentId);
      const skill = (skillsOf.get(suggestion.fromAgentId) ?? []).find((item) => item.skillId === suggestion.skillId);
      if (!from || !to || !skill || !isLocalLibrarySkill(skill.skillId)) continue;
      if (hooks.agentSpace(from.id) === hooks.agentSpace(to.id)) continue;
      const theirs = skillsOf.get(to.id) ?? [];
      if (
        theirs.some(
          (item) =>
            item.skillId === skill.skillId || item.name.trim().toLowerCase() === skill.name.trim().toLowerCase(),
        )
      )
        continue;
      if (
        known.some((item) =>
          item.changes.some(
            (change) => change.type === "skill-copy" && change.skillId === skill.skillId && item.agentId === to.id,
          ),
        )
      )
        continue;
      const fromSpace = spaces.find((space) => space.id === hooks.agentSpace(from.id))?.name ?? "";
      items.push({
        kind: "cross-space",
        source: "dreaming",
        agentId: to.id,
        spaceId: hooks.agentSpace(to.id),
        title: cut(`${fromSpace}: ${from.name}'s "${skill.name}" could help ${to.name}`, LEARNING_LIMITS.title),
        note: cut(hooks.redact(suggestion.why), LEARNING_LIMITS.note),
        ref: null,
        changes: [{ type: "skill-copy", fromAgentId: from.id, skillId: skill.skillId, name: skill.name }],
        risk: "review",
      });
    }
    yield* this.#add(items);
  });

  readonly #add = Effect.fn("AgentLearning.add")(function* (this: AgentLearning, items: readonly NewItem[]) {
    if (items.length === 0) return [];
    const now = new Date().toISOString();
    // A memory item applies by itself; the owner keeps or reverts it from the inbox.
    const made: LearningReviewItem[] = items.map((item) => {
      const state =
        (item.state ?? "pending") === "pending" && item.kind === "memory"
          ? this.#autoApply(item)
            ? "auto-applied"
            : "stale"
          : (item.state ?? "pending");
      return {
        ...item,
        id: randomUUID(),
        state,
        createdAt: now,
        ...(state !== "pending" ? { decidedAt: now } : {}),
      };
    });
    yield* this.#store.update((stored) => {
      const all = [...made, ...stored.items];
      const pending = all.filter((item) => item.state === "pending");
      const decided = all.filter((item) => item.state !== "pending").slice(0, DECIDED_KEPT);
      return {
        ...stored,
        items: [...pending, ...decided].sort((left, right) => right.createdAt.localeCompare(left.createdAt)),
      };
    });
    return made;
  });

  readonly #settle = Effect.fn("AgentLearning.settle")(function* (
    this: AgentLearning,
    itemId: string,
    state: LearningReviewItem["state"],
  ) {
    const decidedAt = new Date().toISOString();
    const stored = yield* this.#store.update((current) => ({
      ...current,
      items: current.items.map((item) => (item.id === itemId ? { ...item, state, decidedAt } : item)),
    }));
    const item = stored.items.find((candidate) => candidate.id === itemId);
    if (!item) return yield* Effect.fail(new LearningRefused("The item does not exist any more."));
    return item;
  });

  /** Applies an accepted item. False when nothing of it could apply any more. */
  readonly #apply = Effect.fn("AgentLearning.apply")(function* (this: AgentLearning, item: LearningReviewItem) {
    const hooks = this.#hooks;
    const agentId = item.agentId;
    if (!agentId || !hooks.agents().some((agent) => agent.id === agentId)) return false;
    if (item.kind === "memory") return this.#applyMemory(agentId, item.changes);
    for (const change of item.changes) {
      if (change.type === "instructions-add") yield* hooks.addInstruction(agentId, change.text);
      else if (change.type === "playbook-add") yield* hooks.addPlaybookLesson(change.playbookId, change.text);
      else if (change.type === "skill-add") yield* hooks.addSkillLesson(agentId, change.skillId, change.text);
      else if (change.type === "skill-copy") yield* hooks.copySkill(change.skillId, agentId);
    }
    return true;
  });

  /** Applies memory changes when each memory still has the text the item read. */
  #applyMemory(agentId: string, changes: readonly LearningChange[]): boolean {
    const base = this.#hooks.memoryBase(agentId);
    const current = new Map(base.memories.map((entry) => [entry.memory.id, entry]));
    const operations: MemoryReviewOperation[] = [];
    for (const change of changes) {
      if (change.type !== "memory-update" && change.type !== "memory-forget") continue;
      const entry = current.get(change.memoryId);
      if (!entry || entry.memory.text !== change.before || entry.userControlled) continue;
      operations.push(
        change.type === "memory-update"
          ? { type: "update", memoryId: change.memoryId, text: change.after }
          : { type: "forget", memoryId: change.memoryId },
      );
    }
    if (operations.length === 0) return false;
    this.#hooks.applyMemory(agentId, base, operations, `${DREAM_TURN_PREFIX}${randomUUID()}`);
    return true;
  }

  /** Puts back what a memory item changed, where the memory still has the item's text. */
  #revertMemory(item: LearningReviewItem): boolean {
    const agentId = item.agentId;
    if (!agentId || !this.#hooks.agents().some((agent) => agent.id === agentId)) return false;
    const base = this.#hooks.memoryBase(agentId);
    const current = new Map(base.memories.map((entry) => [entry.memory.id, entry]));
    const operations: MemoryReviewOperation[] = [];
    for (const change of item.changes) {
      if (change.type === "memory-update") {
        const entry = current.get(change.memoryId);
        if (entry && entry.memory.text === change.after && !entry.userControlled)
          operations.push({ type: "update", memoryId: change.memoryId, text: change.before });
      } else if (change.type === "memory-forget" && !current.has(change.memoryId)) {
        operations.push({ type: "add", text: change.before, inclusion: "searchable" });
      }
    }
    if (operations.length === 0) return false;
    this.#hooks.applyMemory(agentId, base, operations, `${DREAM_TURN_PREFIX}${randomUUID()}`);
    return true;
  }

  /** Drops what is kept of an agent that was deleted. */
  readonly forgetAgent = Effect.fn("AgentLearning.forgetAgent")(function* (this: AgentLearning, agentId: string) {
    yield* this.#store.update((stored) => ({
      ...stored,
      items: stored.items.filter((item) => item.agentId !== agentId),
      dream: {
        ...stored.dream,
        cursors: Object.fromEntries(Object.entries(stored.dream.cursors).filter(([id]) => id !== agentId)),
        at: Object.fromEntries(Object.entries(stored.dream.at).filter(([id]) => id !== agentId)),
      },
      provenance: Object.fromEntries(
        Object.entries(stored.provenance).filter(([, entry]) => entry.agentId !== agentId),
      ),
    }));
  });
}
