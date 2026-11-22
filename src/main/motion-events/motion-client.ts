/**
 * Calls Motion's MCP tools from the host, as an agent: through that agent's own filled `motion` MCP
 * row (its gateway token and agent headers), so Motion's history shows the agent act. The grader acts
 * as its own Motion member instead: the same row with the grader's agent headers, because Motion lets
 * nobody assigned to a ticket review it.
 *
 * Motion's MCP route is stateless and answers JSON, so each call is one `tools/call` request. A tool
 * answers one line of compact JSON (Motion's `docs/agents.md`); an error comes back as text.
 */

import type { McpServerConfig } from "@openbot/contracts/ipc";
import { type DynamicRecord, isDynamicRecord, isString } from "@openbot/contracts/runtime-values";
import type { McpAgent } from "../../backend/mcp-agent-values";

const CALL_TIMEOUT_MS = 20_000;

/** The Motion member the host's grader acts as. Motion makes it on first use. */
export const MOTION_GRADER_KEY = "atelier-grader";
export const MOTION_GRADER_NAME = "Grader";

export interface MotionClientOptions {
  mcpServers: () => readonly McpServerConfig[];
  mcpAgent: (agentId: string) => McpAgent | null;
  personalMcpServer: (config: McpServerConfig, agent: McpAgent | null) => McpServerConfig | null;
}

/** Who a call acts as: an agent, or the grader in the workspace of that agent. */
export interface MotionCaller {
  agentId: string;
  asGrader?: boolean;
}

/** The `motion` MCP row: the board the agents use. */
export function motionServer(configs: readonly McpServerConfig[]): McpServerConfig | undefined {
  return configs.find(
    (config) => config.enabled && config.transport === "http" && config.name.trim().toLowerCase() === "motion",
  );
}

/** The headers of a call: the agent's own, or the grader's in place of its agent headers. */
export function motionHeaders(headers: readonly { key: string; value: string }[], asGrader: boolean) {
  const out: Record<string, string> = {};
  for (const header of headers) {
    const name = header.key.toLowerCase();
    if (asGrader && name === "x-motion-agent") out[header.key] = MOTION_GRADER_KEY;
    else if (asGrader && name === "x-motion-agent-name") out[header.key] = MOTION_GRADER_NAME;
    else out[header.key] = header.value;
  }
  if (asGrader && !Object.keys(out).some((key) => key.toLowerCase() === "x-motion-agent"))
    throw new Error("The motion MCP row sends no agent headers, so the grader cannot act as its own member.");
  if (asGrader && !Object.keys(out).some((key) => key.toLowerCase() === "x-motion-agent-name"))
    out["X-Motion-Agent-Name"] = MOTION_GRADER_NAME;
  return out;
}

/** A tool's answer: its JSON object, a list as `{ items }`, or its text. */
export type MotionAnswer = DynamicRecord | string;

/** The JSON answer of a `tools/call` reply, or an error with Motion's message. */
export function motionToolAnswer(reply: unknown): MotionAnswer {
  if (!isDynamicRecord(reply)) throw new Error("Motion answered no JSON-RPC reply.");
  if (isDynamicRecord(reply.error))
    throw new Error(isString(reply.error.message) ? reply.error.message.slice(0, 300) : "Motion refused the call.");
  const result = isDynamicRecord(reply.result) ? reply.result : {};
  const content = Array.isArray(result.content) ? result.content : [];
  const first = content[0];
  const text = isDynamicRecord(first) && isString(first.text) ? first.text : "";
  if (result.isError === true) throw new Error(text.slice(0, 300) || "Motion refused the call.");
  return answerOf(text);
}

function answerOf(text: string): MotionAnswer {
  try {
    const parsed = JSON.parse(text);
    if (isDynamicRecord(parsed)) return parsed;
    return Array.isArray(parsed) ? { items: parsed } : text;
  } catch {
    return text;
  }
}

export class MotionClient {
  readonly #options: MotionClientOptions;
  #id = 0;

  constructor(options: MotionClientOptions) {
    this.#options = options;
  }

  /** Whether the host has a Motion board at all. */
  available(): boolean {
    return motionServer(this.#options.mcpServers()) !== undefined;
  }

  /** Calls one Motion tool (`issues_create`, `rows_get`, …) and answers its parsed JSON. */
  async tool(caller: MotionCaller, name: string, args: DynamicRecord): Promise<MotionAnswer> {
    const stored = motionServer(this.#options.mcpServers());
    if (!stored) throw new Error("No motion MCP server.");
    const config = this.#options.personalMcpServer(stored, this.#options.mcpAgent(caller.agentId));
    if (config?.transport !== "http") throw new Error("The motion MCP server is not filled for this agent.");
    this.#id += 1;
    const response = await fetch(config.url, {
      method: "POST",
      headers: {
        ...motionHeaders(config.headers, caller.asGrader === true),
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-protocol-version": "2025-06-18",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: this.#id, method: "tools/call", params: { name, arguments: args } }),
      signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`Motion answered ${response.status}.`);
    return motionToolAnswer(await response.json());
  }
}
