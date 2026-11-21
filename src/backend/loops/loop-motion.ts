import type { McpServerConfig } from "@openbot/contracts/ipc";
import { isDynamicRecord, isString } from "@openbot/contracts/runtime-values";
import { type McpAgent, type McpSecretReader, personalizeMcpConfig } from "../mcp-agent-values";
import type { LoopTicketRequest } from "./loop-service";

const TIMEOUT_MS = 15_000;

export interface LoopMotionOptions {
  mcpServers(): readonly McpServerConfig[];
  /** The agent and its space, as the MCP connection of that agent fills its headers. */
  mcpAgent(agentId: string): McpAgent | null;
  agentName(agentId: string): string | null;
  secret: McpSecretReader;
  fetch?: typeof fetch;
}

/**
 * Creates the ticket of a stage through Motion's public API (`POST /api/v1/issues.create`), with the
 * same address and headers as the `motion` MCP server row: the gateway token and the agent and space
 * headers, filled for the agent that acts. So the ticket is made by that agent, in the workspace of its
 * space, as if the agent had called `issues_create` itself. Answers null when no enabled MCP server is
 * named `motion`, when it is not an http server, or when no agent can act.
 */
export function motionTicketCreator(options: LoopMotionOptions) {
  return async (request: LoopTicketRequest): Promise<{ key?: string; url?: string } | null> => {
    const row = options
      .mcpServers()
      .find((server) => server.enabled && server.name.trim().toLowerCase() === "motion" && server.url);
    const actor = request.actorAgentId ?? request.assigneeAgentId;
    if (!row || !actor) return null;
    const agent = options.mcpAgent(actor);
    if (!agent || agent.space.id !== request.spaceId) return null;
    const filled = personalizeMcpConfig(row, agent, options.secret);
    if (!filled) return null;
    const endpoint = new URL("/api/v1/issues.create", new URL(filled.url).origin);
    const headers = new Headers({ "Content-Type": "application/json" });
    for (const pair of filled.headers) headers.set(pair.key, pair.value);
    const assignee = request.assigneeAgentId ? options.agentName(request.assigneeAgentId) : null;
    const response = await (options.fetch ?? fetch)(endpoint, {
      method: "POST",
      headers,
      redirect: "error",
      signal: AbortSignal.timeout(TIMEOUT_MS),
      body: JSON.stringify({
        project: request.project,
        title: request.title,
        description: request.body,
        ...(assignee ? { assignee } : {}),
        ...(request.dueDate ? { due_date: request.dueDate } : {}),
      }),
    });
    if (!response.ok) throw new Error(`Motion answered ${response.status}.`);
    const created = await response.json().then(
      (body) => (isDynamicRecord(body) ? (isDynamicRecord(body.result) ? body.result : body) : null),
      () => null,
    );
    if (!created) return {};
    return {
      ...(isString(created.key) ? { key: created.key } : {}),
      ...(isString(created.url) ? { url: created.url } : {}),
    };
  };
}
