// Checks that a message sent while Codex compacts the context waits in the queue and runs after the
// compaction, and that no message fails because of a compaction (#1766). Runs the real agent
// service on a temporary profile with a fake Codex app-server that, like Codex 0.160.1, refuses
// `turn/start` with `ActiveTurnNotSteerable { turn_kind: Compact }` while a compaction turn runs.
// Four cases: a compaction that ends by itself, one that runs past the start deadline and ends by
// itself, one that the run deadline stops, and one that does not stop, so that OpenBot sends a turn
// that Codex refuses. Then a chat whose compactions fail, and one that each compaction leaves full
// while Codex reports a small estimate during each compaction: both stop after 2. Last, a turn in
// which Codex compacts again after each step stops at its third compaction, and one whose compaction
// hangs stops at the run deadline.
// `bun scripts/codex-compaction-queue-e2e.ts`. Writes .openbot-build/codex-compaction-queue-e2e/report.json.
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { AGENT_PROVIDERS, type AgentEvent } from "@openbot/contracts/ipc";
import { sourceText } from "@openbot/i18n/source";
import { Effect } from "effect";
import type { AgentBrowserHost } from "../src/backend/agent/turn-lifecycle";
import { getString, isRecord } from "../src/backend/protocol";

const OUT = resolve(import.meta.dirname, "../.openbot-build/codex-compaction-queue-e2e");
const root = await mkdtemp(join(tmpdir(), "openbot-compaction-queue-"));
const userData = join(root, "user-data");
const home = join(root, "home");
const logPath = join(root, "protocol.jsonl");
const controlPath = join(root, "control.json");
const fakeCodex = join(root, "codex");
// Codex must start the compaction in 1 s; a started compaction runs for 10 s at most.
const COMPACTION_TIMEOUT_MS = 1_000;

// Before the service modules load: the Codex process and the stores read the home folder.
process.env.HOME = home;
process.env.CODEX_HOME = join(home, ".codex");
process.env.OPENBOT_CODEX_PATH = fakeCodex;
process.env.OPENBOT_FAKE_CODEX_LOG = logPath;
process.env.OPENBOT_FAKE_CODEX_CONTROL = controlPath;
mkdirSync(home, { recursive: true });

const { AgentService } = await import("../src/backend/agent-service");
const { AgentStore } = await import("../src/backend/agent-store");
const { runCauseEffect } = await import("../src/backend/effect-boundary");
const { MailboxStore } = await import("../src/backend/mailbox-store");
const { OpenBotDatabase } = await import("../src/backend/openbot-database");

/**
 * A Codex app-server with the methods that the service calls. Each normal turn reports 90% of the
 * context window, so the next message starts a compaction. `control.json` sets how long the next
 * compaction runs and whether it ignores `turn/interrupt`.
 */
const FAKE_CODEX = `#!/usr/bin/env node
const fs = require("node:fs");
if (process.argv.includes("--version")) {
  process.stdout.write("codex-cli 0.160.1\\n");
  process.exit(0);
}
const log = (entry) => fs.appendFileSync(process.env.OPENBOT_FAKE_CODEX_LOG, JSON.stringify(entry) + "\\n");
const control = () => JSON.parse(fs.readFileSync(process.env.OPENBOT_FAKE_CODEX_CONTROL, "utf8"));
const config = { config: { mcp_servers: {} }, layers: [{ name: { type: "user", file: "/fake/.codex/config.toml", profile: null }, version: "1", config: { mcp_servers: {} } }] };
let buffer = "";
let threads = 0;
let turns = 0;
/** threadId -> turns started, for \`growUsage\`. */
const threadTurns = new Map();
/** threadId -> { turnId, finish } of the compaction turn that runs. */
const compacting = new Map();
/** The turns that compact again after each step, until a \`turn/interrupt\` or 20 compactions. */
const looping = new Set();
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
    case "model/list": return write({ id: message.id, result: { data: [{ model: "gpt-5.5", displayName: "GPT-5.5" }] } });
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
      // Codex 0.160.1 \`start_or_steer_turn\`: an active compaction turn cannot take input.
      if (compacting.has(params.threadId)) {
        log({ refused: params.threadId });
        return write({ id: message.id, error: { code: -32603, message: "failed to submit turn input: ActiveTurnNotSteerable { turn_kind: Compact }" } });
      }
      const turnId = "turn-" + (++turns);
      write({ id: message.id, result: { turn: { id: turnId, status: "inProgress", items: [] } } });
      write({ method: "turn/started", params: { threadId: params.threadId, turn: { id: turnId } } });
      // \`growUsage\`: each turn adds 6% of the window, more than the growth that allows a new compaction.
      const count = (threadTurns.get(params.threadId) ?? 0) + 1;
      threadTurns.set(params.threadId, count);
      const used = control().growUsage ? 84000 + 6000 * (count - 1) : 90000;
      write({ method: "thread/tokenUsage/updated", params: { threadId: params.threadId, turnId, tokenUsage: { total: { totalTokens: used }, last: { totalTokens: used }, modelContextWindow: 100000 } } });
      // \`loop\`: Codex compacts after each step, and each compaction leaves 60% of the window, still
      // above its own limit.
      // \`stallInTurn\`: Codex starts a compaction in the turn and then sends nothing, as Codex 0.167.0
      // did when the connection stopped answering.
      if (control().stallInTurn) {
        looping.add(turnId);
        const item = { type: "contextCompaction", id: "self-compact-" + turnId };
        write({ method: "item/started", params: { threadId: params.threadId, turnId, item } });
        log({ method: "selfCompaction", threadId: params.threadId });
        return;
      }
      if (control().loop) {
        let left = 20;
        looping.add(turnId);
        const again = () => {
          if (!looping.has(turnId)) return;
          if (left-- === 0) {
            looping.delete(turnId);
            return write({ method: "turn/completed", params: { threadId: params.threadId, turn: { id: turnId, status: "completed" } } });
          }
          const item = { type: "contextCompaction", id: "self-compact-" + turnId + "-" + left };
          write({ method: "item/started", params: { threadId: params.threadId, turnId, item } });
          log({ method: "selfCompaction", threadId: params.threadId });
          setTimeout(() => {
            if (!looping.has(turnId)) return;
            write({ method: "item/completed", params: { threadId: params.threadId, turnId, item } });
            const tokenUsage = { total: { totalTokens: 60000 }, last: { totalTokens: 60000 }, modelContextWindow: 100000 };
            write({ method: "thread/tokenUsage/updated", params: { threadId: params.threadId, turnId, tokenUsage } });
            setTimeout(again, 10);
          }, 10);
        };
        return again();
      }
      setTimeout(() => {
        const item = { type: "agentMessage", id: "message-" + turnId, text: "Done.", phase: "final_answer" };
        write({ method: "item/completed", params: { threadId: params.threadId, turnId, item } });
        write({ method: "turn/completed", params: { threadId: params.threadId, turn: { id: turnId, status: "completed" } } });
      }, 50);
      return;
    }
    case "thread/compact/start": {
      const { compactionMs, ignoreInterrupt, compactionStatus, estimate } = control();
      const turnId = "compact-turn-" + (++turns);
      const item = { type: "contextCompaction", id: "compact-item-" + turnId };
      write({ id: message.id, result: {} });
      write({ method: "turn/started", params: { threadId: params.threadId, turn: { id: turnId } } });
      write({ method: "item/started", params: { threadId: params.threadId, turnId, item } });
      const finish = (status) => {
        if (compacting.get(params.threadId)?.turnId !== turnId) return;
        compacting.delete(params.threadId);
        clearTimeout(timer);
        log({ compactionEnded: turnId, threadId: params.threadId, status });
        // Like Codex 0.167.0: an estimate of the compacted session, with no request behind it.
        if (status === "completed" && estimate) {
          const tokenUsage = { total: { totalTokens: 90000 }, last: { totalTokens: 6000 }, modelContextWindow: 100000 };
          write({ method: "thread/tokenUsage/updated", params: { threadId: params.threadId, turnId, tokenUsage } });
        }
        if (status === "completed") write({ method: "item/completed", params: { threadId: params.threadId, turnId, item } });
        write({ method: "turn/completed", params: { threadId: params.threadId, turn: { id: turnId, status } } });
      };
      const timer = setTimeout(() => finish(compactionStatus ?? "completed"), compactionMs);
      compacting.set(params.threadId, { turnId, finish, ignoreInterrupt });
      return;
    }
    case "turn/interrupt": {
      looping.delete(params.turnId);
      write({ id: message.id, result: {} });
      const compaction = compacting.get(params.threadId);
      if (compaction?.turnId === params.turnId) {
        if (!compaction.ignoreInterrupt) compaction.finish("interrupted");
        return;
      }
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
      log({ method: message.method ?? null, id: message.id ?? null, params: message.params ?? null });
      if (message.method && message.id !== undefined) answer(message);
    }
    newline = buffer.indexOf("\\n");
  }
});
`;

/** One line of the fake Codex log: a message that OpenBot sent, or a fact that the fake reports. */
interface ProtocolEntry {
  method: string | null;
  threadId: string | null;
  turnId: string | null;
  refused: string | null;
  compactionEnded: string | null;
  status: string | null;
}

interface CaseReport {
  name: string;
  compactionMs: number;
  ignoreInterrupt: boolean;
  threadId: string;
  statusWhileCompacting: string;
  finalStatus: string;
  finalError: string | null;
  compactionEnd: string | null;
  interruptSent: boolean;
  refusedStarts: number;
  passed: boolean;
}

const errors: { code: string; agentId?: string }[] = [];
const report: {
  compactionTimeoutMs: number;
  cases: CaseReport[];
  failedCompactions?: { compactions: number; failed: number; stopNotices: number; messages: string[] };
  ineffectiveCompactions?: { compactions: number; turns: number; notices: number; messages: string[] };
  compactionLoop?: { compactions: number; interrupts: number; status: string | null; error: string | null };
  compactionDeadline?: { interrupts: number; status: string | null; error: string | null; elapsedMs: number };
  passed: boolean;
  error?: string;
} = {
  compactionTimeoutMs: COMPACTION_TIMEOUT_MS,
  cases: [],
  passed: false,
};

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

function protocol(): ProtocolEntry[] {
  try {
    return readFileSync(logPath, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => protocolEntry(JSON.parse(line)));
  } catch {
    return [];
  }
}

function protocolEntry(value: unknown): ProtocolEntry {
  const entry = isRecord(value) ? value : {};
  const params = isRecord(entry.params) ? entry.params : {};
  return {
    method: getString(entry, "method"),
    threadId: getString(params, "threadId") ?? getString(entry, "threadId"),
    turnId: getString(params, "turnId"),
    refused: getString(entry, "refused"),
    compactionEnded: getString(entry, "compactionEnded"),
    status: getString(entry, "status"),
  };
}

/** Waits for a state of the service or of the fake Codex. */
async function waitFor<T>(label: string, read: () => T | null | undefined | false, timeoutMs = 20_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = read();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}.`);
    await new Promise((done) => setTimeout(done, 25));
  }
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
  contextCompactionTimeoutMs: COMPACTION_TIMEOUT_MS,
});
agents.on("event", (event: AgentEvent) => {
  if (event.type === "error") errors.push({ code: event.code, ...(event.agentId ? { agentId: event.agentId } : {}) });
});

try {
  await runCauseEffect(agents.initialize());

  const cases = [
    {
      name: "compaction ends by itself",
      compactionMs: 400,
      ignoreInterrupt: false,
      end: "completed",
      interrupt: false,
    },
    {
      name: "compaction runs past the start deadline",
      compactionMs: 3_000,
      ignoreInterrupt: false,
      end: "completed",
      interrupt: false,
    },
    {
      name: "deadline stops the compaction",
      compactionMs: 60_000,
      ignoreInterrupt: false,
      end: "interrupted",
      interrupt: true,
    },
    {
      name: "refused start waits for the compaction",
      compactionMs: 12_000,
      ignoreInterrupt: true,
      end: "completed",
      interrupt: true,
    },
  ] as const;

  for (const [index, entry] of cases.entries()) {
    await writeFile(controlPath, JSON.stringify(entry));
    const agent = await runCauseEffect(
      agents.createAgent({
        name: `Compaction ${index + 1}`,
        description: "Checks the queue during a compaction.",
        avatarSeed: `compaction-${index}`,
        avatarHue: null,
        initialMessage: "First message.",
      }),
    );
    // The first turn reports 90% of the context window.
    const threadId = await waitFor("the first turn to end", () => {
      const session = store.activeProviderSession(agent.id)?.externalSessionId;
      const started = protocol().some((line) => line.method === "turn/start" && line.threadId === session);
      const busy = agents
        .listQueue(agent.id)
        .deliveries.some((delivery) => ["queued", "starting", "running"].includes(delivery.status));
      return session && started && !busy ? session : null;
    });

    const receipt = await runCauseEffect(agents.sendMessage({ agentId: agent.id, text: "Second message." }));
    const deliveryId = receipt.deliveries[0]?.id;
    assert.ok(deliveryId, `${entry.name}: no delivery`);
    const compactionTurn = await waitFor("the compaction to start", () =>
      protocol().find((line) => line.method === "thread/compact/start" && line.threadId === threadId),
    );
    assert.ok(compactionTurn);
    const statusWhileCompacting = mailbox.getDelivery(deliveryId)?.delivery.status ?? "missing";

    const finalStatus = await waitFor("the second message to end", () => {
      const status = mailbox.getDelivery(deliveryId)?.delivery.status;
      return status === "completed" || status === "failed" || status === "interrupted" ? status : null;
    });
    const entries = protocol();
    const threadEntries = entries.filter((line) => line.threadId === threadId || line.refused === threadId);
    const result: CaseReport = {
      name: entry.name,
      compactionMs: entry.compactionMs,
      ignoreInterrupt: entry.ignoreInterrupt,
      threadId,
      statusWhileCompacting,
      finalStatus,
      finalError: mailbox.getDelivery(deliveryId)?.delivery.error ?? null,
      compactionEnd: entries.find((line) => line.compactionEnded && line.threadId === threadId)?.status ?? null,
      interruptSent: threadEntries.some(
        (line) => line.method === "turn/interrupt" && line.turnId?.startsWith("compact-turn-"),
      ),
      refusedStarts: threadEntries.filter((line) => line.refused === threadId).length,
      passed: false,
    };
    report.cases.push(result);
    assert.equal(result.statusWhileCompacting, "queued", `${entry.name}: the message did not wait`);
    assert.equal(result.finalStatus, "completed", `${entry.name}: ${result.finalError ?? result.finalStatus}`);
    assert.equal(result.compactionEnd, entry.end, `${entry.name}: the compaction did not end as expected`);
    assert.equal(result.interruptSent, entry.interrupt, `${entry.name}: turn/interrupt`);
    if (entry.ignoreInterrupt) assert.ok(result.refusedStarts > 0, "Codex refused no start");
    else assert.equal(result.refusedStarts, 0, `${entry.name}: Codex refused a start`);
    result.passed = true;
  }

  // Each compaction of this chat fails, and each turn grows the chat by 6% of its window, so the
  // growth rule allows a new compaction after each turn. Without a limit, each turn compacted again:
  // one such chat compacted every 19 seconds for 7 hours and used up the plan limit (upstream #5302).
  await writeFile(
    controlPath,
    JSON.stringify({ compactionMs: 200, ignoreInterrupt: false, compactionStatus: "failed", growUsage: true }),
  );
  const failing = await runCauseEffect(
    agents.createAgent({
      name: "Failed compactions",
      description: "Checks that failed compactions stop.",
      avatarSeed: "compaction-failing",
      avatarHue: null,
      initialMessage: "First message.",
    }),
  );
  const failingIdle = () =>
    !agents
      .listQueue(failing.id)
      .deliveries.some((delivery) => ["queued", "starting", "running"].includes(delivery.status));
  const failingSession = await waitFor("the first turn of the failing chat", () => {
    const session = store.activeProviderSession(failing.id)?.externalSessionId;
    return session && failingIdle() ? session : null;
  });
  for (const text of ["Second message.", "Third message.", "Fourth message.", "Fifth message."]) {
    await waitFor(
      "the failing chat to settle",
      () =>
        failingIdle() &&
        !agents
          .getRuntimeSnapshot()
          .contextStates?.some((state) => state.agentId === failing.id && state.compaction?.status === "running"),
    );
    await runCauseEffect(agents.sendMessage({ agentId: failing.id, text }));
    await waitFor("the message to end", failingIdle);
  }
  const entries = protocol();
  const failedCompactions = {
    compactions: entries.filter((line) => line.method === "thread/compact/start" && line.threadId === failingSession)
      .length,
    failed: entries.filter(
      (line) => line.compactionEnded && line.threadId === failingSession && line.status === "failed",
    ).length,
    stopNotices: errors.filter((error) => error.code === "context_compaction_stopped" && error.agentId === failing.id)
      .length,
    messages: agents.listQueue(failing.id).deliveries.map((delivery) => delivery.status),
  };
  report.failedCompactions = failedCompactions;
  assert.equal(failedCompactions.compactions, 2, "failed compactions: OpenBot did not stop after 2 failures");
  assert.equal(failedCompactions.failed, 2);
  assert.equal(failedCompactions.stopNotices, 1, "failed compactions: no single stop notice");
  assert.ok(
    failedCompactions.messages.every((status) => status === "completed"),
    "failed compactions: a message did not run",
  );

  // Each compaction completes, but the chat stays full: each turn grows it by 6% of its window. Codex
  // reports a small estimate before the compaction ends. The estimate reset the count of compactions
  // that left the chat almost full, so each turn compacted again, without a notice (upstream c858f0a42).
  await writeFile(
    controlPath,
    JSON.stringify({ compactionMs: 200, ignoreInterrupt: false, growUsage: true, estimate: true }),
  );
  const full = await runCauseEffect(
    agents.createAgent({
      name: "Full after compaction",
      description: "Checks that compactions that free no space stop.",
      avatarSeed: "compaction-full",
      avatarHue: null,
      initialMessage: "First message.",
    }),
  );
  const fullIdle = () =>
    !agents
      .listQueue(full.id)
      .deliveries.some((delivery) => ["queued", "starting", "running"].includes(delivery.status));
  const fullSession = await waitFor("the first turn of the full chat", () => {
    const session = store.activeProviderSession(full.id)?.externalSessionId;
    return session && fullIdle() ? session : null;
  });
  for (const text of ["Second message.", "Third message.", "Fourth message."]) {
    await waitFor(
      "the full chat to settle",
      () =>
        fullIdle() &&
        !agents
          .getRuntimeSnapshot()
          .contextStates?.some((state) => state.agentId === full.id && state.compaction?.status === "running"),
    );
    await runCauseEffect(agents.sendMessage({ agentId: full.id, text }));
    await waitFor("the message to end", fullIdle);
  }
  const fullEntries = protocol();
  const ineffectiveCompactions = {
    compactions: fullEntries.filter((line) => line.method === "thread/compact/start" && line.threadId === fullSession)
      .length,
    turns: fullEntries.filter((line) => line.method === "turn/start" && line.threadId === fullSession).length,
    notices: errors.filter((error) => error.code === "context_compaction_ineffective" && error.agentId === full.id)
      .length,
    messages: agents.listQueue(full.id).deliveries.map((delivery) => delivery.status),
  };
  report.ineffectiveCompactions = ineffectiveCompactions;
  assert.equal(ineffectiveCompactions.turns, 4, "ineffective compactions: not every message ran");
  assert.equal(ineffectiveCompactions.compactions, 2, "ineffective compactions: OpenBot did not stop after 2");
  assert.equal(ineffectiveCompactions.notices, 1, "ineffective compactions: one notice");

  // Codex compacts by itself after each step of one turn, and each compaction leaves the session
  // above its own limit. One upstream session compacted 559 times (upstream 63b51fa40). OpenBot stops
  // the turn at the third compaction, and the message fails with what to change.
  await writeFile(controlPath, JSON.stringify({ compactionMs: 200, ignoreInterrupt: false, loop: true }));
  const looper = await runCauseEffect(
    agents.createAgent({
      name: "Compaction loop",
      description: "Checks that a turn that compacts again and again stops.",
      avatarSeed: "compaction-loop",
      avatarHue: null,
      initialMessage: "Loop.",
    }),
  );
  const loopDelivery = await waitFor("the looping turn to end", () => {
    const delivery = agents.listQueue(looper.id).deliveries[0];
    return delivery && ["failed", "completed"].includes(delivery.status) ? delivery : null;
  });
  const loopSession = store.activeProviderSession(looper.id)?.externalSessionId;
  const loopEntries = protocol().filter((line) => line.threadId === loopSession);
  const compactionLoop = {
    compactions: loopEntries.filter((line) => line.method === "selfCompaction").length,
    interrupts: loopEntries.filter((line) => line.method === "turn/interrupt").length,
    status: loopDelivery.status,
    error: loopDelivery.error ?? null,
  };
  report.compactionLoop = compactionLoop;
  assert.equal(compactionLoop.compactions, 3, "compaction loop: not stopped at the third compaction");
  assert.equal(compactionLoop.interrupts, 1, "compaction loop: one stop");
  assert.equal(compactionLoop.status, "failed", "compaction loop: the message did not fail");
  assert.equal(
    compactionLoop.error,
    sourceText("error.agent.compactionLoopStopped", { provider: "ChatGPT" }),
    "compaction loop: the error does not say what to change",
  );

  // Codex starts a compaction inside the turn and then sends nothing. The run deadline (10 s here)
  // stops the turn, and the message fails with the plain reason (upstream 3d2f2f188).
  await writeFile(controlPath, JSON.stringify({ compactionMs: 200, ignoreInterrupt: false, stallInTurn: true }));
  const stallStarted = Date.now();
  const staller = await runCauseEffect(
    agents.createAgent({
      name: "Compaction stall",
      description: "Checks that a compaction inside a turn that hangs stops.",
      avatarSeed: "compaction-stall",
      avatarHue: null,
      initialMessage: "Stall.",
    }),
  );
  const stallDelivery = await waitFor(
    "the stalled turn to end",
    () => {
      const delivery = agents.listQueue(staller.id).deliveries[0];
      return delivery && ["failed", "completed"].includes(delivery.status) ? delivery : null;
    },
    30_000,
  );
  const stallSession = store.activeProviderSession(staller.id)?.externalSessionId;
  const compactionDeadline = {
    interrupts: protocol().filter((line) => line.threadId === stallSession && line.method === "turn/interrupt").length,
    status: stallDelivery.status,
    error: stallDelivery.error ?? null,
    elapsedMs: Date.now() - stallStarted,
  };
  report.compactionDeadline = compactionDeadline;
  assert.equal(compactionDeadline.interrupts, 1, "compaction deadline: one stop");
  assert.equal(compactionDeadline.status, "failed", "compaction deadline: the message did not fail");
  assert.equal(compactionDeadline.error, sourceText("error.agent.compactionConnectionLost"));
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
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}
