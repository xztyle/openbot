// Checks on a real host that a secure code card (`openbot_browser.submit_secret`) reaches a web client
// and that the code goes back through the Team API secret route. The host is the shared Team API host
// (`workspace-e2e-host.ts`) with the real agent service, attention registry and event sockets. Codex is
// a stand-in process that holds each turn open; the browser's secret preparation is a stand-in that
// records the code it gets.
//
// 1. The agent calls `submit_secret` for an SMS code of 6 digits on www.facebook.com. The owner's event
//    socket, with the capabilities of a current web client, gets `browser-takeover-requested` with the
//    public secret metadata (method, origin, digits) and `agent-attention-changed` with kind `secret`.
// 2. The event also passes the WebRTC host peer's re-encoding and the web client's decoder whole.
// 3. A client that connects now gets the request in its runtime snapshot, with the metadata.
// 4. The owner answers on `/v1/browser-secrets/respond`: the stand-in gets the code, the tool call
//    completes, and the list clears.
//
// `bun scripts/browser-secret-host-e2e.ts`. Writes .openbot-build/browser-secret-host-e2e/report.json.
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type AgentAttentionItem,
  type AgentEvent,
  type BrowserTab,
  defaultProviderModel,
  type TeamRealtimeEvent,
} from "@openbot/contracts/ipc";
import { isDynamicRecord } from "@openbot/contracts/runtime-values";

import { TEAM_API_ROUTES } from "@openbot/contracts/team-api-routes";
import { TEAM_PROTOCOL_V1_WEBSOCKET } from "@openbot/contracts/team-protocol";
import { attentionItemsEvent } from "@openbot/contracts/team-protocol/attention-items-v1";
import { TEAM_CURRENT_CAPABILITIES } from "@openbot/contracts/team-protocol/current";
import { decodeTeamProtocolV2EventFrame, encodeTeamProtocolV2Frame } from "@openbot/contracts/team-protocol/v2";
import {
  createTeamProtocolV8Event,
  decodeTeamProtocolV8CurrentEvent,
} from "@openbot/contracts/team-protocol/v8-webrtc-adapter";
import { Effect } from "effect";
import { BROWSER_SECRET_RESPONSE_PATH } from "../packages/contracts/src/ipc-browser-secret";
import type { AgentBrowserHost } from "../src/backend/agent/turn-lifecycle";
import type { RequestId } from "../src/backend/protocol";
import type { JsonObject } from "./workspace-e2e-host";

const root = await mkdtemp(join(tmpdir(), "openbot-browser-secret-"));
const codexExecutable = join(root, "codex");
const turnLog = join(root, "codex-turns.jsonl");
const CODEX_MODEL = defaultProviderModel("codex");
// Before the service reads them: the provider search and the stores.
process.env.HOME = join(root, "home");
process.env.OPENBOT_CODEX_PATH = codexExecutable;

// Codex's app-server, reduced to what a turn needs. A turn whose input says "hold-turn" stays open,
// so its thread can make tool calls; any other turn answers "Done.". Each turn is logged.
const STAND_IN_CODEX = `#!/usr/bin/env node
const fs = require("node:fs");
const { randomUUID } = require("node:crypto");
if (process.argv.includes("--version")) { console.log("codex-cli 0.160.1"); process.exit(0); }
const threads = new Map();
const write = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
const config = { config: { mcp_servers: {} }, layers: [] };
const answer = (request) => {
  const params = request.params ?? {};
  const reply = (result) => write({ id: request.id, result });
  const thread = threads.get(params.threadId) ?? { id: params.threadId, turns: [] };
  switch (request.method) {
    case "initialize": return reply({});
    case "account/read": return reply({ account: { type: "chatgpt", email: "codex@example.com" } });
    case "account/rateLimits/read": return reply({ rateLimits: null, rateLimitsByLimitId: null });
    case "model/list": return reply({ data: [{ model: ${JSON.stringify(CODEX_MODEL)}, displayName: "Codex" }] });
    case "plugin/list": return reply({ marketplaces: [] });
    case "config/read": return reply(config);
    case "config/batchWrite": return reply({});
    case "thread/start": { const next = { id: randomUUID(), turns: [] }; threads.set(next.id, next); return reply({ thread: next }); }
    case "thread/resume":
    case "thread/read": return reply({ thread });
    case "thread/unsubscribe": return reply({ status: "Unsubscribed" });
    case "thread/turns/list": return reply({ data: [], nextCursor: null });
    case "thread/items/list": return reply({ data: [], nextCursor: null });
    case "turn/start": {
      const turn = { id: randomUUID(), status: "inProgress", items: [] };
      thread.turns.push(turn);
      const input = JSON.stringify(params.input);
      fs.appendFileSync(${JSON.stringify(turnLog)}, JSON.stringify({ threadId: thread.id, turnId: turn.id, input }) + "\\n");
      reply({ turn });
      write({ method: "turn/started", params: { threadId: thread.id, turn: { id: turn.id } } });
      if (input.includes("hold-turn")) return;
      setImmediate(() => {
        write({ method: "item/completed", params: { threadId: thread.id, turnId: turn.id, item: { type: "agentMessage", id: randomUUID(), phase: "final_answer", text: "Done." } } });
        turn.status = "completed";
        write({ method: "turn/completed", params: { threadId: thread.id, turn } });
      });
      return;
    }
    case "turn/interrupt": return reply({});
    default: return write({ id: request.id, error: { code: -32601, message: "Method not found: " + request.method } });
  }
};
let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let newline;
  while ((newline = buffer.indexOf("\\n")) >= 0) {
    const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
    if (!line) continue;
    const request = JSON.parse(line);
    if (request.id !== undefined && request.method) answer(request);
  }
});
process.stdout.on("error", (error) => { if (error.code === "EPIPE") process.exit(0); else throw error; });
`;
writeFileSync(codexExecutable, STAND_IN_CODEX, { mode: 0o755 });

const { startWorkspaceE2e, isRecord } = await import("./workspace-e2e-host");
const { CodexAppServerClient } = await import("../src/backend/app-server-client");
const { runCauseEffect } = await import("../src/backend/effect-boundary");
const { AGENT_PROVIDERS } = await import("@openbot/contracts/ipc");

/** The real Codex client; the answers to the tool calls of this script stay here, as a provider keeps them. */
class CodexStandIn extends CodexAppServerClient {
  readonly toolAnswers = new Map<RequestId, unknown>();
  override respond(id: RequestId, result: unknown): void {
    if (typeof id === "string" && id.startsWith("e2e-tool-")) this.toolAnswers.set(id, result);
    else super.respond(id, result);
  }
}

// ---------------------------------------------------------------- browser

const tabs: BrowserTab[] = [];
/** The codes that the stand-in secret preparation got, as the page's fields would. */
const filled: string[] = [];
const unused = () => Effect.die(new Error("Not used by this check."));
const browser: AgentBrowserHost = {
  listTabs: () => tabs,
  beginTakeover: () => Effect.void,
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
  prepareSecret: () =>
    Effect.succeed({
      request: { method: "otp" as const, origin: "https://www.facebook.com", digits: 6 },
      agentScriptedOrigin: false,
      vaultFillable: false,
      submit: (secret: string) =>
        Effect.sync(() => {
          filled.push(secret);
          return "submitted" as const;
        }),
      cancel: () => {},
    }),
};

// ---------------------------------------------------------------- host

const clients: CodexStandIn[] = [];
const e2e = await startWorkspaceE2e(
  "browser-secret-host-e2e",
  [
    "A real provider: Codex is a stand-in process that holds each turn open, and the script makes its tool calls.",
    "The browser of the host: the tab list and the secret fill are stand-ins; no page gets the code.",
    "The web client's drawing of the card: scripts/needs-you-ui-e2e.ts checks it on a mock host.",
  ],
  {
    agents: {
      browser,
      preferredProvider: "codex",
      offProviders: AGENT_PROVIDERS.filter((provider) => provider !== "codex"),
      clientFactory: (_provider, cli) => {
        const client = new CodexStandIn(cli.executable, 30_000);
        clients.push(client);
        return client;
      },
    },
  },
);
const { owner, step } = e2e;
const service = () => e2e.host().agents;

/** An event socket with the capabilities of a current web client, as the WebRTC host peer opens it. */
async function openWebClientEvents(): Promise<WebSocket> {
  const socket = new WebSocket(`ws://127.0.0.1:${e2e.host().port}${TEAM_API_ROUTES.events}`, [
    TEAM_PROTOCOL_V1_WEBSOCKET,
    `openbot-token.${owner.token}`,
  ]);
  await new Promise<void>((resolveOpen, reject) => {
    socket.addEventListener("open", () => resolveOpen(), { once: true });
    socket.addEventListener("error", () => reject(new Error("The event socket did not open.")), { once: true });
  });
  socket.send(
    JSON.stringify({
      type: "agent-event-scope",
      includeConversations: true,
      capabilities: [...TEAM_CURRENT_CAPABILITIES],
    }),
  );
  return socket;
}

/** Waits for a state of the host. */
async function waitFor<T>(label: string, read: () => T | null | undefined | false, timeoutMs = 20_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = read();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}.`);
    await new Promise((done) => setTimeout(done, 25));
  }
}

function turnsLogged(): { threadId: string; turnId: string; input: string }[] {
  try {
    return readFileSync(turnLog, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

/** The provider thread and turn of the turn whose input holds `marker`. */
function providerTurn(marker: string) {
  return waitFor(`the turn of "${marker}"`, () => turnsLogged().find((turn) => turn.input.includes(marker)));
}

let toolCalls = 0;
/** Calls a tool on a provider thread, as the provider would. The answer comes later, or never. */
function callTool(thread: { threadId: string; turnId: string }, namespace: string, tool: string, args: unknown) {
  const client = clients.at(-1);
  assert.ok(client, "The service made a Codex client.");
  const id = `e2e-tool-${++toolCalls}`;
  client.emit("request", {
    id,
    method: "item/tool/call",
    params: { threadId: thread.threadId, turnId: thread.turnId, callId: id, namespace, tool, arguments: args },
  });
  return {
    id,
    answer: () =>
      waitFor(`${tool} to answer`, () => {
        for (const candidate of clients) {
          const value = candidate.toolAnswers.get(id);
          if (value !== undefined) return value;
        }
        return undefined;
      }),
  };
}

function answerText(answer: unknown): string {
  assert.ok(isDynamicRecord(answer) && Array.isArray(answer.contentItems), "The tool answers with content.");
  const item = answer.contentItems[0];
  assert.ok(isDynamicRecord(item) && typeof item.text === "string", "The tool answers with text.");
  return item.text;
}

/** Every event that the owner's socket gets, in order. */
const socketEvents: JsonObject[] = [];
function watch(socket: WebSocket) {
  socket.addEventListener("message", (message) => {
    const value = JSON.parse(String(message.data));
    if (isRecord(value)) socketEvents.push(value);
  });
}
function latest(type: string): JsonObject | undefined {
  return socketEvents.findLast((event) => event.type === type);
}
function attentionItems(): AgentAttentionItem[] | undefined {
  const event = latest("agent-attention-changed");
  return event ? (attentionItemsEvent(event)?.items ?? undefined) : undefined;
}

/** The event as the WebRTC host peer passes it on and the web client decodes it. */
function throughWebClient(event: JsonObject): AgentEvent | TeamRealtimeEvent {
  const frame = createTeamProtocolV8Event(1, event, {
    preserveSemanticTags: true,
    preserveBrowserSecrets: true,
    browserSignIn: true,
    uiBlocks: true,
    subagents: true,
    promptMultiSelect: true,
    agentTalk: true,
  });
  const decoded = decodeTeamProtocolV8CurrentEvent(
    decodeTeamProtocolV2EventFrame(JSON.parse(encodeTeamProtocolV2Frame(frame))),
  );
  if (decoded.status !== "known") throw new Error("The web client does not decode the event.");
  return decoded.event;
}

try {
  const agent = await runCauseEffect(
    e2e.host().agents.createAgentProfile({
      name: "PUO - Operaciones de Marketing",
      description: "Runs the Facebook ads",
      avatarSeed: "secret-card-agent",
      avatarHue: null,
      provider: "codex",
    }),
  );
  const ownerSocket = await openWebClientEvents();
  watch(ownerSocket);
  await runCauseEffect(service().sendMessage({ agentId: agent.id, text: "case:secret hold-turn sign in to Facebook" }));
  const turn = await providerTurn("case:secret");
  const thread = await waitFor(
    "the agent's thread",
    () =>
      service()
        .listAgents()
        .find((entry) => entry.id === agent.id)?.threadId,
  );
  tabs.push({
    id: "tab-facebook",
    title: "Enter the code",
    url: "https://www.facebook.com/checkpoint/",
    loading: false,
    ownerAgentId: agent.id,
    ownerThreadId: thread,
  });
  const call = callTool(turn, "openbot_browser", "submit_secret", {
    tabId: "tab-facebook",
    method: "otp",
    targets: [{ css: "input[name=code]" }],
    digits: 6,
    submission: "enter",
  });

  const request = await step(
    "The web client's socket gets the secret request with its public metadata",
    async () => {
      const requested = await waitFor("the takeover event", () =>
        socketEvents.find((event) => event.type === "browser-takeover-requested"),
      );
      const event = throughWebClient(requested);
      if (event.type !== "browser-takeover-requested") throw new Error(`The event decoded as ${event.type}.`);
      const decoded = event.request;
      assert.deepEqual(decoded.secret, { method: "otp", origin: "https://www.facebook.com", digits: 6 });
      assert.equal(decoded.agentId, agent.id);
      assert.equal(decoded.threadId, thread, "The request is not in the agent's own chat.");
      const listed = await waitFor("the attention list", () =>
        attentionItems()?.find((entry) => entry.agentId === agent.id),
      );
      assert.equal(listed.kind, "secret");
      assert.equal(listed.origin, "www.facebook.com");
      return decoded;
    },
    (value) => value,
  );

  await step("A web client that connects now gets the request in its snapshot", async () => {
    const socket = await openWebClientEvents();
    const snapshot = await e2e.nextMessage(socket, (value) =>
      isRecord(value) && value.type === "runtime-snapshot" ? value : null,
    );
    socket.close();
    const event = throughWebClient(snapshot);
    if (event.type !== "runtime-snapshot") throw new Error(`The snapshot decoded as ${event.type}.`);
    const pending = event.snapshot.pendingBrowserTakeovers;
    const found = pending.find((entry) => String(entry.requestId) === String(request.requestId));
    assert.ok(found, "The snapshot does not hold the request.");
    assert.deepEqual(found.secret, { method: "otp", origin: "https://www.facebook.com", digits: 6 });
    return pending.length;
  });

  await step("The code goes back on the secret route and the request clears", async () => {
    const response = await e2e.call("POST", BROWSER_SECRET_RESPONSE_PATH, {
      token: owner.token,
      body: { requestId: request.requestId, agentId: agent.id, decision: "submit", secret: "482913" },
    });
    assert.equal(response.status, 204, `The answer returned ${response.status}.`);
    const answer = JSON.parse(answerText(await call.answer()));
    assert.equal(answer.status, "completed");
    assert.deepEqual(filled, ["482913"]);
    await waitFor("the empty list", () => attentionItems()?.length === 0);
    assert.ok(socketEvents.some((event) => event.type === "browser-takeover-resolved"));
    assert.ok(!socketEvents.some((event) => JSON.stringify(event).includes("482913")), "An event holds the code.");
    return answer;
  });
  e2e.report.passed = true;
} finally {
  await e2e.finish();
}
process.exit(e2e.report.passed ? 0 : 1);
