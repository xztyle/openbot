/**
 * Puts the Motion pieces together on a host: the events route (`motion-events-server.ts`), the
 * service that turns events into notes (`motion-events-service.ts`) and the current-ticket tracker
 * (`motion-tickets.ts`). The route listens only when `OPENBOT_MOTION_EVENTS_LISTEN` names an address;
 * the tracker works whenever a `motion` MCP row exists.
 */

import type { Server } from "node:http";
import { join } from "node:path";
import {
  DEFAULT_WORKSPACE_MOTION_EVENTS,
  type McpServerConfig,
  type WorkspaceMotionEventsSettings,
} from "@openbot/contracts/ipc";
import { createOpenBotLogger, registerSecretValue } from "@openbot/logging";
import { Effect } from "effect";
import type { McpAgent } from "../../backend/mcp-agent-values";
import { startMotionEventsServer } from "./motion-events-server";
import { type MotionEventsAgent, MotionEventsService, type WaitingTicket } from "./motion-events-service";
import { type MotionStartInput, MotionTickets } from "./motion-tickets";

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
  taskDone?: (input: { agentIds: string[]; key: string; title: string }) => void;
}

/** The `motion` MCP row: the board the agents use. */
export function motionServer(configs: readonly McpServerConfig[]): McpServerConfig | undefined {
  return configs.find(
    (config) => config.enabled && config.transport === "http" && config.name.trim().toLowerCase() === "motion",
  );
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
    notifyOwner: options.notifyOwner,
    timeZone: options.timeZone,
    stateFile: join(options.userData, "motion-events-v1.json"),
    log: (message) => logger.info(message),
  });
  await events.start();
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
          if (agentIds.length > 0) options.taskDone?.({ agentIds, key: event.issue.key, title: event.issue.title });
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
    close: async () => {
      events.dispose();
      const open = server;
      if (open) await new Promise<void>((resolve) => open.close(() => resolve()));
    },
  };
}
