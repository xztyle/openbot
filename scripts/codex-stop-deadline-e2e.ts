// Checks the Codex Stop fixes (upstream be190a7c0, 717d77fcc, 372d739e4). Runs the real Codex client
// on a fake Codex app-server.
// 1. A stopped turn whose command hangs: Codex never answers `turn/interrupt`. The Stop succeeds
//    after the stop deadline, the turn completes as interrupted, the next turn of that thread is
//    refused as busy, and the client asks to be replaced before the next turn.
// 2. A Stop of a turn also stops the running turn of its subagent.
// 3. A turn that ends while its subagent still runs a turn stops that subagent.
// `bun scripts/codex-stop-deadline-e2e.ts`. Writes .openbot-build/codex-stop-deadline-e2e/report.json.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Effect, Result } from "effect";
import { ProviderSessionBusyError } from "../src/backend/agent-client";
import { CodexAppServerClient } from "../src/backend/app-server-client";
import { decodeRecordResponse, decodeTurnResponse, isRecord } from "../src/backend/protocol";

const OUT = resolve(import.meta.dirname, "../.openbot-build/codex-stop-deadline-e2e");
const root = await mkdtemp(join(tmpdir(), "openbot-codex-stop-"));
const logPath = join(root, "protocol.jsonl");
const fakeCodex = join(root, "codex");
process.env.OPENBOT_FAKE_CODEX_LOG = logPath;

// Thread `hang` never ends a stopped turn. Thread `parent` and `done` start a subagent thread
// (`child-<thread>`); `done` then ends its own turn while the subagent works on. A subagent's turn
// ends when it is stopped.
const FAKE_CODEX = `#!/usr/bin/env node
const fs = require("node:fs");
const log = (entry) => fs.appendFileSync(process.env.OPENBOT_FAKE_CODEX_LOG, JSON.stringify(entry) + "\\n");
const write = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
let turns = 0;
let buffer = "";
const startTurn = (threadId) => {
  const turnId = threadId + "-turn-" + (++turns);
  write({ method: "turn/started", params: { threadId, turn: { id: turnId } } });
  return turnId;
};
const answer = (message) => {
  const params = message.params || {};
  if (message.method === "turn/start") {
    const turnId = params.threadId + "-turn-" + (turns + 1);
    write({ id: message.id, result: { turn: { id: turnId, status: "inProgress", items: [] } } });
    startTurn(params.threadId);
    if (params.threadId === "parent" || params.threadId === "done") {
      const child = "child-" + params.threadId;
      const item = { type: "collabAgentToolCall", id: "spawn-" + turnId, tool: "spawnAgent", receiverThreadIds: [child] };
      write({ method: "item/started", params: { threadId: params.threadId, turnId, item } });
      startTurn(child);
      if (params.threadId === "done")
        setTimeout(() => write({ method: "turn/completed", params: { threadId: "done", turn: { id: turnId, status: "completed" } } }), 50);
    }
    return;
  }
  if (message.method === "turn/interrupt") {
    if (params.threadId === "hang") return;
    write({ id: message.id, result: {} });
    write({ method: "turn/completed", params: { threadId: params.threadId, turn: { id: params.turnId, status: "interrupted" } } });
    return;
  }
  write({ id: message.id, result: {} });
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
      log({ method: message.method ?? null, params: message.params ?? null });
      if (message.method && message.id !== undefined) answer(message);
    }
    newline = buffer.indexOf("\\n");
  }
});
setInterval(() => {}, 1000);
`;

interface Report {
  passed: boolean;
  hungStop?: {
    stopMs: number;
    completedAs: string | null;
    nextTurnBusy: boolean;
    replaceForNextTurn: boolean;
  };
  stopReachesSubagent?: boolean;
  endedTurnStopsSubagent?: boolean;
  error?: string;
}

const report: Report = { passed: false };

function interruptsSent(threadId: string): number {
  return readFileSync(logPath, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line): { method: string | null; params: { threadId?: string } | null } => JSON.parse(line))
    .filter((entry) => entry.method === "turn/interrupt" && entry.params?.threadId === threadId).length;
}

async function waitFor(check: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return true;
    await new Promise((resolveWait) => setTimeout(resolveWait, 20));
  }
  return check();
}

const client = new CodexAppServerClient(fakeCodex, 30_000);
try {
  await writeFile(fakeCodex, FAKE_CODEX);
  await chmod(fakeCodex, 0o755);
  await writeFile(logPath, "");
  client.start();
  const completed = new Map<string, string>();
  client.on("notification", ({ method, params }) => {
    if (method !== "turn/completed" || !isRecord(params) || !isRecord(params.turn)) return;
    const { threadId } = params;
    const { status } = params.turn;
    if (typeof threadId === "string" && typeof status === "string") completed.set(threadId, status);
  });
  const run = <T>(effect: Effect.Effect<T, unknown>) => Effect.runPromise(effect);
  const startTurn = (threadId: string) =>
    run(client.request("turn/start", { threadId, input: [] }, decodeTurnResponse));

  // 1. A Stop that Codex never answers.
  const hung = await startTurn("hang");
  const stopStarted = Date.now();
  await run(client.request("turn/interrupt", { threadId: "hang", turnId: hung.turn.id }, decodeRecordResponse));
  const stopMs = Date.now() - stopStarted;
  const next = await run(Effect.result(client.request("turn/start", { threadId: "hang" }, decodeRecordResponse)));
  report.hungStop = {
    stopMs,
    completedAs: completed.get("hang") ?? null,
    nextTurnBusy: Result.isFailure(next) && next.failure.cause instanceof ProviderSessionBusyError,
    replaceForNextTurn: client.replaceForNextTurn(),
  };

  // 2. A Stop of the parent also stops its subagent.
  const parent = await startTurn("parent");
  await run(client.request("turn/interrupt", { threadId: "parent", turnId: parent.turn.id }, decodeRecordResponse));
  report.stopReachesSubagent = await waitFor(
    () => interruptsSent("child-parent") === 1 && completed.get("child-parent") === "interrupted",
    2_000,
  );

  // 3. A turn that ends while its subagent works.
  await startTurn("done");
  report.endedTurnStopsSubagent = await waitFor(
    () => completed.get("done") === "completed" && interruptsSent("child-done") === 1,
    2_000,
  );

  report.passed =
    report.hungStop.stopMs >= 9_000 &&
    report.hungStop.stopMs < 15_000 &&
    report.hungStop.completedAs === "interrupted" &&
    report.hungStop.nextTurnBusy &&
    report.hungStop.replaceForNextTurn &&
    report.stopReachesSubagent &&
    report.endedTurnStopsSubagent;
} catch (error) {
  report.error = error instanceof Error ? (error.stack ?? error.message) : String(error);
} finally {
  await Effect.runPromise(client.stop().pipe(Effect.ignore));
  mkdirSync(OUT, { recursive: true });
  writeFileSync(join(OUT, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  await rm(root, { recursive: true, force: true });
}
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
process.exit(report.passed ? 0 : 1);
