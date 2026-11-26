/**
 * The independent grader of Motion tickets. A ticket of a local agent that moves to review with no
 * reviewer of its own (`issue.review_requested` with no recipients), or that its agent marks Done
 * while it has acceptance criteria, is graded before it counts as done:
 *
 * - A fresh judge without tools and without the assignee's context reads the criteria, the hand-off
 *   and the evidence of the assignee's recent turns (`motion-review.ts`), on the cheap gate model, or
 *   for an important ticket (high priority, money) on the other vendor's model.
 * - The host then calls `issues_review` as the grader's own Motion member (an assignee cannot review
 *   its own ticket): pass moves it to Done, reopen sends it back with specific notes, and Motion's
 *   `issue.reviewed` event wakes the assignee with them.
 * - After `MAX_REVIEW_ROUNDS` reopenings, or when the judge gives no verdict twice, the ticket stays in
 *   review and goes to the owner as a Needs you item, with the notes on the ticket.
 *
 * - The owner's verdict on such a ticket (from Atelier), or the deciding manager's, replaces the
 *   grader's (`decide`): accept closes it in Motion at once as that person's member, with no further
 *   round, even when its agent marks it Done afterwards; send back reopens it with the note.
 *
 * The rounds of each ticket, and the tickets a person accepted, are kept in one small file, so a
 * restart does not reset them.
 */

import { readFile } from "node:fs/promises";
import type { ConversationMessage, TicketVerdict } from "@openbot/contracts/ipc";
import { type DynamicRecord, isDynamicRecord, isString } from "@openbot/contracts/runtime-values";
import { Effect } from "effect";
import { writeJsonFileAtomically } from "../../backend/atomic-json-file";
import type { MotionAnswer, MotionCaller } from "./motion-client";
import type { MotionEvent } from "./motion-event";
import type { WaitingTicket } from "./motion-events-service";
import {
  type DeliverableFile,
  deliverablePaths,
  EVIDENCE_WINDOW_MS,
  isImportantTicket,
  MAX_REVIEW_ROUNDS,
  parseReviewVerdict,
  type ReviewTicket,
  reviewEvidence,
  reviewPrompt,
  reviewTicket,
} from "./motion-review";
import { ticketOfToolCall } from "./motion-tickets";

const ROUNDS_MS = 30 * 86_400_000;
/** How long a person's acceptance keeps a ticket out of review. */
const ACCEPTED_MS = 7 * 86_400_000;
/** A status an agent sets that means done, in the languages the boards use. */
const DONE_STATUS =
  /^(done|hecho|terminad[oa]|completad[oa]|completed?|closed|cerrad[oa]|listo|finished|finalizad[oa]|resuelt[oa]|resolved)$/iu;

export interface MotionGraderAgent {
  id: string;
  name: string;
}

export interface MotionGraderDependencies {
  tool(caller: MotionCaller, name: string, args: DynamicRecord): Promise<MotionAnswer>;
  agents(): readonly MotionGraderAgent[];
  /** The assignee's recent chat, the evidence of its run. */
  evidence(agentId: string): readonly ConversationMessage[];
  /** The text of files in the assignee's workspace (a path outside it reads as not found). */
  readFiles?(agentId: string, paths: readonly string[]): Promise<readonly DeliverableFile[]>;
  /** One answer of the judge, and the model that gave it. */
  judge(input: { agentId: string; important: boolean; prompt: string }): Promise<{ text: string; model: string }>;
  /** Hands the ticket to the owner: a Needs you item with a push. */
  escalate(ticket: Omit<WaitingTicket, "createdAt" | "asks" | "reason">, body: string, reason?: string): void;
  /** A held note to the agent: it reads it with its next turn. */
  tell(agentId: string, text: string, clientMessageId: string): void;
  stateFile: string;
  log(message: string): void;
  now?: () => number;
}

interface Rounds {
  rounds: number;
  at: number;
}

/** A ticket that a person accepted as it is: its key, and when. */
interface Accepted {
  key: string;
  at: number;
}

function decodeAccepted(value: unknown): Record<string, Accepted> {
  const accepted = isDynamicRecord(value) && isDynamicRecord(value.accepted) ? value.accepted : {};
  const out: Record<string, Accepted> = {};
  for (const [id, entry] of Object.entries(accepted))
    if (isDynamicRecord(entry) && isString(entry.key) && typeof entry.at === "number")
      out[id] = { key: entry.key, at: entry.at };
  return out;
}

/** A person's verdict on a review that the grader handed over. */
export interface ReviewDecision {
  issueId: string;
  key: string;
  verdict: TicketVerdict;
  /** The person's words: they go on the ticket as the review notes. */
  notes: string;
}

function decodeRounds(value: unknown): Record<string, Rounds> {
  const rounds = isDynamicRecord(value) && isDynamicRecord(value.rounds) ? value.rounds : {};
  const out: Record<string, Rounds> = {};
  for (const [id, entry] of Object.entries(rounds))
    if (isDynamicRecord(entry) && typeof entry.rounds === "number" && typeof entry.at === "number")
      out[id] = { rounds: entry.rounds, at: entry.at };
  return out;
}

/**
 * What a review still misses, in one line: the items of its "Missing:" list, or else its notes. The
 * owner reads it on the escalated ticket.
 */
export function missingLine(notes: string): string {
  const lines = notes.split("\n").map((line) => line.trim());
  const start = lines.findIndex((line) => /^missing:?$/iu.test(line));
  const items =
    start < 0
      ? []
      : lines.slice(start + 1).flatMap((line) => (/^[-*•]\s+/u.test(line) ? [line.replace(/^[-*•]\s+/u, "")] : []));
  return items.length > 0 ? items.join("; ") : lines.filter(Boolean).join(" ");
}

export class MotionGrader {
  readonly #deps: MotionGraderDependencies;
  #rounds: Record<string, Rounds> = {};
  #accepted: Record<string, Accepted> = {};
  #loaded: Promise<void> | null = null;
  #chain: Promise<unknown> = Promise.resolve();
  readonly #inFlight = new Set<string>();

  constructor(deps: MotionGraderDependencies) {
    this.#deps = deps;
  }

  #now(): number {
    return this.#deps.now?.() ?? Date.now();
  }

  #load(): Promise<void> {
    this.#loaded ??= readFile(this.#deps.stateFile, "utf8")
      .then((text) => {
        this.#rounds = decodeRounds(JSON.parse(text));
        this.#accepted = decodeAccepted(JSON.parse(text));
      })
      .catch(() => undefined);
    return this.#loaded;
  }

  #save(): Promise<void> {
    const now = this.#now();
    this.#rounds = Object.fromEntries(Object.entries(this.#rounds).filter(([, entry]) => now - entry.at < ROUNDS_MS));
    this.#accepted = Object.fromEntries(
      Object.entries(this.#accepted).filter(([, entry]) => now - entry.at < ACCEPTED_MS),
    );
    // Grades run one at a time, so their saves do too.
    return Effect.runPromise(
      writeJsonFileAtomically(
        this.#deps.stateFile,
        { version: 1, rounds: this.#rounds, accepted: this.#accepted },
        { createDirectory: true },
      ),
    ).catch(() => this.#deps.log("Could not save the grader's review rounds."));
  }

  /** Whether a person accepted this ticket as it is: no review round starts for it. */
  #isAccepted(issueId: string | null, key: string): boolean {
    return Object.entries(this.#accepted).some(([id, entry]) => id === issueId || (key !== "" && entry.key === key));
  }

  /**
   * A person's verdict on a review that the grader handed over: the owner's answer from Atelier, or
   * the deciding manager's. It replaces the grader's verdict in Motion (`issues_review` with
   * `override`), as the caller's own member: accept moves the ticket to Done whatever its status,
   * and no review round follows; send back reopens it with the notes, and the grader grades the next
   * hand-off once before it comes back to a person. Throws when Motion refuses it.
   */
  async decide(caller: MotionCaller, decision: ReviewDecision): Promise<void> {
    await this.#load();
    const accept = decision.verdict === "accept";
    // Marked before Motion answers: an agent that closes the ticket meanwhile does not send it back to review.
    if (accept) {
      this.#accepted[decision.issueId] = { key: decision.key, at: this.#now() };
      delete this.#rounds[decision.issueId];
    } else {
      delete this.#accepted[decision.issueId];
      this.#rounds[decision.issueId] = { rounds: MAX_REVIEW_ROUNDS - 1, at: this.#now() };
    }
    await this.#save();
    await this.#deps.tool(caller, "issues_review", {
      issue: decision.issueId,
      verdict: accept ? "pass" : "reopen",
      notes: decision.notes,
      override: true,
    });
    this.#deps.log(`A person's verdict on ${decision.key}: ${accept ? "accepted as it is" : "sent back"}.`);
  }

  /** Grades a ticket that went to review with no reviewer. Grades run one at a time. */
  grade(event: MotionEvent): Promise<void> {
    if (this.#inFlight.has(event.issue.id)) return Promise.resolve();
    this.#inFlight.add(event.issue.id);
    const run = this.#chain
      .then(() => this.#grade(event))
      .catch((error: unknown) =>
        this.#deps.log(`The grader failed on ${event.issue.key}: ${error instanceof Error ? error.message : "failed"}`),
      )
      .finally(() => this.#inFlight.delete(event.issue.id));
    this.#chain = run;
    return run;
  }

  /**
   * A Motion tool call of an agent, after it answered: a ticket with acceptance criteria that its
   * agent moved to Done goes to review instead, so the grader (or its reviewer) checks it first.
   */
  observeToolCall(agentId: string, tool: string, args: unknown): void {
    const name = tool.replace(/^.*__/u, "");
    if (name !== "issues_update" && name !== "rows_update") return;
    if (!isDynamicRecord(args)) return;
    const status = isString(args.status)
      ? args.status
      : isDynamicRecord(args.values) && isString(args.values.status)
        ? args.values.status
        : null;
    if (!status || !DONE_STATUS.test(status.trim())) return;
    const reference = ticketOfToolCall(name === "rows_update" ? "issues_update" : name, args);
    if (!reference) return;
    void this.#backToReview(agentId, reference).catch((error: unknown) =>
      this.#deps.log(`Could not send ${reference} to review: ${error instanceof Error ? error.message : "failed"}`),
    );
  }

  async #backToReview(agentId: string, reference: string): Promise<void> {
    await this.#load();
    const row = await this.#deps.tool({ agentId }, "rows_get", { id: reference });
    const ticket = reviewTicket(row, { key: reference, title: "", url: "" });
    if (!ticket.criteria?.trim()) return;
    // A person accepted it as it is: Done stays Done.
    const rowId = isDynamicRecord(row) && isString(row.id) ? row.id : null;
    if (this.#isAccepted(rowId, ticket.key)) return;
    if (ticket.status && !DONE_STATUS.test(ticket.status.trim())) return;
    await this.#deps.tool({ agentId }, "issues_request_review", {
      issue: ticket.key,
      handoff:
        ticket.handoff ??
        "Marked done by its assignee without a hand-off. Moved to review because the issue has acceptance criteria.",
    });
    this.#deps.tell(
      agentId,
      `Motion · ${ticket.key} “${ticket.title}” has acceptance criteria, so it went to review instead of Done. A grader checks it now and you hear the verdict. Next time call issues_request_review with a hand-off.`,
      `motion-review-redirect:${ticket.key}:${this.#now()}`,
    );
  }

  #escalate(ticket: Omit<WaitingTicket, "createdAt" | "asks" | "reason">, body: string, reason?: string): void {
    this.#deps.log(`The grader handed ${ticket.key} to the owner: ${body}`);
    this.#deps.escalate(ticket, body, reason);
  }

  async #grade(event: MotionEvent): Promise<void> {
    await this.#load();
    const agents = this.#deps.agents();
    const assignee = event.issue.assignees
      .map((person) =>
        person.kind === "agent" && person.agentKey ? agents.find((agent) => agent.id === person.agentKey) : undefined,
      )
      .find((agent) => agent !== undefined);
    if (!assignee) return;
    const grader: MotionCaller = { agentId: assignee.id, asGrader: true };
    const reference = event.issue.key || event.issue.id;
    const fallback = { key: event.issue.key, title: event.issue.title, url: event.issue.url };
    const row = await this.#deps.tool(grader, "rows_get", { id: reference }).catch(() => null);
    const read = reviewTicket(row, fallback);
    const ticket: ReviewTicket = {
      ...read,
      criteria: read.criteria ?? event.criteria,
      handoff: read.handoff ?? event.handoff,
    };
    if (this.#isAccepted(event.issue.id, ticket.key)) {
      // A person accepted it as it is, and it came back to review: it passes on their decision.
      await this.#deps.tool(grader, "issues_review", {
        issue: reference,
        verdict: "pass",
        notes: "Accepted as it is by a person's decision: no more review rounds.",
        override: true,
      });
      this.#deps.log(`Passed ${ticket.key} on a person's earlier acceptance.`);
      return;
    }
    const previous = this.#rounds[event.issue.id]?.rounds ?? 0;
    const round = previous + 1;
    const waiting = {
      issueId: event.issue.id,
      agentId: assignee.id,
      key: ticket.key,
      title: ticket.title,
      url: ticket.url,
    };
    if (round > MAX_REVIEW_ROUNDS) {
      this.#escalate(waiting, `${ticket.key} failed review ${MAX_REVIEW_ROUNDS} times. It waits for your call.`);
      return;
    }
    const important = isImportantTicket(ticket);
    const since = this.#now() - EVIDENCE_WINDOW_MS;
    const messages = this.#deps.evidence(assignee.id);
    const paths = deliverablePaths(messages, since, ticket);
    const files =
      paths.length && this.#deps.readFiles
        ? await this.#deps.readFiles(assignee.id, paths).catch((): readonly DeliverableFile[] => [])
        : [];
    const prompt = reviewPrompt({
      ticket,
      assignee: assignee.name,
      evidence: reviewEvidence(messages, since, files),
      round,
    });
    let answer = await this.#deps.judge({ agentId: assignee.id, important, prompt });
    let verdict = parseReviewVerdict(answer.text);
    if (!verdict) {
      answer = await this.#deps.judge({ agentId: assignee.id, important, prompt });
      verdict = parseReviewVerdict(answer.text);
    }
    if (!verdict) {
      this.#escalate(waiting, `The grader could not grade ${ticket.key}. It waits in review for you.`);
      return;
    }
    const signed = `${verdict.notes}\n\n(Independent grader, ${answer.model}, round ${round} of ${MAX_REVIEW_ROUNDS}.)`;
    if (verdict.verdict === "reopen" && round >= MAX_REVIEW_ROUNDS) {
      // The last round: the owner decides instead of another round. The notes go on the ticket.
      await this.#deps
        .tool(grader, "comments_create", {
          page_id: event.issue.id,
          body: `Review round ${round}: not yet.\n\n${signed}`,
        })
        .catch(() => undefined);
      this.#rounds[event.issue.id] = { rounds: round, at: this.#now() };
      await this.#save();
      this.#escalate(
        waiting,
        `${ticket.key} still misses its criteria after ${MAX_REVIEW_ROUNDS} reviews. It waits for your call.`,
        missingLine(verdict.notes),
      );
      return;
    }
    await this.#deps.tool(grader, "issues_review", { issue: reference, verdict: verdict.verdict, notes: signed });
    if (verdict.verdict === "pass") delete this.#rounds[event.issue.id];
    else this.#rounds[event.issue.id] = { rounds: round, at: this.#now() };
    await this.#save();
    this.#deps.log(`Graded ${ticket.key}: ${verdict.verdict} (round ${round}, ${answer.model}).`);
  }
}
