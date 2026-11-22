import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  type DecideReviewProposalInput,
  isPerformanceScorecard,
  PERFORMANCE_GRADES,
  type PerformanceGrade,
  type PerformanceReview,
  type PerformanceReviewsInput,
  type PerformanceScorecard,
  REVIEW_PROPOSAL_LIMIT,
  REVIEW_SUMMARY_LIMIT,
} from "@openbot/contracts/agent-efficiency";
import type { AgentSummary } from "@openbot/contracts/ipc";
import { isDynamicRecord, isNumber, isOneOf, isString } from "@openbot/contracts/runtime-values";
import { createOpenBotLogger } from "@openbot/logging";
import { Effect } from "effect";
import { modelTier } from "../agent/model-policy";
import {
  databaseRows,
  optionalNumberColumn,
  optionalStringColumn,
  requiredStringColumn,
} from "../database/database-rows";
import { extractJsonObject } from "../structured-output";
import { JsonStore } from "./json-store";

const logger = createOpenBotLogger("performance-reviews");

/** The file of the reviews, in the user data folder. */
export const PERFORMANCE_REVIEWS_FILE = "agent-reviews-v1.json";
const WEEK_MS = 7 * 24 * 60 * 60_000;
/** How often the scheduler looks for an agent that is due. */
const CHECK_INTERVAL_MS = 60 * 60_000;
/** The most reviews in one check, so a server with many agents spreads them over the hours. */
const REVIEWS_PER_CHECK = 4;
/** The reviews kept for each agent, newest first. */
const REVIEWS_KEPT = 12;
/** The person messages that a review quotes, each cut to `QUOTE_LIMIT`. */
const QUOTES = 16;
const QUOTE_LIMIT = 280;
const INSTRUCTIONS_LIMIT = 2_400;

const PRAISE =
  /\b(gracias|perfecto|genial|excelente|bien hecho|buen trabajo|me gusta|aprobado|thanks|thank you|great|perfect|good job|love it|approved)\b|👍|🙌|❤️/iu;
const COMPLAINT =
  /\b(mal|aburrido|no me gusta|rehaz|rehacer|otra vez|de nuevo|incorrecto|equivocad[oa]|no funciona|falla|error|wrong|redo|again|not what|doesn'?t work|broken|bad)\b|👎/iu;
const TICKET_DONE =
  /\b([A-Z]{2,6}-\d{1,5})\b[^\n]{0,60}\b(hecho|hecha|terminad[oa]|cerrad[oa]|done|closed|completad[oa])\b/u;
const TICKET_REOPENED = /\b([A-Z]{2,6}-\d{1,5})\b[^\n]{0,60}\b(reabiert[oa]|reabr|reopen)/iu;

interface StoredReviews {
  version: 1;
  /** Off: no weekly review runs; a person can still run one. */
  enabled: boolean;
  reviews: PerformanceReview[];
}

const EMPTY: StoredReviews = { version: 1, enabled: true, reviews: [] };

function isReview(value: unknown): value is PerformanceReview {
  return (
    isDynamicRecord(value) &&
    isString(value.id) &&
    isString(value.agentId) &&
    isString(value.periodStart) &&
    isString(value.periodEnd) &&
    isOneOf(PERFORMANCE_GRADES, value.grade) &&
    isPerformanceScorecard(value.scorecard) &&
    isString(value.summary) &&
    (value.proposal === null ||
      (isDynamicRecord(value.proposal) &&
        isString(value.proposal.text) &&
        isOneOf(["pending", "approved", "dismissed"] as const, value.proposal.state))) &&
    (value.reviewCostUsd === null || isNumber(value.reviewCostUsd)) &&
    isString(value.createdAt)
  );
}

function decodeStored(value: unknown): StoredReviews | null {
  if (!isDynamicRecord(value) || value.version !== 1) return null;
  return {
    version: 1,
    enabled: value.enabled !== false,
    reviews: Array.isArray(value.reviews) ? value.reviews.filter(isReview) : [],
  };
}

/** What a review reads of one agent's week, all from this host's records. */
interface WeekRecords {
  scorecard: PerformanceScorecard;
  quotes: string[];
  errors: string[];
}

/** The week of one agent from the mailbox and the usage records. */
export function readWeek(db: DatabaseSync, agentId: string, since: string, auto: boolean): WeekRecords {
  const rawRows = db
    .prepare(
      `SELECT d.status AS status, d.error AS error, m.sender_kind AS sender_kind, m.text AS text
         FROM projection_deliveries d JOIN projection_mailbox_messages m ON m.message_id = d.message_id
        WHERE d.recipient_agent_id = ? AND d.created_at >= ?
        ORDER BY d.created_at`,
    )
    .all(agentId, since);
  const rows = databaseRows(rawRows).map((row) => ({
    status: requiredStringColumn(row, "status"),
    error: optionalStringColumn(row, "error"),
    sender_kind: requiredStringColumn(row, "sender_kind"),
    text: requiredStringColumn(row, "text"),
  }));
  const turns = rows.length;
  const failed = rows.filter((row) => row.status === "failed");
  const people = rows.filter((row) => row.sender_kind === "user").map((row) => row.text);
  const praise = people.filter((text) => PRAISE.test(text)).length;
  const complaints = people.filter((text) => COMPLAINT.test(text)).length;
  const done = new Set<string>();
  const reopened = new Set<string>();
  for (const row of rows) {
    const doneMatch = TICKET_DONE.exec(row.text);
    if (doneMatch?.[1]) done.add(doneMatch[1]);
    const reopenMatch = TICKET_REOPENED.exec(row.text);
    if (reopenMatch?.[1]) reopened.add(reopenMatch[1]);
  }
  const rawUsage = db
    .prepare(
      `SELECT model, turn_id, session_id, estimated_cost_usd FROM agent_usage_records
        WHERE agent_id = ? AND occurred_at >= ?`,
    )
    .all(agentId, since);
  const usage = databaseRows(rawUsage).map((row) => ({
    model: requiredStringColumn(row, "model"),
    turn_id: requiredStringColumn(row, "turn_id"),
    session_id: requiredStringColumn(row, "session_id"),
    estimated_cost_usd: optionalNumberColumn(row, "estimated_cost_usd"),
  }));
  const costUsd = usage.reduce((total, row) => total + (row.estimated_cost_usd ?? 0), 0);
  // The turns of the agent's own work, without its background reviews, gates and condensing.
  const work = new Map<string, string>();
  for (const row of usage) {
    if (/^(gate|condense|memory-review|profile|side|grader|fanout):/u.test(row.session_id)) continue;
    const previous = work.get(row.turn_id);
    if (!previous || modelTier(previous) === "small") work.set(row.turn_id, row.model);
  }
  const small = [...work.values()].filter((model) => modelTier(model) === "small").length;
  return {
    scorecard: {
      turns,
      failedTurns: failed.length,
      ticketsDone: done.size,
      ticketsReopened: reopened.size,
      praise,
      complaints,
      costUsd: Math.round(costUsd * 100) / 100,
      smallModelShare: auto && work.size > 0 ? Math.round((small / work.size) * 100) / 100 : null,
    },
    quotes: people.slice(-QUOTES).map((text) => text.replace(/\s+/gu, " ").trim().slice(0, QUOTE_LIMIT)),
    errors: failed.slice(-5).map((row) => (row.error ?? "").replace(/\s+/gu, " ").slice(0, 200)),
  };
}

/** The prompt of one review. The answer is one JSON object. */
export function reviewPrompt(agent: AgentSummary, week: WeekRecords): string {
  return [
    "You review the last 7 days of one AI agent of a small company, for its owner. Be fair, short and concrete.",
    "Answer with one JSON object and nothing else:",
    '{"grade": "great" | "good" | "watch" | "poor", "summary": "two or three short sentences in the language of the agent\'s instructions: what went well, what did not", "proposal": null or "one or two sentences to add to the agent\'s instructions"}',
    "Give a proposal only when the week shows a clear, repeated problem that one instruction would fix, such as the same complaint twice or the same failure. Otherwise null. Never propose to change its role, its tools or its budget.",
    "",
    `Agent: ${agent.name}${agent.title ? ` (${agent.title})` : ""}`,
    `Instructions: ${agent.description.slice(0, INSTRUCTIONS_LIMIT)}`,
    `Week: ${JSON.stringify(week.scorecard)}`,
    week.errors.length > 0 ? `Failed turns: ${week.errors.join(" | ")}` : "Failed turns: none",
    week.quotes.length > 0
      ? `What people wrote to it:\n${week.quotes.map((quote) => `- ${quote}`).join("\n")}`
      : "People wrote nothing to it.",
  ].join("\n");
}

function decodeAnswer(answer: string): { grade: PerformanceGrade; summary: string; proposal: string | null } {
  const json = extractJsonObject(answer);
  const grade = isOneOf(PERFORMANCE_GRADES, json.grade) ? json.grade : "good";
  const summary = isString(json.summary) ? json.summary.trim().slice(0, REVIEW_SUMMARY_LIMIT) : "";
  if (!summary) throw new Error("The review has no summary.");
  const proposal =
    isString(json.proposal) && json.proposal.trim() ? json.proposal.trim().slice(0, REVIEW_PROPOSAL_LIMIT) : null;
  return { grade, summary, proposal };
}

export interface PerformanceReviewsOptions {
  path: string;
  database(): DatabaseSync;
  agents(): readonly AgentSummary[];
  /** Runs the prompt on the agent's small model, and answers the text and its cost. Null: no model. */
  generate(agent: AgentSummary, prompt: string): Effect.Effect<{ text: string; costUsd: number | null } | null>;
  /** Adds the approved text to the agent's instructions. */
  applyInstruction(agentId: string, text: string): Effect.Effect<void, { readonly cause: unknown }>;
  running(): boolean;
}

/**
 * The weekly performance review of each agent. The counts come from this host's records with no
 * model call; one short pass of the small model then writes the summary and, when the week shows a
 * pattern, an instruction for the owner to approve. A review never changes an agent by itself. An
 * agent with no work that week, a hidden one and a sleeping one get no review and cost nothing.
 */
export class PerformanceReviews {
  readonly #options: PerformanceReviewsOptions;
  readonly #store: JsonStore<StoredReviews>;
  #timer: ReturnType<typeof setInterval> | null = null;
  #checking = false;

  constructor(options: PerformanceReviewsOptions) {
    this.#options = options;
    this.#store = new JsonStore(options.path, EMPTY, decodeStored);
  }

  start(): void {
    if (this.#timer !== null) return;
    this.#timer = setInterval(() => Effect.runFork(this.checkDue()), CHECK_INTERVAL_MS);
    this.#timer.unref?.();
  }

  dispose(): void {
    if (this.#timer !== null) clearInterval(this.#timer);
    this.#timer = null;
  }

  readonly list = Effect.fn("PerformanceReviews.list")(function* (
    this: PerformanceReviews,
    input: PerformanceReviewsInput,
  ) {
    const stored = yield* this.#store.load();
    const known = new Set(this.#options.agents().map((agent) => agent.id));
    let reviews = stored.reviews.filter((review) => known.has(review.agentId));
    if (input.agentId) reviews = reviews.filter((review) => review.agentId === input.agentId);
    else {
      const seen = new Set<string>();
      reviews = reviews.filter((review) => !seen.has(review.agentId) && Boolean(seen.add(review.agentId)));
    }
    if (input.pendingOnly) reviews = reviews.filter((review) => review.proposal?.state === "pending");
    return { reviews: reviews.slice(0, 500), enabled: stored.enabled };
  });

  readonly setEnabled = Effect.fn("PerformanceReviews.setEnabled")(function* (
    this: PerformanceReviews,
    enabled: boolean,
  ) {
    yield* this.#store.update((stored) => ({ ...stored, enabled }));
  });

  /** Reviews the agents whose last review is a week old and that worked that week. */
  readonly checkDue = Effect.fn("PerformanceReviews.checkDue")(function* (this: PerformanceReviews) {
    if (this.#checking || !this.#options.running()) return;
    this.#checking = true;
    yield* Effect.gen({ self: this }, function* () {
      const stored = yield* this.#store.load();
      if (!stored.enabled) return;
      const now = Date.now();
      const last = new Map<string, number>();
      for (const review of stored.reviews)
        last.set(review.agentId, Math.max(last.get(review.agentId) ?? 0, Date.parse(review.createdAt)));
      const due = this.#options
        .agents()
        .filter(
          (agent) =>
            agent.hiddenAt === undefined &&
            agent.sleepingSince === undefined &&
            now - (last.get(agent.id) ?? 0) >= WEEK_MS &&
            // A new agent waits for its first full week.
            (agent.createdBy?.at === undefined || now - Date.parse(agent.createdBy.at) >= WEEK_MS),
        )
        .slice(0, REVIEWS_PER_CHECK * 3);
      let done = 0;
      for (const agent of due) {
        if (done >= REVIEWS_PER_CHECK || !this.#options.running()) break;
        const review = yield* this.run(agent.id).pipe(
          Effect.catchCause((cause) =>
            Effect.sync(() => {
              logger.warn("A weekly review failed.", { agentId: agent.id, error: cause });
              return null;
            }),
          ),
        );
        if (review) done += 1;
      }
    }).pipe(Effect.ensuring(Effect.sync(() => (this.#checking = false))));
  });

  /** Reviews the agent's last seven days now. Null when it did no work in them. */
  readonly run = Effect.fn("PerformanceReviews.run")(function* (this: PerformanceReviews, agentId: string) {
    const agent = this.#options.agents().find((candidate) => candidate.id === agentId);
    if (!agent) throw new Error("The agent does not exist.");
    const end = new Date();
    const start = new Date(end.getTime() - WEEK_MS);
    const week = readWeek(this.#options.database(), agentId, start.toISOString(), agent.modelPolicy === "auto");
    if (week.scorecard.turns === 0) return null;
    const generated = yield* this.#options.generate(agent, reviewPrompt(agent, week));
    if (!generated) return null;
    const answer = decodeAnswer(generated.text);
    const review: PerformanceReview = {
      id: randomUUID(),
      agentId,
      periodStart: start.toISOString(),
      periodEnd: end.toISOString(),
      grade: answer.grade,
      scorecard: week.scorecard,
      summary: answer.summary,
      proposal: answer.proposal ? { text: answer.proposal, state: "pending" } : null,
      reviewCostUsd: generated.costUsd,
      createdAt: end.toISOString(),
    };
    yield* this.#store.update((stored) => {
      const mine = [review, ...stored.reviews.filter((item) => item.agentId === agentId)].slice(0, REVIEWS_KEPT);
      return { ...stored, reviews: [...mine, ...stored.reviews.filter((item) => item.agentId !== agentId)] };
    });
    return review;
  });

  readonly decide = Effect.fn("PerformanceReviews.decide")(function* (
    this: PerformanceReviews,
    input: DecideReviewProposalInput,
  ) {
    const stored = yield* this.#store.load();
    const review = stored.reviews.find((candidate) => candidate.id === input.reviewId);
    if (review?.proposal?.state !== "pending" || !review.proposal)
      throw new Error("The proposal does not wait any more.");
    const text = input.text ?? review.proposal.text;
    if (input.decision === "approve") yield* this.#options.applyInstruction(review.agentId, text);
    const decided: PerformanceReview = {
      ...review,
      proposal: {
        text,
        state: input.decision === "approve" ? "approved" : "dismissed",
        decidedAt: new Date().toISOString(),
      },
    };
    yield* this.#store.update((current) => ({
      ...current,
      reviews: current.reviews.map((candidate) => (candidate.id === review.id ? decided : candidate)),
    }));
    return { review: decided };
  });
}
