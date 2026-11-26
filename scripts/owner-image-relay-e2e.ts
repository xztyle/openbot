// The owner sees an image that two teammates passed on: Image Generator makes it and sends it to
// Creativo, Creativo forwards the attached file to CSO, and CSO tells the owner with
// `message_owner` and the file in `paths`. Runs the real agent service on a temporary profile with a
// fake Codex app-server; each turn whose text names a STEP calls the planned Atelier tool, with
// "$ATTACHED" replaced by the first attached local file of the message that started the turn.
// Checks: each teammate gets the image as an attached local file; CSO's message to the owner is in
// CSO's chat with the owner, counts as unread, and carries the image with the same bytes; no error
// event reaches the owner. `scripts/owner-dm-only-web-e2e.ts` checks that such an image shows in the
// chat on a computer and a phone.
// `bun scripts/owner-image-relay-e2e.ts`. Writes .openbot-build/owner-image-relay-e2e/report.json.
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { AGENT_PROVIDERS, type AgentEvent, type ConversationMessageSender } from "@openbot/contracts/ipc";
import { OWNER_MESSAGE_ITEM_TYPE } from "@openbot/contracts/owner-conversation";
import { Effect } from "effect";
import type { AgentBrowserHost } from "../src/backend/agent/turn-lifecycle";
import { AGENT_WAKE_COALESCE_MS } from "../src/backend/collaboration-limits";

const OUT = resolve(import.meta.dirname, "../.openbot-build/owner-image-relay-e2e");
const root = await mkdtemp(join(tmpdir(), "openbot-image-relay-"));
const userData = join(root, "user-data");
const home = join(root, "home");
const fakeCodex = join(root, "codex");
const planFile = join(root, "plan.json");
// A 1 x 1 PNG: the turkey of the campaign.
const PAVO = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP4+5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==",
  "base64",
);
const OWNER_NOTE = "Este es el pavo para la campaña de Acción de Gracias.";

process.env.HOME = home;
process.env.CODEX_HOME = join(home, ".codex");
process.env.OPENBOT_CODEX_PATH = fakeCodex;
mkdirSync(home, { recursive: true });

const { AgentService } = await import("../src/backend/agent-service");
const { AgentStore } = await import("../src/backend/agent-store");
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
      // "$ATTACHED" stands for the first file of the message's "Attached local files" list.
      const attached = /Attached local files:\\n- [^:]+: (.+)/.exec(text)?.[1];
      const args = call && attached ? JSON.parse(JSON.stringify(call.args).replaceAll("$ATTACHED", attached)) : call?.args;
      if (!call) return setTimeout(() => finish(params.threadId, turnId), 20);
      const id = "tool-" + turnId;
      waiting.set(id, { threadId: params.threadId, turnId });
      return write({
        id,
        method: "item/tool/call",
        params: { threadId: params.threadId, turnId, callId: "call-" + turnId, namespace: "openbot", tool: "tool_call", arguments: { name: "openbot." + call.tool, arguments: args } },
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

const report: {
  passed: boolean;
  hops: Array<{ agent: string; attached: string | null }>;
  ownerMessage?: { text: string; attachments: string[]; sameBytes: boolean; unread: number };
  error?: string;
} = { passed: false, hops: [] };

await writeFile(fakeCodex, FAKE_CODEX, { mode: 0o755 });
const database = new OpenBotDatabase(userData);
const store = new AgentStore(userData, home, database);
// As the application makes it: a message's files go to the Shared folder of its space.
const mailbox = new MailboxStore(userData, store.sharedRoot, store.database, store.spaces);
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

const idle = (agentId: string, timeoutMs?: number) =>
  waitFor(
    "the agent to finish",
    () =>
      agents
        .listQueue(agentId)
        .deliveries.every((delivery) => !["queued", "starting", "running"].includes(delivery.status)),
    timeoutMs,
  );
const completions = (agentId: string) =>
  events.filter((event) => event.type === "turn-completed" && event.agentId === agentId).length;

async function create(name: string) {
  const agent = await runCauseEffect(
    agents.createAgent({
      name,
      description: `${name} works on the campaign.`,
      avatarSeed: name.toLowerCase().replace(/[^a-z0-9]+/gu, "-"),
      avatarHue: null,
      initialMessage: "Hola.",
    }),
  );
  await waitFor("the first turn", () => completions(agent.id) === 1);
  await idle(agent.id);
  return agent;
}

/** The image that reached `agentId` in a teammate's message, by the path its prompt names. */
async function attachedTo(agentId: string): Promise<string | null> {
  const snapshot = await runCauseEffect(agents.readConversation(agentId));
  const received = snapshot.messages.filter(
    (message) => message.exchange?.senderAgentId && message.attachments?.length,
  );
  return received.at(-1)?.attachments?.[0]?.name ?? null;
}

try {
  await runCauseEffect(agents.initialize());
  const generator = await create("Image Generator");
  const creativo = await create("Creativo");
  const cso = await create("CSO");
  const image = join(generator.workspacePath, "pavo.png");
  writeFileSync(image, PAVO);
  writeFileSync(
    planFile,
    JSON.stringify({
      generate: {
        tool: "send_message",
        args: {
          recipientAgentIds: [creativo.id],
          text: "Aquí va el pavo. STEP:forward",
          paths: [image],
          expectsReply: false,
        },
      },
      forward: {
        tool: "send_message",
        args: {
          recipientAgentIds: [cso.id],
          text: "El pavo para revisar. STEP:tell-owner",
          paths: ["$ATTACHED"],
          expectsReply: false,
        },
      },
      "tell-owner": { tool: "message_owner", args: { text: OWNER_NOTE, paths: ["$ATTACHED"] } },
    }),
  );
  const csoTurns = completions(cso.id);
  await runCauseEffect(agents.sendMessage({ agentId: generator.id, text: "Haz el pavo. STEP:generate" }, owner));
  const wake = AGENT_WAKE_COALESCE_MS + 60_000;
  await waitFor("Creativo's turn", () => completions(creativo.id) > 1, wake);
  await waitFor("CSO's turn", () => completions(cso.id) > csoTurns, wake * 2);
  await idle(cso.id);
  report.hops.push({ agent: "Creativo", attached: await attachedTo(creativo.id) });
  report.hops.push({ agent: "CSO", attached: await attachedTo(cso.id) });
  assert.equal(report.hops[0]?.attached, "pavo.png", "Creativo did not get the image.");
  assert.equal(report.hops[1]?.attached, "pavo.png", "CSO did not get the image that Creativo passed on.");

  const snapshot = await runCauseEffect(agents.readConversation(cso.id));
  const posted = snapshot.messages.find((message) => message.itemType === OWNER_MESSAGE_ITEM_TYPE);
  assert.equal(posted?.text, OWNER_NOTE, "CSO's message to the owner is not in its chat.");
  const attachment = posted?.attachments?.[0];
  assert.equal(attachment?.name, "pavo.png", "The message to the owner has no image.");
  assert.equal(attachment?.kind, "image");
  const file = await runCauseEffect(mailbox.resolveAttachment(attachment.id));
  assert.ok(file, "The image of the message to the owner has no file.");
  const sameBytes = readFileSync(file.path).equals(PAVO);
  assert.ok(sameBytes, "The owner's image is not the image that Image Generator made.");
  const unread = agents.listConversationReads(owner.id)[cso.id]?.unreadCount ?? -1;
  report.ownerMessage = {
    text: posted.text,
    attachments: (posted.attachments ?? []).map(({ name }) => name),
    sameBytes,
    unread,
  };
  assert.ok(unread >= 1, "The message to the owner does not count as unread.");
  const errors = events.filter((event) => event.type === "error");
  assert.deepEqual(errors, [], "An error reached the owner.");
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
