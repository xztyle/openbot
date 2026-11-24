/**
 * Puts the Motion pieces together on a host: the events route (`motion-events-server.ts`), the
 * service that turns events into notes (`motion-events-service.ts`) and the current-ticket tracker
 * (`motion-tickets.ts`). The route listens only when `OPENBOT_MOTION_EVENTS_LISTEN` names an address;
 * the tracker works whenever a `motion` MCP row exists.
 */

import type { Server } from "node:http";
import { join } from "node:path";
import type { ConversationMessage } from "@openbot/contracts/ipc";
import {
  DEFAULT_WORKSPACE_MOTION_EVENTS,
  type McpServerConfig,
  type WorkspaceMotionEventsSettings,
} from "@openbot/contracts/ipc";
import type { DynamicRecord } from "@openbot/contracts/runtime-values";
import { createOpenBotLogger, registerSecretValue } from "@openbot/logging";
import { Effect } from "effect";
import type { ApprovalRouter, PendingApproval } from "../../backend/approvals/approval-router";
import type { McpAgent } from "../../backend/mcp-agent-values";
import type { TrustAuditInput } from "../../backend/trust/trust-audit-log";
import { MOTION_OWNER_KEY, MotionClient, motionServer } from "./motion-client";
import { startMotionEventsServer } from "./motion-events-server";
import { type MotionEventsAgent, MotionEventsService, type WaitingTicket } from "./motion-events-service";
import { readDeliverableFiles } from "./motion-files";
import { MotionGrader } from "./motion-grader";
import { MotionOrders } from "./motion-orders";
import { type MotionStartInput, MotionTickets } from "./motion-tickets";
import { fallbackReason, parseWaitingAsks, waitingAsksPrompt, waitingComments } from "./motion-waiting-asks";

export { motionServer } from "./motion-client";

const logger = createOpenBotLogger("motion-events");
const CALL_TIMEOUT_MS = 15_000;

export interface MotionEventsHostOptions {
  userData: string;
  environment: NodeJS.ProcessEnv;
  settings: () => WorkspaceMotionEventsSettings | undefined;
  agents: () => readonly MotionEventsAgent[];
  /**
   * The signing secret of the events route. It comes from the host's environment, which main takes
   * before agents start (`host-secret-environment.ts`). The shared Secrets scope is no place for it:
   * every agent reads that scope, and could sign an event that wakes or steers any agent.
   */
  secret: () => string | null;
  send: (
    input: { agentId: string; text: string; clientMessageId: string },
    fyi: boolean,
  ) => Effect.Effect<unknown, unknown>;
  showWaiting: (tickets: readonly WaitingTicket[]) => void;
  notifyOwner: (input: { agentId: string; title: string; body: string }) => void;
  timeZone: () => string;
  mcpServers: () => readonly McpServerConfig[];
  mcpAgent: (agentId: string) => McpAgent | null;
  personalMcpServer: (config: McpServerConfig, agent: McpAgent | null) => McpServerConfig | null;
  /** The web client path of an agent's chat, such as `/app/s/<host>/<space>/dm/<agent>`. */
  chatPath: (agentId: string) => string | null;
  ticketsChanged: () => void;
  /** A ticket of these local agents is done: each may learn a lesson from the work. */
  taskDone?: (input: { agentIds: string[]; key: string; title: string; priority?: string | null }) => void;
  /** The folders an agent may write, where the grader reads the files it delivered. */
  workRoots?: (agentId: string) => readonly string[];
  /** The agent's recent chat, the evidence the grader reads. */
  evidence: (agentId: string) => readonly ConversationMessage[];
  /** One answer of the grader's judge, in a fresh context (`AgentService.generateReviewText`). */
  judge: (input: { agentId: string; important: boolean; prompt: string }) => Promise<{ text: string; model: string }>;
  /** Whether the chat app proxy reports the agents' Motion calls to `observeToolCall`. */
  observesToolCalls: boolean;
  /** Tier 1 of `docs/approvals.md`: a waiting ticket goes to its agent's manager. Absent: the owner answers all. */
  approvals?: ApprovalRouter | undefined;
  /** The owner's language, for the plain summary of a ticket. */
  ownerLanguage?: () => string;
  /** One line of the trust audit trail: the owner answered a ticket. */
  record?: (entry: TrustAuditInput) => void;
}

/** The approval request id of a waiting ticket. */
export function ticketApprovalId(issueId: string): string {
  return `ticket:${issueId}`;
}

/** Motion's operation URL from its MCP address (`http://host:8080/mcp` → `http://host:8080/api/v1/<op>`). */
export function motionOperationUrl(mcpUrl: string, operation: string, override?: string): string {
  const base = override?.trim() || mcpUrl.replace(/\/mcp\/?$/u, "");
  return `${base.replace(/\/+$/u, "")}/api/v1/${operation}`;
}

function motionCaller(options: MotionEventsHostOptions) {
  return async (agentId: string, operation: "issues.start", body: MotionStartInput): Promise<unknown> => {
    const stored = motionServer(options.mcpServers());
    if (!stored) throw new Error("No motion MCP server.");
    const config = options.personalMcpServer(stored, options.mcpAgent(agentId));
    if (config?.transport !== "http") throw new Error("The motion MCP server is not filled for this agent.");
    const headers = Object.fromEntries(config.headers.map((header) => [header.key, header.value]));
    const response = await fetch(
      motionOperationUrl(config.url, operation, options.environment.OPENBOT_MOTION_API_URL),
      {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
      },
    );
    if (!response.ok) throw new Error(`Motion answered ${response.status}.`);
    return response.json();
  };
}

export interface MotionEventsHost {
  tickets: MotionTickets;
  events: MotionEventsService;
  grader: MotionGrader;
  orders: MotionOrders;
  /** A Motion tool call of an agent's turn, after it answered. */
  observeToolCall(agentId: string, tool: string, args: unknown): void;
  /**
   * The owner answered a ticket that waits on them from Atelier: the answer goes on the ticket as a
   * comment of the owner's own Motion member, and the ticket leaves Needs you.
   */
  answerWaiting(issueId: string, answer: string, ownerName: string): Promise<void>;
  close(): Promise<void>;
}

export async function startMotionEventsHost(options: MotionEventsHostOptions): Promise<MotionEventsHost> {
  const origin = (options.environment.OPENBOT_WEB_APP_URL ?? options.environment.OPENBOT_AUTH_API_URL ?? "").replace(
    /\/+$/u,
    "",
  );
  const tickets = new MotionTickets({
    call: motionCaller(options),
    chatUrl: (agentId) => {
      const path = options.chatPath(agentId);
      return origin.startsWith("http") && path ? `${origin}${path}` : null;
    },
    changed: options.ticketsChanged,
    stateFile: join(options.userData, "motion-tickets-v1.json"),
    log: (message) => logger.info(message),
  });
  await tickets.load();
  const events = new MotionEventsService({
    settings: () => options.settings() ?? DEFAULT_WORKSPACE_MOTION_EVENTS,
    agents: options.agents,
    deliver: ({ agentId, text, fyi, clientMessageId }) =>
      Effect.runPromise(options.send({ agentId, text, clientMessageId }, fyi)).then(() => undefined),
    showWaiting: options.showWaiting,
    stopped: (issueId) => void options.approvals?.cancel(ticketApprovalId(issueId)),
    classify: (ticket) => void classify(ticket),
    notifyOwner: options.notifyOwner,
    timeZone: options.timeZone,
    stateFile: join(options.userData, "motion-events-v1.json"),
    log: (message) => logger.info(message),
  });
  const motion = new MotionClient(options);
  /** Reads why a ticket waits on the owner (its comments, through a judge) and records it. */
  const classifying = new Set<string>();
  async function classify(ticket: WaitingTicket): Promise<void> {
    if (classifying.has(ticket.issueId)) return;
    classifying.add(ticket.issueId);
    try {
      const answer = await motion
        .tool({ agentId: ticket.agentId }, "comments_list", { page_id: ticket.issueId })
        .catch(() => null);
      const comments = waitingComments(answer && typeof answer === "object" ? answer : null);
      const prompt = waitingAsksPrompt({
        key: ticket.key,
        title: ticket.title,
        comments,
        language: options.ownerLanguage?.(),
      });
      const judged = await options
        .judge({ agentId: ticket.agentId, important: false, prompt })
        .then((reply) => parseWaitingAsks(reply.text))
        .catch(() => null);
      const reason = judged?.reason || fallbackReason(comments);
      await events.setAsks(ticket.issueId, judged?.asks ?? "other", reason, {
        ownerOnly: judged?.ownerOnly ?? null,
        plain: judged?.plain ?? null,
      });
      logger.info("Read why a Motion ticket waits on a person.", { key: ticket.key, asks: judged?.asks ?? "other" });
      const evidence = [
        events.escalationBody(ticket.issueId) ?? "",
        ...comments.slice(-4).map((comment) => `${comment.author || "comment"}: ${comment.body.slice(0, 1_500)}`),
      ]
        .filter(Boolean)
        .join("\n\n");
      await route(ticket.issueId, evidence);
    } catch (error) {
      logger.warn("Could not read why a Motion ticket waits on a person.", {
        key: ticket.key,
        error: error instanceof Error ? error.message : "failed",
      });
      await route(ticket.issueId, "").catch(() => undefined);
    } finally {
      classifying.delete(ticket.issueId);
    }
  }
  /**
   * Who answers a ticket that the host read (`docs/approvals.md`): the owner when only the owner may
   * decide it or no agent may; otherwise the approval router wakes the agent's manager.
   */
  async function route(issueId: string, evidence: string): Promise<void> {
    const ticket = events.waiting().find((item) => item.issueId === issueId);
    if (!ticket || ticket.approver) return;
    const approvals = options.approvals;
    if (ticket.ownerOnly || !approvals) {
      await events.setApprover(issueId, "owner");
      return;
    }
    const result = await approvals.route({
      id: ticketApprovalId(issueId),
      source: "ticket",
      askerId: ticket.agentId,
      title: `${ticket.key} · ${ticket.title}`,
      reason: ticket.reason ?? "",
      evidence,
      ticket: { key: ticket.key, url: ticket.url, issueId },
      reviewEscalated: ticket.asks === "review-escalated",
    });
    await events.setApprover(issueId, result.approver);
    if (result.approver === "manager")
      logger.info("A waiting Motion ticket goes to the agent's manager, not the owner.", {
        key: ticket.key,
        manager: result.agentId,
      });
  }
  await events.start();
  const tool = (caller: Parameters<MotionClient["tool"]>[0], name: string, args: DynamicRecord) =>
    motion.tool(caller, name, args);
  const grader = new MotionGrader({
    tool,
    agents: options.agents,
    evidence: options.evidence,
    ...(options.workRoots
      ? {
          readFiles: (agentId: string, paths: readonly string[]) =>
            readDeliverableFiles(options.workRoots?.(agentId) ?? [], paths),
        }
      : {}),
    judge: options.judge,
    escalate: (ticket, body, reason) => events.escalate(ticket, body, reason),
    tell: (agentId, text, clientMessageId) =>
      void Effect.runPromise(options.send({ agentId, text, clientMessageId }, true)).catch(() => undefined),
    stateFile: join(options.userData, "motion-grader-v1.json"),
    log: (message) => logger.info(message),
  });
  const orders = new MotionOrders({
    tool,
    available: () => motion.available(),
    observesToolCalls: () => options.observesToolCalls,
    agents: options.agents,
    currentTicket: (agentId) => tickets.current(agentId),
    woken: (agentId, issueId) => events.noteWoken(agentId, issueId),
    expecting: (agentId) => events.expectOrderCard(agentId),
    note: (input) => events.note(input),
    stateFile: join(options.userData, "motion-orders-v1.json"),
    log: (message) => logger.info(message),
  });
  await orders.start();
  options.approvals?.handle("ticket", {
    settle: async (request, answer) => {
      const issueId = request.ticket?.issueId;
      if (!issueId) return;
      const key = request.ticket?.key ?? "the ticket";
      const note = answer.note ? ` ${answer.note}` : "";
      const text = request.reviewEscalated
        ? answer.verdict === "approve"
          ? `${answer.byName} (manager) accepts ${key} as is, with no more review rounds: close it.${note}`
          : `${answer.byName} (manager) sends ${key} back. Fix this, then request review again:${note}`
        : answer.verdict === "approve"
          ? `${answer.byName} (manager) approves ${key}: go ahead.${note}`
          : `${answer.byName} (manager) declines ${key}:${note}`;
      // The answer goes on the ticket as the manager's own comment, and wakes the asker at once.
      await motion
        .tool({ agentId: answer.byId }, "comments_create", { page_id: issueId, body: text })
        .catch((error: unknown) =>
          logger.warn("Could not comment a manager's answer on a Motion ticket.", {
            key,
            error: error instanceof Error ? error.message : "failed",
          }),
        );
      events.noteWoken(request.askerId, issueId);
      await Effect.runPromise(
        options.send(
          { agentId: request.askerId, text: `Motion · ${text}`, clientMessageId: `approval-answer:${request.id}` },
          false,
        ),
      ).catch(() => undefined);
      void events.dismissWaiting(issueId);
    },
    toOwner: async (request, why) => {
      const issueId = request.ticket?.issueId;
      if (!issueId) return;
      await events.setApprover(
        issueId,
        "owner",
        why.kind === "escalated" ? { by: why.byName, reason: why.reason } : undefined,
      );
    },
    reopen: async (decision: PendingApproval) => {
      if (!decision.ticket) return false;
      await events.reopen({
        issueId: decision.ticket.issueId,
        agentId: decision.askerId,
        key: decision.ticket.key,
        title: decision.title.replace(`${decision.ticket.key} · `, ""),
        url: decision.ticket.url,
        asks: decision.reviewEscalated ? "review-escalated" : "approval",
        reason: decision.reason,
      });
      return true;
    },
  });
  let server: Server | null = null;
  const listen = options.environment.OPENBOT_MOTION_EVENTS_LISTEN?.trim();
  if (listen) {
    const secret = () => {
      const value = options.secret();
      if (value) registerSecretValue(value);
      return value || null;
    };
    server = await startMotionEventsServer({
      listen,
      secret,
      receive: async (event) => {
        const outcome = await events.receive(event);
        if (outcome.outcome !== "duplicate") orders.observeEvent(event);
        // A ticket in review with no reviewer of its own: the independent grader takes it.
        if (outcome.grade) void grader.grade(event);
        // A done ticket, or one the agent was taken off, is nobody's current ticket any more.
        if (event.issue.statusCategory === "done") tickets.settle(event.issue.key);
        if (
          event.type === "issue.status_changed" &&
          event.issue.statusCategory === "done" &&
          outcome.outcome !== "duplicate"
        ) {
          const agentIds = [event.actor, ...event.issue.assignees].flatMap((person) =>
            person?.kind === "agent" && person.agentKey ? [person.agentKey] : [],
          );
          if (agentIds.length > 0)
            options.taskDone?.({
              agentIds,
              key: event.issue.key,
              title: event.issue.title,
              priority: event.issue.priority ?? null,
            });
        }
        if (event.type === "issue.unassigned")
          for (const person of event.recipients) if (person.agentKey) tickets.settle(event.issue.key, person.agentKey);
        return outcome;
      },
      log: (message) => logger.info(message),
    }).catch((error: unknown) => {
      logger.warn("The Motion events route did not start.", {
        listen,
        error: error instanceof Error ? error.message : "failed",
      });
      return null;
    });
    if (server) logger.info("The Motion events route listens.", { listen });
  }
  return {
    tickets,
    events,
    grader,
    orders,
    observeToolCall: (agentId, name, args) => {
      tickets.observeToolCall(agentId, name, args);
      grader.observeToolCall(agentId, name, args);
      orders.observeToolCall(agentId, name, args);
    },
    answerWaiting: async (issueId, answer, ownerName) => {
      const ticket = events.waiting().find((item) => item.issueId === issueId);
      if (!ticket) return;
      const agentName = options.agents().find((agent) => agent.id === ticket.agentId)?.name;
      options.record?.({
        actor: { kind: "agent", id: ticket.agentId, ...(agentName ? { name: agentName } : {}) },
        category: "approval",
        action: "ticket approval",
        summary: `${ticket.key} · ${ticket.title} → ${answer}`,
        outcome: "answered",
        agentId: ticket.agentId,
        ticket: ticket.key,
        answeredBy: ownerName,
        answeredByKind: "owner",
      });
      await motion.tool(
        { agentId: ticket.agentId, asMember: { key: MOTION_OWNER_KEY, name: ownerName } },
        "comments_create",
        { page_id: issueId, body: answer },
      );
      await events.dismissWaiting(issueId);
    },
    close: async () => {
      events.dispose();
      orders.dispose();
      const open = server;
      if (open) await new Promise<void>((resolve) => open.close(() => resolve()));
    },
  };
}
