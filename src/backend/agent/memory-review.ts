import { randomUUID } from "node:crypto";
import {
  type AgentModelOption,
  type AgentSummary,
  type ConversationMessage,
  isContextResetMarker,
  skillConversationEventItemType,
  type WorkspaceLearningSettings,
} from "@openbot/contracts/ipc";
import { createOpenBotLogger } from "@openbot/logging";
import { Effect, Exit, Fiber, Schema, Scope } from "effect";
import type { AgentClient } from "../agent-client";
import { extractJsonObject } from "../structured-output";
import type { AgentMemories } from "./agent-memories";
import { memoryChangesMessage } from "./memory-changes-message";
import {
  acceptedSuggestion,
  MemoryReviewResult,
  memoryReviewPrompt,
  type ReviewSkill,
  type SkillReviewInput,
  SkillReviewResult,
  type SkillReviewSuggestion,
} from "./memory-review-prompt";
import type { MemoryReviewState } from "./memory-review-state";
import type { ProfileClients } from "./profile-clients";
import { type GenerationObserver, GenerationUsageLimitError, generateTextWithoutTools } from "./profile-generation";
import {
  type LearnedSkillDraft,
  revisionKeepsSkill,
  type SkillLearner,
  SkillWriterResult,
  skillWriterPrompt,
  writerCanRevise,
} from "./skill-learning";

const logger = createOpenBotLogger("memory-review");

/** An agent is reviewed at most once in this time, whatever its turns. */
export const MEMORY_REVIEW_MIN_GAP_MS = 3 * 60 * 60_000;
/** A chat that stops for this long after a person wrote in it is reviewed once, before the interval. */
const MEMORY_REVIEW_IDLE_MS = 30 * 60_000;
/** The counted turns that a chat needs before a pause reviews it. */
const MEMORY_REVIEW_IDLE_TURNS = 5;
/** The most skills that the reviews make for one agent. Each one adds its description to every prompt. */
const LEARNED_SKILL_LIMIT = 5;
const REVIEW_TURN_PREFIX = "memory-review-";
/** The file of the review positions and counters, in the user data folder. */
export const MEMORY_REVIEW_STATE_FILE = "memory-review-state.json";
/** The chat messages that a review reads from the database when the chat is not loaded. */
export const MEMORY_REVIEW_MESSAGES = 200;

class MemoryReviewFailed extends Schema.TaggedError<MemoryReviewFailed>()("MemoryReviewFailed", {
  cause: Schema.Defect(),
}) {}

export interface MemoryReviewOptions {
  memories: Pick<AgentMemories, "reviewBase" | "applyReview">;
  profileClients: Pick<ProfileClients, "hasSpare" | "run">;
  state: MemoryReviewState;
  settings(): WorkspaceLearningSettings;
  listAgents(): AgentSummary[];
  /** The model of the review: the provider's smaller default model when it is listed, else the agent's own. */
  model(agent: AgentSummary): Effect.Effect<AgentModelOption | null, unknown>;
  createClient(agent: AgentSummary): AgentClient;
  usageObserver(agent: AgentSummary, model: AgentModelOption): GenerationObserver;
  /** The agent's own chat, without the turn that runs now. */
  chat(agentId: string): readonly ConversationMessage[];
  turnActive(agentId: string): boolean;
  appendSystemMessage(agentId: string, message: ConversationMessage): void;
  skills?(agentId: string): Effect.Effect<readonly ReviewSkill[], unknown>;
  skillLearner?: SkillLearner;
  redact(text: string): string;
  stopping(): boolean;
  now?(): number;
  /** Replaces the provider generation, for an end-to-end script without a provider. */
  generate?(agent: AgentSummary, model: AgentModelOption, prompt: string): Effect.Effect<string, unknown>;
}

/** What ended with a turn of an agent's own chat. */
export interface ReviewedTurn {
  /** A completed turn that is not a quiet routine run. */
  counts: boolean;
  /** A person wrote in it. */
  person: boolean;
}

interface ReviewedConversation {
  readonly agentId: string;
  turns: number;
  personTurns: number;
  heldLines: ConversationMessage[];
  timer: Fiber.Fiber<void> | null;
  waiting: boolean;
}

/**
 * Background memory reviews and skill learning of the agents' own chats (upstream 0.53.2 and 0.66,
 * cut down to keep the cost low on a fleet).
 *
 * - Only an agent's own chat, never a channel, task or routine session.
 * - Only after a person wrote in the chat: talk between agents and routine runs alone start none, so an
 *   agent that is idle or only works for other agents costs nothing.
 * - After `memoryReviewTurns` counted turns, or once after a pause of `MEMORY_REVIEW_IDLE_MS` when the
 *   chat had at least `MEMORY_REVIEW_IDLE_TURNS`. Each agent at most once in `MEMORY_REVIEW_MIN_GAP_MS`,
 *   and the server at most `dailyReviewLimit` times a day.
 * - One review at a time on the server, on the provider's smaller model, reading only the messages
 *   after the last review, within a fixed character budget.
 * - A lesson for a skill costs a second generation only when the review found one.
 */
export class MemoryReview {
  readonly #options: MemoryReviewOptions;
  readonly #conversations = new Map<string, ReviewedConversation>();
  #running: { agentId: string; fiber: Fiber.Fiber<void> } | null = null;
  #scope = Scope.makeUnsafe();

  constructor(options: MemoryReviewOptions) {
    this.#options = options;
  }

  #now(): number {
    return this.#options.now?.() ?? Date.now();
  }

  #off(): boolean {
    return this.#options.settings().memoryReviewTurns <= 0;
  }

  readonly turnEnded = Effect.fn("MemoryReview.turnEnded")(function* (
    this: MemoryReview,
    agentId: string,
    turn: ReviewedTurn,
  ) {
    const conversation = this.#conversation(agentId);
    yield* this.#stopTimer(conversation);
    this.#flush(conversation);
    if (this.#off()) return;
    if (turn.counts) conversation.turns += 1;
    if (turn.person) conversation.personTurns += 1;
    if (conversation.personTurns === 0) return;
    if (conversation.turns >= this.#options.settings().memoryReviewTurns) yield* this.#start(conversation);
    else if (conversation.turns >= MEMORY_REVIEW_IDLE_TURNS)
      yield* this.#startTimer(conversation, MEMORY_REVIEW_IDLE_MS);
    yield* this.#startWaiting();
  }).bind(this);

  readonly cancel = Effect.fn("MemoryReview.cancel")(function* (this: MemoryReview, agentId: string) {
    const conversation = this.#conversations.get(agentId);
    this.#conversations.delete(agentId);
    if (conversation) yield* this.#stopTimer(conversation);
    const running = this.#running;
    if (running?.agentId === agentId) yield* Fiber.interrupt(running.fiber);
    yield* this.#options.state.forgetAgent(agentId);
  }).bind(this);

  readonly dispose = Effect.fn("MemoryReview.dispose")(function* (this: MemoryReview) {
    yield* Scope.close(this.#scope, Exit.void);
    this.#scope = Scope.makeUnsafe();
    this.#running = null;
    this.#conversations.clear();
  }).bind(this);

  #conversation(agentId: string): ReviewedConversation {
    const known = this.#conversations.get(agentId);
    if (known) return known;
    const conversation: ReviewedConversation = {
      agentId,
      turns: 0,
      personTurns: 0,
      heldLines: [],
      timer: null,
      waiting: false,
    };
    this.#conversations.set(agentId, conversation);
    return conversation;
  }

  readonly #stopTimer = Effect.fn("MemoryReview.stopTimer")(function* (
    this: MemoryReview,
    conversation: ReviewedConversation,
  ) {
    const timer = conversation.timer;
    conversation.timer = null;
    if (timer) yield* Fiber.interrupt(timer);
  }).bind(this);

  readonly #startTimer = Effect.fn("MemoryReview.startTimer")(function* (
    this: MemoryReview,
    conversation: ReviewedConversation,
    delayMs: number,
  ) {
    if (this.#off() || this.#options.stopping()) return;
    yield* this.#stopTimer(conversation);
    conversation.timer = yield* Effect.sleep(delayMs).pipe(
      Effect.andThen(
        Effect.suspend(() => {
          conversation.timer = null;
          if (this.#conversations.get(conversation.agentId) !== conversation) return Effect.void;
          if (conversation.personTurns === 0 || conversation.turns === 0) return Effect.void;
          if (this.#options.turnActive(conversation.agentId)) return Effect.void;
          return this.#start(conversation);
        }),
      ),
      Effect.forkIn(this.#scope),
    );
  }).bind(this);

  readonly #start = Effect.fn("MemoryReview.start")(function* (
    this: MemoryReview,
    conversation: ReviewedConversation,
  ): Effect.fn.Return<void> {
    const options = this.#options;
    if (this.#off() || options.stopping()) return;
    yield* options.state.load();
    // The daily limit: the counters stay, so the first turn of the next day starts the review.
    if (options.state.reviewsToday() >= options.settings().dailyReviewLimit) return;
    const wait = options.state.agent(conversation.agentId).reviewedAt + MEMORY_REVIEW_MIN_GAP_MS - this.#now();
    if (wait > 0) {
      yield* this.#startTimer(conversation, wait);
      return;
    }
    if (this.#running || !options.profileClients.hasSpare()) {
      conversation.waiting = true;
      return;
    }
    conversation.waiting = false;
    const fiber = yield* this.#review(conversation).pipe(
      Effect.catch((failure) =>
        Effect.sync(() => {
          if (failure.cause instanceof GenerationUsageLimitError) return;
          logger.warn("Could not review the agent's memories.", { error: failure.cause });
        }),
      ),
      Effect.ensuring(
        Effect.suspend(() => {
          if (this.#running?.agentId === conversation.agentId) this.#running = null;
          return this.#startWaiting();
        }),
      ),
      Effect.forkIn(this.#scope),
    );
    this.#running = { agentId: conversation.agentId, fiber };
  }).bind(this);

  readonly #startWaiting = Effect.fn("MemoryReview.startWaiting")(function* (
    this: MemoryReview,
  ): Effect.fn.Return<void> {
    if (this.#running) return;
    for (const conversation of this.#conversations.values()) {
      if (!conversation.waiting) continue;
      yield* this.#start(conversation);
      return;
    }
  }).bind(this);

  readonly #review = Effect.fn("MemoryReview.review")(
    function* (this: MemoryReview, conversation: ReviewedConversation) {
      const options = this.#options;
      const { agentId } = conversation;
      const messages = yield* Effect.try(() => options.chat(agentId));
      const reviewed = options.state.agent(agentId);
      const excerpt = reviewExcerpt(messages, reviewed.cursor);
      const cursor = messages.at(-1)?.id ?? reviewed.cursor;
      conversation.turns = 0;
      conversation.personTurns = 0;
      if (!excerpt.some(isPersonMessage)) return yield* options.state.update(agentId, { cursor });
      const agent = options.listAgents().find((candidate) => candidate.id === agentId);
      if (!agent || options.stopping()) return;
      const model = yield* options.model(agent);
      if (!model) return yield* options.state.update(agentId, { cursor });
      // Counted before the generation, so a review that fails still uses its place in the day.
      yield* options.state.update(agentId, { cursor, reviewedAt: this.#now() }, true);
      const base = yield* Effect.try(() => options.memories.reviewBase(agentId));
      const redacted = base.memories.map((entry) => ({
        ...entry,
        memory: { ...entry.memory, text: options.redact(entry.memory.text) },
      }));
      // A review never changes a memory that it saw only redacted.
      const hidden = new Set(
        redacted
          .filter((entry, index) => entry.memory.text !== base.memories[index]?.memory.text)
          .map((entry) => entry.memory.id),
      );
      const skillInput = yield* this.#skillInput(agentId);
      const prompt = memoryReviewPrompt(
        agent,
        { ...base, memories: redacted },
        excerpt.map((message) => redactedMessage(message, options.redact)),
        skillInput ?? undefined,
      );
      const answer = yield* this.#generate(agent, model, prompt);
      const json = yield* Effect.try(() => extractJsonObject(answer));
      const result = yield* Schema.decodeUnknownEffect(MemoryReviewResult)(json);
      const operations = result.operations.filter(
        (operation) => operation.type === "add" || !hidden.has(operation.memoryId),
      );
      const suggestion = skillInput
        ? yield* Schema.decodeUnknownEffect(SkillReviewResult)(json).pipe(
            Effect.map(({ skill }) => acceptedSuggestion(skill, skillInput)),
            Effect.orElseSucceed(() => null),
          )
        : null;
      if (options.stopping()) return;
      if (operations.length === 0 && !suggestion) return;
      if (!options.listAgents().some((candidate) => candidate.id === agentId)) return;
      const turnId = `${REVIEW_TURN_PREFIX}${randomUUID()}`;
      const changes =
        operations.length === 0
          ? []
          : yield* Effect.try(() => options.memories.applyReview(agentId, base, operations, turnId));
      const learned = suggestion ? yield* this.#learn(agent, model, suggestion, excerpt, turnId) : null;
      const lines = [memoryChangesMessage(turnId, changes, options.redact), learned].filter(
        (line): line is ConversationMessage => line !== null,
      );
      if (options.turnActive(agentId)) conversation.heldLines.push(...lines);
      else for (const line of lines) yield* Effect.try(() => options.appendSystemMessage(agentId, line));
    },
    Effect.mapError((failure) => new MemoryReviewFailed({ cause: failure })),
  ).bind(this);

  #generate(agent: AgentSummary, model: AgentModelOption, prompt: string) {
    const options = this.#options;
    if (options.generate) return options.generate(agent, model, prompt);
    return Effect.gen(function* () {
      const client = yield* Effect.try(() => options.createClient(agent));
      return yield* options.profileClients.run(client, (cancelled) =>
        generateTextWithoutTools(client, model, prompt, cancelled, options.usageObserver(agent, model)),
      );
    });
  }

  #skillInput(agentId: string): Effect.Effect<SkillReviewInput | null> {
    const { skills, redact, skillLearner, state } = this.#options;
    if (!skills || !skillLearner || this.#options.settings().skillLearning !== "automatic") return Effect.succeed(null);
    return Effect.suspend(() => skills(agentId)).pipe(
      Effect.map(
        (list): SkillReviewInput => ({
          skills: list.map((skill) => ({
            skillId: skill.skillId,
            name: redact(skill.name),
            description: skill.description === undefined ? undefined : redact(skill.description),
          })),
          mayCreate: state.agent(agentId).learnedSkills < LEARNED_SKILL_LIMIT,
        }),
      ),
      Effect.catchCause((cause) =>
        Effect.sync(() => {
          logger.warn("Could not list the agent's skills for its memory review.", { error: cause });
          return null;
        }),
      ),
    );
  }

  #learn(
    agent: AgentSummary,
    model: AgentModelOption,
    suggestion: SkillReviewSuggestion,
    excerpt: readonly ConversationMessage[],
    turnId: string,
  ): Effect.Effect<ConversationMessage | null> {
    const options = this.#options;
    const learner = options.skillLearner;
    if (!learner) return Effect.succeed(null);
    const generate = (prompt: string) => this.#generate(agent, model, prompt);
    return Effect.gen(function* () {
      const skillId = suggestion.action === "update" ? suggestion.skillId : undefined;
      const current = skillId ? yield* learner.read(skillId) : undefined;
      const shown = current && {
        ...current,
        description: options.redact(current.description),
        instructions: options.redact(current.instructions),
      };
      if (shown && (shown.description !== current.description || shown.instructions !== current.instructions))
        return yield* Effect.fail(new Error("The skill holds redacted text, so the review does not rewrite it."));
      if (current && !writerCanRevise(current))
        return yield* Effect.fail(
          new Error("The skill is too long to write again, so the review does not rewrite it."),
        );
      if (!options.profileClients.hasSpare() || options.stopping()) return null;
      const answer = yield* generate(
        skillWriterPrompt(
          agent,
          suggestion,
          excerpt.map((message) => redactedMessage(message, options.redact)),
          shown,
        ),
      );
      const written = yield* Schema.decodeUnknownEffect(SkillWriterResult)(
        yield* Effect.try(() => extractJsonObject(answer)),
      );
      if (current && !revisionKeepsSkill(current, written.instructions))
        return yield* Effect.fail(
          new Error("The revision drops text or letters of the skill, so the review does not save it."),
        );
      if (options.stopping()) return null;
      const draft: LearnedSkillDraft =
        skillId && current
          ? {
              action: "update",
              skillId,
              expectedRevision: current.revision,
              description: options.redact(written.description),
              instructions: options.redact(written.instructions),
            }
          : {
              action: "create",
              name: options.redact(suggestion.name),
              description: options.redact(written.description),
              instructions: options.redact(written.instructions),
            };
      const event = yield* learner.save(agent.id, draft);
      if (event.action === "created")
        yield* options.state.update(agent.id, { learnedSkills: options.state.agent(agent.id).learnedSkills + 1 });
      const line: ConversationMessage = {
        id: `${turnId}:skill-${event.action}`,
        turnId,
        author: "system",
        source: "system",
        status: "completed",
        createdAt: new Date().toISOString(),
        itemType: skillConversationEventItemType(event),
        text: options.redact(event.skillName),
      };
      return line;
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.sync(() => {
          logger.warn("Could not save the skill that the memory review found.", { error: cause });
          return null;
        }),
      ),
    );
  }

  #flush(conversation: ReviewedConversation): void {
    const lines = conversation.heldLines;
    if (lines.length === 0 || this.#options.turnActive(conversation.agentId)) return;
    conversation.heldLines = [];
    for (const line of lines) {
      try {
        this.#options.appendSystemMessage(conversation.agentId, line);
      } catch (error) {
        logger.warn("Could not show the memory review's changes.", { error });
      }
    }
  }
}

/** A message that a person wrote, not a routine run or another agent. */
function isPersonMessage(message: ConversationMessage): boolean {
  return message.author === "user" && message.source !== "routine" && !message.senderAgentId;
}

function redactedMessage(message: ConversationMessage, redact: (text: string) => string): ConversationMessage {
  const trace = message.trace;
  return {
    ...message,
    text: redact(message.text),
    ...(trace
      ? {
          trace: {
            ...trace,
            steps: trace.steps.map((step) => ({
              ...step,
              ...(step.text === undefined ? {} : { text: redact(step.text) }),
              ...(step.command === undefined ? {} : { command: redact(step.command) }),
              ...(step.label === undefined ? {} : { label: redact(step.label) }),
            })),
          },
        }
      : {}),
  };
}

/** The messages after the cursor, or after the last clear of the chat, without a trailing clear. */
function reviewExcerpt(messages: readonly ConversationMessage[], cursor: string | null) {
  let end = messages.length;
  while (end > 0) {
    const message = messages[end - 1];
    if (!message || !isContextResetMarker(message)) break;
    end -= 1;
  }
  let start = 0;
  for (let index = end - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message && (message.id === cursor || isContextResetMarker(message))) {
      start = index + 1;
      break;
    }
  }
  return messages.slice(start, end);
}
