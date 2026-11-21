/**
 * The Motion ticket each agent works on now. An agent takes up a ticket when its turn calls a Motion
 * tool on it (`issues_update`, `comments_create`, `worklogs_log`, `rows_update`), or says so itself
 * with `issues_start`. The host then calls Motion's `issues.start` as that agent, with a link to its
 * chat: a To do ticket moves to In progress, and the ticket page shows "Agent X is working on this".
 * The fleet card, the org chart card and the DM header show the ticket.
 *
 * Calls go through the agent's own filled `motion` MCP row (its token and agent headers), so Motion
 * sees the agent act. A ticket that is done, or that the agent stopped (`issues_stop`), clears; a
 * ticket not touched for a day no longer shows.
 */

import { readFile } from "node:fs/promises";
import type { WorkspaceFleetTicket } from "@openbot/contracts/ipc";
import { isDynamicRecord, isString } from "@openbot/contracts/runtime-values";
import { Effect } from "effect";
import { writeJsonFileAtomically } from "../../backend/atomic-json-file";

const STALE_MS = 24 * 3_600_000;
/** The same ticket is not started again within this time. */
const RESTART_MS = 30 * 60_000;
const ISSUE_KEY = /^[A-Z][A-Z0-9]{0,15}-\d{1,9}$/u;
const ROW_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
/** Tools that work on a ticket, and whether a row id (not only a key) names one there. */
const WORK_TOOLS: Record<string, boolean> = {
  issues_start: true,
  issues_update: true,
  worklogs_log: true,
  comments_create: false,
  rows_update: false,
};

export interface MotionTicket extends WorkspaceFleetTicket {
  since: number;
}

/** The body of Motion's `issues.start`. */
export interface MotionStartInput {
  issue: string;
  chat_url?: string;
}

export interface MotionTicketsDependencies {
  /** Calls Motion's `issues.start` as the agent and answers its parsed JSON; rejects on a failure. */
  call(agentId: string, operation: "issues.start", body: MotionStartInput): Promise<unknown>;
  /** The web address of the agent's chat, for the ticket page. */
  chatUrl(agentId: string): string | null;
  /** The tickets changed: the fleet reads them again. */
  changed(): void;
  stateFile: string;
  log(message: string): void;
  now?: () => number;
}

/** The ticket a Motion tool call names, or null. */
export function ticketOfToolCall(tool: string, args: unknown): string | null {
  const name = tool.replace(/^.*__/u, "");
  if (!(name in WORK_TOOLS) || !isDynamicRecord(args)) return null;
  for (const field of ["issue", "id", "page_id"]) {
    const value = args[field];
    if (!isString(value)) continue;
    const reference = value.trim();
    if (ISSUE_KEY.test(reference.toUpperCase())) return reference.toUpperCase();
    if (WORK_TOOLS[name] && ROW_ID.test(reference)) return reference;
  }
  return null;
}

function decodeTickets(value: unknown): Map<string, MotionTicket> {
  const tickets = new Map<string, MotionTicket>();
  if (!isDynamicRecord(value) || value.version !== 1 || !isDynamicRecord(value.tickets)) return tickets;
  for (const [agentId, entry] of Object.entries(value.tickets)) {
    if (
      isDynamicRecord(entry) &&
      isString(entry.key) &&
      isString(entry.title) &&
      isString(entry.url) &&
      typeof entry.since === "number"
    )
      tickets.set(agentId, { key: entry.key, title: entry.title, url: entry.url, since: entry.since });
  }
  return tickets;
}

export class MotionTickets {
  readonly #deps: MotionTicketsDependencies;
  #tickets = new Map<string, MotionTicket>();
  /** The reference last started for each agent, and when, so a busy turn calls Motion once. */
  readonly #started = new Map<string, { reference: string; at: number }>();

  constructor(deps: MotionTicketsDependencies) {
    this.#deps = deps;
  }

  #now(): number {
    return this.#deps.now?.() ?? Date.now();
  }

  async load(): Promise<void> {
    this.#tickets = await readFile(this.#deps.stateFile, "utf8")
      .then((text) => decodeTickets(JSON.parse(text)))
      .catch(() => new Map<string, MotionTicket>());
  }

  /** The ticket the agent works on now, or null. */
  current(agentId: string): WorkspaceFleetTicket | null {
    const ticket = this.#tickets.get(agentId);
    if (!ticket || this.#now() - ticket.since > STALE_MS) return null;
    return { key: ticket.key, title: ticket.title, url: ticket.url };
  }

  /** A Motion tool call of an agent's turn, after it answered. */
  observeToolCall(agentId: string, tool: string, args: unknown): void {
    const name = tool.replace(/^.*__/u, "");
    if (name === "issues_stop") {
      const reference = isDynamicRecord(args) && isString(args.issue) ? args.issue.trim().toUpperCase() : null;
      if (reference && this.#tickets.get(agentId)?.key === reference) this.#set(agentId, null);
      return;
    }
    const reference = ticketOfToolCall(tool, args);
    if (!reference) return;
    const last = this.#started.get(agentId);
    const now = this.#now();
    if (last?.reference === reference && now - last.at < RESTART_MS) return;
    this.#started.set(agentId, { reference, at: now });
    void this.#start(agentId, reference).catch((error: unknown) => {
      this.#started.delete(agentId);
      this.#deps.log(`Motion issues.start for ${agentId} failed: ${error instanceof Error ? error.message : "failed"}`);
    });
  }

  /** The ticket is done or the agent left it: it is nobody's current ticket any more. */
  settle(key: string, agentId?: string): void {
    for (const [owner, ticket] of this.#tickets)
      if (ticket.key === key && (agentId === undefined || owner === agentId)) this.#set(owner, null);
  }

  async #start(agentId: string, reference: string): Promise<void> {
    const chatUrl = this.#deps.chatUrl(agentId);
    const answer = await this.#deps.call(agentId, "issues.start", {
      issue: reference,
      ...(chatUrl ? { chat_url: chatUrl } : {}),
    });
    if (!isDynamicRecord(answer) || !isString(answer.url)) return;
    const key = isString(answer.key) ? answer.key : reference;
    if (answer.started !== true) {
      this.settle(key, agentId);
      return;
    }
    const title = isString(answer.title) ? answer.title.slice(0, 240) : "";
    this.#set(agentId, { key, title, url: answer.url, since: this.#now() });
  }

  #set(agentId: string, ticket: MotionTicket | null): void {
    if (ticket) this.#tickets.set(agentId, ticket);
    else if (!this.#tickets.delete(agentId)) return;
    this.#deps.changed();
    const tickets = Object.fromEntries(this.#tickets);
    void Effect.runPromise(
      writeJsonFileAtomically(this.#deps.stateFile, { version: 1, tickets }, { createDirectory: true }),
    ).catch(() => this.#deps.log("Could not save the Motion tickets."));
  }
}
