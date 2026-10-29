// Checks the core of the Slack-style workspace on the real agent service and channel service of a
// temporary profile, with a fake Codex app-server whose turns answer "Done." and a fake gate model:
//
// - Answer modes: a `mention` member answers only when a person addresses it; an `always` member
//   asks the gate, and answers only when the gate says yes; an `always-no-gate` member answers every
//   message without asking the gate.
// - The gate: one question for each `always` member, its decisions stored on the message, at most
//   two gated answers, and the highest priorities first.
// - Private channels: a person who is not in one does not see it, an admin does, and an agent that is
//   not a member cannot be addressed in it.
// - DMs: an agent answers each message of its DM without a mention.
//
// `bun scripts/workspace-scope-e2e.ts`. Writes .openbot-build/workspace-scope-e2e/report.json.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { AGENT_PROVIDERS, type ChannelMessage } from "@openbot/contracts/ipc";
import { Effect } from "effect";
import type { AgentBrowserHost } from "../src/backend/agent/turn-lifecycle";
import type { ChannelGateModel } from "../src/backend/channel-gate";

const OUT = resolve(import.meta.dirname, "../.openbot-build/workspace-scope-e2e");
const root = await mkdtemp(join(tmpdir(), "openbot-workspace-scope-"));
const userData = join(root, "user-data");
const home = join(root, "home");
const fakeCodex = join(root, "codex");

// Before the service modules load: the Codex process and the stores read the home folder.
process.env.HOME = home;
process.env.CODEX_HOME = join(home, ".codex");
process.env.OPENBOT_CODEX_PATH = fakeCodex;
mkdirSync(home, { recursive: true });

const { AgentService } = await import("../src/backend/agent-service");
const { AgentStore } = await import("../src/backend/agent-store");
const { runCauseEffect } = await import("../src/backend/effect-boundary");
const { MailboxStore } = await import("../src/backend/mailbox-store");
const { OpenBotDatabase } = await import("../src/backend/openbot-database");
const { channelViewer } = await import("../src/backend/channel-visibility");

const PERSON = { id: "local", name: "Alex" };

/** A Codex app-server with the methods that the service calls. Every turn answers "Done.". */
const FAKE_CODEX = `#!/usr/bin/env node
if (process.argv.includes("--version")) {
  process.stdout.write("codex-cli 0.160.1\\n");
  process.exit(0);
}
const config = { config: { mcp_servers: {} }, layers: [{ name: { type: "user", file: "/fake/.codex/config.toml", profile: null }, version: "1", config: { mcp_servers: {} } }] };
let buffer = "";
let threads = 0;
let turns = 0;
process.stdout.on("error", (error) => {
  if (error.code === "EPIPE") process.exit(0);
  throw error;
});
const write = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
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
    case "thread/start": return write({ id: message.id, result: { thread: { id: "thread-" + (++threads), turns: [] } } });
    case "thread/resume": return write({ id: message.id, result: { thread: { id: params.threadId, turns: [] } } });
    case "thread/unsubscribe": return write({ id: message.id, result: { status: "Unsubscribed" } });
    case "thread/turns/list":
    case "thread/items/list": return write({ id: message.id, result: { data: [], nextCursor: null } });
    case "thread/read": return write({ id: message.id, result: { thread: { id: params.threadId, turns: [] } } });
    case "turn/start": {
      const turnId = "turn-" + (++turns);
      write({ id: message.id, result: { turn: { id: turnId, status: "inProgress", items: [] } } });
      write({ method: "turn/started", params: { threadId: params.threadId, turn: { id: turnId } } });
      return setTimeout(() => {
        const item = { type: "agentMessage", id: "message-" + turnId, text: "Done.", phase: "final_answer" };
        write({ method: "item/completed", params: { threadId: params.threadId, turnId, item } });
        write({ method: "turn/completed", params: { threadId: params.threadId, turn: { id: turnId, status: "completed" } } });
      }, 20);
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
    }
    newline = buffer.indexOf("\\n");
  }
});
`;

const report: { checks: { name: string; passed: boolean }[]; gateQuestions: number; passed: boolean; error?: string } =
  { checks: [], gateQuestions: 0, passed: false };

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

/** Waits a little and checks that a state never came, for what must not happen. */
async function stays(label: string, read: () => boolean, ms = 1_500): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    assert.ok(!read(), `It happened, and must not: ${label}.`);
    await new Promise((done) => setTimeout(done, 50));
  }
}

function pass(name: string, condition: boolean, detail?: string) {
  report.checks.push({ name, passed: condition });
  assert.ok(condition, detail ? `${name}: ${detail}` : name);
}

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
});
const channels = () => agents.channels;

/** The fake cheap model: each agent wants to answer only messages about its own topic. */
const topics = new Map<string, { word: string; priority: number }>();
const gateModel: ChannelGateModel = {
  label: "fake/gate",
  timeoutMs: 5_000,
  generate: (agentId, prompt) =>
    Effect.sync(() => {
      report.gateQuestions += 1;
      const topic = topics.get(agentId);
      // Only the newest message counts: the prompt also has the agent's profile and older messages.
      const newest = prompt.split("The newest message, which you decide about:\n")[1]?.split("\n")[0] ?? "";
      const answer = Boolean(topic && newest.toLowerCase().includes(topic.word));
      const priority = topic?.priority ?? 0.5;
      return JSON.stringify({ answer, reason: answer ? `About ${topic?.word}.` : "Not about my work.", priority });
    }),
};
// The test's model in place of the provider generation; the rest of the hooks stay real.
Object.assign(channels().hooks, { gate: () => gateModel });

const command = (value: Parameters<ReturnType<typeof channels>["command"]>[0], actor = PERSON) =>
  runCauseEffect(channels().command(value, actor));
const answersOf = (channelId: string, agentId: string): ChannelMessage[] =>
  channels()
    .store.messages(channelId)
    .filter((entry) => entry.author.kind === "agent" && entry.author.id === agentId && entry.message.text === "Done.");
const idle = (channelId: string) =>
  waitFor("the channel's tasks to end", () =>
    channels()
      .store.tasks(channelId)
      .every((task) => !["queued", "running", "waiting"].includes(task.state)),
  );
async function say(channelId: string, text: string, recipientAgentId: string | null = null): Promise<ChannelMessage> {
  const before = new Set(
    channels()
      .store.messages(channelId)
      .map((entry) => entry.id),
  );
  await command({
    type: "send",
    operationId: randomUUID(),
    channelId,
    text,
    recipientAgentId,
    replyToMessageId: null,
    attachmentDraftIds: [],
  });
  return waitFor("the person's message", () =>
    channels()
      .store.messages(channelId)
      .find((entry) => !before.has(entry.id) && entry.author.kind === "member" && entry.message.text === text),
  );
}

try {
  await runCauseEffect(agents.initialize());
  const create = async (name: string) => {
    const agent = await runCauseEffect(
      agents.createAgent({
        name,
        description: `${name} is a teammate.`,
        avatarSeed: name.toLowerCase(),
        avatarHue: null,
        initialMessage: "Hello.",
      }),
    );
    await waitFor(`the first chat turn of ${name} to end`, () =>
      agents
        .listQueue(agent.id)
        .deliveries.every((delivery) => !["queued", "starting", "running"].includes(delivery.status)),
    );
    return agent;
  };
  const baker = await create("Baker");
  const tester = await create("Tester");
  const writer = await create("Writer");
  const outsider = await create("Outsider");
  topics.set(baker.id, { word: "cake", priority: 0.9 });
  topics.set(tester.id, { word: "cake", priority: 0.4 });
  topics.set(writer.id, { word: "cake", priority: 0.7 });

  // --- Answer modes and the gate ---
  const team = randomUUID();
  await command({
    type: "create",
    operationId: randomUUID(),
    channelId: team,
    kind: "channel",
    visibility: "public",
    name: "team",
    humanMemberIds: [PERSON.id],
    members: [
      { agentId: baker.id, answerMode: "always" },
      { agentId: tester.id, answerMode: "always" },
      { agentId: writer.id, answerMode: "always" },
      { agentId: outsider.id, answerMode: "mention" },
    ],
  });

  const offTopic = await say(team, "Does anyone know a good tire shop?");
  const offDecisions = await waitFor("the gate's decisions on the off-topic message", () => {
    const stored = channels().store.message(team, offTopic.id);
    return stored?.gateDecisions?.length === 3 && !stored.gatePending?.length ? stored.gateDecisions : null;
  });
  pass("The gate asks each always member once", offDecisions.length === 3);
  pass(
    "The gate keeps every always member quiet on an off-topic message",
    offDecisions.every((d) => !d.answer),
  );
  pass("The mention member is not asked", !offDecisions.some((d) => d.agentId === outsider.id));
  await stays("an agent answers the off-topic message", () =>
    [baker, tester, writer, outsider].some((agent) => answersOf(team, agent.id).length > 0),
  );

  const onTopic = await say(team, "Is the cake recipe ready?");
  const onDecisions = await waitFor("the gate's decisions on the on-topic message", () => {
    const stored = channels().store.message(team, onTopic.id);
    return stored?.gateDecisions?.length === 3 && !stored.gatePending?.length ? stored.gateDecisions : null;
  });
  pass(
    "The gate decision log names the model",
    onDecisions.every((d) => d.model === "fake/gate"),
  );
  await waitFor("Baker's answer", () => answersOf(team, baker.id).length > 0);
  await idle(team);
  pass("The highest priority answers first", answersOf(team, baker.id).length === 1);
  const finalDecisions = channels().store.message(team, onTopic.id)?.gateDecisions ?? [];
  const final = (agentId: string) => finalDecisions.filter((d) => d.agentId === agentId).at(-1);
  pass(
    "The second round lets the next priority answer, up to two gated answers",
    answersOf(team, writer.id).length === 1 && answersOf(team, tester.id).length === 0,
    JSON.stringify(finalDecisions),
  );
  pass(
    "The lowest priority is held back by the limit",
    final(tester.id)?.limited === true || final(tester.id)?.answer === false,
    JSON.stringify(finalDecisions),
  );
  pass("A mention member stays quiet without a mention", answersOf(team, outsider.id).length === 0);

  await say(team, "@Outsider can you check the tire shop list?", outsider.id);
  await waitFor("the mentioned member's answer", () => answersOf(team, outsider.id).length > 0);
  pass("A mention member answers when a person addresses it", answersOf(team, outsider.id).length === 1);
  await idle(team);

  await command({
    type: "set-member",
    operationId: randomUUID(),
    channelId: team,
    agentId: tester.id,
    answerMode: "always-no-gate",
  });
  const questionsBefore = report.gateQuestions;
  const testerBefore = answersOf(team, tester.id).length;
  const plain = await say(team, "Good morning everyone");
  await waitFor("the no-gate member's answer", () => answersOf(team, tester.id).length > testerBefore);
  await waitFor("the gate to finish", () => !channels().store.message(team, plain.id)?.gatePending?.length);
  const plainDecisions = channels().store.message(team, plain.id)?.gateDecisions ?? [];
  pass(
    "An always-no-gate member answers without asking the gate",
    !plainDecisions.some((d) => d.agentId === tester.id),
  );
  pass("The gate is asked only for the gated members", report.gateQuestions - questionsBefore === 2);
  await idle(team);

  // --- Private channels ---
  const secret = randomUUID();
  await command({
    type: "create",
    operationId: randomUUID(),
    channelId: secret,
    kind: "channel",
    visibility: "private",
    name: "secret",
    humanMemberIds: [PERSON.id],
    members: [{ agentId: baker.id, answerMode: "mention" }],
  });
  const ids = (viewer: ReturnType<typeof channelViewer>) =>
    channels()
      .store.list(viewer.id, false, viewer)
      .map((summary) => summary.id);
  pass("A person outside a private channel does not see it", !ids(channelViewer("rui", "member")).includes(secret));
  pass("A person in a private channel sees it", ids(channelViewer(PERSON.id, "member")).includes(secret));
  pass("An admin sees a private channel", ids(channelViewer("admin", "admin")).includes(secret));
  pass("A public channel shows to everyone", ids(channelViewer("rui", "member")).includes(team));
  const refused = await command({
    type: "send",
    operationId: randomUUID(),
    channelId: secret,
    text: "@Outsider what is in here?",
    recipientAgentId: outsider.id,
    replyToMessageId: null,
    attachmentDraftIds: [],
  }).then(
    () => false,
    () => true,
  );
  await stays("an agent outside the private channel answers in it", () => answersOf(secret, outsider.id).length > 0);
  pass(
    "An agent outside a private channel cannot be addressed in it",
    refused || answersOf(secret, outsider.id).length === 0,
  );
  pass(
    "A private channel's members do not include outsiders",
    !channels()
      .store.get(secret)
      .members.some((m) => m.agentId === outsider.id),
  );

  // --- DMs ---
  const dmId = randomUUID();
  const dm = await command({
    type: "open-dm",
    operationId: randomUUID(),
    channelId: dmId,
    memberIds: [],
    agentIds: [baker.id],
  });
  const dmChannel = isDm(dm) ? dm : channels().store.get(dmId);
  const before = answersOf(dmChannel.id, baker.id).length;
  await say(dmChannel.id, "Quick question about tires");
  await waitFor("the DM answer", () => answersOf(dmChannel.id, baker.id).length > before);
  pass("An agent answers each message of its DM without a mention", true);
  await idle(dmChannel.id);

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

function isDm(value: unknown): value is { id: string } {
  return typeof value === "object" && value !== null && "id" in value && typeof value.id === "string";
}
