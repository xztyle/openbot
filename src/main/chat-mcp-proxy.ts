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
import type { EventCheckArguments, EventCheckReadSession } from "../backend/event-check-reader";
import { readJsonBody } from "../backend/local-mcp-bridge";
import { isSlackApp, mayCallChatTool } from "../backend/mcp-chat-policy";
import { McpOperationError, mcpCall, mcpFailure, mcpSync } from "../backend/mcp-effects";
import {
  type McpAuthorizationSource,
  type McpToolRuntimeSource,
  usableMcpServer,
} from "../backend/mcp-provider-shapes";
import { mcpSecretValues, redactMcpValues } from "../backend/mcp-redaction";
import { redactMcpResult } from "../backend/mcp-result-redaction";
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
  secrets: string[];
  connectionId: string;
  users: number;
  obsolete: boolean;
}

interface ReadAccess {
  key: string;
  config: McpServerConfig;
  controller: AbortController;
  policy: string;
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
    Effect.runFork(this.#retireRemoved());
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
    Effect.runFork(this.#retireRemoved());
    for (const [controller, chat] of this.#running) if (chat === key) controller.abort();
  }
  readAccounts(threadId: string) {
    const key = this.options.chatKey(threadId);
    if (!key) return [];
    return this.options
      .configs()
      .filter((config) => config.enabled && this.#mode(key, config.id))
      .map((config) => ({ id: config.id, name: config.name }));
  }
  read<A>(
    threadId: string,
    connectionId: string,
    use: (session: EventCheckReadSession) => Effect.Effect<A, McpOperationError>,
  ): Effect.Effect<A, McpOperationError> {
    return Effect.acquireUseRelease(
      mcpCall(() => {
        const key = this.options.chatKey(threadId);
        const config = this.options.configs().find((item) => item.id === connectionId && item.enabled);
        if (!key || !config || !this.#mode(key, connectionId)) throw new Error(sourceText("error.mcp.chatDenied"));
        const controller = new AbortController();
        this.#running.set(controller, key);
        const access: ReadAccess = { key, config, controller, policy: JSON.stringify(this.options.policies.get(key)) };
        return access;
      }),
      (access) =>
        Effect.acquireUseRelease(
          this.#upstream(access.config),
          (upstream) => this.#readSession(threadId, access, upstream).pipe(Effect.flatMap(use)),
          (upstream) => this.#releaseUpstream(upstream),
        ),
      (access) =>
        Effect.sync(() => {
          access.controller.abort();
          this.#running.delete(access.controller);
        }),
    ).pipe(
      Effect.timeout("45 seconds"),
      Effect.mapError(mcpFailure),
      Effect.catchCause(() =>
        mcpSync(() => {
          throw new Error(sourceText("error.mcp.chatUnreachable"));
        }),
      ),
    );
  }
  readonly #readSession = Effect.fn("ChatMcpProxy.readSession")(function* (
    this: ChatMcpProxy,
    threadId: string,
    access: ReadAccess,
    upstream: Upstream,
  ) {
    const valid = () =>
      !access.controller.signal.aborted &&
      this.options.chatKey(threadId) === access.key &&
      JSON.stringify(this.options.policies.get(access.key)) === access.policy &&
      this.options
        .configs()
        .some((config) => config.enabled && JSON.stringify(config) === JSON.stringify(access.config));
    const tools = yield* mcpCall(() => this.#safeTools(upstream.client, access.controller.signal));
    if (JSON.stringify(tools).length > 512_000) throw new Error("App tool metadata too large.");
    if (!valid()) throw new Error(sourceText("error.mcp.chatDenied"));
    const allowed = tools.filter((tool) => mayCallChatTool("read", tool, access.config));
    const session: EventCheckReadSession = {
      valid,
      tools: allowed
        .filter((tool) => tool.name.length <= 256 && JSON.stringify(tool.inputSchema).length <= 16000)
        .slice(0, 500)
        .map((tool) => ({
          name: redactMcpValues(tool.name, upstream.secrets),
          description: redactMcpValues(tool.description ?? "", upstream.secrets).slice(0, 4096),
          inputSchemaJson: this.#redactJson(tool.inputSchema, upstream.secrets),
        })),
      call: (toolName, args) => this.#readTool(access, upstream, valid, toolName, args),
    };
    return session;
  });
  readonly #readTool = Effect.fn("ChatMcpProxy.readTool")(function* (
    this: ChatMcpProxy,
    access: { config: McpServerConfig; controller: AbortController },
    upstream: Upstream,
    valid: () => boolean,
    toolName: string,
    args: EventCheckArguments,
  ) {
    const tools = yield* mcpCall(() => this.#safeTools(upstream.client, access.controller.signal));
    const tool = tools.find((item) => item.name === toolName);
    if (!valid() || !tool || !mayCallChatTool("read", tool, access.config))
      throw new Error(sourceText("error.mcp.chatDenied"));
    const result = yield* Effect.tryPromise({
      try: (signal) =>
        upstream.client.callTool({ name: toolName, arguments: args }, undefined, {
          signal: AbortSignal.any([signal, access.controller.signal]),
          timeout: 30_000,
        }),
      catch: () => new McpOperationError({ cause: new Error(sourceText("error.mcp.chatUnreachable")) }),
    });
    if (!valid()) throw new Error(sourceText("error.mcp.chatDenied"));
    const encoded = JSON.stringify(result);
    if (encoded.length > 512_000) throw new Error("App result too large.");
    return redactMcpResult(result, upstream.secrets);
  });
  #redactJson(value: unknown, secrets: string[]): string {
    return JSON.stringify(redactMcpResult(value, secrets));
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
    ).pipe(Effect.ensuring(this.#releaseUpstream(upstream)));
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
      held.users++;
      return held;
    }
    for (const upstream of this.#upstreams.values()) {
      if (upstream.connectionId !== config.id) continue;
      upstream.obsolete = true;
      if (upstream.users === 0) yield* this.#releaseUpstream(upstream);
    }
    const client = new Client({ name: "openbot-chat-gateway", version: "1" }, { capabilities: {} });
    const transport = createMcpTransport(resolved);
    const upstream: Upstream = {
      client,
      ready: Promise.resolve(),
      connectionId: config.id,
      users: 0,
      obsolete: false,
      secrets: [...mcpSecretValues([config]), ...(resolved.authorization ? [resolved.authorization] : [])],
    };
    client.onclose = () => {
      if (this.#upstreams.get(identity) === upstream) this.#upstreams.delete(identity);
    };
    upstream.ready = this.#connect(upstream, transport);
    this.#upstreams.set(identity, upstream);
    yield* mcpCall(() => upstream.ready).pipe(
      Effect.onError(() => Effect.sync(() => this.#upstreams.delete(identity))),
    );
    upstream.users++;
    return upstream;
  });
  readonly #releaseUpstream = Effect.fn("ChatMcpProxy.releaseUpstream")(function* (
    this: ChatMcpProxy,
    upstream: Upstream,
  ) {
    upstream.users = Math.max(0, upstream.users - 1);
    if (upstream.obsolete && upstream.users === 0) {
      for (const [identity, held] of this.#upstreams) if (held === upstream) this.#upstreams.delete(identity);
      yield* mcpCall(() => upstream.client.close()).pipe(Effect.catch(() => Effect.void));
    }
  });
  readonly #retireRemoved = Effect.fn("ChatMcpProxy.retireRemoved")(function* (this: ChatMcpProxy) {
    const enabled = new Set(
      this.options
        .configs()
        .filter((config) => config.enabled)
        .map((config) => config.id),
    );
    for (const upstream of this.#upstreams.values()) {
      if (enabled.has(upstream.connectionId)) continue;
      upstream.obsolete = true;
      if (upstream.users === 0) yield* this.#releaseUpstream(upstream);
    }
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
  async #safeTools(client: Client, signal?: AbortSignal): Promise<Tool[]> {
    try {
      return await this.#tools(client, signal);
    } catch {
      throw new Error(sourceText("error.mcp.chatUnreachable"));
    }
  }
  // Read current metadata before every authorization, including servers without change notifications.
  async #tools(client: Client, signal?: AbortSignal): Promise<Tool[]> {
    const tools: Tool[] = [];
    const seen = new Set<string>();
    let cursor: string | undefined;
    let pages = 0;
    do {
      if (++pages > 20) throw new Error("Too many app tool pages.");
      const page = await client.listTools(cursor ? { cursor } : undefined, { timeout: 30_000, signal });
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
