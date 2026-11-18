// Checks on a real host that a browser takeover of an agent that the user never opened reaches every
// place that says "needs you", and that an answer clears each of them. The host is the shared Team API
// host (`workspace-e2e-host.ts`) with the real agent service, mailbox, attention registry, web push
// sender and event sockets. Codex is a stand-in process that holds each turn open; the script makes
// the provider's tool calls on the thread of a turn, as a provider does.
//
// 1. The orchestrator's turn sends work to the publisher with `send_message`; the publisher's turn
//    starts. The publisher has no DM row: no person wrote to it (`dm-agents` leaves it out of
//    `recentAgentIds`).
// 2. The publisher calls `openbot_browser.request_takeover`. The owner's event socket gets the request,
//    the escalation that names the orchestrator, and `agent-attention-changed` with the takeover, its
//    site and the tab title (the wire event decodes with `attention-items-v1`). The owner's browser gets
//    one web push of kind `needs-takeover` that opens the orchestrator's chat, with no chat text.
// 3. A client that connects now gets the list after the snapshot.
// 4. The owner answers through the Team API route: the publisher's tool call gets "completed", and the
//    list, the escalations and the request clear.
// 5. A tab whose handover does not end still shows its card after the wait, and an answer clears it.
//
// `bun scripts/needs-you-host-e2e.ts`. Writes .openbot-build/needs-you-host-e2e/report.json.
import assert from "node:assert/strict";
import { createDecipheriv, createECDH, hkdfSync, randomBytes, randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type AgentAttentionItem,
  type AgentEvent,
  type BrowserTab,
  defaultProviderModel,
} from "@openbot/contracts/ipc";
import { isDynamicRecord } from "@openbot/contracts/runtime-values";
import { TEAM_API_ROUTES } from "@openbot/contracts/team-api-routes";
import { attentionItemsEvent } from "@openbot/contracts/team-protocol/attention-items-v1";
import { WEB_PUSH_CODECS, WEB_PUSH_ROUTES } from "@openbot/contracts/team-protocol/web-push-v1";
import { WORKSPACE_CODECS, WORKSPACE_ROUTES } from "@openbot/contracts/team-protocol/workspace-v1";
import { Effect } from "effect";
import type { AgentBrowserHost } from "../src/backend/agent/turn-lifecycle";
import type { RequestId } from "../src/backend/protocol";
import type { JsonObject } from "./workspace-e2e-host";

const root = await mkdtemp(join(tmpdir(), "openbot-needs-you-"));
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

const { startWorkspaceE2e, record, isRecord } = await import("./workspace-e2e-host");
const { CodexAppServerClient } = await import("../src/backend/app-server-client");
const { runCauseEffect } = await import("../src/backend/effect-boundary");
const { WebPushService } = await import("../src/main/web-push");
const { WebPushStore } = await import("../src/main/web-push-store");
const { webPushWorkspace } = await import("../src/main/web-push-workspace");
const { WorkspaceSidebarStore } = await import("../src/main/workspace-sidebar-store");
const { AGENT_PROVIDERS } = await import("@openbot/contracts/ipc");

/** The real Codex client; the answers to the tool calls of this script stay here, as a provider keeps them. */
class CodexStandIn extends CodexAppServerClient {
  readonly toolAnswers = new Map<RequestId, unknown>();
  override respond(id: RequestId, result: unknown): void {
    if (typeof id === "string" && id.startsWith("e2e-tool-")) this.toolAnswers.set(id, result);
    else super.respond(id, result);
  }
}

// ---------------------------------------------------------------- browser and push service

/** The tabs of the host's browser. A handover of `STUCK_TAB` never ends, as with a busy tab queue. */
const tabs: BrowserTab[] = [];
const STUCK_TAB = "tab-stuck";
const handedOver: string[] = [];
const unused = () => Effect.die(new Error("Not used by this check."));
const browser: AgentBrowserHost = {
  listTabs: () => tabs,
  beginTakeover: (tabId) => (tabId === STUCK_TAB ? Effect.never : Effect.sync(() => void handedOver.push(tabId))),
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

interface PushBrowser {
  endpoint: string;
  ecdh: ReturnType<typeof createECDH>;
  auth: Buffer;
}
const pushBrowser: PushBrowser = (() => {
  const ecdh = createECDH("prime256v1");
  ecdh.generateKeys();
  return { endpoint: `https://fcm.googleapis.com/fcm/send/e2e-${randomUUID()}`, ecdh, auth: randomBytes(16) };
})();

/** Opens an `aes128gcm` push body (RFC 8188, RFC 8291) with the browser's private key. */
function decrypt(body: Buffer): string {
  const salt = body.subarray(0, 16);
  const keyLength = body.readUInt8(20);
  const serverPublic = body.subarray(21, 21 + keyLength);
  const content = body.subarray(21 + keyLength);
  const shared = pushBrowser.ecdh.computeSecret(serverPublic);
  const info = Buffer.concat([Buffer.from("WebPush: info\0"), pushBrowser.ecdh.getPublicKey(), serverPublic]);
  const inputKey = Buffer.from(hkdfSync("sha256", shared, pushBrowser.auth, info, 32));
  const key = Buffer.from(hkdfSync("sha256", inputKey, salt, Buffer.from("Content-Encoding: aes128gcm\0"), 16));
  const nonce = Buffer.from(hkdfSync("sha256", inputKey, salt, Buffer.from("Content-Encoding: nonce\0"), 12));
  const decipher = createDecipheriv("aes-128-gcm", key, nonce);
  decipher.setAuthTag(content.subarray(content.length - 16));
  const plain = Buffer.concat([decipher.update(content.subarray(0, content.length - 16)), decipher.final()]);
  return plain.subarray(0, plain.length - 1).toString("utf8");
}

const pushes: { urgency: string; message: JsonObject; text: string }[] = [];
const pushService: typeof fetch = Object.assign(
  async (_input: string | URL | Request, init?: RequestInit) => {
    const body = init?.body;
    assert.ok(body instanceof Uint8Array, "The push body is not bytes.");
    const text = decrypt(Buffer.from(body));
    pushes.push({
      urgency: new Headers(init?.headers).get("urgency") ?? "",
      message: record(JSON.parse(text), "push"),
      text,
    });
    return new Response(null, { status: 201 });
  },
  { preconnect: fetch.preconnect },
);

// ---------------------------------------------------------------- host

const clients: CodexStandIn[] = [];
const e2e = await startWorkspaceE2e(
  "needs-you-host-e2e",
  [
    "A real provider: Codex is a stand-in process that holds each turn open, and the script makes its tool calls.",
    "The browser of the host: the tab list and the handover are stand-ins; the card's preview and the live view are not drawn.",
    "The web client's drawing of these events: scripts/needs-you-ui-e2e.ts checks it on a mock host.",
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
    server: async ({ agents, team, userData }) => {
      const sidebar = new WorkspaceSidebarStore(join(userData, "workspace-sidebar.json"));
      await runCauseEffect(sidebar.load());
      return {
        workspaceSidebar: sidebar,
        webPush: new WebPushService({
          agents,
          store: new WebPushStore(join(userData, "web-push.json")),
          hostId: () => team.getIdentity()?.serverId ?? null,
          memberActive: (memberId) => team.getMember(memberId)?.disabled === false,
          hiddenAgentIds: () => new Set(),
          workspace: webPushWorkspace({
            channels: agents.channels,
            spaces: agents.spaces,
            sidebar,
            memberRole: (memberId) => team.getMember(memberId)?.role ?? null,
            hostViewer: () => null,
          }),
          burstMs: 50,
          fetch: pushService,
        }),
      };
    },
  },
);
const { owner, step } = e2e;
const service = () => e2e.host().agents;

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

const hostEvents: AgentEvent[] = [];
service().on("event", (event: AgentEvent) => hostEvents.push(event));

try {
  const orchestrator = await runCauseEffect(
    e2e.host().agents.createAgentProfile({
      name: "GTA 6 - Main Orchestrator",
      description: "Talks with the user and delegates",
      avatarSeed: "needs-you-orchestrator",
      avatarHue: null,
      provider: "codex",
    }),
  );
  const publisher = await runCauseEffect(
    e2e.host().agents.createAgentProfile({
      name: "GTA 6 - Publisher",
      description: "Creates the accounts",
      avatarSeed: "needs-you-publisher",
      avatarHue: null,
      provider: "codex",
    }),
  );
  const ownerSocket = await e2e.openEvents(owner.token);
  watch(ownerSocket);
  await step("Both browsers of the owner register for web push", async () => {
    const response = await e2e.optional(WEB_PUSH_CODECS, WEB_PUSH_ROUTES.register, owner.token, {
      endpoint: pushBrowser.endpoint,
      p256dh: pushBrowser.ecdh.getPublicKey().toString("base64url"),
      auth: pushBrowser.auth.toString("base64url"),
      level: "needs-me",
      mutedUntil: null,
      locale: "en",
    });
    assert.equal(response.status, 200);
  });

  const publisherTurn = await step(
    "The orchestrator gives the publisher work; the publisher's turn starts",
    async () => {
      await runCauseEffect(
        service().sendMessage({ agentId: orchestrator.id, text: "case:orchestrator hold-turn create the account" }),
      );
      const turn = await providerTurn("case:orchestrator");
      const sent = callTool(turn, "openbot", "send_message", {
        recipientAgentIds: [publisher.id],
        text: "case:publisher hold-turn Create the Google account for GTA 6 Pulse.",
      });
      await sent.answer();
      return providerTurn("case:publisher");
    },
  );

  await step("The publisher has no DM row: no person wrote to it", async () => {
    const response = await e2e.optional(WORKSPACE_CODECS, WORKSPACE_ROUTES.dmAgents, owner.token, {});
    const body = record(response.body, "dm-agents");
    assert.ok(Array.isArray(body.recentAgentIds), "The host names the recent agents.");
    assert.ok(!body.recentAgentIds.includes(publisher.id), "The publisher is a recent agent.");
    return body;
  });

  // The chat thread of a new agent comes with its first turn.
  const publisherThread = await waitFor(
    "the publisher's thread",
    () =>
      service()
        .listAgents()
        .find((agent) => agent.id === publisher.id)?.threadId,
  );
  tabs.push({
    id: "tab-google",
    title: "Create a Google Account",
    url: "https://accounts.google.com/lifecycle/steps/signup/birthdaygender",
    loading: false,
    ownerAgentId: publisher.id,
    ownerThreadId: publisherThread,
  });
  const pushesBefore = pushes.length;
  const takeover = callTool(publisherTurn, "openbot_browser", "request_takeover", { tabId: "tab-google" });

  const { listed: item } = await step(
    "The owner's socket gets the takeover, its escalation and the attention list",
    async () => {
      const listed = await waitFor("the attention list", () =>
        attentionItems()?.find((entry) => entry.agentId === publisher.id),
      );
      assert.equal(listed.kind, "browser-takeover");
      assert.equal(listed.origin, "accounts.google.com");
      assert.equal(listed.summary, "Create a Google Account");
      assert.equal(listed.threadId, publisherThread);
      assert.ok(!Number.isNaN(Date.parse(listed.createdAt)));
      const requested = await waitFor("the takeover event", () =>
        socketEvents.find((event) => event.type === "browser-takeover-requested"),
      );
      const escalations = await waitFor("the escalation", () => {
        const event = latest("agent-input-escalations-changed");
        return Array.isArray(event?.escalations) && event.escalations.length > 0 ? event.escalations : null;
      });
      assert.deepEqual(
        escalations.map((entry) => (isDynamicRecord(entry) ? [entry.kind, entry.delegatorAgentIds] : null)),
        [["browser-takeover", [orchestrator.id]]],
      );
      assert.ok(handedOver.includes("tab-google"), "The tab was handed over before the card showed.");
      return { listed, requested };
    },
    (value) => value.listed,
  );

  await step("One web push of kind needs-takeover opens the orchestrator's chat", async () => {
    const push = await waitFor("the push", () => pushes.slice(pushesBefore).find((entry) => entry.message.kind));
    assert.equal(push.message.kind, "needs-takeover");
    assert.equal(push.message.body, "Needs you to finish a step in the browser.");
    assert.equal(push.message.agentId, orchestrator.id, "The push does not open the chat that shows the request.");
    assert.match(String(push.message.path), new RegExp(`/dm/${orchestrator.id}$`, "u"));
    assert.equal(push.urgency, "high");
    assert.ok(!push.text.includes("hold-turn"), "The push holds chat text.");
    return push.message;
  });

  await step("A client that connects now gets the list after the snapshot", async () => {
    const socket = await e2e.openEvents(owner.token);
    const event = await e2e.nextMessage(socket, (value) => attentionItemsEvent(value));
    socket.close();
    assert.equal(event.items.length, 1);
    assert.equal(event.items[0]?.requestId, item.requestId);
    return event.items.length;
  });

  await step("An answer on the Team API route clears the request everywhere", async () => {
    const response = await e2e.call("POST", TEAM_API_ROUTES.respond.browserTakeover, {
      token: owner.token,
      body: { requestId: item.requestId, decision: "complete" },
    });
    assert.equal(response.status, 204, `The answer returned ${response.status}.`);
    const answer = JSON.parse(answerText(await takeover.answer()));
    assert.equal(answer.status, "completed");
    await waitFor("the empty list", () => attentionItems()?.length === 0);
    await waitFor("no escalation", () => {
      const event = latest("agent-input-escalations-changed");
      return Array.isArray(event?.escalations) && event.escalations.length === 0;
    });
    assert.ok(socketEvents.some((event) => event.type === "browser-takeover-resolved"));
    assert.equal(service().attentionItems().length, 0);
    return answer;
  });

  await step(
    "A tab whose handover does not end still shows its card, and an answer clears it",
    async () => {
      tabs.push({
        id: STUCK_TAB,
        title: "Verify it's you",
        url: "https://accounts.google.com/v3/signin/challenge",
        loading: false,
        ownerAgentId: publisher.id,
        ownerThreadId: publisherThread,
      });
      const started = Date.now();
      const stuck = callTool(publisherTurn, "openbot_browser", "request_takeover", { tabId: STUCK_TAB });
      const listed = await waitFor(
        "the card of the busy tab",
        () => attentionItems()?.find((entry) => entry.agentId === publisher.id),
        15_000,
      );
      const waitedMs = Date.now() - started;
      const response = await e2e.call("POST", TEAM_API_ROUTES.respond.browserTakeover, {
        token: owner.token,
        body: { requestId: listed.requestId, decision: "cancel" },
      });
      assert.equal(response.status, 204);
      assert.equal(JSON.parse(answerText(await stuck.answer())).status, "cancelled");
      await waitFor("the empty list", () => attentionItems()?.length === 0);
      return { waitedMs };
    },
    (value) => value,
  );
  e2e.report.passed = true;
} finally {
  await e2e.finish();
}
process.exit(e2e.report.passed ? 0 : 1);
