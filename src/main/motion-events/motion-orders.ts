/**
 * Orders between agents as Motion cards, so an order cannot stall in silence.
 *
 * - `send_message` with `card` (`order-tools.ts`) makes the card here, as the sender: assigned to the
 *   recipient, with the sender's dedupe key and acceptance criteria. The message itself wakes the
 *   recipient, so the `issue.assigned` event that follows is held instead of waking it twice.
 * - Each order card is watched. Progress is the assignee's own Motion calls on the card; a card in
 *   review is not stalled. After `ORDER_STALL_HOURS` without progress the assignee gets a nudge that
 *   wakes it; after as many hours more, the agent who gave the order (else the assignee's manager)
 *   gets a note to check in. A card that is done, or that the assignee was taken off, is forgotten.
 *
 * The watched cards are kept in one small file, so a restart forgets nothing.
 */

import { readFile } from "node:fs/promises";
import { agentManagers } from "@openbot/contracts/agent-org";
import { type DynamicRecord, isDynamicRecord, isString } from "@openbot/contracts/runtime-values";
import { Effect } from "effect";
import type { OrderCard, OrderCardsPort } from "../../backend/agent/order-tools";
import { writeJsonFileAtomically } from "../../backend/atomic-json-file";
import type { MotionAnswer, MotionCaller } from "./motion-client";
import type { MotionEvent } from "./motion-event";
import type { MotionDeliveryMode, MotionEventsAgent } from "./motion-events-service";
import { ticketOfToolCall } from "./motion-tickets";

export const ORDER_STALL_HOURS = 6;
const STALL_MS = ORDER_STALL_HOURS * 3_600_000;
const KEEP_MS = 14 * 86_400_000;
const ORDER_LIMIT = 300;
const DONE_STATUS =
  /^(done|hecho|terminad[oa]|completad[oa]|completed?|closed|cerrad[oa]|listo|finished|finalizad[oa]|resuelt[oa]|resolved)$/iu;

export interface WatchedOrder {
  issueId: string;
  key: string;
  title: string;
  url: string;
  assigneeId: string;
  senderId: string;
  createdAt: number;
  progressAt: number;
  inReview: boolean;
  nudgedAt: number | null;
  escalatedAt: number | null;
}

function isWatchedOrder(value: unknown): value is WatchedOrder {
  return (
    isDynamicRecord(value) &&
    isString(value.issueId) &&
    isString(value.key) &&
    isString(value.title) &&
    isString(value.url) &&
    isString(value.assigneeId) &&
    isString(value.senderId) &&
    typeof value.createdAt === "number" &&
    typeof value.progressAt === "number" &&
    typeof value.inReview === "boolean" &&
    (value.nudgedAt === null || typeof value.nudgedAt === "number") &&
    (value.escalatedAt === null || typeof value.escalatedAt === "number")
  );
}

export interface MotionOrdersDependencies {
  tool(caller: MotionCaller, name: string, args: DynamicRecord): Promise<MotionAnswer>;
  available(): boolean;
  /** Whether the host sees the agents' Motion calls (the chat app proxy); without them, no nudges. */
  observesToolCalls(): boolean;
  agents(): readonly MotionEventsAgent[];
  /** The ticket the agent works on now, for the project of an order that names none. */
  currentTicket(agentId: string): { key: string } | null;
  /** The message wakes the recipient: the assignment event of the card is held. */
  woken(agentId: string, issueId: string): void;
  /** A card for the agent is being made: its assignment event, which can come first, is held too. */
  expecting?(agentId: string): () => void;
  /** A note that wakes the agent (in quiet hours it waits for their end). */
  note(input: { agentId: string; text: string; clientMessageId: string }): Promise<MotionDeliveryMode>;
  stateFile: string;
  log(message: string): void;
  now?: () => number;
}

function decodeOrders(value: unknown): WatchedOrder[] {
  return isDynamicRecord(value) && Array.isArray(value.orders) ? value.orders.filter(isWatchedOrder) : [];
}

/** The project key of an issue key: `UO` of `UO-12`. */
function projectOf(key: string | undefined): string | null {
  const match = key ? /^([A-Z][A-Z0-9]{0,15})-\d+$/u.exec(key.toUpperCase()) : null;
  return match?.[1] ?? null;
}

export class MotionOrders implements OrderCardsPort {
  readonly #deps: MotionOrdersDependencies;
  #orders: WatchedOrder[] = [];
  #loaded: Promise<void> | null = null;
  #timer: ReturnType<typeof setInterval> | null = null;
  #ticking = false;
  #saving: Promise<void> = Promise.resolve();

  constructor(deps: MotionOrdersDependencies) {
    this.#deps = deps;
  }

  #now(): number {
    return this.#deps.now?.() ?? Date.now();
  }

  start(): Promise<void> {
    this.#loaded ??= readFile(this.#deps.stateFile, "utf8")
      .then((text) => {
        this.#orders = decodeOrders(JSON.parse(text));
      })
      .catch(() => undefined);
    if (!this.#timer) {
      this.#timer = setInterval(() => void this.tick(), 5 * 60_000);
      this.#timer.unref?.();
    }
    return this.#loaded;
  }

  dispose(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
  }

  orders(): readonly WatchedOrder[] {
    return this.#orders;
  }

  available(): boolean {
    return this.#deps.available();
  }

  async create(input: Parameters<OrderCardsPort["create"]>[0]): Promise<OrderCard> {
    await this.start();
    const project =
      input.card.project ??
      projectOf(this.#deps.currentTicket(input.senderAgentId)?.key) ??
      projectOf(this.#orders.findLast((order) => order.senderId === input.senderAgentId)?.key);
    if (!project) throw new Error("name card.project, the Motion project key such as UO");
    const release = this.#deps.expecting?.(input.recipientAgentId);
    const answer = await this.#deps
      .tool({ agentId: input.senderAgentId }, "issues_create", {
        project,
        title: input.card.title,
        description: input.text,
        assignee: input.recipientName,
        ...(input.card.criteria ? { criteria: input.card.criteria } : {}),
        ...(input.card.dedupeKey ? { dedupe_key: input.card.dedupeKey } : {}),
        ...(input.card.due ? { due_date: input.card.due } : {}),
        ...(input.card.priority ? { priority: input.card.priority } : {}),
        ...(input.card.estimateHours ? { estimate_hours: input.card.estimateHours } : {}),
      })
      .finally(() => release?.());
    const row = isDynamicRecord(answer) ? answer : {};
    if (!isString(row.key) || !isString(row.url)) throw new Error("Motion made no issue");
    const card: OrderCard = {
      key: row.key,
      title: isString(row.title) ? row.title : input.card.title,
      url: row.url,
      existing: row.existing === true,
    };
    const issueId = isString(row.id) ? row.id : card.key;
    this.#deps.woken(input.recipientAgentId, issueId);
    if (!this.#orders.some((order) => order.issueId === issueId && order.assigneeId === input.recipientAgentId)) {
      const now = this.#now();
      this.#orders = [
        ...this.#orders,
        {
          issueId,
          key: card.key,
          title: card.title.slice(0, 240),
          url: card.url,
          assigneeId: input.recipientAgentId,
          senderId: input.senderAgentId,
          createdAt: now,
          progressAt: now,
          inReview: false,
          nudgedAt: null,
          escalatedAt: null,
        },
      ].slice(-ORDER_LIMIT);
      await this.#save();
    }
    return card;
  }

  /** A Motion tool call of an agent: its own work on an order card is progress. */
  observeToolCall(agentId: string, tool: string, args: unknown): void {
    const name = tool.replace(/^.*__/u, "");
    const reference =
      name === "issues_request_review" && isDynamicRecord(args) && isString(args.issue)
        ? args.issue.trim().toUpperCase()
        : ticketOfToolCall(tool, args);
    if (!reference) return;
    let changed = false;
    for (const order of this.#orders) {
      if (order.assigneeId !== agentId || (order.key !== reference && order.issueId !== reference)) continue;
      order.progressAt = this.#now();
      order.nudgedAt = null;
      order.escalatedAt = null;
      if (name === "issues_request_review") order.inReview = true;
      changed = true;
    }
    if (changed) void this.#save();
  }

  /** A Motion event of an order card: review, done or taken off. */
  observeEvent(event: MotionEvent): void {
    const watched = this.#orders.filter((order) => order.issueId === event.issue.id || order.key === event.issue.key);
    if (watched.length === 0) return;
    const now = this.#now();
    if (event.issue.statusCategory === "done") {
      this.#orders = this.#orders.filter((order) => !watched.includes(order));
    } else if (event.type === "issue.unassigned") {
      const gone = new Set(event.recipients.flatMap((person) => (person.agentKey ? [person.agentKey] : [])));
      this.#orders = this.#orders.filter((order) => !(watched.includes(order) && gone.has(order.assigneeId)));
    } else {
      for (const order of watched) {
        if (event.type === "issue.review_requested") order.inReview = true;
        if (event.type === "issue.reviewed" || event.type === "issue.blocker_cleared") {
          order.inReview = false;
          order.progressAt = now;
          order.nudgedAt = null;
          order.escalatedAt = null;
        }
      }
    }
    void this.#save();
  }

  /** Nudges the stalled order cards, then tells who gave the order. */
  async tick(): Promise<void> {
    if (this.#ticking || !this.#deps.observesToolCalls()) return;
    this.#ticking = true;
    try {
      await this.start();
      const now = this.#now();
      const agents = this.#deps.agents();
      const known = new Set(agents.map((agent) => agent.id));
      this.#orders = this.#orders.filter((order) => now - order.createdAt < KEEP_MS && known.has(order.assigneeId));
      for (const order of [...this.#orders]) {
        if (order.inReview || now - order.progressAt < STALL_MS) continue;
        if (order.nudgedAt !== null && (order.escalatedAt !== null || now - order.nudgedAt < STALL_MS)) continue;
        if (await this.#isDone(order)) {
          this.#orders = this.#orders.filter((entry) => entry !== order);
          continue;
        }
        const assignee = agents.find((agent) => agent.id === order.assigneeId);
        const hours = Math.round((now - order.progressAt) / 3_600_000);
        const card = `${order.key} “${order.title}”`;
        if (order.nudgedAt === null) {
          order.nudgedAt = now;
          await this.#deps.note({
            agentId: order.assigneeId,
            clientMessageId: `motion-order-nudge:${order.issueId}:${now}`,
            text: `Motion · Your order ${card} has had no progress for ${hours} h.\n${order.url}\nWork on it now (issues_start), or say in a comment on the card what blocks it and set it blocked. Do not answer here.`,
          });
          continue;
        }
        order.escalatedAt = now;
        const sender = order.senderId !== order.assigneeId && known.has(order.senderId) ? order.senderId : null;
        const manager = sender ?? agentManagers(agents).get(order.assigneeId) ?? null;
        if (!manager) continue;
        await this.#deps.note({
          agentId: manager,
          clientMessageId: `motion-order-stalled:${order.issueId}:${now}`,
          text: `Motion · ${card}, ${sender ? "your order to" : "assigned to"} ${assignee?.name ?? order.assigneeId}, has had no progress for ${hours} h, also after a nudge.\n${order.url}\nCheck in with them, unblock it, or reassign it. Keep the ticket current in Motion.`,
        });
      }
      await this.#save();
    } finally {
      this.#ticking = false;
    }
  }

  async #isDone(order: WatchedOrder): Promise<boolean> {
    try {
      const row = await this.#deps.tool({ agentId: order.assigneeId }, "rows_get", { id: order.key });
      const status = isDynamicRecord(row) && isString(row.status) ? row.status : "";
      return DONE_STATUS.test(status.trim());
    } catch {
      return false;
    }
  }

  /** Saves one at a time, each the newest list: two writes in flight could land in either order. */
  #save(): Promise<void> {
    this.#saving = this.#saving.then(() =>
      Effect.runPromise(
        writeJsonFileAtomically(this.#deps.stateFile, { version: 1, orders: this.#orders }, { createDirectory: true }),
      ).catch(() => this.#deps.log("Could not save the watched order cards.")),
    );
    return this.#saving;
  }
}
