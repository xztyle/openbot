// Simulates the Motion board's ticket events against the host's Motion route, on the real agent
// service of a temporary profile with a fake Codex app-server that records what each turn got. The
// route, the service and the deliveries are wired as `motion-events-host.ts` wires them.
//
// - A signed `issue.assigned` wakes the assigned agent once, with the ticket key, title and link; the
//   same event again (Motion's retry) delivers nothing, and a bad signature or an old timestamp is
//   refused before anything else.
// - A status change by the owner reaches the agent as a held note: no turn starts for it.
// - An overdue ticket wakes the agent and its manager from the org chart, once each.
// - A ticket that an agent hands to the owner shows in Needs you (a ticket item that opens the ticket)
//   with a push; when the owner gives it back, it goes.
// - A comment that mentions an agent wakes it; an agent's own change tells nobody.
//
// `bun scripts/motion-events-e2e.ts`. Writes .openbot-build/motion-events-e2e/report.json.
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { AGENT_PROVIDERS, DEFAULT_WORKSPACE_MOTION_EVENTS, isTicketAttention } from "@openbot/contracts/ipc";
import { isDynamicRecord } from "@openbot/contracts/runtime-values";
import { Effect } from "effect";
import type { AgentBrowserHost } from "../src/backend/agent/turn-lifecycle";

const OUT = resolve(import.meta.dirname, "../.openbot-build/motion-events-e2e");
const root = await mkdtemp(join(tmpdir(), "openbot-motion-events-"));
const userData = join(root, "user-data");
const home = join(root, "home");
const fakeCodex = join(root, "codex");
const inputLog = join(root, "inputs.jsonl");
const SECRET = "motion-e2e-secret";

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
const { signMotionEvent } = await import("../src/main/motion-events/motion-event");
const { MotionEventsService } = await import("../src/main/motion-events/motion-events-service");
const { startMotionEventsServer, MOTION_EVENTS_PATH } = await import("../src/main/motion-events/motion-events-server");
const { MotionTickets } = await import("../src/main/motion-events/motion-tickets");

/**
 * A Codex app-server with the methods that the service calls. Each turn records its input with the
 * agent's thread and answers "Done.".
 */
const FAKE_CODEX = `#!/usr/bin/env node
const { appendFileSync } = require("node:fs");
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
    case "account/rateLimits/read": return write({ id: message.id, result: { rateLimits: null, rateLimitsByLimitId: null } });
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
      const turnId = "turn-" + process.pid + "-" + (++turns);
      appendFileSync(${JSON.stringify(inputLog)}, JSON.stringify({ threadId: params.threadId, input: params.input }) + "\\n");
      write({ id: message.id, result: { turn: { id: turnId, status: "inProgress", items: [] } } });
      write({ method: "turn/started", params: { threadId: params.threadId, turn: { id: turnId } } });
      setTimeout(() => {
        const threadId = params.threadId;
        const item = { type: "agentMessage", id: "answer-" + turnId, text: "Done.", phase: "final_answer" };
        write({ method: "item/completed", params: { threadId, turnId, item } });
        write({ method: "turn/completed", params: { threadId, turn: { id: turnId, status: "completed" } } });
      }, 30);
      return;
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

interface CaseReport {
  name: string;
  details: unknown;
  passed: boolean;
}

const report: { cases: CaseReport[]; passed: boolean; error?: string } = { cases: [], passed: false };

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

/**
 * The turn inputs that the fake Codex recorded, as text, for the agent named `name`: its provider
 * thread is the one whose first turn got "Start <name>.".
 */
function turnInputs(name: string): string[] {
  let entries: { threadId: string; input: string }[] = [];
  try {
    entries = readFileSync(inputLog, "utf8")
      .split("\n")
      .filter(Boolean)
      .flatMap((line) => {
        const entry = JSON.parse(line);
        return isDynamicRecord(entry) && typeof entry.threadId === "string"
          ? [{ threadId: entry.threadId, input: JSON.stringify(entry.input) }]
          : [];
      });
  } catch {
    return [];
  }
  const thread = entries.find((entry) => entry.input.includes(`Start ${name}.`))?.threadId;
  return thread ? entries.filter((entry) => entry.threadId === thread).map((entry) => entry.input) : [];
}

const OWNER: MotionMember = { id: "u-owner", name: "Alex", kind: "person", agent_key: null, role: "owner" };
const URL_OF = (issue: string) => `https://motion.example.com/w/ws/p/${issue}`;
let sequence = 0;

interface MotionMember {
  id: string;
  name: string;
  kind: string;
  agent_key: string | null;
  role: string;
}

/** The fields of one event type, beside the ones every event has. */
interface EventFields {
  id?: string;
  actor?: MotionMember | null;
  recipients?: MotionMember[];
  issue?: object;
  created?: boolean;
  from?: string;
  days_overdue?: number;
  reason?: string;
  comment?: { id: string; thread_id: string; body: string; truncated: boolean };
}

interface Outcome {
  outcome?: string;
  deliveries?: { agentId: string; mode: string }[];
  waiting?: boolean;
  error?: string;
}

/** The answer of the route, read field by field. */
function readOutcome(value: unknown): Outcome {
  if (!isDynamicRecord(value)) return {};
  const deliveries = Array.isArray(value.deliveries)
    ? value.deliveries.flatMap((entry: unknown) =>
        isDynamicRecord(entry) && typeof entry.agentId === "string" && typeof entry.mode === "string"
          ? [{ agentId: entry.agentId, mode: entry.mode }]
          : [],
      )
    : undefined;
  return {
    ...(typeof value.outcome === "string" ? { outcome: value.outcome } : {}),
    ...(deliveries ? { deliveries } : {}),
    ...(typeof value.waiting === "boolean" ? { waiting: value.waiting } : {}),
    ...(typeof value.error === "string" ? { error: value.error } : {}),
  };
}

/** A Motion event body, as Motion's `agent_events.rs` writes it. */
function motionEvent(type: string, issue: { id: string; key: string; title: string }, fields: EventFields) {
  sequence += 1;
  return {
    id: `evt_e2e_${sequence}`,
    type,
    at: Date.now(),
    workspace: { id: "ws", name: "Universidad Online" },
    issue: {
      ...issue,
      url: URL_OF(issue.id),
      project: "UO",
      status: { name: "To Do", category: "todo" },
      due: "2026-11-22",
      assignees: [],
      reporter: [OWNER],
    },
    actor: OWNER,
    recipients: [],
    ...fields,
  };
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
});
const pushes: { agentId: string; title: string; body: string }[] = [];
let server: Awaited<ReturnType<typeof startMotionEventsServer>> | null = null;

try {
  await runCauseEffect(agents.initialize());
  const create = (name: string) =>
    runCauseEffect(
      agents.createAgent({
        name,
        description: "Motion check.",
        avatarSeed: name.toLowerCase(),
        avatarHue: null,
        initialMessage: `Start ${name}.`,
      }),
    );
  const lead = await create("Lead");
  const dev = await create("Dev");
  const other = await create("Other");
  await runCauseEffect(agents.updateAgent({ agentId: dev.id, reportsToAgentId: lead.id }));
  const idle = (agentId: string) =>
    agents.listQueue(agentId).deliveries.every((delivery) => delivery.status === "completed");
  for (const agent of [lead, dev, other])
    await waitFor(`the first turn of ${agent.name}`, () => turnInputs(agent.name).length === 1 && idle(agent.id));

  const service = new MotionEventsService({
    settings: () => DEFAULT_WORKSPACE_MOTION_EVENTS,
    agents: () => agents.listAgents(),
    deliver: ({ agentId, text, fyi, clientMessageId }) =>
      runCauseEffect(
        agents.sendMessage({ agentId, text, clientMessageId }, undefined, undefined, "motion-event", fyi),
      ).then(() => undefined),
    showWaiting: (tickets) => agents.setWaitingTickets(tickets),
    notifyOwner: (input) => pushes.push(input),
    timeZone: () => "UTC",
    stateFile: join(userData, "motion-events-v1.json"),
    log: () => {},
  });
  await service.start();
  server = await startMotionEventsServer({
    listen: "127.0.0.1:0",
    secret: () => SECRET,
    receive: (event) => service.receive(event),
    log: () => {},
  });
  const address = server.address();
  assert.ok(address && typeof address === "object", "The route listens on a port.");
  const port = address.port;
  const post = async (body: unknown, options: { secret?: string; timestamp?: number } = {}) => {
    const text = JSON.stringify(body);
    const timestamp = String(options.timestamp ?? Math.floor(Date.now() / 1000));
    const response = await fetch(`http://127.0.0.1:${port}${MOTION_EVENTS_PATH}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-motion-timestamp": timestamp,
        "x-motion-signature": signMotionEvent(options.secret ?? SECRET, timestamp, text),
      },
      body: text,
    });
    return {
      status: response.status,
      body: readOutcome(await response.json()),
    };
  };
  const member = (agent: { id: string; name: string }): MotionMember => ({
    id: `u-${agent.id}`,
    name: agent.name,
    kind: "agent",
    agent_key: agent.id,
    role: "member",
  });
  const landing = { id: "issue-1", key: "UO-1", title: "Landing page for the course" };

  // (a) Assigned: one wake, once; a retry and a bad signature deliver nothing.
  const assigned = motionEvent("issue.assigned", landing, {
    recipients: [member(dev)],
    created: true,
    issue: { ...motionEvent("x", landing, {}).issue, assignees: [member(dev)] },
  });
  const refused = await post(assigned, { secret: "wrong" });
  assert.equal(refused.status, 401, "A bad signature is refused.");
  const stale = await post(assigned, { timestamp: Math.floor(Date.now() / 1000) - 3_600 });
  assert.equal(stale.status, 401, "An old timestamp is refused.");
  const first = await post(assigned);
  assert.equal(first.status, 200);
  assert.deepEqual(first.body.deliveries, [{ agentId: dev.id, mode: "wake" }]);
  await waitFor("the assigned turn of Dev", () => turnInputs(dev.name).length === 2 && idle(dev.id));
  const devInput = turnInputs(dev.name)[1] ?? "";
  assert.ok(
    devInput.includes("UO-1") && devInput.includes("Landing page") && devInput.includes(URL_OF("issue-1")),
    devInput,
  );
  const retry = await post(assigned);
  assert.equal(retry.body.outcome, "duplicate", "Motion's retry of the same event is no second delivery.");
  await new Promise((done) => setTimeout(done, 300));
  assert.equal(turnInputs(dev.name).length, 2, "Dev got the assignment once.");
  assert.equal(turnInputs(lead.name).length, 1, "Nobody else got it.");
  assert.equal(turnInputs(other.name).length, 1, "Nobody else got it.");
  const marker = (await runCauseEffect(agents.readConversation(dev.id))).messages.find((message) =>
    message.text.includes("UO-1"),
  );
  assert.equal(
    marker?.itemType,
    "system-notice:motion-event",
    "The chat shows a Motion marker, not a message from the owner.",
  );
  report.cases.push({
    name: "an assigned ticket wakes its agent once; a retry and a bad signature deliver nothing",
    details: { refused: refused.body, stale: stale.body, first: first.body, retry: retry.body },
    passed: true,
  });

  // (b) A status change by the owner is a held note: no turn starts.
  const moved = await post(motionEvent("issue.status_changed", landing, { recipients: [member(dev)], from: "To Do" }));
  assert.deepEqual(moved.body.deliveries, [{ agentId: dev.id, mode: "fyi" }]);
  await new Promise((done) => setTimeout(done, 500));
  assert.equal(turnInputs(dev.name).length, 2, "The held note starts no turn.");
  const held = agents.listQueue(dev.id).deliveries.filter((delivery) => delivery.status === "queued");
  assert.equal(held.length, 1, "The note waits in the queue for the next turn.");
  report.cases.push({ name: "a change by the owner that needs no action is held", details: moved.body, passed: true });

  // (c) Overdue: the agent and its manager, once each.
  const overdue = await post(
    motionEvent("issue.overdue", landing, {
      id: "evt:overdue:issue-1:1:0",
      actor: null,
      recipients: [member(dev)],
      days_overdue: 0,
    }),
  );
  assert.deepEqual(
    [...(overdue.body.deliveries ?? [])].sort((a, b) => a.agentId.localeCompare(b.agentId)),
    [
      { agentId: dev.id, mode: "fyi" },
      { agentId: lead.id, mode: "wake" },
    ].sort((a, b) => a.agentId.localeCompare(b.agentId)),
    "Dev was woken for this ticket moments ago, so its note is held; its manager is woken.",
  );
  await waitFor("the overdue turn of Lead", () => turnInputs(lead.name).length === 2 && idle(lead.id));
  const leadInput = turnInputs(lead.name)[1] ?? "";
  assert.ok(leadInput.includes("overdue") && leadInput.includes("Dev"), leadInput);
  assert.equal(turnInputs(other.name).length, 1, "An agent outside the line hears nothing.");
  const again = await post(
    motionEvent("issue.overdue", landing, { id: "evt:overdue:issue-1:1:0", actor: null, recipients: [member(dev)] }),
  );
  assert.equal(again.body.outcome, "duplicate", "The same overdue day goes once.");
  report.cases.push({
    name: "an overdue ticket reaches the agent and its manager",
    details: overdue.body,
    passed: true,
  });

  // (d) Waiting on the owner: Needs you and a push, no wake; it goes when the owner gives it back.
  const handed = await post(
    motionEvent("issue.waiting_on_person", landing, { actor: member(dev), recipients: [OWNER], reason: "assigned" }),
  );
  assert.equal(handed.body.waiting, true);
  const items = agents.attentionItems().filter((item) => isTicketAttention(item));
  assert.equal(items.length, 1, "The ticket shows in Needs you.");
  assert.equal(items[0]?.agentId, dev.id);
  assert.equal(items[0]?.url, URL_OF("issue-1"));
  assert.ok(items[0]?.summary?.startsWith("UO-1"), items[0]?.summary);
  assert.equal(pushes.length, 1, "The owner gets one push.");
  assert.ok(pushes[0]?.body.includes("waits on you"), pushes[0]?.body);
  const back = await post(motionEvent("issue.assigned", landing, { recipients: [member(dev)] }));
  assert.equal(back.status, 200);
  assert.equal(
    agents.attentionItems().filter((item) => isTicketAttention(item)).length,
    0,
    "Given back, it waits no more.",
  );
  report.cases.push({
    name: "a ticket that waits on the owner reaches Needs you with a push",
    details: { items, pushes },
    passed: true,
  });

  // (e) A mention wakes the agent; an agent's own change tells nobody.
  const docs = { id: "issue-2", key: "UO-2", title: "Course outline" };
  const before = turnInputs(other.name).length;
  const mention = await post(
    motionEvent("comment.mentioned", docs, {
      recipients: [member(other)],
      comment: { id: "c1", thread_id: "c1", body: "Can you check the outline?", truncated: false },
    }),
  );
  assert.deepEqual(mention.body.deliveries, [{ agentId: other.id, mode: "wake" }]);
  await waitFor("the mention turn of Other", () => turnInputs(other.name).length === before + 1 && idle(other.id));
  assert.ok((turnInputs(other.name).at(-1) ?? "").includes("Can you check the outline?"));
  const own = await post(motionEvent("issue.assigned", docs, { actor: member(other), recipients: [member(other)] }));
  assert.equal(own.body.outcome, "ignored", "An agent's own change tells nobody.");
  report.cases.push({
    name: "a mention wakes the agent; its own change does not",
    details: mention.body,
    passed: true,
  });

  // (f) The current ticket: a Motion tool call on a ticket starts it as the agent, and the fleet shows it.
  const calls: { agentId: string; operation: string; body: unknown }[] = [];
  const tickets = new MotionTickets({
    call: async (agentId, operation, input) => {
      calls.push({ agentId, operation, body: input });
      return { key: "UO-2", title: docs.title, url: URL_OF(docs.id), started: true, status_category: "in_progress" };
    },
    chatUrl: (agentId) => `https://bots.example.com/app/general/dm/${agentId}`,
    changed: () => agents.currentTicketsChanged(),
    stateFile: join(userData, "motion-tickets-v1.json"),
    log: () => {},
  });
  agents.setCurrentTickets((agentId) => tickets.current(agentId));
  tickets.observeToolCall(other.id, "mcp__motion_d6e7a74e__issues_update", { issue: "uo-2", status: "In Review" });
  tickets.observeToolCall(other.id, "comments_create", { page_id: "UO-2", body: "Done." });
  await waitFor("the current ticket", () => tickets.current(other.id));
  assert.deepEqual(
    calls,
    [
      {
        agentId: other.id,
        operation: "issues.start",
        body: { issue: "UO-2", chat_url: `https://bots.example.com/app/general/dm/${other.id}` },
      },
    ],
    "One call for a busy turn on one ticket.",
  );
  const fleet = agents.workspace?.fleet({});
  const card = fleet?.agents.find((entry) => entry.agentId === other.id);
  assert.deepEqual(card?.currentTicket, { key: "UO-2", title: docs.title, url: URL_OF(docs.id) });
  tickets.observeToolCall(other.id, "issues_stop", { issue: "UO-2" });
  assert.equal(tickets.current(other.id), null, "issues_stop clears it.");
  tickets.observeToolCall(other.id, "rows_get", { id: "UO-3" });
  assert.equal(calls.length, 1, "Reading a ticket is not working on it.");
  report.cases.push({
    name: "a Motion tool call makes the ticket the agent's current one",
    details: { calls, card },
    passed: true,
  });
  report.passed = true;
} catch (error) {
  report.error = error instanceof Error ? (error.stack ?? error.message) : String(error);
  process.exitCode = 1;
} finally {
  const open = server;
  if (open) await new Promise<void>((done) => open.close(() => done()));
  await runCauseEffect(agents.stop()).catch(() => {});
  database.close();
  mkdirSync(OUT, { recursive: true });
  writeFileSync(join(OUT, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  await rm(root, { recursive: true, force: true });
  process.stdout.write(`${report.passed ? "PASS" : "FAIL"} ${join(OUT, "report.json")}\n`);
  if (report.error) process.stdout.write(`${report.error}\n`);
}
