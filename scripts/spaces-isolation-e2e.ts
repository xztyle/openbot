// Checks that an agent sees and reaches only the agents and channels of its own space, and that each
// space has its own shared folder. Runs the real agent service, channel service, mailbox and tool
// router on a temporary profile with a fake Codex app-server. The fake calls a tool through
// `tool_call`, as a model does, and logs the result and the instructions of each session.
// Each check names the enforcement point it covers: list_agents, send_message, read_agent,
// interrupt_agent, update_agents, create_routine, create_agent, the mailbox, channel members,
// channel tools, the developer instructions and sandbox roots, and the space changes themselves.
// `bun scripts/spaces-isolation-e2e.ts`. Writes .openbot-build/spaces-isolation-e2e/report.json.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { AGENT_PROVIDERS, GENERAL_SPACE_ID, isSidebarLayoutSnapshot } from "@openbot/contracts/ipc";
import { isDynamicRecord, isString } from "@openbot/contracts/runtime-values";
import { Effect } from "effect";
import type { AgentBrowserHost } from "../src/backend/agent/turn-lifecycle";

const OUT = resolve(import.meta.dirname, "../.openbot-build/spaces-isolation-e2e");
const root = await mkdtemp(join(tmpdir(), "openbot-spaces-"));
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
const { SidebarLayoutStore } = await import("../src/backend/sidebar-layout-store");
const { applyControlSpaces, listControlSpaces } = await import("../src/main/server-mode-spaces");

const CALL_MARK = "SPACE-CALL";
let requests = 0;
const PERSON = { id: "local", name: "Alex" };

/**
 * A Codex app-server with the methods that the service calls. A turn whose input has
 * `SPACE-CALL#<n> <<ARGS{"__tool":"…",…}ARGS>>` calls `openbot.<__tool>` with the rest of that JSON
 * through `tool_call`, logs the result, and ends. Other turns answer "Done.".
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
      const calls = [...text.matchAll(/SPACE-CALL#(\\d+) <<ARGS([\\s\\S]*?)ARGS>>/g)];
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
          tool: "tool_call",
          arguments: { name: "openbot." + __tool, arguments: args },
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
  passed: boolean;
  error?: string;
} = { calls: [], checks: [], passed: false };

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
const sidebar = new SidebarLayoutStore(join(userData, "sidebar-layout.json"));
await runCauseEffect(sidebar.initialize());
const agents = new AgentService({
  sidebarLayout: sidebar,
  store,
  mailbox,
  browser,
  preferredProvider: "codex",
  offProviders: AGENT_PROVIDERS.filter((provider) => provider !== "codex"),
  timezone: () => "UTC",
});
const channels = () => agents.channels;

function idle(agentId: string) {
  return waitFor("the agent's turns to end", () =>
    agents
      .listQueue(agentId)
      .deliveries.every((delivery) => !["queued", "starting", "running"].includes(delivery.status)),
  );
}

/** A person's message to the agent that makes the fake call `tool`; returns the tool result. */
async function callTool(name: string, agentId: string, tool: string, args: ToolArgs) {
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
  report.calls.push({ name, success, text });
  return { success: success === true, text };
}

/** A person's channel message to a member that makes the fake call a channel tool. */
async function callChannelTool(name: string, channelId: string, agentId: string, tool: string, args: ToolArgs) {
  const before = toolLogs().length;
  await runCauseEffect(
    channels().command(
      {
        type: "send",
        operationId: randomUUID(),
        channelId,
        text: `${CALL_MARK}#${++requests} <<ARGS${JSON.stringify({ __tool: tool, ...args })}ARGS>>`,
        recipientAgentId: agentId,
        replyToMessageId: null,
        attachmentDraftIds: [],
      },
      PERSON,
    ),
  );
  const entry = await waitFor(`${name} tool result`, () => toolLogs()[before]);
  await waitFor("the channel tasks to end", () =>
    channels()
      .store.tasks(channelId)
      .every((task) => !["queued", "running", "waiting"].includes(task.state)),
  );
  const text =
    entry.kind === "tool"
      ? (entry.result?.contentItems.map((item) => item.text).join("\n") ?? JSON.stringify(entry.error))
      : "";
  const success = entry.kind === "tool" ? (entry.result?.success ?? null) : null;
  report.calls.push({ name, success, text });
  return { success: success === true, text };
}

/** The arguments the fake passes to a tool. */
interface ToolArgs {
  agentId?: string;
  agentIds?: string[];
  recipientAgentIds?: string[];
  recipientAgentId?: string;
  sectionId?: string;
  name?: string;
  description?: string;
  initialMessage?: string;
  text?: string;
  expectsReply?: boolean;
  reason?: string;
  notifications?: boolean;
  instruction?: string;
  expectedResult?: string;
  schedule?: { kind: "daily"; time: string };
}

/** The agent ids of a list_agents result. */
function listedAgentIds(text: string): string[] {
  const value = JSON.parse(text);
  if (!isDynamicRecord(value) || !Array.isArray(value.agents)) return [];
  return value.agents.flatMap((agent) => (isDynamicRecord(agent) && isString(agent.id) ? [agent.id] : []));
}

const OTHER_SPACE = "is in another space";
const OTHER_CHANNEL_MEMBER = "is in another space than this channel";

try {
  await runCauseEffect(agents.initialize());
  const create = async (name: string, spaceId?: string) => {
    const agent = await runCauseEffect(
      agents.createAgent({
        name,
        description: `${name} works on its project.`,
        avatarSeed: name.toLowerCase(),
        avatarHue: null,
        initialMessage: "Hello.",
        ...(spaceId ? { spaceId } : {}),
      }),
    );
    await idle(agent.id);
    return agent;
  };

  // The space itself: made by a person, with its own shared folder.
  const made = await runCauseEffect(agents.spaces.apply({ kind: "create", name: "Trading", icon: "📈", hue: 215 }));
  const tradingId = made.createdSpaceId ?? "";
  const trading = made.spaces.find((space) => space.id === tradingId);
  pass("A new space has a slug and a position after General", trading?.slug === "trading" && trading.position === 1);
  const tradingShared = join(home, "OpenBot", "Spaces", "trading", "Shared");
  pass("A new space gets its shared folder", existsSync(tradingShared));
  pass("General has its own shared folder", existsSync(join(home, "OpenBot", "Spaces", "general", "Shared")));

  const alpha = await create("Alpha", tradingId);
  const beta = await create("Beta", tradingId);
  const gamma = await create("Gamma");
  pass("createAgent with a space puts the agent there", store.spaces.agentSpaceId(alpha.id) === tradingId);
  pass(
    "createAgent without a space puts the agent in General",
    store.spaces.agentSpaceId(gamma.id) === GENERAL_SPACE_ID,
  );

  // Developer instructions and sandbox roots name the space's shared folder, never the old global one.
  const alphaThread = logEntries().find(
    (entry) => entry.kind === "thread" && entry.developerInstructions.includes("Alpha"),
  );
  pass(
    "The instructions name the shared folder of the agent's space",
    alphaThread?.kind === "thread" &&
      alphaThread.developerInstructions.includes(tradingShared) &&
      alphaThread.developerInstructions.includes('"Trading"') &&
      !alphaThread.developerInstructions.includes(store.sharedRoot),
  );
  pass(
    "The writable roots hold the space's shared folder, not the global one",
    alphaThread?.kind === "thread" &&
      alphaThread.roots.includes(tradingShared) &&
      !alphaThread.roots.includes(store.sharedRoot),
  );

  // list_agents
  const listed = await callTool("list_agents in Trading", alpha.id, "list_agents", {});
  const listedIds = listedAgentIds(listed.text);
  pass(
    "list_agents lists the agents of the caller's space only",
    listedIds.includes(beta.id) && listedIds.includes(alpha.id) && !listedIds.includes(gamma.id),
  );
  const listedGeneral = await callTool("list_agents in General", gamma.id, "list_agents", {});
  const generalIds = listedAgentIds(listedGeneral.text);
  pass("An agent of General sees General only", generalIds.includes(gamma.id) && !generalIds.includes(alpha.id));

  // A sidebar section is the user's, across spaces; an agent sees in it only its own space.
  await runCauseEffect(sidebar.mutate({ type: "create", name: "Desk" }, agents.sidebarChatIds()));
  const deskId = sidebar.getSnapshot().sections.find((section) => section.name === "Desk")?.id ?? "";
  for (const agent of [alpha, beta, gamma])
    await runCauseEffect(
      sidebar.mutate({ type: "assign", agentId: agent.id, sectionId: deskId }, agents.sidebarChatIds()),
    );
  const teammates = agents.sectionTeammates(alpha.id)?.members.map((member) => member.id) ?? [];
  pass(
    "Section teammates are the agents of the same section and space",
    teammates.includes(beta.id) && !teammates.includes(gamma.id),
  );
  const sections = await callTool("list_sections", alpha.id, "list_sections", {});
  const layout = JSON.parse(sections.text);
  pass(
    "list_sections shows only the agents of the caller's space",
    isSidebarLayoutSnapshot(layout) &&
      layout.agentAssignments[beta.id] === deskId &&
      layout.agentAssignments[gamma.id] === undefined &&
      !layout.agentOrder.includes(gamma.id),
  );
  const rename = await callTool("rename_section of a mixed section", alpha.id, "rename_section", {
    sectionId: deskId,
    name: "Mine",
  });
  pass(
    "An agent cannot rename a section that holds agents of another space",
    !rename.success && sidebar.getSnapshot().sections.some((section) => section.name === "Desk"),
    rename.text,
  );

  // send_message
  const crossSend = await callTool("send_message to another space", alpha.id, "send_message", {
    recipientAgentIds: [gamma.id],
    text: "Can you check the prices?",
    expectsReply: false,
  });
  pass(
    "send_message to another space is refused",
    !crossSend.success && crossSend.text.includes(OTHER_SPACE),
    crossSend.text,
  );
  const sameSend = await callTool("send_message in the space", alpha.id, "send_message", {
    recipientAgentIds: [beta.id],
    text: "Here are the prices.",
    expectsReply: false,
  });
  pass("send_message in the space goes out", sameSend.success, sameSend.text);
  await idle(beta.id);

  // read_agent, interrupt_agent, update_agents, create_routine
  const refusedCalls: [string, string, ToolArgs][] = [
    ["read_agent", "read_agent", { agentId: gamma.id }],
    ["interrupt_agent", "interrupt_agent", { agentId: gamma.id, reason: "Stop." }],
    ["update_agents", "update_agents", { agentIds: [gamma.id], notifications: false }],
    [
      "create_routine",
      "create_routine",
      { agentId: gamma.id, name: "Prices", instruction: "Check.", schedule: { kind: "daily", time: "09:00" } },
    ],
  ];
  for (const [name, tool, args] of refusedCalls) {
    const result = await callTool(`${name} on another space`, alpha.id, tool, args);
    pass(
      `${name} on an agent of another space is refused`,
      !result.success && result.text.includes(OTHER_SPACE),
      result.text,
    );
  }

  // The mailbox is the last check of every route between agents.
  const direct = await Effect.runPromiseExit(
    mailbox.enqueue({ sender: { kind: "agent", agentId: alpha.id }, recipientAgentIds: [gamma.id], text: "Hi." }),
  );
  pass("The mailbox refuses an agent message to another space", direct._tag === "Failure");

  // create_agent from an agent: the new agent starts in its creator's space.
  const created = await callTool("create_agent", alpha.id, "create_agent", {
    name: "Scout",
    description: "Finds prices.",
    initialMessage: "Say hello.",
  });
  const scout = agents.listAgents().find((agent) => agent.name === "Scout");
  pass(
    "An agent that create_agent makes starts in its creator's space",
    scout !== undefined && store.spaces.agentSpaceId(scout.id) === tradingId,
    created.text,
  );
  if (scout) await idle(scout.id);

  // Channels: members of the channel's space only.
  const generalChannel = randomUUID();
  const refused = await Effect.runPromiseExit(
    channels().command(
      {
        type: "save",
        operationId: randomUUID(),
        channelId: generalChannel,
        draft: { name: "mixed", title: "", instructions: "", members: [{ agentId: alpha.id }], leadAgentId: null },
      },
      PERSON,
    ),
  );
  pass("A General channel refuses a member of another space", refused._tag === "Failure");
  const tradingChannel = randomUUID();
  // A client puts a new channel in its space before it creates it.
  await runCauseEffect(agents.spaces.apply({ kind: "place-channel", spaceId: tradingId, channelId: tradingChannel }));
  await runCauseEffect(
    channels().command(
      {
        type: "save",
        operationId: randomUUID(),
        channelId: tradingChannel,
        draft: {
          name: "desk",
          title: "",
          instructions: "",
          members: [{ agentId: alpha.id }, { agentId: beta.id }],
          leadAgentId: alpha.id,
        },
      },
      PERSON,
    ),
  );
  pass("A channel of the space takes agents of the space", channels().store.get(tradingChannel).members.length === 2);
  const addGamma = await callChannelTool(
    "channel_add_member of another space",
    tradingChannel,
    alpha.id,
    "channel_add_member",
    {
      agentId: gamma.id,
    },
  );
  pass(
    "channel_add_member of an agent of another space is refused",
    !addGamma.success && addGamma.text.includes(OTHER_SPACE),
    addGamma.text,
  );
  pass(
    "The channel keeps its members",
    channels()
      .store.get(tradingChannel)
      .members.every((member) => member.agentId !== gamma.id),
  );

  // A member moved to another space takes no channel work and cannot use the channel's tools.
  await runCauseEffect(agents.spaces.apply({ kind: "move", spaceId: GENERAL_SPACE_ID, agentIds: [beta.id] }));
  const assign = await callChannelTool("channel_assign to a moved member", tradingChannel, alpha.id, "channel_assign", {
    recipientAgentId: beta.id,
    instruction: "Check the prices.",
    expectedResult: "The prices.",
  });
  pass(
    "channel_assign to a member that moved to another space is refused",
    !assign.success && (assign.text.includes(OTHER_SPACE) || assign.text.includes(OTHER_CHANNEL_MEMBER)),
    assign.text,
  );

  // Space changes: a space with agents is not deleted, General never is, and moveTo empties it first.
  const notEmpty = await Effect.runPromiseExit(agents.spaces.apply({ kind: "delete", spaceId: tradingId }));
  pass("A space with agents is not deleted", notEmpty._tag === "Failure");
  const general = await Effect.runPromiseExit(agents.spaces.apply({ kind: "delete", spaceId: GENERAL_SPACE_ID }));
  pass("General is not deleted", general._tag === "Failure");
  const index = JSON.parse(readFileSync(join(home, "OpenBot", "Spaces", "index.json"), "utf8"));
  pass("The space index names the shared folder of each agent", index.agents[alpha.id] === tradingShared);
  const bulk = await runCauseEffect(
    agents.spaces.applyBulk([{ name: "trading", agentIds: [beta.id, "missing-agent"] }, { name: "Research" }]),
  );
  pass(
    "A bulk apply finds a space by name, skips an unknown id and makes a missing space",
    bulk.spaces[0]?.id === tradingId &&
      bulk.spaces[0]?.created === false &&
      bulk.movedAgents === 1 &&
      bulk.skipped.some((entry) => entry.id === "missing-agent") &&
      bulk.spaces[1]?.created === true,
  );
  const again = await runCauseEffect(agents.spaces.applyBulk([{ name: "Trading", agentIds: [beta.id] }]));
  pass("A second bulk apply changes nothing", again.movedAgents === 0 && again.spaces[0]?.created === false);
  // The control socket routes, as the operator's migration script calls them.
  const control = {
    spaces: agents.spaces,
    agents: () => agents.listAgents(),
    channels: () =>
      channels()
        .store.ids()
        .map((id) => channels().store.get(id)),
    legacySharedRoot: store.sharedRoot,
  };
  const applied = await Effect.runPromise(
    applyControlSpaces(control, JSON.stringify({ spaces: [{ name: "Ops", icon: "🛠️", agentIds: [gamma.id] }] })),
  );
  const appliedBody = JSON.parse(applied.body);
  pass(
    "POST /v1/spaces/apply makes the space, moves the agent and answers its shared folder",
    applied.status === 200 &&
      appliedBody.report.movedAgents === 1 &&
      appliedBody.report.spaces[0].sharedDirectory === join(home, "OpenBot", "Spaces", "ops", "Shared") &&
      store.spaces.agentSpaceId(gamma.id) === appliedBody.report.spaces[0].id,
  );
  const listedControl = JSON.parse(listControlSpaces(control).body);
  pass(
    "GET /v1/spaces lists each space with its shared folder, agents and the managed folders",
    listedControl.legacySharedRoot === store.sharedRoot &&
      listedControl.managedFolders.some((entry: { folder: string }) => entry.folder === "Watchers") &&
      listedControl.spaces.some(
        (space: { name: string; agents: { name: string }[] }) =>
          space.name === "Ops" && space.agents.some((agent) => agent.name === "Gamma"),
      ),
  );
  const invalid = await Effect.runPromise(applyControlSpaces(control, JSON.stringify({ spaces: [{ name: "" }] })));
  pass("POST /v1/spaces/apply refuses a space without a name", invalid.status === 400);
  const moved = await runCauseEffect(
    agents.spaces.apply({ kind: "delete", spaceId: tradingId, moveTo: GENERAL_SPACE_ID }),
  );
  pass(
    "Deleting a space with moveTo puts its agents and channels in that space",
    !moved.spaces.some((space) => space.id === tradingId) &&
      store.spaces.agentSpaceId(alpha.id) === GENERAL_SPACE_ID &&
      store.spaces.channelSpaceId(channels().store.get(tradingChannel)) === GENERAL_SPACE_ID,
  );
  report.passed = true;
} catch (error) {
  report.error = error instanceof Error ? (error.stack ?? error.message) : String(error);
  report.calls.push(
    ...toolLogs().map((entry) => ({ name: "log", success: null, text: JSON.stringify(entry).slice(0, 200) })),
  );
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
