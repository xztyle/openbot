// Checks that an agent manages workspace channels from its own chat, as a person does in the channel
// settings: it lists, reads, creates, renames, archives, restores and deletes channels, adds and
// removes members, sets their answer modes, focus and the routing, makes a group, and posts a brief
// that gives members tasks. It also checks the rules: an agent sees and changes only channels of its
// own space, adds only agents of its space, changes only channels it is a member of or made, does not
// make a second channel with the same name, and deletes only with userAsked. The user is a person of
// each channel an agent makes, and each change emits the channel and space events the clients read.
// Runs the real agent service, channel service, space service and tool router on a temporary profile
// with a fake Codex app-server, which calls each tool through `tool_call` as a model does.
// `bun scripts/agent-channel-admin-e2e.ts`. Writes .openbot-build/agent-channel-admin-e2e/report.json.
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { AGENT_PROVIDERS, type AgentEvent, type Channel, isChannelChangeMarker } from "@openbot/contracts/ipc";
import { type DynamicRecord, isDynamicRecord } from "@openbot/contracts/runtime-values";
import { Effect } from "effect";
import type { AgentBrowserHost } from "../src/backend/agent/turn-lifecycle";

const OUT = resolve(import.meta.dirname, "../.openbot-build/agent-channel-admin-e2e");
const root = await mkdtemp(join(tmpdir(), "openbot-channel-admin-"));
const userData = join(root, "user-data");
const home = join(root, "home");
const fakeCodex = join(root, "codex");
const fakeLog = join(root, "codex.jsonl");

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

const CALL_MARK = "ADMIN-CALL";
let requests = 0;
/** The host user of this computer, the first person of the team. */
const PERSON = { id: "member-owner", name: "Alex" };

/**
 * A Codex app-server with the methods that the service calls. A turn whose input has
 * `ADMIN-CALL#<n> <<ARGS{"__tool":"…",…}ARGS>>` calls `openbot.<__tool>` with the rest of that JSON
 * through `tool_call` (`tool_search` directly), logs the result, and ends. Other turns answer "Done.".
 */
const FAKE_CODEX = `#!/usr/bin/env node
const { appendFileSync } = require("node:fs");
if (process.argv.includes("--version")) {
  process.stdout.write("codex-cli 0.160.1\\n");
  process.exit(0);
}
const LOG = ${JSON.stringify(fakeLog)};
const config = { config: { mcp_servers: {} }, layers: [{ name: { type: "user", file: "/fake/.codex/config.toml", profile: null }, version: "1", config: { mcp_servers: {} } }] };
let buffer = "";
let threads = 0;
let turns = 0;
/** The numbers of the requests that ran. */
const executed = new Set();
/** Tool request id -> the turn that waits for its result. */
const waiting = new Map();
process.stdout.on("error", (error) => {
  if (error.code === "EPIPE") process.exit(0);
  throw error;
});
const log = (entry) => appendFileSync(LOG, JSON.stringify(entry) + "\\n");
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
    case "thread/start": {
      log({ kind: "thread", developerInstructions: params.developerInstructions || "", roots: params.runtimeWorkspaceRoots || [] });
      return write({ id: message.id, result: { thread: { id: "thread-" + (++threads), turns: [] } } });
    }
    case "thread/resume": {
      log({ kind: "thread", developerInstructions: params.developerInstructions || "", roots: params.runtimeWorkspaceRoots || [] });
      return write({ id: message.id, result: { thread: { id: params.threadId, turns: [] } } });
    }
    case "thread/unsubscribe": return write({ id: message.id, result: { status: "Unsubscribed" } });
    case "thread/turns/list":
    case "thread/items/list": return write({ id: message.id, result: { data: [], nextCursor: null } });
    case "thread/read": return write({ id: message.id, result: { thread: { id: params.threadId, turns: [] } } });
    case "turn/start": {
      const turnId = "turn-" + (++turns);
      const text = (params.input || []).map((item) => item.text || "").join("\\n");
      write({ id: message.id, result: { turn: { id: turnId, status: "inProgress", items: [] } } });
      write({ method: "turn/started", params: { threadId: params.threadId, turn: { id: turnId } } });
      const calls = [...text.matchAll(/ADMIN-CALL#(\\d+) <<ARGS([\\s\\S]*?)ARGS>>/g)];
      // A reply or a channel packet can quote a request that ran already; each request runs once.
      const match = calls.filter((call) => !executed.has(call[1])).at(-1);
      if (match) executed.add(match[1]);
      if (!match) return setTimeout(() => finish(params.threadId, turnId), 20);
      const id = "tool-" + turnId;
      waiting.set(id, { threadId: params.threadId, turnId });
      // The packet carries the request as JSON text, so its quotes arrive escaped.
      const { __tool, ...args } = JSON.parse(match[2].replace(/\\\\"/g, '"'));
      return write({
        id,
        method: "item/tool/call",
        params: {
          threadId: params.threadId,
          turnId,
          callId: "call-" + turnId,
          namespace: "openbot",
          // Discovery is its own tool; every other tool goes through tool_call.
          tool: __tool === "tool_search" ? "tool_search" : "tool_call",
          arguments: __tool === "tool_search" ? args : { name: "openbot." + __tool, arguments: args },
        },
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
        log({ kind: "tool", turnId: turn.turnId, result: message.result ?? null, error: message.error ?? null });
        finish(turn.threadId, turn.turnId);
      }
    }
    newline = buffer.indexOf("\\n");
  }
});
`;

type LogEntry =
  | {
      kind: "tool";
      turnId: string;
      result: { success: boolean; contentItems: { type: string; text: string }[] } | null;
      error: unknown;
    }
  | { kind: "thread"; developerInstructions: string; roots: string[] };

const report: {
  calls: { name: string; success: boolean | null; text: string }[];
  checks: { name: string; passed: boolean }[];
  notes: string[];
  passed: boolean;
  error?: string;
} = { calls: [], checks: [], notes: [], passed: false };

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

/** Waits for a state of the service or the fake's log. */
async function waitFor<T>(label: string, read: () => T | null | undefined | false, timeoutMs = 20_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = read();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}.`);
    await new Promise((done) => setTimeout(done, 25));
  }
}

function logEntries(): LogEntry[] {
  let text = "";
  try {
    text = readFileSync(fakeLog, "utf8");
  } catch {
    return [];
  }
  return text
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

const toolLogs = () => logEntries().filter((entry) => entry.kind === "tool");

function pass(name: string, condition: boolean, detail?: string) {
  report.checks.push({ name, passed: condition });
  assert.ok(condition, detail ? `${name}: ${detail}` : name);
}

await writeFile(fakeCodex, FAKE_CODEX, { mode: 0o755 });
const database = new OpenBotDatabase(userData);
const store = new AgentStore(userData, home, database);
const mailbox = new MailboxStore(userData, store.sharedRoot, store.database, store.spaces);
const agents = new AgentService({
  store,
  mailbox,
  browser,
  preferredProvider: "codex",
  offProviders: AGENT_PROVIDERS.filter((provider) => provider !== "codex"),
  timezone: () => "UTC",
  channelPeople: () => [PERSON],
  channelPerson: (id) => (id === PERSON.id ? PERSON : null),
});
const channels = () => agents.channels;
const events: AgentEvent[] = [];
agents.on("event", (event) => events.push(event));

function idle(agentId: string) {
  return waitFor("the agent's turns to end", () =>
    agents
      .listQueue(agentId)
      .deliveries.every((delivery) => !["queued", "starting", "running"].includes(delivery.status)),
  );
}

/** A person's message to the agent that makes the fake call `tool`; returns the tool result. */
async function callTool(name: string, agentId: string, tool: string, args: DynamicRecord) {
  const before = toolLogs().length;
  await runCauseEffect(
    agents.sendMessage({
      agentId,
      text: `${CALL_MARK}#${++requests} <<ARGS${JSON.stringify({ __tool: tool, ...args })}ARGS>>`,
      attachmentDraftIds: [],
    }),
  );
  const entry = await waitFor(`${name} tool result`, () => toolLogs()[before]);
  await idle(agentId);
  const text =
    entry.kind === "tool"
      ? (entry.result?.contentItems.map((item) => item.text).join("\n") ?? JSON.stringify(entry.error))
      : "";
  const success = entry.kind === "tool" ? (entry.result?.success ?? null) : null;
  report.calls.push({ name, success, text: text.slice(0, 600) });
  return { success: success === true, text, value: jsonRecord(text) };
}

function channelNamed(name: string): Channel | undefined {
  const store = channels().store;
  return store
    .ids()
    .map((id) => store.get(id))
    .find((channel) => channel.name === name);
}

function notes(channelId: string): string[] {
  return channels()
    .store.messages(channelId)
    .filter((entry) => isChannelChangeMarker(entry.message))
    .map((entry) => entry.message.text);
}

/** The tool result as a record; a text that is no JSON object is an empty one. */
function jsonRecord(text: string): DynamicRecord {
  try {
    const value = JSON.parse(text);
    return isDynamicRecord(value) ? value : {};
  } catch {
    return {};
  }
}

function listedIds(value: DynamicRecord): string[] {
  const list = value.channels;
  return Array.isArray(list)
    ? list.flatMap((item) => (isDynamicRecord(item) && typeof item.id === "string" ? [item.id] : []))
    : [];
}

const OTHER_SPACE = "is in another space";

try {
  await runCauseEffect(agents.initialize());
  const create = async (name: string, spaceId?: string) => {
    const agent = await runCauseEffect(
      agents.createAgent({
        name,
        description: `${name} works on the niches.`,
        avatarSeed: name.toLowerCase(),
        avatarHue: null,
        initialMessage: "Hello.",
        ...(spaceId ? { spaceId } : {}),
      }),
    );
    await idle(agent.id);
    return agent;
  };
  const made = await runCauseEffect(agents.spaces.apply({ kind: "create", name: "Niches" }));
  const nichesId = made.createdSpaceId ?? "";
  const cso = await create("CSO", nichesId);
  const writer = await create("Writer", nichesId);
  const analyst = await create("Analyst", nichesId);
  const outsider = await create("Outsider");

  // The instructions tell the agent that it can manage channels when the user asks.
  const csoThread = logEntries().find(
    (entry) => entry.kind === "thread" && entry.developerInstructions.includes("CSO"),
  );
  pass(
    "The developer instructions name the channel tools for the agent's own chat",
    csoThread?.kind === "thread" &&
      csoThread.developerInstructions.includes("openbot.create_channel") &&
      !csoThread.developerInstructions.includes("outside them do not call channel_ tools"),
  );

  // 1. Discovery.
  const found = await callTool("tool_search create channel", cso.id, "tool_search", { query: "create channel" });
  pass(
    "tool_search finds create_channel with its schema and guidance",
    found.success &&
      found.text.includes('"name":"openbot.create_channel"') &&
      found.text.includes("inputSchema") &&
      found.text.includes("only when the user asks"),
    found.text.slice(0, 300),
  );

  // 2. An empty list, then a new channel with members, answer modes, focus and visibility.
  const empty = await callTool("list_channels before", cso.id, "list_channels", {});
  pass(
    "list_channels succeeds and lists no channel yet",
    empty.success && listedIds(empty.value).length === 0,
    empty.text,
  );
  const eventsBefore = events.length;
  const created = await callTool("create_channel", cso.id, "create_channel", {
    name: "Fitness Niche",
    topic: "Fitness content",
    description: "Everything about the fitness niche.",
    instructions: "Post one idea per message.",
    visibility: "private",
    members: [
      { agentId: writer.id, answerMode: "always" },
      { agentId: analyst.id, focus: "Market data" },
    ],
  });
  const fitness = channelNamed("fitness-niche");
  pass("create_channel succeeds", created.success && fitness !== undefined, created.text);
  assert.ok(fitness);
  pass(
    "The channel has the settings of the call",
    fitness.kind === "channel" &&
      fitness.visibility === "private" &&
      fitness.topic === "Fitness content" &&
      fitness.description === "Everything about the fitness niche." &&
      fitness.instructions === "Post one idea per message.",
  );
  pass(
    "The user is a person of the channel and the agent is its creator",
    fitness.humanMemberIds?.includes(PERSON.id) === true &&
      fitness.createdBy?.kind === "agent" &&
      fitness.createdBy.id === cso.id,
  );
  const memberOf = (channel: Channel, agentId: string) => channel.members.find((item) => item.agentId === agentId);
  pass(
    "The members have their answer modes and focus, the maker included",
    memberOf(fitness, cso.id)?.answerMode === "mention" &&
      memberOf(fitness, writer.id)?.answerMode === "always" &&
      memberOf(fitness, analyst.id)?.answerMode === "mention" &&
      memberOf(fitness, analyst.id)?.focus === "Market data",
  );
  pass(
    "The channel is in the space of the agent",
    store.spaces.channelSpaceId(fitness) === nichesId &&
      agents.spaces.snapshot().channels.some((item) => item.id === fitness.id && item.spaceId === nichesId),
  );
  const newEvents = events.slice(eventsBefore);
  pass(
    "The clients get the space and channel events of the new channel",
    newEvents.some((event) => event.type === "workspace-spaces-changed") &&
      newEvents.some((event) => event.type === "channels-changed" && event.channelId === fitness.id),
  );
  pass("A note names the agent that made the channel", notes(fitness.id).includes("CSO created this channel."));
  pass(
    "The host user's channel list has the new channel",
    channels()
      .store.list(PERSON.id)
      .some((summary) => summary.id === fitness.id),
  );

  // 3. Refusals of create: the same name again, and an agent of another space.
  const twice = await callTool("create_channel again", cso.id, "create_channel", { name: "fitness-niche" });
  pass(
    "The same name in the space is not created again",
    !twice.success && twice.text.includes(fitness.id),
    twice.text,
  );
  const channelCount = channels().store.ids().length;
  const foreign = await callTool("create_channel with another space's agent", cso.id, "create_channel", {
    name: "cooking",
    members: [{ agentId: outsider.id }],
  });
  pass(
    "A member of another space refuses the channel",
    !foreign.success && foreign.text.includes(OTHER_SPACE) && channels().store.ids().length === channelCount,
    foreign.text,
  );

  // 4. Members: answer modes, focus, removal, and an agent of another space.
  const modes = await callTool("update_channel_members update", cso.id, "update_channel_members", {
    channelId: fitness.id,
    update: [
      { agentId: writer.id, answerMode: "always-no-gate" },
      { agentId: analyst.id, focus: null },
    ],
  });
  const afterModes = channels().store.get(fitness.id);
  pass(
    "update_channel_members changes answer modes and focus",
    modes.success &&
      memberOf(afterModes, writer.id)?.answerMode === "always-no-gate" &&
      memberOf(afterModes, analyst.id)?.focus === undefined,
    modes.text,
  );
  const removed = await callTool("update_channel_members remove", cso.id, "update_channel_members", {
    channelId: fitness.id,
    remove: [analyst.id],
  });
  pass(
    "update_channel_members removes a member",
    removed.success && memberOf(channels().store.get(fitness.id), analyst.id) === undefined,
    removed.text,
  );
  const addForeign = await callTool(
    "update_channel_members add another space's agent",
    cso.id,
    "update_channel_members",
    {
      channelId: fitness.id,
      add: [{ agentId: outsider.id }],
    },
  );
  pass(
    "An agent of another space is not added",
    !addForeign.success &&
      addForeign.text.includes(OTHER_SPACE) &&
      memberOf(channels().store.get(fitness.id), outsider.id) === undefined,
    addForeign.text,
  );
  const added = await callTool("update_channel_members add", cso.id, "update_channel_members", {
    channelId: fitness.id,
    add: [{ agentId: analyst.id, answerMode: "mention", focus: "Prices" }],
  });
  pass(
    "update_channel_members adds a member with its settings",
    added.success && memberOf(channels().store.get(fitness.id), analyst.id)?.focus === "Prices",
    added.text,
  );

  // 5. Settings: rename, topic, visibility, routing and lead.
  const renamed = await callTool("update_channel", cso.id, "update_channel", {
    channelId: fitness.id,
    name: "Fitness & Health",
    topic: "Fitness and health content",
    visibility: "public",
    routing: "coordinator",
    leadAgentId: writer.id,
  });
  const afterRename = channels().store.get(fitness.id);
  pass(
    "update_channel renames the channel and changes its topic, visibility, routing and lead",
    renamed.success &&
      afterRename.name === "fitness-health" &&
      afterRename.topic === "Fitness and health content" &&
      afterRename.visibility === "public" &&
      afterRename.routing === "coordinator" &&
      afterRename.leadAgentId === writer.id,
    renamed.text,
  );
  const read = await callTool("read_channel", cso.id, "read_channel", { channelId: fitness.id });
  const readMembers = Array.isArray(read.value.members) ? read.value.members : [];
  pass(
    "read_channel gives the settings, the members with answer modes, and the messages",
    read.success &&
      read.value.name === "fitness-health" &&
      read.value.routing === "coordinator" &&
      readMembers.some(
        (item) => isDynamicRecord(item) && item.agentId === writer.id && item.answerMode === "always-no-gate",
      ) &&
      Array.isArray(read.value.messages),
    read.text.slice(0, 300),
  );

  // 6. A brief that gives a member a task.
  const posted = await callTool("post_channel_message", cso.id, "post_channel_message", {
    channelId: fitness.id,
    text: "Write three post ideas for this week.",
    assignAgentIds: [writer.id],
  });
  const brief = channels()
    .store.messages(fitness.id)
    .find((message) => message.message.text.includes("Write three post ideas"));
  pass(
    "post_channel_message posts as the agent and mentions the member it assigns",
    posted.success &&
      brief?.author.kind === "agent" &&
      brief.author.id === cso.id &&
      brief.mentions?.some((mention) => mention.kind === "agent" && mention.id === writer.id) === true,
    posted.text,
  );
  assert.ok(brief);
  const task = channels()
    .store.tasks(fitness.id)
    .find((item) => item.requestMessageId === brief.id);
  pass("The assigned member gets a task for the brief", task?.ownerAgentId === writer.id);
  await waitFor("the writer's task to end", () =>
    channels()
      .store.tasks(fitness.id)
      .find((item) => item.requestMessageId === brief.id && item.state === "completed"),
  );
  pass("The member's task completes", true);

  // 7. Another space sees nothing, and a non-member of the space cannot change the channel.
  const outsiderList = await callTool("list_channels from another space", outsider.id, "list_channels", {});
  pass(
    "An agent of another space does not list the channel",
    outsiderList.success && !listedIds(outsiderList.value).includes(fitness.id),
    outsiderList.text,
  );
  const outsiderRead = await callTool("read_channel from another space", outsider.id, "read_channel", {
    channelId: fitness.id,
  });
  pass(
    "An agent of another space cannot read the channel",
    !outsiderRead.success && outsiderRead.text.includes("another space"),
    outsiderRead.text,
  );
  const outsiderChange = await callTool("update_channel from another space", outsider.id, "update_channel", {
    channelId: fitness.id,
    name: "taken",
  });
  pass(
    "An agent of another space cannot change the channel",
    !outsiderChange.success && channels().store.get(fitness.id).name === "fitness-health",
    outsiderChange.text,
  );
  const second = await callTool("create_channel without the analyst", cso.id, "create_channel", {
    name: "Cooking Niche",
    members: [{ agentId: writer.id }],
  });
  const cooking = channelNamed("cooking-niche");
  pass("A second public channel is created", second.success && cooking?.visibility === "public", second.text);
  assert.ok(cooking);
  const analystList = await callTool("list_channels by a non-member", analyst.id, "list_channels", {});
  pass(
    "An agent of the space lists a public channel it is not a member of",
    analystList.success && listedIds(analystList.value).includes(cooking.id),
    analystList.text,
  );
  const analystChange = await callTool("update_channel by a non-member", analyst.id, "update_channel", {
    channelId: cooking.id,
    topic: "Recipes",
  });
  pass(
    "An agent that is not a member and did not make the channel cannot change it",
    !analystChange.success &&
      analystChange.text.includes("member of or made") &&
      !channels().store.get(cooking.id).topic,
    analystChange.text,
  );

  // 8. Archive and restore.
  const archived = await callTool("archive", cso.id, "update_channel", { channelId: cooking.id, archived: true });
  pass(
    "update_channel archives the channel",
    archived.success && channels().store.get(cooking.id).archived,
    archived.text,
  );
  const listedArchived = await callTool("list_channels after archive", cso.id, "list_channels", {});
  pass("An archived channel leaves the default list", !listedIds(listedArchived.value).includes(cooking.id));
  const restored = await callTool("restore", cso.id, "update_channel", { channelId: cooking.id, archived: false });
  pass(
    "update_channel restores the channel",
    restored.success && !channels().store.get(cooking.id).archived,
    restored.text,
  );

  // 9. A group conversation with the user.
  const group = await callTool("create_channel group", cso.id, "create_channel", {
    kind: "group",
    members: [{ agentId: writer.id }, { agentId: analyst.id, answerMode: "always" }],
  });
  const groupValue = isDynamicRecord(group.value.channel) ? group.value.channel : {};
  const groupChannel = typeof groupValue.id === "string" ? channels().store.get(groupValue.id) : undefined;
  pass(
    "create_channel makes a group of the user, the agent and its members",
    group.success &&
      groupChannel?.kind === "group" &&
      groupChannel.humanMemberIds?.includes(PERSON.id) === true &&
      groupChannel.members.length === 3 &&
      memberOf(groupChannel, analyst.id)?.answerMode === "always" &&
      store.spaces.channelSpaceId(groupChannel) === nichesId,
    group.text,
  );

  // 10. Delete needs userAsked.
  const unasked = await callTool("delete_channel without userAsked", cso.id, "delete_channel", {
    channelId: cooking.id,
  });
  pass(
    "delete_channel without userAsked is refused",
    !unasked.success && channels().store.exists(cooking.id),
    unasked.text,
  );
  const deleted = await callTool("delete_channel", cso.id, "delete_channel", {
    channelId: cooking.id,
    userAsked: true,
  });
  pass("delete_channel deletes the channel", deleted.success && !channels().store.exists(cooking.id), deleted.text);

  // 11. The in-task tools still point an agent outside a channel task to the new tools.
  const inTask = await callTool("channel_add_member outside a task", cso.id, "channel_add_member", {
    agentId: writer.id,
  });
  pass(
    "A channel_ tool outside a channel task names the tools for the agent's own chat",
    !inTask.success && inTask.text.includes("update_channel_members"),
    inTask.text,
  );

  report.notes = notes(fitness.id);
  pass(
    "Each change of the agent left a note in the channel",
    report.notes.includes("CSO changed how Writer, Analyst answer in the channel.") &&
      report.notes.includes("CSO removed Analyst from the channel.") &&
      report.notes.includes("CSO added Analyst to the channel.") &&
      report.notes.includes("CSO changed the channel settings."),
    JSON.stringify(report.notes),
  );
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
