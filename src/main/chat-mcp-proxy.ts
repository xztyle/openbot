import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { createServer, type Server as HttpServer, type IncomingMessage, type ServerResponse } from "node:http";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema, type Tool } from "@modelcontextprotocol/sdk/types.js";
import { COMPUTER_USE_MCP_SERVER_ID, type McpServerConfig } from "@openbot/contracts/ipc";
import { sourceText } from "@openbot/i18n/source";
import { Effect } from "effect";
import { runCauseEffect } from "../backend/effect-boundary";
import { readJsonBody } from "../backend/local-mcp-bridge";
import { isSlackApp, mayCallChatTool } from "../backend/mcp-chat-policy";
import { type McpOperationError, mcpCall } from "../backend/mcp-effects";
import {
  type McpAuthorizationSource,
  type McpToolRuntimeSource,
  usableMcpServer,
} from "../backend/mcp-provider-shapes";
import { createMcpTransport } from "../backend/mcp-transport";
import type { ChatMcpPolicyStore } from "./chat-mcp-policy-store";

interface Options {
  stateDirectory?: string;
  policies: ChatMcpPolicyStore;
  configs: () => readonly McpServerConfig[];
  chatKey: (threadId: string) => string | null;
  authorization: McpAuthorizationSource;
  runtimes: McpToolRuntimeSource;
}
interface Upstream {
  client: Client;
  ready: Promise<void>;
}

/** Owns app transports. Provider processes receive scoped loopback URLs, never the app credentials. */
export class ChatMcpProxy {
  readonly #running = new Map<AbortController, string>();
  readonly #upstreams = new Map<string, Upstream>();
  #server: HttpServer | null = null;
  #port: number | null = null;
  constructor(readonly options: Options) {}
  readonly start = Effect.fn("ChatMcpProxy.start")(function* (this: ChatMcpProxy) {
    const server = createServer((request, response) => {
      void runCauseEffect(this.#handle(request, response));
    });
    yield* mcpCall(
      () =>
        new Promise<void>((resolve, reject) => {
          server.once("error", reject);
          server.listen(0, "127.0.0.1", () => {
            server.off("error", reject);
            resolve();
          });
        }),
    );
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("No chat app proxy port.");
    this.#server = server;
    this.#port = address.port;
  });
  forThread(threadId: string, configs: readonly McpServerConfig[]): McpServerConfig[] {
    const key = this.options.chatKey(threadId);
    const builtIn = configs.filter((config) => config.id === COMPUTER_USE_MCP_SERVER_ID);
    if (!key || this.#port === null) return builtIn;
    const grants = this.options.policies.get(key).grants;
    const revision = createHash("sha256").update(JSON.stringify(grants)).digest("hex").slice(0, 16);
    const apps = configs.filter((config) => grants.some((grant) => grant.connectionId === config.id));
    return [
      ...builtIn,
      ...apps.map((config) => ({
        ...config,
        id: `chat-${config.id}`,
        name: `${config.name}_${config.id.slice(-8)}`,
        transport: "http" as const,
        command: "",
        args: [],
        env: [],
        envPassthrough: [],
        workingDirectory: "",
        url: `http://127.0.0.1:${this.#port}/chat-mcp/${Buffer.from(key).toString("base64url")}/${config.id}?revision=${revision}`,
        headers: [{ key: "Authorization", value: `Bearer ${this.#token(key, config.id)}` }],
      })),
    ];
  }
  revoke(key: string): void {
    for (const [controller, chat] of this.#running) if (chat === key) controller.abort();
  }
  #token(key: string, connection: string): string {
    return createHmac("sha256", this.options.policies.secret()).update(`${key}\0${connection}`).digest("hex");
  }
  #access(request: IncomingMessage) {
    const path = new URL(request.url ?? "/", "http://localhost").pathname;
    const match = /^\/chat-mcp\/([a-zA-Z0-9_-]{1,256})\/([a-zA-Z0-9_-]{1,128})$/.exec(path);
    if (!match?.[1] || !match[2]) return null;
    const key = Buffer.from(match[1], "base64url").toString("utf8");
    const config = this.options.configs().find((item) => item.id === match[2] && item.enabled);
    const received = Buffer.from(request.headers.authorization ?? "");
    const expected = Buffer.from(`Bearer ${this.#token(key, match[2])}`);
    if (!config || received.length !== expected.length || !timingSafeEqual(received, expected)) return null;
    if (!this.#mode(key, config.id)) return null;
    return { key, config };
  }
  #mode(key: string, id: string) {
    return this.options.policies.get(key).grants.find((grant) => grant.connectionId === id)?.mode;
  }
  readonly #handle = Effect.fn("ChatMcpProxy.handle")(function* (
    this: ChatMcpProxy,
    request: IncomingMessage,
    response: ServerResponse,
  ) {
    const access = this.#access(request);
    if (!access) {
      response.writeHead(403);
      response.end();
      return;
    }
    if (request.method !== "POST") {
      response.writeHead(405, { allow: "POST" });
      response.end();
      return;
    }
    const result = this.#serve(access.key, access.config, request, response).pipe(
      Effect.catch(() =>
        Effect.sync(() => {
          if (!response.headersSent) {
            response.writeHead(502);
            response.end(JSON.stringify({ error: sourceText("error.mcp.chatUnreachable") }));
          }
        }),
      ),
    );
    yield* result;
  });
  readonly #serve = Effect.fn("ChatMcpProxy.serve")(function* (
    this: ChatMcpProxy,
    key: string,
    config: McpServerConfig,
    request: IncomingMessage,
    response: ServerResponse,
  ) {
    const upstream = yield* this.#upstream(config);
    const mcp = this.#serverFor(key, config, upstream);
    const transport = new StreamableHTTPServerTransport({});
    yield* Effect.acquireUseRelease(
      mcpCall(() => mcp.connect(transport)),
      () =>
        Effect.gen(function* () {
          const body = yield* readJsonBody(request, 4 * 1024 * 1024);
          yield* mcpCall(() => transport.handleRequest(request, response, body));
        }),
      () => mcpCall(() => mcp.close()).pipe(Effect.catch(() => Effect.void)),
    );
  });
  #serverFor(key: string, config: McpServerConfig, upstream: Upstream): Server {
    const mcp = new Server({ name: "openbot-chat-app", version: "1" }, { capabilities: { tools: {} } });
    const allowed = (tool: Tool) => mayCallChatTool(this.#mode(key, config.id), tool, config);
    mcp.setRequestHandler(ListToolsRequestSchema, async () => {
      const tools = await this.#safeTools(upstream.client);
      return {
        tools: this.options.configs().some((item) => item.id === config.id && item.enabled)
          ? tools.filter(allowed)
          : [],
      };
    });
    mcp.setRequestHandler(CallToolRequestSchema, async ({ params }, extra) => {
      const tools = await this.#safeTools(upstream.client);
      const tool = tools.find((item) => item.name === params.name);
      if (!this.options.configs().some((item) => item.id === config.id && item.enabled) || !tool || !allowed(tool))
        return { isError: true, content: [{ type: "text", text: sourceText("error.mcp.chatDenied") }] };
      const controller = new AbortController();
      this.#running.set(controller, key);
      try {
        return await upstream.client.callTool(params, undefined, {
          signal: AbortSignal.any([extra.signal, controller.signal]),
          timeout: 300_000,
        });
      } catch {
        return { isError: true, content: [{ type: "text", text: sourceText("error.mcp.chatUnreachable") }] };
      } finally {
        this.#running.delete(controller);
      }
    });
    return mcp;
  }
  readonly #upstream = Effect.fn("ChatMcpProxy.upstream")(function* (this: ChatMcpProxy, config: McpServerConfig) {
    const launched = yield* this.#launchConfig(config);
    const resolved = yield* usableMcpServer(launched, this.options.runtimes(), this.options.authorization);
    if (resolved.error !== undefined) throw new Error("Unavailable app transport.");
    const identity = createHash("sha256").update(JSON.stringify(resolved)).digest("hex");
    const held = this.#upstreams.get(identity);
    if (held) {
      yield* mcpCall(() => held.ready);
      return held;
    }
    const client = new Client({ name: "openbot-chat-gateway", version: "1" }, { capabilities: {} });
    const transport = createMcpTransport(resolved);
    const upstream: Upstream = { client, ready: Promise.resolve() };
    client.onclose = () => {
      if (this.#upstreams.get(identity) === upstream) this.#upstreams.delete(identity);
    };
    upstream.ready = this.#connect(upstream, transport);
    this.#upstreams.set(identity, upstream);
    yield* mcpCall(() => upstream.ready).pipe(
      Effect.onError(() => Effect.sync(() => this.#upstreams.delete(identity))),
    );
    return upstream;
  });
  readonly #launchConfig = Effect.fn("ChatMcpProxy.launchConfig")(function* (
    this: ChatMcpProxy,
    config: McpServerConfig,
  ) {
    if (!isSlackApp(config)) return config;
    const env = [...config.env];
    if (!env.some((item) => item.key === "SLACK_MCP_ADD_MESSAGE_TOOL"))
      env.push({ key: "SLACK_MCP_ADD_MESSAGE_TOOL", value: "true" });
    if (this.options.stateDirectory) {
      const path = join(this.options.stateDirectory, createHash("sha256").update(config.id).digest("hex"));
      yield* mcpCall(() => mkdir(path, { recursive: true, mode: 0o700 }));
      env.push(
        { key: "SLACK_MCP_USERS_CACHE", value: join(path, "users.json") },
        { key: "SLACK_MCP_CHANNELS_CACHE", value: join(path, "channels.json") },
      );
    }
    return { ...config, env };
  });
  async #connect(upstream: Upstream, transport: ReturnType<typeof createMcpTransport>): Promise<void> {
    try {
      await upstream.client.connect(transport, { timeout: 30_000 });
    } catch (error) {
      await upstream.client.close().catch(() => undefined);
      throw error;
    }
  }
  async #safeTools(client: Client): Promise<Tool[]> {
    try {
      return await this.#tools(client);
    } catch {
      throw new Error(sourceText("error.mcp.chatUnreachable"));
    }
  }
  // Read current metadata before every authorization, including servers without change notifications.
  async #tools(client: Client): Promise<Tool[]> {
    const tools: Tool[] = [];
    const seen = new Set<string>();
    let cursor: string | undefined;
    do {
      const page = await client.listTools(cursor ? { cursor } : undefined, { timeout: 30_000 });
      tools.push(...page.tools);
      cursor = page.nextCursor;
      if (tools.length > 10_000 || (cursor && seen.has(cursor))) throw new Error("Invalid app tools pagination.");
      if (cursor) seen.add(cursor);
    } while (cursor);
    return tools;
  }
  readonly close = Effect.fn("ChatMcpProxy.close")(function* (
    this: ChatMcpProxy,
  ): Effect.fn.Return<void, McpOperationError> {
    for (const controller of this.#running.keys()) controller.abort();
    yield* Effect.forEach(this.#upstreams.values(), (upstream) =>
      mcpCall(() => upstream.client.close()).pipe(Effect.catch(() => Effect.void)),
    );
    this.#upstreams.clear();
    if (this.#server) yield* mcpCall(() => new Promise<void>((resolve) => this.#server?.close(() => resolve())));
    this.#server = null;
    this.#port = null;
  });
}
