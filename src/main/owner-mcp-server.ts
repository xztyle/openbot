import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, type CallToolResult, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { AgentAttentionItem, LoopDecision } from "@openbot/contracts/ipc";
import { type DynamicRecord, isDynamicRecord, isNumber, isString } from "@openbot/contracts/runtime-values";
import type { OwnerHeldItem } from "@openbot/contracts/team-protocol/owner-away-v1";
import { createOpenBotLogger, redactSecretValues, toLogValue } from "@openbot/logging";
import { hideChannelSecrets } from "../backend/channel-secrets";
import { readBodyWithin } from "./http-body";
import type { OwnerMcpTokens } from "./owner-mcp-tokens";

const logger = createOpenBotLogger("owner-mcp");

const BODY_LIMIT_BYTES = 64 * 1024;
const MESSAGE_TEXT_LIMIT = 8_000;
/** Messages through this endpoint in one hour, for all tokens: a looping chat app cannot flood the team. */
const MESSAGES_PER_HOUR = 60;
/** Refused calls from one address in a minute before it gets 429. */
const FAILURES_PER_MINUTE = 20;
const HOUR_MS = 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;
/** A chat app gives a tool call about a minute; `get_reply` waits less than that. */
const REPLY_WAIT_LIMIT_S = 40;
const REPLY_POLL_MS = 1_000;
const RECENT_LIMIT = 20;
const TEXT_PER_MESSAGE = 2_000;
const MCP_PATH = /^\/mcp(?:\/([A-Za-z0-9_-]{1,128}))?\/?$/u;
const ENDED = new Set(["completed", "failed", "interrupted", "cancelled"]);

export interface OwnerMcpAgent {
  id: string;
  name: string;
  title: string;
  space: string;
}

export interface OwnerMcpMessage {
  from: "owner" | "agent";
  text: string;
  at: string;
}

export interface OwnerMcpServerOptions {
  tokens: OwnerMcpTokens;
  /** The agents that take messages: not hidden. */
  listAgents: () => OwnerMcpAgent[];
  /** Sends a message as the owner, the same as the owner's own chat with the agent. */
  sendMessage: (input: { agentId: string; text: string; clientMessageId: string }) => Promise<{ deliveryId: string }>;
  delivery: (deliveryId: string) => { recipientAgentId: string; status: string; turnId: string | null } | null;
  turnAnswer: (agentId: string, turnId: string) => string | null;
  recentMessages: (agentId: string, limit: number) => OwnerMcpMessage[];
  attentionItems: () => AgentAttentionItem[];
  loopDecisions: () => LoopDecision[];
  heldItems: () => OwnerHeldItem[];
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

class ToolRefusal extends Error {}

/** What a tool answers, as JSON text for the chat app. */
type ToolAnswer = object;

const TOOLS = [
  {
    name: "list_agents",
    description:
      "List the owner's Atelier agents: id, name, role and space. Use the id or the exact name in other tools.",
    inputSchema: {
      type: "object",
      properties: { space: { type: "string", description: "Only agents of the space with this name." } },
    },
  },
  {
    name: "send_message",
    description:
      "Send a message or an order to one agent as the owner, the same as typing it in Atelier. Answers a deliveryId; read the agent's answer with get_reply.",
    inputSchema: {
      type: "object",
      properties: {
        agent: { type: "string", description: "The agent's id or exact name." },
        text: { type: "string", description: "The message, plain text." },
      },
      required: ["agent", "text"],
    },
  },
  {
    name: "get_reply",
    description:
      "The state of a sent message and, once the agent finished, its answer. Waits up to wait_seconds (at most 40) for the answer.",
    inputSchema: {
      type: "object",
      properties: {
        deliveryId: { type: "string" },
        wait_seconds: { type: "number", description: "0 to 40. Default 20." },
      },
      required: ["deliveryId"],
    },
  },
  {
    name: "read_messages",
    description: "The latest messages between the owner and one agent, oldest first (at most 20).",
    inputSchema: {
      type: "object",
      properties: {
        agent: { type: "string", description: "The agent's id or exact name." },
        limit: { type: "number", description: "1 to 20. Default 10." },
      },
      required: ["agent"],
    },
  },
  {
    name: "list_decisions",
    description:
      "What waits for the owner: agents' questions, approvals and sign-in steps, loop gates, and requests held for later. Answer them in the Atelier app.",
    inputSchema: { type: "object", properties: {} },
  },
] as const;

/**
 * The Atelier MCP endpoint: the owner reaches his agents from another chat app (Claude, ChatGPT)
 * with text tools. Every call needs one of the owner's access tokens (`owner-mcp-tokens.ts`), as a
 * bearer header or as the last path segment (`/mcp/<token>`), because some chat apps take only a
 * URL. The connector gateway (`connector-gateway.ts`) serves it. It sends no CORS headers,
 * so a web page that somehow holds a token still cannot read an answer.
 *
 * It sends messages as the owner and reads; it answers no approval and spends nothing. Approvals and
 * money stay in the app, where the owner sees the whole card.
 */
export class OwnerMcpServer {
  readonly #options: OwnerMcpServerOptions;
  readonly #now: () => number;
  readonly #sleep: (ms: number) => Promise<void>;
  #sent: number[] = [];
  readonly #failures = new Map<string, number[]>();

  constructor(options: OwnerMcpServerOptions) {
    this.#options = options;
    this.#now = options.now ?? Date.now;
    this.#sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  /** Answers one request under `/mcp`. The connector gateway owns the listener. */
  async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const address = request.socket.remoteAddress ?? "unknown";
    try {
      if (this.#throttled(address)) return plain(response, 429, "Too many refused requests. Wait a minute.");
      const match = MCP_PATH.exec(new URL(request.url ?? "/", "http://localhost").pathname);
      if (!match) return this.#refuse(response, address, 404, "not found");
      const header = request.headers.authorization;
      const token = match[1] ?? (header?.startsWith("Bearer ") ? header.slice(7).trim() : "");
      if (!token || !this.#options.tokens.verify(token)) return this.#refuse(response, address, 401, "unauthorized");
      if (request.method !== "POST") {
        response.writeHead(405, { allow: "POST" });
        response.end();
        return;
      }
      const raw = await readBodyWithin(request, BODY_LIMIT_BYTES);
      if (raw === null) return plain(response, 413, "The request is too large.");
      let body: unknown;
      try {
        body = JSON.parse(raw.toString("utf8"));
      } catch {
        return plain(response, 400, "The request is not JSON.");
      }
      // One stateless server and transport for each POST, as the GitHub proxy does.
      const mcp = this.#mcp();
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      try {
        await mcp.connect(transport);
        await transport.handleRequest(request, response, body);
      } finally {
        await transport.close().catch(() => undefined);
        await mcp.close().catch(() => undefined);
      }
    } catch (error) {
      logger.warn("An MCP request failed.", toLogValue(error));
      if (!response.headersSent) plain(response, 500, "internal error");
    }
  }

  #mcp(): Server {
    const mcp = new Server(
      { name: "atelier", version: "1.0.0" },
      {
        capabilities: { tools: {} },
        instructions:
          "Atelier is the owner's team of AI agents. Use list_agents, then send_message to give an agent an order and get_reply to read its answer. list_decisions shows what waits for the owner; he answers those in the Atelier app.",
      },
    );
    mcp.setRequestHandler(ListToolsRequestSchema, () => ({ tools: [...TOOLS] }));
    mcp.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
      try {
        return text(await this.#call(params.name, isDynamicRecord(params.arguments) ? params.arguments : {}));
      } catch (error) {
        if (error instanceof ToolRefusal) return { content: [{ type: "text", text: error.message }], isError: true };
        throw error;
      }
    });
    return mcp;
  }

  async #call(name: string, args: DynamicRecord): Promise<ToolAnswer> {
    if (name === "list_agents") {
      const space = isString(args.space) ? args.space.trim().toLowerCase() : "";
      return this.#options.listAgents().filter((agent) => !space || agent.space.toLowerCase() === space);
    }
    if (name === "send_message") {
      const agent = this.#agent(args.agent);
      // A key pasted into the chat app is hidden before the agent's thread stores it, as the message
      // box of Atelier hides it.
      const message = isString(args.text) ? hideChannelSecrets(args.text.trim(), "person") : "";
      if (!message) throw new ToolRefusal("text is empty.");
      if (message.length > MESSAGE_TEXT_LIMIT) throw new ToolRefusal(`text is longer than ${MESSAGE_TEXT_LIMIT}.`);
      const now = this.#now();
      this.#sent = this.#sent.filter((time) => now - time < HOUR_MS);
      if (this.#sent.length >= MESSAGES_PER_HOUR)
        throw new ToolRefusal(`At most ${MESSAGES_PER_HOUR} messages an hour go through this connection. Try later.`);
      this.#sent.push(now);
      const { deliveryId } = await this.#options.sendMessage({
        agentId: agent.id,
        text: message,
        clientMessageId: `owner-mcp:${randomUUID()}`,
      });
      logger.info(`The owner sent a message to agent ${agent.id} through MCP.`);
      return { agent: agent.name, deliveryId, next: "Call get_reply with this deliveryId for the answer." };
    }
    if (name === "get_reply") {
      const deliveryId = isString(args.deliveryId) ? args.deliveryId : "";
      const wait = isNumber(args.wait_seconds) ? Math.max(0, Math.min(REPLY_WAIT_LIMIT_S, args.wait_seconds)) : 20;
      const until = this.#now() + wait * 1000;
      for (;;) {
        const delivery = this.#options.delivery(deliveryId);
        if (!delivery) throw new ToolRefusal("No message has this deliveryId.");
        const ended = ENDED.has(delivery.status);
        if (ended || this.#now() >= until) {
          const answer =
            ended && delivery.turnId ? this.#options.turnAnswer(delivery.recipientAgentId, delivery.turnId) : null;
          return {
            status: delivery.status,
            answer,
            ...(ended ? {} : { next: "The agent is still working. Call get_reply again later." }),
          };
        }
        await this.#sleep(REPLY_POLL_MS);
      }
    }
    if (name === "read_messages") {
      const agent = this.#agent(args.agent);
      const limit = isNumber(args.limit) ? Math.max(1, Math.min(RECENT_LIMIT, Math.floor(args.limit))) : 10;
      return {
        agent: agent.name,
        messages: this.#options.recentMessages(agent.id, limit).map((message) => ({
          ...message,
          text: clip(message.text, TEXT_PER_MESSAGE),
        })),
      };
    }
    if (name === "list_decisions") {
      const names = new Map(this.#options.listAgents().map((agent) => [agent.id, agent.name]));
      return {
        waiting: this.#options.attentionItems().map((item) => ({
          kind: item.kind,
          agent: names.get(item.agentId) ?? item.agentId,
          since: item.createdAt,
          // An approval has no summary: its command can hold a secret, so only its kind shows.
          ...(item.summary ? { summary: item.summary } : {}),
          ...(item.origin ? { site: item.origin } : {}),
          ...(item.url ? { url: item.url } : {}),
        })),
        loopGates: this.#options.loopDecisions().map((decision) => ({
          title: decision.title,
          kind: decision.kind,
          ...(decision.amountUsd === undefined ? {} : { amountUsd: decision.amountUsd }),
          ...(decision.detail ? { detail: clip(decision.detail, 500) } : {}),
          since: new Date(decision.createdAt).toISOString(),
        })),
        heldForLater: this.#options.heldItems().map((item) => ({
          kind: item.kind,
          agent: names.get(item.agentId) ?? item.agentId,
          title: item.title,
          ...(item.options ? { options: item.options } : {}),
          since: new Date(item.createdAt).toISOString(),
        })),
        answer: "The owner answers these in the Atelier app.",
      };
    }
    throw new ToolRefusal(`Unknown tool ${name}.`);
  }

  #agent(value: unknown): OwnerMcpAgent {
    const wanted = isString(value) ? value.trim() : "";
    const agents = this.#options.listAgents();
    const found =
      agents.find((agent) => agent.id === wanted) ??
      agents.filter((agent) => agent.name.toLowerCase() === wanted.toLowerCase()).at(0);
    if (!found) throw new ToolRefusal(`No agent is called ${wanted || "that"}. Call list_agents.`);
    return found;
  }

  #throttled(address: string): boolean {
    const now = this.#now();
    const recent = (this.#failures.get(address) ?? []).filter((time) => now - time < MINUTE_MS);
    if (recent.length) this.#failures.set(address, recent);
    else this.#failures.delete(address);
    return recent.length >= FAILURES_PER_MINUTE;
  }

  #refuse(response: ServerResponse, address: string, status: number, message: string): void {
    this.#failures.set(address, [...(this.#failures.get(address) ?? []), this.#now()]);
    plain(response, status, message);
  }
}

function plain(response: ServerResponse, status: number, message: string): void {
  response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  response.end(JSON.stringify({ error: message }));
}

/**
 * Every answer leaves Atelier for the chat app's servers, so a credential in an agent's reply, a
 * message or a decision goes first, and a value saved in Secrets with it. Email addresses stay.
 */
function text(value: ToolAnswer): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(redactSecretValues(value), null, 1) }] };
}

function clip(value: string, limit: number): string {
  return value.length > limit ? `${value.slice(0, limit - 1)}…` : value;
}
