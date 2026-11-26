// Checks that the owner's chat with an agent, its unread count and its notifications are for the
// owner's conversation only. Runs the real agent service on a temporary profile with a fake Codex
// app-server that answers each turn and, when a turn's text names a STEP, calls an Atelier tool first.
// (a) A Motion event wakes the agent: its answer adds nothing unread and the end of the turn tells
//     nothing (`agentTalk`, so `notificationForAgentEvent` gives no notice on desktop, web or push).
// (b) A teammate's message wakes the agent: the same.
// (c) The owner writes: the answer counts as unread and the end of the turn tells the owner.
// (d) A Motion event wakes the agent and it writes to the owner with `message_owner`: that message,
//     and only it, counts as unread, and the end of the turn tells the owner with its text.
// The host's two counts (the SQL one and the one over a snapshot) agree at each step.
// `bun scripts/owner-dm-only-e2e.ts`. Writes .openbot-build/owner-dm-only-e2e/report.json.
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  AGENT_PROVIDERS,
  type AgentEvent,
  type ClientAgentSummary,
  type ConversationMessageSender,
} from "@openbot/contracts/ipc";
import { OWNER_MESSAGE_ITEM_TYPE } from "@openbot/contracts/owner-conversation";
import { translateFor } from "@openbot/i18n";
import { notificationForAgentEvent } from "@openbot/team-client/agent-notifications";
import { Effect } from "effect";
import type { AgentBrowserHost } from "../src/backend/agent/turn-lifecycle";
import { AGENT_WAKE_COALESCE_MS } from "../src/backend/collaboration-limits";

const OUT = resolve(import.meta.dirname, "../.openbot-build/owner-dm-only-e2e");
const root = await mkdtemp(join(tmpdir(), "openbot-owner-dm-"));
const userData = join(root, "user-data");
const home = join(root, "home");
const fakeCodex = join(root, "codex");
const planFile = join(root, "plan.json");
const OWNER_NOTE = "Necesito tu OK para lanzar la campaña de Peluquería.";

process.env.HOME = home;
process.env.CODEX_HOME = join(home, ".codex");
process.env.OPENBOT_CODEX_PATH = fakeCodex;
mkdirSync(home, { recursive: true });

const { AgentService } = await import("../src/backend/agent-service");
const { AgentStore } = await import("../src/backend/agent-store");
const { ConversationReadStore } = await import("../src/backend/conversation-read-store");
const { runCauseEffect } = await import("../src/backend/effect-boundary");
const { MailboxStore } = await import("../src/backend/mailbox-store");
const { OpenBotDatabase } = await import("../src/backend/openbot-database");

/** Answers each turn with "Done."; a turn whose text names STEP:<name> first calls the planned tool. */
const FAKE_CODEX = `#!/usr/bin/env node
const { readFileSync } = require("node:fs");
if (process.argv.includes("--version")) {
  process.stdout.write("codex-cli 0.160.1\\n");
  process.exit(0);
}
const PLAN = ${JSON.stringify(planFile)};
const config = { config: { mcp_servers: {} }, layers: [{ name: { type: "user", file: "/fake/.codex/config.toml", profile: null }, version: "1", config: { mcp_servers: {} } }] };
let buffer = "";
let threads = 0;
let turns = 0;
const waiting = new Map();
process.stdout.on("error", (error) => {
  if (error.code === "EPIPE") process.exit(0);
  throw error;
});
const write = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
const finish = (threadId, turnId) => {
  const item = { type: "agentMessage", id: "message-" + turnId, text: "Done.", phase: "final_answer" };
  write({ method: "item/completed", params: { threadId, turnId, item } });
  write({ method: "turn/completed", params: { threadId, turn: { id: turnId, status: "completed" } } });
};
const answer = (message) => {
  const params = message.params || {};
  switch (message.method) {
    case "initialize": return write({ id: message.id, result: {} });
    case "account/read": return write({ id: message.id, result: { account: { type: "chatgpt", email: "codex@example.com" } } });
    case "account/rateLimits/read": return write({ id: message.id, result: { rateLimits: { limitId: "codex", primary: null, secondary: null }, rateLimitsByLimitId: null } });
    case "model/list": return write({ id: message.id, result: { data: [{ model: "gpt-6-luna", displayName: "GPT-6 Luna" }] } });
    case "plugin/list": return write({ id: message.id, result: { marketplaces: [] } });
    case "config/read": return write({ id: message.id, result: config });
    case "config/batchWrite": return write({ id: message.id, result: {} });
    case "thread/start": return write({ id: message.id, result: { thread: { id: "thread-" + process.pid + "-" + (++threads), turns: [] } } });
    case "thread/resume": return write({ id: message.id, result: { thread: { id: params.threadId, turns: [] } } });
    case "thread/unsubscribe": return write({ id: message.id, result: { status: "Unsubscribed" } });
    case "thread/turns/list":
    case "thread/items/list": return write({ id: message.id, result: { data: [], nextCursor: null } });
    case "thread/read": return write({ id: message.id, result: { thread: { id: params.threadId, turns: [] } } });
    case "turn/start": {
      const turnId = "turn-" + process.pid + "-" + (++turns);
      const text = (params.input || []).map((item) => item.text || "").join("\\n");
      write({ id: message.id, result: { turn: { id: turnId, status: "inProgress", items: [] } } });
      write({ method: "turn/started", params: { threadId: params.threadId, turn: { id: turnId } } });
      const step = [...text.matchAll(/STEP:([a-z0-9-]+)/g)].at(-1)?.[1];
      const call = step ? JSON.parse(readFileSync(PLAN, "utf8"))[step] : undefined;
      if (!call) return setTimeout(() => finish(params.threadId, turnId), 20);
      const id = "tool-" + turnId;
      waiting.set(id, { threadId: params.threadId, turnId });
      return write({
        id,
        method: "item/tool/call",
        params: { threadId: params.threadId, turnId, callId: "call-" + turnId, namespace: "openbot", tool: "tool_call", arguments: { name: "openbot." + call.tool, arguments: call.args } },
      });
    }
    case "turn/interrupt": {
      write({ id: message.id, result: {} });
      return write({ method: "turn/completed", params: { threadId: params.threadId, turn: { id: params.turnId, status: "interrupted" } } });
    }
    default:
      return write({ id: message.id, error: { code: -32601, message: "Method not found: " + message.method } });
  }
};
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let newline = buffer.indexOf("\\n");
  while (newline >= 0) {
    const line = buffer.slice(0, newline);
    buffer = buffer.slice(newline + 1);
    if (line) {
      const message = JSON.parse(line);
      if (message.method && message.id !== undefined) answer(message);
      else if (!message.method && waiting.has(message.id)) {
        const turn = waiting.get(message.id);
        waiting.delete(message.id);
        finish(turn.threadId, turn.turnId);
      }
    }
    newline = buffer.indexOf("\\n");
  }
});
`;

const unused = () => Effect.die(new Error("Not used by this check."));
const browser: AgentBrowserHost = {
  listTabs: () => [],
  beginTakeover: unused,
  endTakeover: () => {},
  resolveUploadTarget: unused,
  handleDynamicTool: unused,
  userControlTabFor: () => null,
  awaitUserControlRelease: unused,
  onChanged: () => () => {},
  onControlChanged: () => () => {},
  onDocumentChanged: () => () => {},
  clearControls: () => {},
  endControl: () => {},
  close: () => Effect.void,
  clearAgentSession: () => Effect.void,
};

async function waitFor<T>(label: string, read: () => T | null | undefined | false, timeoutMs = 20_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = read();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}.`);
    await new Promise((done) => setTimeout(done, 25));
  }
}

interface CaseReport {
  name: string;
  unread: number;
  agentTalk: boolean;
  notification: string | null;
  passed: boolean;
}
const report: { cases: CaseReport[]; passed: boolean; error?: string } = { cases: [], passed: false };

await writeFile(fakeCodex, FAKE_CODEX, { mode: 0o755 });
const database = new OpenBotDatabase(userData);
const store = new AgentStore(userData, home, database);
const mailbox = new MailboxStore(userData, store.sharedRoot, store.database);
const agents = new AgentService({
  store,
  mailbox,
  browser,
  preferredProvider: "codex",
  offProviders: AGENT_PROVIDERS.filter((provider) => provider !== "codex"),
  timezone: () => "UTC",
  approvalAutomation: {
    autoApproves: () => true,
    set: () => Effect.succeed({ defaultAutoApprove: true, autoApproveOverrides: {} }),
  },
});
const owner: ConversationMessageSender = { id: "local-user:owner", name: "Alejandro" };
const events: AgentEvent[] = [];
agents.on("event", (event: AgentEvent) => events.push(event));
const t = translateFor("es");

const idle = (agentId: string, timeoutMs?: number) =>
  waitFor(
    "the agent to finish",
    () =>
      agents
        .listQueue(agentId)
        .deliveries.every((delivery) => !["queued", "starting", "running"].includes(delivery.status)),
    timeoutMs,
  );

/** The turn-completed events of an agent so far. */
const completions = (agentId: string) =>
  events.filter(
    (event): event is Extract<AgentEvent, { type: "turn-completed" }> =>
      event.type === "turn-completed" && event.agentId === agentId,
  );

async function create(name: string) {
  const agent = await runCauseEffect(
    agents.createAgent({
      name,
      description: `${name} checks the owner's chat.`,
      avatarSeed: name.toLowerCase().replace(/[^a-z0-9]+/gu, "-"),
      avatarHue: null,
      initialMessage: "Hola.",
    }),
  );
  await waitFor("the first turn", () => completions(agent.id).length === 1);
  await idle(agent.id);
  return agent;
}

/** Reads the chat as read, so the next step starts from no unread message. */
async function readAll(agentId: string) {
  const snapshot = await runCauseEffect(agents.readConversation(agentId));
  await runCauseEffect(agents.markConversationRead(agentId, owner.id, snapshot.messages.at(-1)?.id ?? null));
}

/** Waits for the agent's next turn to end, then records what the owner gets from it. */
async function afterTurn(name: string, agentId: string, turnsBefore: number, timeoutMs?: number) {
  const ended = await waitFor("the turn to end", () => completions(agentId)[turnsBefore], timeoutMs);
  await idle(agentId);
  const unread = agents.listConversationReads(owner.id)[agentId]?.unreadCount ?? -1;
  // The host's other count, over the chat's messages, must agree with the SQL one.
  const snapshot = await runCauseEffect(agents.readConversation(agentId));
  const cursor = agents.listConversationReads(owner.id)[agentId]?.throughMessageId ?? null;
  const reads = new ConversationReadStore(database);
  const snapshotState = reads.markRead(`${owner.id}:check`, snapshot, cursor);
  assert.equal(snapshotState.unreadCount, unread, `${name}: the SQL and snapshot counts agree`);
  const list: ClientAgentSummary[] = agents.listAgents().map((agent) => ({ ...agent, notifications: true }));
  const content = notificationForAgentEvent(ended, list, t, "all");
  return { ended, unread, content, snapshot };
}

try {
  await runCauseEffect(agents.initialize());
  const lead = await create("QA de Producto");
  const teammate = await create("CSO");
  writeFileSync(
    planFile,
    JSON.stringify({
      "ask-lead": {
        tool: "send_message",
        args: { recipientAgentIds: [lead.id], text: "Revisa MAS-28, por favor.", expectsReply: true },
      },
      "tell-owner": { tool: "message_owner", args: { text: OWNER_NOTE } },
    }),
  );
  await readAll(lead.id);

  // (a) A Motion event.
  let before = completions(lead.id).length;
  await runCauseEffect(
    agents.sendMessage(
      { agentId: lead.id, text: "Motion · MAS-28 was reopened after review." },
      undefined,
      undefined,
      "motion-event",
    ),
  );
  const motion = await afterTurn("motion", lead.id, before);
  assert.equal(motion.unread, 0, "A Motion wake adds nothing unread.");
  assert.equal(motion.ended.agentTalk, true, "A Motion wake is the agent's own activity.");
  assert.equal(motion.content, null, "A Motion wake tells the owner nothing.");
  report.cases.push({
    name: "Motion event wake",
    unread: motion.unread,
    agentTalk: true,
    notification: null,
    passed: true,
  });

  // (b) A teammate's message. It wakes the agent after the coalescing window.
  before = completions(lead.id).length;
  await runCauseEffect(agents.sendMessage({ agentId: teammate.id, text: "STEP:ask-lead" }, owner));
  const teammateTurn = await afterTurn("teammate", lead.id, before, AGENT_WAKE_COALESCE_MS + 60_000);
  assert.ok(
    teammateTurn.snapshot.messages.some((message) => message.exchange?.senderAgentId === teammate.id),
    "The teammate's message reached the agent.",
  );
  assert.equal(teammateTurn.unread, 0, "A teammate's wake adds nothing unread.");
  assert.equal(teammateTurn.ended.agentTalk, true);
  assert.equal(teammateTurn.content, null, "A teammate's wake tells the owner nothing.");
  report.cases.push({
    name: "teammate message wake",
    unread: teammateTurn.unread,
    agentTalk: true,
    notification: null,
    passed: true,
  });

  // (c) The owner's own message.
  before = completions(lead.id).length;
  await runCauseEffect(agents.sendMessage({ agentId: lead.id, text: "¿Cómo va MAS-28?" }, owner));
  const ownerTurn = await afterTurn("owner", lead.id, before);
  assert.equal(ownerTurn.unread, 1, "The answer to the owner counts as unread.");
  assert.equal(ownerTurn.ended.agentTalk, undefined);
  assert.ok(ownerTurn.content, "The answer to the owner tells the owner.");
  report.cases.push({
    name: "owner message and its answer",
    unread: ownerTurn.unread,
    agentTalk: false,
    notification: ownerTurn.content.body,
    passed: true,
  });
  await readAll(lead.id);

  // (d) A Motion event, and the agent writes to the owner on purpose.
  before = completions(lead.id).length;
  await runCauseEffect(
    agents.sendMessage(
      { agentId: lead.id, text: "Motion · MAS-30 needs the owner's OK. STEP:tell-owner" },
      undefined,
      undefined,
      "motion-event",
    ),
  );
  const told = await afterTurn("message_owner", lead.id, before);
  const posted = told.snapshot.messages.find((message) => message.itemType === OWNER_MESSAGE_ITEM_TYPE);
  assert.equal(posted?.text, OWNER_NOTE, "The message to the owner is in the chat.");
  assert.equal(told.unread, 1, "Only the message to the owner counts as unread, not the turn's answer.");
  assert.equal(told.ended.agentTalk, undefined, "A turn with a message to the owner tells the owner.");
  assert.ok(told.content, "The owner is told.");
  report.cases.push({
    name: "Motion wake with message_owner",
    unread: told.unread,
    agentTalk: false,
    notification: told.content.body,
    passed: true,
  });
  report.passed = true;
} catch (error) {
  report.error = error instanceof Error ? (error.stack ?? error.message) : String(error);
  process.exitCode = 1;
} finally {
  await runCauseEffect(agents.stop()).catch(() => {});
  database.close();
  mkdirSync(OUT, { recursive: true });
  writeFileSync(join(OUT, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  await rm(root, { recursive: true, force: true });
  process.stdout.write(`${report.passed ? "PASS" : "FAIL"} ${join(OUT, "report.json")}\n`);
  if (report.error) process.stdout.write(`${report.error}\n`);
}
