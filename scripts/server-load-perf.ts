// Load harness for the main-process stalls of a busy server. It runs the real agent service on a COPY
// of a server database (never the original), with a stand-in `claude` executable that streams turns
// the way the Claude CLI does: thinking and text deltas, tool calls with large results, and a
// transcript in the Claude config folder. A simulated client reads what a connected app reads (each
// event as JSON, the runtime snapshot, the page of open chats). After `--crash-at` seconds every
// stand-in process is killed, so the service reconciles the cut-off turns after the provider restart,
// as after a Claude crash. The harness measures the event-loop stalls and can record a CPU profile of
// the load phase.
//
// Run: node --import tsx scripts/server-load-perf.ts --db=<copy of openbot.db> [--agents=12]
//      [--seconds=60] [--crash-at=30] [--transcript-mb=40] [--profile=<file.cpuprofile>] [--label=x]
//      [--stall-stacks=<ms>]   (the JavaScript stack of each main-thread task of at least that long)
//      [--read-workers=2]      (0: every read on the main thread, as before the database read workers)
//      [--clients=1]           (connected apps that each read after each event)
//      [--verify-copies]       (check each kept message digest and shared event copy; a difference fails)
//      [--encode-pages=main]   (read and encode the open chats' pages on the main thread, as before)
// The database file is copied again into a temporary folder (`--tmp`) for each run. The run fails when a
// completed turn has no stored answer. Writes .openbot-build/server-load-perf/<label>.json. A profile of
// a run through tsx names the functions; bundle the script with esbuild first for exact line numbers.
import { EventEmitter } from "node:events";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { Session } from "node:inspector/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { performance as nodePerformance } from "node:perf_hooks";
import { DatabaseSync } from "node:sqlite";
import { AGENT_PROVIDERS, defaultProviderModel } from "@openbot/contracts/ipc";
import { TEAM_API_ROUTES } from "@openbot/contracts/team-api-routes";
import { TEAM_CURRENT_CAPABILITIES } from "@openbot/contracts/team-protocol/current";
import { Effect } from "effect";
import type { AgentBrowserHost } from "../src/backend/agent/turn-lifecycle";
import type { AgentClient, DiagnosticOrigin } from "../src/backend/agent-client";
import type { ClaudeCliInfo } from "../src/backend/cli";
import type { AppServerNotification, AppServerRequest, RequestId, ResponseDecoder } from "../src/backend/protocol";
import { providerSync } from "../src/backend/provider-client-effects";
import type { ReadProviderHistory } from "../src/backend/provider-history";

const argument = (name: string) => process.argv.find((arg) => arg.startsWith(`--${name}=`))?.slice(`--${name}=`.length);
const sourceDatabase = argument("db");
if (!sourceDatabase || !existsSync(sourceDatabase)) {
  process.stderr.write("Usage: node --import tsx scripts/server-load-perf.ts --db=<copy of openbot.db>\n");
  process.exit(2);
}
const AGENTS = Number(argument("agents") ?? 12);
const SECONDS = Number(argument("seconds") ?? 60);
const CRASH_AT = Number(argument("crash-at") ?? 30);
const TRANSCRIPT_MB = Number(argument("transcript-mb") ?? 40);
const PROFILE = argument("profile");
/** `--stall-stacks=<ms>` keeps the JavaScript stack of each main-thread task of at least that long. */
const STALL_STACKS_MS = argument("stall-stacks") ? Number(argument("stall-stacks")) : null;
const LABEL = argument("label") ?? "run";
const OPEN_CHATS = 3;
/** `--clients=N`: how many connected apps read after each event, as a desktop, a phone and a browser do. */
const CLIENTS = Math.max(1, Number(argument("clients") ?? 1));
/** `--verify-copies`: compare each kept message digest and shared event copy with a fresh one. */
const VERIFY_COPIES = process.argv.includes("--verify-copies");
/** `--encode-pages=main` reads and encodes the open chats' pages on the main thread, as before. */
const ENCODE_PAGES_OFF_MAIN = argument("encode-pages") !== "main";
if (VERIFY_COPIES) process.env.OPENBOT_VERIFY_CONVERSATION_COPIES = "1";
/** `--reads=0` leaves out the unread-state read that the app makes after each conversation event. */
const readStates = argument("reads") !== "0";
/** `--read-workers=0` keeps every read on the main thread, as before the database read workers. */
const READ_WORKERS = Number(argument("read-workers") ?? 2);
const STALL_MS = 150;
const CLAUDE_MODEL = defaultProviderModel("claude");

const root = await mkdtemp(join(argument("tmp") ?? tmpdir(), "openbot-load-perf-"));
const userData = join(root, "user-data");
const home = join(root, "home");
const claudeExecutable = join(root, "claude");
const spawnLog = join(root, "claude-spawns.jsonl");
mkdirSync(userData, { recursive: true });
mkdirSync(home, { recursive: true });
process.env.HOME = home;
process.env.CLAUDE_CONFIG_DIR = join(home, ".claude");
process.env.OPENBOT_CLAUDE_PATH = claudeExecutable;

const log = (message: string) => process.stdout.write(`[${new Date().toISOString().slice(11, 23)}] ${message}\n`);

// The copy: agents work in this temporary home, and every agent runs on the Claude stand-in.
log(`Copying ${sourceDatabase}`);
copyFileSync(sourceDatabase, join(userData, "openbot.db"));
const workspaceRoot = join(home, "OpenBot", "Agents");
/** The member that reads the chats: the one with the most read cursors, as the owner on a server. */
let memberId = "owner";
const busy: { agentId: string; threadId: string; workspace: string; sessionId: string | null }[] = [];
{
  const database = new DatabaseSync(join(userData, "openbot.db"));
  const agents = database
    .prepare(
      `SELECT a.agent_id, a.thread_id, a.agent_json,
         (SELECT count(*) FROM projection_thread_messages m WHERE m.thread_id = a.thread_id) messages
       FROM projection_agents a ORDER BY messages DESC`,
    )
    .all();
  const update = database.prepare("UPDATE projection_agents SET agent_json = ?, model = ? WHERE agent_id = ?");
  database.exec("BEGIN");
  for (const row of agents) {
    const agentId = String(row.agent_id);
    const agent = JSON.parse(String(row.agent_json));
    agent.workspacePath = join(workspaceRoot, agentId);
    if (agent.provider !== "claude") {
      agent.provider = "claude";
      agent.model = CLAUDE_MODEL;
    }
    mkdirSync(agent.workspacePath, { recursive: true });
    update.run(JSON.stringify(agent), agent.model, agentId);
  }
  database.exec("UPDATE projection_provider_sessions SET provider = 'claude' WHERE provider <> 'claude'");
  database.exec("COMMIT");
  for (const row of agents.slice(0, AGENTS)) {
    const session = database
      .prepare(
        `SELECT external_session_id FROM projection_provider_sessions
         WHERE thread_id = ? AND provider = 'claude' ORDER BY updated_at DESC LIMIT 1`,
      )
      .get(String(row.thread_id));
    busy.push({
      agentId: String(row.agent_id),
      threadId: String(row.thread_id),
      workspace: join(workspaceRoot, String(row.agent_id)),
      sessionId: session ? String(session.external_session_id) : null,
    });
  }
  const reader = database
    .prepare("SELECT member_id FROM projection_thread_reads GROUP BY member_id ORDER BY count(*) DESC LIMIT 1")
    .get();
  if (reader) memberId = String(reader.member_id);
  database.close();
}

// A transcript for each busy agent's saved session, so a resume works and the restart recovery reads a
// long history, as on a server whose agents worked for weeks. Sizes fall from TRANSCRIPT_MB.
function seedTranscript(workspace: string, sessionId: string, megabytes: number): void {
  const directory = join(process.env.CLAUDE_CONFIG_DIR ?? "", "projects", workspace.replace(/[^a-zA-Z0-9]/g, "-"));
  mkdirSync(directory, { recursive: true });
  const lines: string[] = [];
  let size = 0;
  let parent: string | null = null;
  let index = 0;
  const filler = "x".repeat(2_000);
  while (size < megabytes * 1024 * 1024) {
    const uuid = `seed-${sessionId}-${index}`;
    const record =
      index % 3 === 0
        ? { type: "user", message: { role: "user", content: `seeded prompt ${index}` } }
        : index % 3 === 1
          ? {
              type: "assistant",
              message: {
                id: `msg-${index}`,
                role: "assistant",
                content: [
                  { type: "text", text: `seeded answer ${index} ${filler.slice(0, 400)}` },
                  { type: "tool_use", id: `tool-${index}`, name: "Bash", input: { command: "ls" } },
                ],
              },
            }
          : {
              type: "user",
              message: {
                role: "user",
                content: [{ type: "tool_result", tool_use_id: `tool-${index - 1}`, content: filler }],
              },
            };
    const line = JSON.stringify({
      ...record,
      uuid,
      parentUuid: parent,
      sessionId,
      timestamp: new Date(Date.now() - 86_400_000 + index).toISOString(),
      cwd: workspace,
      isSidechain: false,
    });
    lines.push(line);
    size += line.length + 1;
    parent = uuid;
    index += 1;
  }
  writeFileSync(join(directory, `${sessionId}.jsonl`), `${lines.join("\n")}\n`);
}
busy.forEach((agent, index) => {
  if (!agent.sessionId) return;
  seedTranscript(agent.workspace, agent.sessionId, Math.max(1, Math.round(TRANSCRIPT_MB / (1 + index))));
});
log(`Seeded transcripts for ${busy.filter((agent) => agent.sessionId).length} sessions.`);

// The stand-in for the Claude CLI: stream-json in and out, a transcript like the real one.
const STAND_IN_CLAUDE = `#!${process.execPath}
const fs = require("node:fs");
const { join } = require("node:path");
const { randomUUID } = require("node:crypto");
const args = process.argv.slice(2);
if (args.includes("--version")) { process.stdout.write("2.1.302 (Claude Code)\\n"); process.exit(0); }
const option = (name) => {
  const index = args.findIndex((arg) => arg === name || arg.startsWith(name + "="));
  if (index < 0) return null;
  return args[index] === name ? (args[index + 1] ?? null) : args[index].slice(name.length + 1);
};
const sessionId = option("--resume") ?? option("--session-id") ?? randomUUID();
const projectDirectory = join(process.env.CLAUDE_CONFIG_DIR, "projects", process.cwd().replace(/[^a-zA-Z0-9]/g, "-"));
fs.mkdirSync(projectDirectory, { recursive: true });
const transcript = join(projectDirectory, sessionId + ".jsonl");
fs.appendFileSync(${JSON.stringify(spawnLog)}, JSON.stringify({ pid: process.pid, sessionId }) + "\\n");
const write = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
let parent = null;
const record = (entry) => {
  const uuid = entry.uuid ?? randomUUID();
  fs.appendFileSync(transcript, JSON.stringify({ ...entry, uuid, parentUuid: parent, sessionId, timestamp: new Date().toISOString(), cwd: process.cwd(), isSidechain: false }) + "\\n");
  parent = uuid;
  return uuid;
};
const words = "the river runs past the old mill and the water turns the wheel while the miller counts the sacks of grain ".split(" ");
const sentence = (n) => Array.from({ length: n }, (_, i) => words[(i * 7 + n) % words.length]).join(" ") + " ";
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
let cost = 0;
let busy = Promise.resolve();
async function turn(message) {
  const userUuid = record({ type: "user", uuid: message.uuid, message: message.message });
  const steps = 4;
  for (let step = 0; step <= steps; step += 1) {
    const last = step === steps;
    for (let i = 0; i < 8; i += 1) {
      write({ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: sentence(6) } }, parent_tool_use_id: null, session_id: sessionId, uuid: randomUUID() });
      await sleep(40);
    }
    let text = "";
    const deltas = last ? 60 : 25;
    for (let i = 0; i < deltas; i += 1) {
      const piece = last && i === 0 ? "Report part. " : sentence(5 + (i % 4));
      text += piece;
      write({ type: "stream_event", event: { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: piece } }, parent_tool_use_id: null, session_id: sessionId, uuid: randomUUID() });
      await sleep(40);
    }
    const id = "msg_" + randomUUID();
    const toolId = "toolu_" + randomUUID();
    const content = last ? [{ type: "text", text }] : [{ type: "text", text }, { type: "tool_use", id: toolId, name: "Bash", input: { command: "ls -la " + step, description: "List files" } }];
    const usage = { input_tokens: 10, cache_read_input_tokens: 20000, output_tokens: 300 };
    const assistant = { id, type: "message", role: "assistant", model: ${JSON.stringify(CLAUDE_MODEL)}, content, stop_reason: null, usage };
    const uuid = record({ type: "assistant", message: assistant });
    write({ type: "assistant", message: assistant, parent_tool_use_id: null, session_id: sessionId, uuid });
    if (last) break;
    await sleep(600);
    const result = sentence(40).repeat(4 + (step * 9) % 40);
    const user = { role: "user", content: [{ type: "tool_result", tool_use_id: toolId, content: result }] };
    const resultUuid = record({ type: "user", message: user });
    write({ type: "user", message: user, parent_tool_use_id: null, session_id: sessionId, uuid: resultUuid, tool_use_result: { stdout: result, stderr: "" } });
  }
  cost += 0.01;
  write({ type: "result", subtype: "success", is_error: false, result: "Done.", session_id: sessionId, uuid: randomUUID(),
    duration_ms: 1, duration_api_ms: 1, num_turns: 5, total_cost_usd: cost, usage: { input_tokens: 0, output_tokens: 0 }, permission_denials: [],
    modelUsage: { ${JSON.stringify(CLAUDE_MODEL)}: { inputTokens: 50, outputTokens: 1500, cacheReadInputTokens: 100000, cacheCreationInputTokens: 0, costUSD: cost, webSearchRequests: 0, contextWindow: 200000, maxOutputTokens: 32000 } } });
  void userUuid;
}
let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let newline = buffer.indexOf("\\n");
  while (newline >= 0) {
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    newline = buffer.indexOf("\\n");
    if (!line) continue;
    const message = JSON.parse(line);
    if (message.type === "control_request")
      write({ type: "control_response", response: { subtype: "success", request_id: message.request_id, response: {} } });
    else if (message.type === "user") busy = busy.then(() => turn(message));
  }
});
process.stdin.on("end", () => process.exit(0));
`;
await writeFile(claudeExecutable, STAND_IN_CLAUDE, { mode: 0o755 });

const { AgentService } = await import("../src/backend/agent-service");
const { keptMessageChecks } = await import("../src/backend/agent/delivery-content");
const { encodeTeamResponseBody } = await import("../src/main/team-api/response-encoding");
const { markerExclusionsForCapabilities, WEBRTC_FRAME_BODY_BUDGET } = await import(
  "../src/main/team-api/request-helpers"
);
const { spawnSourceAppReadWorker } = await import("../src/main/database-read-worker-source");
const ROUTE_CAPABILITIES: ReadonlySet<string> = new Set<string>(TEAM_CURRENT_CAPABILITIES);
const { AgentStore } = await import("../src/backend/agent-store");
const { ClaudeAgentClient } = await import("../src/backend/claude-client");
const { runCauseEffect } = await import("../src/backend/effect-boundary");
const { MailboxStore } = await import("../src/backend/mailbox-store");
const { OpenBotDatabase } = await import("../src/backend/openbot-database");

interface ClientEvents {
  notification: [notification: AppServerNotification];
  request: [request: AppServerRequest];
  exit: [error: Error];
  diagnostic: [message: string, origin?: DiagnosticOrigin];
}

/** The real Claude client; only the account, usage and model reads are answered here. */
class ClaudeStandIn extends EventEmitter<ClientEvents> implements AgentClient {
  readonly provider = "claude";
  readonly contextCompaction = "native";
  readonly #real: InstanceType<typeof ClaudeAgentClient>;
  readonly readHistory: ReadProviderHistory;

  constructor(cli: ClaudeCliInfo) {
    super();
    this.#real = new ClaudeAgentClient(
      cli,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      join(userData, "provider-state", "claude"),
    );
    this.readHistory = this.#real.readHistory;
    this.#real.on("notification", (notification) => this.emit("notification", notification));
    this.#real.on("request", (request) => this.emit("request", request));
    this.#real.on("diagnostic", (message) => this.emit("diagnostic", message));
    this.#real.on("exit", (error) => this.emit("exit", error));
  }
  get running(): boolean {
    return this.#real.running;
  }
  start(): void {
    this.#real.start();
  }
  stop() {
    return this.#real.stop();
  }
  canReleaseProcess = () => this.#real.canReleaseProcess();
  releaseThread(externalThreadId: string) {
    return this.#real.releaseThread(externalThreadId);
  }
  releaseIdleThreads() {
    return this.#real.releaseIdleThreads();
  }
  request<T>(method: string, params: unknown, decoder: ResponseDecoder<T>, timeoutMs?: number) {
    if (!this.#real.running) return this.#real.request(method, params, decoder, timeoutMs);
    switch (method) {
      case "account/read":
        return providerSync(() => decoder({ account: { type: "claude", email: "claude@example.com" } }));
      case "account/rateLimits/read":
        return providerSync(() => decoder({ rateLimits: null, rateLimitsByLimitId: null }));
      case "model/list":
        return providerSync(() => decoder({ data: [{ model: CLAUDE_MODEL, displayName: "Claude" }] }));
      default:
        return this.#real.request(method, params, decoder, timeoutMs);
    }
  }
  notify(): void {
    this.#real.notify();
  }
  respond(id: RequestId, result: unknown): void {
    this.#real.respond(id, result);
  }
  respondError(id: RequestId, error: Parameters<AgentClient["respondError"]>[1]): void {
    this.#real.respondError(id, error);
  }
}

const unused = () => Effect.die(new Error("Not used by the load harness."));
const browser: AgentBrowserHost = {
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

// Event-loop stalls: a 10 ms timer that notes each late tick.
const stalls: number[] = [];
let lastTick = performance.now();
let measuring = false;
const ticker = setInterval(() => {
  const now = performance.now();
  const late = now - lastTick - 10;
  lastTick = now;
  if (measuring && late >= STALL_MS) stalls.push(Math.round(late));
}, 10);

const timed = new Map<string, { count: number; totalMs: number; maxMs: number }>();
function record(name: string, ms: number): void {
  const entry = timed.get(name) ?? { count: 0, totalMs: 0, maxMs: 0 };
  entry.count += 1;
  entry.totalMs += ms;
  entry.maxMs = Math.max(entry.maxMs, ms);
  timed.set(name, entry);
}
function time<T>(name: string, run: () => T): T {
  const start = performance.now();
  try {
    return run();
  } finally {
    record(name, performance.now() - start);
  }
}

const initStart = performance.now();
const database = new OpenBotDatabase(userData);
if (READ_WORKERS > 0) database.useReadWorkers(spawnSourceAppReadWorker, { workers: READ_WORKERS });
const store = new AgentStore(userData, home, database);
const mailbox = new MailboxStore(userData, store.sharedRoot, store.database);
const service = new AgentService({
  store,
  mailbox,
  browser,
  preferredProvider: "claude",
  offProviders: AGENT_PROVIDERS.filter((provider) => provider !== "claude"),
  clientFactory: (_provider, cli) => new ClaudeStandIn(cli),
});
await runCauseEffect(service.initialize());
const initMs = performance.now() - initStart;
log(`Service ready in ${initMs.toFixed(0)} ms.`);

// The simulated client.
let events = 0;
let eventBytes = 0;
const eventTypes = new Map<string, number>();
const openChats = busy.slice(0, OPEN_CHATS).map((agent) => agent.agentId);
const pageDue = new Map<string, NodeJS.Timeout>();
/** The message that each busy agent works on now, by agent. */
const pending = new Map<string, string>();
const isActive = (status: string) => status === "queued" || status === "starting" || status === "running";
service.on("event", (event) => {
  events += 1;
  eventTypes.set(event.type, (eventTypes.get(event.type) ?? 0) + 1);
  // A current client gets a conversation or queue change as an invalidation and reads what it shows;
  // the Team API encodes other events whole.
  const sent =
    event.type === "conversation"
      ? { type: "conversation-invalidated", agentId: event.snapshot.agentId, revision: event.snapshot.revision }
      : event.type === "queue-changed"
        ? { type: "queue-invalidated", agentId: event.snapshot.agentId }
        : event;
  eventBytes += time("client: event JSON", () => JSON.stringify(sent).length);
  // The app reads the unread state of every chat after each conversation invalidation.
  // As the Team API route: a read worker computes the states when one runs.
  if (event.type === "conversation" && readStates)
    for (let client = 0; client < CLIENTS; client += 1) {
      const start = performance.now();
      void runCauseEffect(service.listConversationReadsOffMain(memberId))
        .then((reads) => {
          JSON.stringify(reads);
          record("client: conversation reads", performance.now() - start);
        })
        .catch(() => {});
    }
  if (event.type === "queue-changed") {
    const delivery = pending.get(event.snapshot.agentId);
    if (delivery && !event.snapshot.deliveries.some((item) => item.id === delivery && isActive(item.status)))
      settle(event.snapshot.agentId);
    // The web app reads the queue of the agent after each queue invalidation.
    for (let client = 0; client < CLIENTS; client += 1)
      time("client: queue read", () => JSON.stringify(service.listQueue(event.snapshot.agentId)).length);
  }
  if (
    event.type === "conversation" &&
    openChats.includes(event.snapshot.agentId) &&
    !pageDue.has(event.snapshot.agentId)
  ) {
    const agentId = event.snapshot.agentId;
    pageDue.set(
      agentId,
      setTimeout(() => {
        pageDue.delete(agentId);
        for (let client = 0; client < CLIENTS; client += 1) {
          const start = performance.now();
          void clientPage(agentId)
            .then(() => record("client: open chat page", performance.now() - start))
            .catch(() => {});
        }
      }, 300),
    );
  }
});
/**
 * The open chat's page as the Team API route answers it (`routeAgentConversation`): encoded by a read
 * worker when one runs, or read and encoded here, with the halving of a page larger than one frame.
 */
async function clientPage(agentId: string): Promise<number> {
  const route = {
    method: "GET",
    path: TEAM_API_ROUTES.agent.conversationPage(agentId),
    protocol: 8,
    capabilities: ROUTE_CAPABILITIES,
    hiddenAgentIds: new Set<string>(),
  };
  const exclusions = markerExclusionsForCapabilities(ROUTE_CAPABILITIES);
  if (ENCODE_PAGES_OFF_MAIN) {
    const encoded = await runCauseEffect(
      service.readConversationPageResponseFor(
        agentId,
        memberId,
        { type: "latest" },
        60,
        exclusions,
        { ...route, capabilities: [...route.capabilities], hiddenAgentIds: [] },
        WEBRTC_FRAME_BODY_BUDGET,
      ),
    );
    if (encoded && "body" in encoded) return encoded.body.length;
  }
  for (let limit = 60; ; limit = Math.floor(limit / 2)) {
    const page = await runCauseEffect(
      service.readConversationPageFor(agentId, memberId, { type: "latest" }, limit, exclusions),
    );
    if (Buffer.byteLength(JSON.stringify(page)) <= WEBRTC_FRAME_BODY_BUDGET)
      return encodeTeamResponseBody(route, 200, page).length;
    if (limit === 1) return 0;
  }
}

const snapshots = setInterval(() => {
  time("client: runtime snapshot", () => JSON.stringify(service.getRuntimeSnapshot()).length);
}, 1_000);

// Load: each busy agent gets a new message when its last one ends.
let sent = 0;
let stopping = false;
async function sendNext(agentId: string): Promise<void> {
  if (stopping) return;
  const receipt = await runCauseEffect(
    service.sendMessage({ agentId, text: `Load turn ${sent + 1}: write the next part of the report.` }),
  ).catch((error) => {
    log(`send to ${agentId} failed: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  });
  const deliveryId = receipt?.deliveries[0]?.id;
  if (deliveryId) pending.set(agentId, deliveryId);
  sent += 1;
}
/** The agent's last message ended: it gets the next one. */
function settle(agentId: string): void {
  if (!pending.delete(agentId)) return;
  void sendNext(agentId);
}
// The queue event of the end normally settles a message; this catches one that ended without it.
const watcher = setInterval(() => {
  for (const [agentId, deliveryId] of pending) {
    const status = mailbox.getDelivery(deliveryId)?.delivery.status;
    if (status === "completed" || status === "failed" || status === "interrupted") settle(agentId);
  }
}, 2_000);

let session: Session | null = null;
if (PROFILE) {
  session = new Session();
  session.connect();
  await session.post("Profiler.enable");
  await session.post("Profiler.setSamplingInterval", { interval: 1_000 });
  await session.post("Profiler.start");
}
const stallRoutes =
  STALL_STACKS_MS === null
    ? null
    : (await import("../src/main/server-debug-profiler")).createServerDebugRoutes({ userDataPath: userData, log });
if (stallRoutes)
  await stallRoutes.route(
    "POST",
    "/v1/debug/stall-watch",
    JSON.stringify({ seconds: Math.max(10, SECONDS + 5), threshold_ms: STALL_STACKS_MS }),
  );
measuring = true;
const loadStart = performance.now();
// The main thread's busy time in the load phase, without the cost of a profile.
const utilizationStart = nodePerformance.eventLoopUtilization();
for (const agent of busy) await sendNext(agent.agentId);
log(`Sent the first message to ${busy.length} agents.`);

/** The stand-in processes that this run started. */
function standInPids(): Set<number> {
  if (!existsSync(spawnLog)) return new Set();
  return new Set(
    readFileSync(spawnLog, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => Number(JSON.parse(line).pid)),
  );
}
let crashed = 0;
const crashTimer =
  CRASH_AT > 0 && CRASH_AT < SECONDS
    ? setTimeout(() => {
        for (const pid of standInPids()) {
          try {
            process.kill(pid, "SIGKILL");
            crashed += 1;
          } catch {}
        }
        log(`Killed ${crashed} stand-in processes.`);
      }, CRASH_AT * 1_000)
    : null;

await new Promise((done) => setTimeout(done, SECONDS * 1_000));
measuring = false;
const loadMs = performance.now() - loadStart;
const utilization = nodePerformance.eventLoopUtilization(utilizationStart);
stopping = true;
if (crashTimer) clearTimeout(crashTimer);
if (session) {
  const { profile } = await session.post("Profiler.stop");
  writeFileSync(PROFILE ?? "", JSON.stringify(profile));
  session.disconnect();
  log(`Profile: ${PROFILE}`);
}
const stallStacks = stallRoutes
  ? JSON.parse((await stallRoutes.route("GET", "/v1/debug/stalls", ""))?.body ?? "{}").stalls
  : undefined;
stallRoutes?.close();
clearInterval(watcher);
clearInterval(snapshots);
clearInterval(ticker);
for (const timer of pageDue.values()) clearTimeout(timer);

const reconciled = (() => {
  const check = new DatabaseSync(join(userData, "openbot.db"), { readOnly: true });
  try {
    return Number(
      check
        .prepare("SELECT count(*) n FROM orchestration_events WHERE event_type = 'turn.reconciled-after-restart'")
        .get()?.n ?? 0,
    );
  } catch {
    return -1;
  } finally {
    check.close();
  }
})();
const completedTurns = (() => {
  const check = new DatabaseSync(join(userData, "openbot.db"), { readOnly: true });
  try {
    return Number(
      check
        .prepare("SELECT count(*) n FROM projection_deliveries WHERE status = 'completed' AND created_at > ?")
        .get(new Date(Date.now() - loadMs - 5_000).toISOString())?.n ?? 0,
    );
  } finally {
    check.close();
  }
})();

// What the run must leave: each turn that completed has its answer stored, with no streaming part left.
const problems: string[] = [];
{
  const check = new DatabaseSync(join(userData, "openbot.db"), { readOnly: true });
  try {
    const since = new Date(Date.now() - loadMs - 5_000).toISOString();
    const turns = check
      .prepare(
        `SELECT d.delivery_id, d.turn_id FROM projection_deliveries d
         WHERE d.status = 'completed' AND d.created_at > ? AND d.turn_id IS NOT NULL`,
      )
      .all(since);
    const answer = check.prepare(
      `SELECT count(*) n FROM projection_thread_messages
       WHERE turn_id = ? AND author = 'assistant' AND status = 'completed'
         AND json_extract(message_json, '$.text') LIKE '%Report part.%'`,
    );
    const streaming = check.prepare(
      "SELECT count(*) n FROM projection_thread_messages WHERE turn_id = ? AND status = 'streaming'",
    );
    // A turn that the crash cut off ends as the restart recovery decided; the stand-in left no answer.
    const reconciledTurns = new Set(
      check
        .prepare("SELECT payload_json FROM orchestration_events WHERE event_type = ? AND occurred_at > ?")
        .all("turn.reconciled-after-restart", since)
        .map((row) => String(JSON.parse(String(row.payload_json)).detail?.turnId)),
    );
    for (const row of turns) {
      if (reconciledTurns.has(String(row.turn_id))) continue;
      if (Number(answer.get(String(row.turn_id))?.n ?? 0) === 0)
        problems.push(
          `turn ${String(row.turn_id)} completed with no stored answer: ${JSON.stringify(
            check
              .prepare(
                `SELECT author, status, item_type, substr(json_extract(message_json, '$.text'), 1, 24) text
                 FROM projection_thread_messages WHERE turn_id = ?`,
              )
              .all(String(row.turn_id)),
          )}`,
        );
      if (Number(streaming.get(String(row.turn_id))?.n ?? 0) > 0)
        problems.push(`turn ${String(row.turn_id)} completed with a streaming message left`);
    }
    if (turns.length === 0) problems.push("no turn completed");
  } finally {
    check.close();
  }
}
if (problems.length > 0) process.exitCode = 1;

const sorted = [...stalls].sort((left, right) => right - left);
const result = {
  label: LABEL,
  agents: busy.length,
  seconds: SECONDS,
  crashAt: CRASH_AT,
  readWorkers: READ_WORKERS,
  clients: CLIENTS,
  encodePages: ENCODE_PAGES_OFF_MAIN ? "worker" : "main",
  ...(VERIFY_COPIES ? { verifiedCopies: { ...keptMessageChecks } } : {}),
  initMs: Math.round(initMs),
  messagesSent: sent,
  completedTurns,
  problems,
  killedProcesses: crashed,
  reconciledEvents: reconciled,
  busyMs: Math.round(utilization.active),
  busyShare: Number(utilization.utilization.toFixed(3)),
  events,
  eventMb: Number((eventBytes / 1e6).toFixed(1)),
  eventTypes: Object.fromEntries(eventTypes),
  stalls: {
    count: stalls.length,
    totalMs: stalls.reduce((sum, value) => sum + value, 0),
    maxMs: sorted[0] ?? 0,
    top: sorted.slice(0, 10),
  },
  ...(stallStacks
    ? {
        stallStacks: stallStacks.map(
          (stall: {
            blockedMs: number;
            late: boolean;
            frames: { functionName: string; url: string; line: number }[];
          }) =>
            `${stall.blockedMs} ms${stall.late ? " (late)" : ""}: ${stall.frames
              .slice(0, 14)
              .map(
                (frame) =>
                  `${frame.functionName || "(anonymous)"} ${frame.url.split("/").slice(-2).join("/")}:${frame.line}`,
              )
              .join(" < ")}`,
        ),
      }
    : {}),
  timed: Object.fromEntries(
    [...timed.entries()].map(([name, entry]) => [
      name,
      { count: entry.count, avgMs: Number((entry.totalMs / entry.count).toFixed(2)), maxMs: Math.round(entry.maxMs) },
    ]),
  ),
};
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
const out = resolve(process.cwd(), ".openbot-build/server-load-perf");
mkdirSync(out, { recursive: true });
writeFileSync(join(out, `${LABEL}.json`), `${JSON.stringify(result, null, 2)}\n`);

await runCauseEffect(service.stop()).catch(() => {});
database.close();
for (const pid of standInPids())
  try {
    process.kill(pid, "SIGKILL");
  } catch {}
await rm(root, { recursive: true, force: true });
process.exit(process.exitCode ?? 0);
