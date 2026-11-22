import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Effect } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { OwnerMcpServer } from "./owner-mcp-server";
import { OwnerMcpTokens } from "./owner-mcp-tokens";

let folder: string;
let http: Server;
let base: string;
let tokens: OwnerMcpTokens;
const sent: { agentId: string; text: string }[] = [];
const LEAKED_KEY = `sk-ant-${"x9Y8z7W6v5".repeat(3)}`;

beforeEach(async () => {
  folder = await mkdtemp(join(tmpdir(), "owner-mcp-"));
  tokens = new OwnerMcpTokens({ file: join(folder, "tokens.json") });
  sent.length = 0;
  const mcp = new OwnerMcpServer({
    tokens,
    listAgents: () => [
      { id: "a1", name: "Ana", title: "CSO", space: "Universidad" },
      { id: "a2", name: "Bo", title: "Media buyer", space: "Piks" },
    ],
    sendMessage: async (input) => {
      sent.push({ agentId: input.agentId, text: input.text });
      return { deliveryId: "d1" };
    },
    delivery: (id) =>
      id === "d1" || id === "d2"
        ? { recipientAgentId: "a1", status: "completed", turnId: id === "d1" ? "t1" : "t2" }
        : null,
    turnAnswer: (_agentId, turnId) =>
      turnId === "t2" ? `Your key is ${LEAKED_KEY}` : "On it. Campaign is paused until you approve.",
    recentMessages: () => [{ from: "owner", text: "status?", at: "2026-11-21T10:00:00.000Z" }],
    attentionItems: () => [
      {
        kind: "approval",
        requestId: 1,
        agentId: "a1",
        threadId: "th",
        turnId: "t1",
        createdAt: "2026-11-21T10:00:00.000Z",
      },
    ],
    loopDecisions: () => [],
    heldItems: () => [],
    sleep: async () => undefined,
  });
  http = createServer((request, response) => void mcp.handle(request, response));
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${portOf(http)}`;
});

afterEach(async () => {
  http.closeAllConnections();
  await new Promise<void>((resolve) => http.close(() => resolve()));
  await rm(folder, { recursive: true, force: true });
});

async function connect(url: string): Promise<Client> {
  const client = new Client({ name: "test", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(url)));
  return client;
}

function textOf(result: Awaited<ReturnType<Client["callTool"]>>): string {
  const [block] = Array.isArray(result.content) ? result.content : [];
  return block && typeof block.text === "string" ? block.text : "";
}

describe("OwnerMcpServer", () => {
  it("refuses a request without a valid token", async () => {
    const response = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer atm_nope" },
      body: "{}",
    });
    expect(response.status).toBe(401);
  });

  it("lists agents, sends an order and reads the reply with a token in the URL", async () => {
    const { token } = await Effect.runPromise(tokens.create("Claude"));
    const client = await connect(`${base}/mcp/${token}`);
    const names = (await client.listTools()).tools.map((tool) => tool.name);
    expect(names).toEqual(["list_agents", "send_message", "get_reply", "read_messages", "list_decisions"]);
    expect(textOf(await client.callTool({ name: "list_agents", arguments: { space: "piks" } }))).toContain("Bo");
    const order = JSON.parse(
      textOf(await client.callTool({ name: "send_message", arguments: { agent: "ana", text: "Pause ads" } })),
    );
    expect(order.deliveryId).toBe("d1");
    expect(sent).toEqual([{ agentId: "a1", text: "Pause ads" }]);
    const reply = JSON.parse(textOf(await client.callTool({ name: "get_reply", arguments: { deliveryId: "d1" } })));
    expect(reply).toEqual({ status: "completed", answer: "On it. Campaign is paused until you approve." });
    const decisions = JSON.parse(textOf(await client.callTool({ name: "list_decisions", arguments: {} })));
    expect(decisions.waiting).toEqual([{ kind: "approval", agent: "Ana", since: "2026-11-21T10:00:00.000Z" }]);
    await client.close();
  });

  // Failure mode: an agent's answer that quoted a key went to the chat app's servers as written, and a
  // key pasted in the chat app reached the agent's thread.
  it("hides a key in an order and in the reply that leaves for the chat app", async () => {
    const { token } = await Effect.runPromise(tokens.create("Claude"));
    const client = await connect(`${base}/mcp/${token}`);
    await client.callTool({ name: "send_message", arguments: { agent: "ana", text: `Use ${LEAKED_KEY} for it` } });
    expect(sent).toEqual([{ agentId: "a1", text: "Use [hidden: Anthropic key] for it" }]);
    const reply = textOf(await client.callTool({ name: "get_reply", arguments: { deliveryId: "d2" } }));
    expect(reply).not.toContain(LEAKED_KEY);
    expect(JSON.parse(reply).answer).toBe("Your key is [redacted]");
    await client.close();
  });

  it("stops a revoked token at once", async () => {
    const { token, entry } = await Effect.runPromise(tokens.create("ChatGPT"));
    await Effect.runPromise(tokens.revoke(entry.id));
    const response = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: "{}",
    });
    expect(response.status).toBe(401);
    expect(new OwnerMcpTokens({ file: join(folder, "tokens.json") }).any()).toBe(false);
  });

  it("answers a tool error for an unknown agent", async () => {
    const { token } = await Effect.runPromise(tokens.create("x"));
    const client = await connect(`${base}/mcp/${token}`);
    const result = await client.callTool({ name: "send_message", arguments: { agent: "Zed", text: "hi" } });
    expect(result.isError).toBe(true);
    expect(sent).toEqual([]);
    await client.close();
  });
});

function portOf(server: Server): number {
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("The test server has no port.");
  return address.port;
}
