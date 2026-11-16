// Checks that "Apps for this chat" fills a connection for the agent that calls it. The real agent
// service and the real chat-app proxy (`createChatMcp`) run on a temporary profile, with a key in
// Secrets and two agents, one in General and one in another space. A local MCP server stands in for
// Motion: it records the headers of each request, and its `whoami` tool returns them. The MCP row has
// the headers that production uses for Motion, and the `*` key grants it to every chat. Each agent
// calls `whoami` through the URL that its own thread gets, and must arrive as itself, with its space
// and the shared token. The Test path must send the token too, and leave out the agent headers.
// Run: `bun scripts/chat-mcp-agent-values-e2e.ts`. Writes .openbot-build/chat-mcp-agent-values-e2e/report.json.
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { McpServerConfig } from "@openbot/contracts/ipc";
import { Effect } from "effect";

const OUT = resolve(import.meta.dirname, "../.openbot-build/chat-mcp-agent-values-e2e");
const SHARED_TOKEN = "motion-shared-token-5d1e";
const STEP_DEADLINE_MS = 30_000;

const root = await mkdtemp(join(tmpdir(), "openbot-chat-mcp-values-"));
const userData = join(root, "user-data");
const home = join(root, "home");
process.env.HOME = home;
mkdirSync(home, { recursive: true });

const { AgentApiKeys, SHARED_API_KEY_SCOPE } = await import("../src/backend/agent-api-keys");
const { AgentService } = await import("../src/backend/agent-service");
const { AgentStore } = await import("../src/backend/agent-store");
const { runCauseEffect } = await import("../src/backend/effect-boundary");
const { MailboxStore } = await import("../src/backend/mailbox-store");
const { OpenBotDatabase } = await import("../src/backend/openbot-database");
const { createChatMcp } = await import("../src/main/create-chat-mcp");
const { NO_MCP_TOOL_RUNTIMES } = await import("../src/backend/mcp-provider-shapes");
type AgentBrowserHost = import("../src/backend/agent/turn-lifecycle").AgentBrowserHost;

/** The headers and the method of each request the stand-in for Motion got, lower-cased as Node gives them. */
const seen: Record<string, string | undefined>[] = [];
const WATCHED = [
  "authorization",
  "x-motion-agent",
  "x-motion-agent-name",
  "x-motion-workspace-key",
  "x-motion-workspace-name",
];

async function body(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

function json(response: ServerResponse, value: unknown): void {
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify(value));
}

function watched(request: IncomingMessage): Record<string, string | undefined> {
  return Object.fromEntries(
    WATCHED.map((name) => {
      const value = request.headers[name];
      return [name, Array.isArray(value) ? value.join(",") : value];
    }),
  );
}

async function motionStandIn(): Promise<{ url: string; close: () => Promise<void> }> {
  const server: Server = createServer((request, response) => {
    void (async () => {
      if (request.method !== "POST") {
        response.writeHead(405).end();
        return;
      }
      const headers = watched(request);
      const message: { id?: number | string; method: string } = JSON.parse(await body(request));
      seen.push({ ...headers, method: message.method });
      if (message.id === undefined) {
        response.writeHead(202).end();
        return;
      }
      if (message.method === "initialize")
        return json(response, {
          jsonrpc: "2.0",
          id: message.id,
          result: {
            protocolVersion: "2025-06-18",
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: "motion-e2e", version: "1" },
          },
        });
      if (message.method === "tools/list")
        return json(response, {
          jsonrpc: "2.0",
          id: message.id,
          result: {
            tools: [
              {
                name: "whoami",
                description: "Reads who called.",
                inputSchema: { type: "object", properties: {} },
                annotations: { readOnlyHint: true },
              },
            ],
          },
        });
      if (message.method === "tools/call")
        return json(response, {
          jsonrpc: "2.0",
          id: message.id,
          result: { content: [{ type: "text", text: JSON.stringify(headers) }] },
        });
      return json(response, { jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "unknown" } });
    })().catch((error: unknown) => response.writeHead(500).end(String(error)));
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  assert.ok(address !== null && typeof address === "object");
  return {
    url: `http://127.0.0.1:${address.port}/mcp`,
    close: () => new Promise<void>((done) => server.close(() => done())),
  };
}

const unused = () => {
  throw new Error("This check does not use the browser.");
};
const agentBrowser: AgentBrowserHost = {
  listTabs: () => [],
  beginTakeover: unused,
  endTakeover: () => {},
  userControlTabFor: () => null,
  awaitUserControlRelease: unused,
  resolveUploadTarget: unused,
  handleDynamicTool: unused,
  onChanged: () => () => {},
  onControlChanged: () => () => {},
  onDocumentChanged: () => () => {},
  clearControls: () => {},
  endControl: () => {},
  close: () => Effect.void,
  clearAgentSession: () => Effect.void,
};

interface StepResult {
  name: string;
  passed: boolean;
  detail?: unknown;
  error?: string;
}
const report: { passed: boolean; steps: StepResult[] } = { passed: false, steps: [] };

async function step<T>(name: string, run: () => Promise<T>): Promise<T> {
  process.stdout.write(`- ${name}\n`);
  let deadline: ReturnType<typeof setTimeout> | undefined;
  try {
    const value = await Promise.race([
      run(),
      new Promise<never>((_, reject) => {
        deadline = setTimeout(() => reject(new Error(`No result within ${STEP_DEADLINE_MS} ms.`)), STEP_DEADLINE_MS);
      }),
    ]);
    report.steps.push({ name, passed: true, detail: value });
    return value;
  } catch (error) {
    report.steps.push({ name, passed: false, error: error instanceof Error ? error.message : String(error) });
    throw error;
  } finally {
    clearTimeout(deadline);
  }
}

const motion = await motionStandIn();
const database = new OpenBotDatabase(userData);
const store = new AgentStore(userData, home, database);
const mailbox = new MailboxStore(userData, store.sharedRoot, store.database);
const keys = new AgentApiKeys(join(userData, "agent-api-keys"));
await runCauseEffect(store.initialize());
await runCauseEffect(mailbox.initialize());
const agents = new AgentService({ store, mailbox, browser: agentBrowser, agentApiKeys: keys });
/** The chat-app proxy, once setup starts it. */
const proxy: { current: Effect.Success<ReturnType<typeof createChatMcp>> | null } = { current: null };
const clients: Client[] = [];

/** Calls `whoami` as an agent's provider would: through the loopback URL its thread gets. */
async function whoamiAs(threadId: string): Promise<Record<string, string | undefined>> {
  const chatMcp = proxy.current;
  assert.ok(chatMcp, "The chat-app proxy is not running.");
  const handed = chatMcp.scope(threadId, agents.storedMcpServers()).find((config) => config.name.startsWith("motion"));
  assert.ok(handed, "The thread was not handed the motion connection.");
  assert.ok(!handed.url.includes(motion.url), "The thread was handed the upstream URL, not the proxy.");
  assert.ok(
    !handed.headers.some((pair) => pair.value.includes(SHARED_TOKEN)),
    "The thread was handed the shared token.",
  );
  const client = new Client({ name: "provider-e2e", version: "1" });
  clients.push(client);
  await client.connect(
    new StreamableHTTPClientTransport(new URL(handed.url), {
      requestInit: { headers: Object.fromEntries(handed.headers.map((pair) => [pair.key, pair.value])) },
    }),
  );
  const tools = await client.listTools();
  assert.ok(
    tools.tools.some((tool) => tool.name === "whoami"),
    "The proxy did not offer the upstream tool.",
  );
  const result = await client.callTool({ name: "whoami", arguments: {} });
  const content = Array.isArray(result.content) ? result.content : [];
  const first = content[0];
  assert.ok(first && first.type === "text" && typeof first.text === "string", "whoami returned no text.");
  return JSON.parse(first.text);
}

try {
  const setup = await step("setup: a shared Motion token, two agents in two spaces, and the motion row", async () => {
    await runCauseEffect(keys.save(SHARED_API_KEY_SCOPE, "MOTION_TOKEN", SHARED_TOKEN));
    const create = async (name: string) =>
      runCauseEffect(
        agents.createAgentProfile({
          name,
          description: name,
          avatarSeed: name.toLowerCase().replace(/[^a-z]+/g, "-"),
          avatarHue: null,
        }),
      );
    const scout = await create("Scout de Catálogo");
    const lead = await create("Líder de Producto");
    const pipeline = store.spaces.create({ name: "Pipeline Universidad" });
    store.spaces.assign("agent", [lead.id], pipeline.id);
    const scoutThread = await runCauseEffect(store.ensureThreadId(scout.id));
    const leadThread = await runCauseEffect(store.ensureThreadId(lead.id));
    // A new row has no id: the store gives it one.
    const row: McpServerConfig = {
      id: "",
      name: "motion",
      transport: "http",
      enabled: true,
      command: "",
      args: [],
      env: [],
      envPassthrough: [],
      workingDirectory: "",
      url: motion.url,
      headers: [
        { key: "Authorization", value: "Bearer {{secret:shared/MOTION_TOKEN}}" },
        { key: "X-Motion-Agent", value: "{{agent.id}}" },
        { key: "X-Motion-Agent-Name", value: "{{agent.name}}" },
        { key: "X-Motion-Workspace-Key", value: "{{space.id}}" },
        { key: "X-Motion-Workspace-Name", value: "{{space.name}}" },
      ],
    };
    await runCauseEffect(agents.saveMcpServer({ config: row }));
    const motionId = agents.storedMcpServers().find((config) => config.name === "motion")?.id;
    assert.ok(motionId, "The motion row was not stored.");
    // As in production: the `*` key grants the row to every chat.
    await writeFile(
      join(userData, "chat-app-permissions-v1.json"),
      JSON.stringify({ version: 1, chats: { "*": { grants: [{ connectionId: motionId, mode: "read" }] } } }),
    );
    proxy.current = await Effect.runPromise(
      createChatMcp({
        path: userData,
        service: () => agents,
        runtimes: () => NO_MCP_TOOL_RUNTIMES,
        endpoint: (config) => Effect.succeed({ url: config.url, authorization: null, proxied: false }),
      }),
    );
    return { scout, lead, pipeline, scoutThread, leadThread };
  });

  await step("General agent: Motion sees the agent, its space and the shared token", async () => {
    const headers = await whoamiAs(setup.scoutThread);
    assert.equal(headers.authorization, `Bearer ${SHARED_TOKEN}`);
    assert.equal(headers["x-motion-agent"], setup.scout.id);
    assert.equal(decodeURIComponent(headers["x-motion-agent-name"] ?? ""), "Scout de Catálogo");
    assert.equal(headers["x-motion-workspace-key"], "general");
    return { agent: headers["x-motion-agent"], space: headers["x-motion-workspace-key"] };
  });

  await step("agent in another space: Motion sees that agent and its space, not the first one", async () => {
    const headers = await whoamiAs(setup.leadThread);
    assert.equal(headers.authorization, `Bearer ${SHARED_TOKEN}`);
    assert.equal(headers["x-motion-agent"], setup.lead.id);
    assert.equal(decodeURIComponent(headers["x-motion-agent-name"] ?? ""), "Líder de Producto");
    assert.equal(headers["x-motion-workspace-key"], setup.pipeline.id);
    assert.equal(decodeURIComponent(headers["x-motion-workspace-name"] ?? ""), "Pipeline Universidad");
    return { agent: headers["x-motion-agent"], space: headers["x-motion-workspace-key"] };
  });

  await step("Test button: sends the shared token and no agent headers", async () => {
    // The chat connections close first, so none of their requests lands among the test's.
    for (const client of clients.splice(0)) await client.close();
    if (proxy.current) await Effect.runPromise(proxy.current.close());
    proxy.current = null;
    const before = seen.length;
    const row = agents.storedMcpServers().find((config) => config.name === "motion");
    assert.ok(row, "The motion row is not stored.");
    const result = await runCauseEffect(agents.testMcpServer({ config: row }));
    assert.equal(result.error, null, `The test failed: ${result.error}`);
    // Each connection starts with `initialize`; the chat connections closed before this point.
    const requests = seen.slice(before).filter((request) => request.method === "initialize");
    assert.ok(requests.length > 0, "The test sent no request.");
    for (const headers of requests) {
      assert.equal(headers.authorization, `Bearer ${SHARED_TOKEN}`, "The test sent the template text.");
      assert.equal(headers["x-motion-agent"], undefined, "The test named an agent.");
    }
    return { requests: requests.length };
  });

  report.passed = report.steps.every((entry) => entry.passed);
} catch (error) {
  if (!report.steps.some((entry) => !entry.passed))
    report.steps.push({ name: "setup", passed: false, error: error instanceof Error ? error.message : String(error) });
} finally {
  for (const client of clients) await client.close().catch(() => undefined);
  if (proxy.current) await Effect.runPromise(proxy.current.close()).catch(() => undefined);
  await runCauseEffect(agents.stop()).catch(() => undefined);
  database.close();
  await motion.close();
  mkdirSync(OUT, { recursive: true });
  writeFileSync(join(OUT, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  await rm(root, { recursive: true, force: true });
  for (const entry of report.steps)
    process.stdout.write(`${entry.passed ? "PASS" : "FAIL"} ${entry.name}${entry.error ? `: ${entry.error}` : ""}\n`);
  process.stdout.write(`Report: ${join(OUT, "report.json")}\n`);
  if (!report.passed) process.exitCode = 1;
}
