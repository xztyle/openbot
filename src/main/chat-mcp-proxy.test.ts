// @vitest-environment node

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { McpServerConfig } from "@openbot/contracts/ipc";
import { Effect } from "effect";
import { expect, it, vi } from "vitest";
import { runCauseEffect } from "../backend/effect-boundary";
import { readJsonBody } from "../backend/local-mcp-bridge";
import { mcpFailure } from "../backend/mcp-effects";
import { NO_MCP_TOOL_RUNTIMES } from "../backend/mcp-provider-shapes";
import { ChatMcpPolicyStore } from "./chat-mcp-policy-store";
import { ChatMcpProxy } from "./chat-mcp-proxy";
import { ChatMcpService } from "./chat-mcp-service";

async function fakeApp() {
  const calls: string[] = [];
  let readOnly = true;
  const server = createServer((req, res) => {
    const mcp = new Server({ name: "app", version: "1" }, { capabilities: { tools: {} } });
    mcp.setRequestHandler(ListToolsRequestSchema, () => ({
      tools: [
        { name: "read", inputSchema: { type: "object" }, annotations: { readOnlyHint: readOnly } },
        { name: "send", inputSchema: { type: "object" }, annotations: { readOnlyHint: false } },
        { name: "unknown", inputSchema: { type: "object" } },
      ],
    }));
    mcp.setRequestHandler(CallToolRequestSchema, ({ params }) => {
      calls.push(`${req.headers.authorization}:${params.name}`);
      return { content: [{ type: "text", text: `${req.headers.authorization}:${params.name}` }] };
    });
    const transport = new StreamableHTTPServerTransport({});
    void runCauseEffect(
      Effect.gen(function* () {
        yield* Effect.promise(() => mcp.connect(transport));
        const body = yield* readJsonBody(req);
        yield* Effect.promise(() => transport.handleRequest(req, res, body));
      }).pipe(Effect.ensuring(Effect.promise(() => mcp.close()))),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No test listener.");
  return {
    url: `http://127.0.0.1:${address.port}/mcp`,
    calls,
    reclassify: () => {
      readOnly = false;
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
function config(id: string, url: string, token: string): McpServerConfig {
  return {
    id,
    name: id,
    transport: "http",
    enabled: true,
    command: "",
    args: [],
    env: [],
    envPassthrough: [],
    workingDirectory: "",
    url,
    headers: [{ key: "Authorization", value: token }],
  };
}
async function connect(config: McpServerConfig | undefined) {
  if (!config) throw new Error("Missing test account.");
  const client = new Client({ name: "agent-test", version: "1" }, { capabilities: {} });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(config.url), {
      requestInit: { headers: Object.fromEntries(config.headers.map(({ key, value }) => [key, value])) },
    }),
  );
  return client;
}
it("keeps accounts apart, rejects cached writes, revokes access and persists the chat choices", async () => {
  const root = await mkdtemp(join(tmpdir(), "openbot-chat-apps-"));
  const app = await fakeApp();
  let configs = [config("job-one", app.url, "Bearer one"), config("job-two", app.url, "Bearer two")];
  const policies = new ChatMcpPolicyStore(join(root, "permissions.json"));
  await runCauseEffect(policies.load());
  await runCauseEffect(policies.save("agent:one", { grants: [{ connectionId: "job-one", mode: "read" }] }));
  await runCauseEffect(policies.save("channel:group", { grants: [{ connectionId: "job-two", mode: "write" }] }));
  const proxy = new ChatMcpProxy({
    policies,
    configs: () => configs,
    chatKey: (id) => id,
    runtimes: () => NO_MCP_TOOL_RUNTIMES,
    authorization: () => Effect.succeed(null),
  });
  const clients: Client[] = [];
  try {
    await runCauseEffect(proxy.start());
    expect(proxy.forThread("unknown", configs)).toEqual([]);
    const scopedOne = proxy.forThread("agent:one", configs);
    const scopedTwo = proxy.forThread("channel:group", configs);
    expect(scopedOne.map((item) => item.id)).toEqual(["chat-job-one"]);
    expect(JSON.stringify(scopedOne)).not.toContain("Bearer one");
    const one = await connect(scopedOne[0]);
    clients.push(one);
    const two = await connect(scopedTwo[0]);
    clients.push(two);
    expect((await one.listTools()).tools.map((tool) => tool.name)).toEqual(["read"]);
    expect(await one.callTool({ name: "send", arguments: {} })).toMatchObject({ isError: true });
    await one.callTool({ name: "read", arguments: {} });
    await two.callTool({ name: "send", arguments: {} });
    expect(app.calls).toEqual(["Bearer one:read", "Bearer two:send"]);
    await runCauseEffect(policies.save("channel:group", { grants: [{ connectionId: "job-two", mode: "read" }] }));
    proxy.revoke("channel:group");
    expect(await two.callTool({ name: "send", arguments: {} })).toMatchObject({ isError: true });
    expect(app.calls).toHaveLength(2);
    app.reclassify();
    expect(await one.callTool({ name: "read", arguments: {} })).toMatchObject({ isError: true });
    expect((await one.listTools()).tools).toEqual([]);
    expect(app.calls).toHaveLength(2);
    const service = new ChatMcpService({
      policies,
      proxy,
      agents: () => [{ id: "one" }],
      channelExists: () => true,
      configs: () => configs,
      changed: () => Effect.void,
    });
    configs = configs.filter((item) => item.id !== "job-one");
    const snapshot = service.snapshot({ kind: "agent", id: "one" });
    expect(snapshot.grants).toEqual([]);
    await runCauseEffect(service.save({ kind: "agent", id: "one" }, { grants: snapshot.grants }));
    await expect(one.callTool({ name: "read", arguments: {} })).rejects.toThrow();
    const reopened = new ChatMcpPolicyStore(policies.path);
    await runCauseEffect(reopened.load());
    expect(reopened.get("channel:group").grants).toEqual([{ connectionId: "job-two", mode: "read" }]);
  } finally {
    await Promise.all(clients.map((client) => client.close()));
    await runCauseEffect(proxy.close());
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});

it("restarts an app process after it exits", async () => {
  const root = await mkdtemp(join(tmpdir(), "openbot-app-restart-"));
  const sdk = pathToFileURL(resolve("node_modules/@modelcontextprotocol/sdk/dist/esm")).href;
  const file = join(root, "app.mjs");
  await writeFile(
    file,
    `import { Server } from ${JSON.stringify(`${sdk}/server/index.js`)};
import { StdioServerTransport } from ${JSON.stringify(`${sdk}/server/stdio.js`)};
import { ListToolsRequestSchema, CallToolRequestSchema } from ${JSON.stringify(`${sdk}/types.js`)};
const server = new Server({name:"process-test",version:"1"},{capabilities:{tools:{}}});
server.setRequestHandler(ListToolsRequestSchema,()=>({tools:[{name:"pid",inputSchema:{type:"object"},annotations:{readOnlyHint:true}}]}));
server.setRequestHandler(CallToolRequestSchema,()=>({content:[{type:"text",text:String(process.pid)}]}));
await server.connect(new StdioServerTransport());`,
  );
  const policies = new ChatMcpPolicyStore(join(root, "policy.json"));
  await runCauseEffect(policies.load());
  await runCauseEffect(policies.save("agent:one", { grants: [{ connectionId: "process", mode: "read" }] }));
  const configs = [
    { ...config("process", "", ""), transport: "stdio" as const, command: process.execPath, args: [file], headers: [] },
  ];
  const proxy = new ChatMcpProxy({
    policies,
    configs: () => configs,
    chatKey: (id) => id,
    runtimes: () => NO_MCP_TOOL_RUNTIMES,
    authorization: () => Effect.succeed(null),
  });
  let client: Client | null = null;
  try {
    await runCauseEffect(proxy.start());
    client = await connect(proxy.forThread("agent:one", configs)[0]);
    const readPid = async () => {
      if (!client) throw new Error("Missing test client.");
      const reply = await client.callTool({ name: "pid", arguments: {} });
      if (!Array.isArray(reply.content)) throw new Error("No app reply.");
      const part = reply.content[0];
      if (part?.type !== "text" || typeof part.text !== "string") throw new Error("No app PID.");
      return Number(part.text);
    };
    const before = await readPid();
    process.kill(before, "SIGTERM");
    await vi.waitFor(async () => expect(await readPid()).not.toBe(before));
  } finally {
    await client?.close();
    await runCauseEffect(proxy.close());
    await rm(root, { recursive: true, force: true });
  }
});

it("gives deterministic checks only their selected account and fresh read tools, even in a write-enabled chat", async () => {
  const root = await mkdtemp(join(tmpdir(), "openbot-event-check-mcp-"));
  const app = await fakeApp();
  const policies = new ChatMcpPolicyStore(join(root, "policy.json"));
  await runCauseEffect(policies.load());
  await runCauseEffect(policies.save("agent:one", { grants: [{ connectionId: "job-one", mode: "write" }] }));
  const configs = [config("job-one", app.url, "Bearer one"), config("job-two", app.url, "Bearer two")];
  const proxy = new ChatMcpProxy({
    policies,
    configs: () => configs,
    chatKey: (id) => id,
    runtimes: () => NO_MCP_TOOL_RUNTIMES,
    authorization: () => Effect.succeed(null),
  });
  try {
    expect(proxy.readAccounts("agent:one")).toEqual([{ id: "job-one", name: "job-one" }]);
    await expect(runCauseEffect(proxy.read("agent:one", "job-two", () => Effect.void))).rejects.toThrow();
    const tools = await runCauseEffect(proxy.read("agent:one", "job-one", (session) => Effect.succeed(session.tools)));
    expect(tools.map((tool) => tool.name)).toEqual(["read"]);
    await expect(
      runCauseEffect(proxy.read("agent:one", "job-one", (session) => session.call("send", {}))),
    ).rejects.toThrow();
    const result = await runCauseEffect(proxy.read("agent:one", "job-one", (session) => session.call("read", {})));
    expect(JSON.stringify(result)).not.toContain("Bearer one");
    expect(app.calls).toEqual(["Bearer one:read"]);
    await expect(
      runCauseEffect(
        proxy.read("agent:one", "job-one", (session) =>
          Effect.gen(function* () {
            app.reclassify();
            yield* session.call("read", {});
          }),
        ),
      ),
    ).rejects.toThrow();
    expect(app.calls).toHaveLength(1);
    await expect(
      runCauseEffect(
        proxy.read("agent:one", "job-one", (session) =>
          Effect.gen(function* () {
            yield* policies.save("agent:one", { grants: [] }).pipe(Effect.mapError(mcpFailure));
            proxy.revoke("agent:one");
            yield* session.call("read", {});
          }),
        ),
      ),
    ).rejects.toThrow();
    expect(app.calls).toHaveLength(1);
  } finally {
    await runCauseEffect(proxy.close());
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});
