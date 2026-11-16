// Checks the debug routes of the server control socket (`src/main/server-debug-profiler.ts`) with the
// real `node:inspector` of this process. A busy function runs while a CPU profile records, and the
// profile must name it. A second profile while one runs is refused. The stall recorder must keep the
// stack of a long task that blocks the main thread. No app, database or network is started.
//
// Run: node --import tsx scripts/server-debug-profiler-e2e.ts (Bun has no inspector sessions).
// Writes .openbot-build/server-debug-profiler-e2e/report.json and exits non-zero on a failure.
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServerDebugRoutes } from "../src/main/server-debug-profiler";

const OUT = resolve(import.meta.dirname, "../.openbot-build/server-debug-profiler-e2e");
const root = await mkdtemp(join(tmpdir(), "openbot-debug-profiler-"));
const logs: string[] = [];
const routes = createServerDebugRoutes({ userDataPath: root, log: (message) => logs.push(message) });
const report: { checks: string[]; logs: string[]; passed: boolean; error?: string } = {
  checks: [],
  logs,
  passed: false,
};

function busyProfilerTarget(milliseconds: number): number {
  const end = Date.now() + milliseconds;
  let total = 0;
  while (Date.now() < end) total += Math.sqrt(Math.random());
  return total;
}

function blockingStallTarget(milliseconds: number): number {
  return busyProfilerTarget(milliseconds);
}

const pause = (milliseconds: number) => new Promise((done) => setTimeout(done, milliseconds));

try {
  assert.equal(await routes.route("GET", "/v1/other", ""), null, "Other paths are not debug routes.");
  const wrongMethod = await routes.route("GET", "/v1/debug/cpu-profile", "");
  assert.equal(wrongMethod?.status, 405);
  const tooLong = await routes.route("POST", "/v1/debug/cpu-profile", "seconds=121");
  assert.equal(tooLong?.status, 400, "A profile longer than 120 s is refused.");
  report.checks.push("bad requests are refused");

  const running = routes.route("POST", "/v1/debug/cpu-profile", JSON.stringify({ seconds: 2 }));
  await pause(200);
  const second = await routes.route("POST", "/v1/debug/cpu-profile", "seconds=1");
  assert.equal(second?.status, 409, "One profile runs at a time.");
  report.checks.push("a second profile waits for the first");
  // Ticks of busy work while the profile records.
  for (let index = 0; index < 8; index += 1) {
    busyProfilerTarget(100);
    await pause(10);
  }
  const answer = await running;
  assert.equal(answer?.status, 200, JSON.stringify(answer));
  const path = String(answer?.lines.path);
  assert.ok(path.startsWith(join(root, "debug-profiles")), "The profile is in the userData folder.");
  const profile: { nodes: { callFrame: { functionName: string } }[]; samples: number[] } = JSON.parse(
    readFileSync(path, "utf8"),
  );
  assert.ok(profile.samples.length > 500, `A 1 ms interval gives many samples (${profile.samples.length}).`);
  assert.ok(
    profile.nodes.some((node) => node.callFrame.functionName === "busyProfilerTarget"),
    "The profile names the busy function.",
  );
  report.checks.push(`the profile names the busy function (${profile.samples.length} samples)`);

  const watch = await routes.route("POST", "/v1/debug/stall-watch", "seconds=30&threshold_ms=100");
  assert.equal(watch?.status, 200, JSON.stringify(watch));
  const again = await routes.route("POST", "/v1/debug/stall-watch", "seconds=30");
  assert.equal(again?.status, 409, "One stall recorder runs at a time.");
  // The worker connects to this thread's inspector before it watches.
  await pause(500);
  blockingStallTarget(400);
  let stalls: { blockedMs: number; frames: { functionName: string }[] }[] = [];
  for (let attempt = 0; attempt < 100 && stalls.length === 0; attempt += 1) {
    await pause(20);
    stalls = JSON.parse((await routes.route("GET", "/v1/debug/stalls", ""))?.body ?? "{}").stalls ?? [];
  }
  const stall = stalls[0];
  assert.ok(stall, "The recorder keeps the stall.");
  assert.ok(stall.blockedMs >= 300, `The stall lasted the whole long task (${stall.blockedMs} ms).`);
  const names = stall.frames.map((frame) => frame.functionName);
  assert.ok(
    names.includes("busyProfilerTarget") && names.includes("blockingStallTarget"),
    `The stack names the long task: ${names.join(" < ")}`,
  );
  report.checks.push(`the stall recorder keeps the stack (${stall.blockedMs} ms: ${names.slice(0, 3).join(" < ")})`);
  const stopped = await routes.route("POST", "/v1/debug/stall-watch", "stop=1");
  assert.equal(stopped?.lines.stopped, "yes");
  const state = JSON.parse((await routes.route("GET", "/v1/debug/stalls", ""))?.body ?? "{}");
  assert.equal(state.watching, false);
  report.checks.push("the stall recorder stops");

  // The folder keeps the newest profiles only.
  for (let index = 0; index < 7; index += 1) {
    const short = await routes.route("POST", "/v1/debug/cpu-profile", "seconds=1");
    assert.equal(short?.status, 200);
  }
  const kept = (await readdir(join(root, "debug-profiles"))).filter((name) => name.endsWith(".cpuprofile"));
  assert.equal(kept.length, 6, "The folder keeps six profiles.");
  report.checks.push("the folder keeps the newest six profiles");
  report.passed = true;
} catch (error) {
  report.error = error instanceof Error ? (error.stack ?? error.message) : String(error);
  process.exitCode = 1;
} finally {
  routes.close();
  mkdirSync(OUT, { recursive: true });
  writeFileSync(join(OUT, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  await rm(root, { recursive: true, force: true });
  for (const check of report.checks) process.stdout.write(`PASS ${check}\n`);
  process.stdout.write(`${report.passed ? "PASS" : "FAIL"} ${join(OUT, "report.json")}\n`);
  if (report.error) process.stdout.write(`${report.error}\n`);
}
