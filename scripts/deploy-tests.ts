// Every test, run beside a deploy, never before it (AGENTS.md, "Deploys and critical flows"). The deploy
// launcher starts this script in the background with the build; it never blocks or delays the deploy,
// and it has no skip flag.
//
// 1. The critical flows first, all of them: the flows the owner uses on the phone each day.
// 2. Then every E2E script that runs by itself (no dev stack, no account, no flags), and the Vitest suite.
//
// Results go to `<out>/deploy-tests.json` (rewritten after each test) and one log per test in `<out>/logs`.
// Any failure writes `<out>/FAILED` and sends the owner an urgent push through the host's control socket
// (`POST /v1/owner-alert`), so a failure is never quiet. `--critical-only` runs step 1 alone, as the
// check after a deploy does.
//
// `bun scripts/deploy-tests.ts --out=<dir> [--label=<release>] [--critical-only] [--concurrency=<n>]`
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

interface Test {
  name: string;
  critical: boolean;
  /** The flow it covers, for the owner's alert. */
  flow: string;
  /** The program, then its arguments. */
  program: string;
  args: string[];
  timeoutMs: number;
}

interface Result {
  name: string;
  flow: string;
  critical: boolean;
  status: "passed" | "failed" | "timed-out";
  exitCode: number | null;
  durationMs: number;
  log: string;
}

const argument = (name: string) =>
  process.argv.find((value) => value.startsWith(`--${name}=`))?.slice(name.length + 3) ?? null;
const outArgument = argument("out");
if (!outArgument) throw new Error("Pass --out=<dir>.");
const out: string = outArgument;
const label = argument("label") ?? "this deploy";
const criticalOnly = process.argv.includes("--critical-only");
const concurrency = Math.max(1, Number(argument("concurrency") ?? 3));
const root = join(import.meta.dir, "..");
const say = (line: string) => process.stdout.write(`${line}\n`);
const bun = process.execPath;

/**
 * The libraries and fonts the test Chromium needs on this server, which has no system copies. A
 * missing folder leaves the environment as it is.
 */
const TEST_LIBS = "/opt/openbot/test-libs";
const BROWSER_ENV: Record<string, string> = existsSync(TEST_LIBS)
  ? {
      LD_LIBRARY_PATH: [
        `${TEST_LIBS}/root/usr/lib/x86_64-linux-gnu`,
        `${TEST_LIBS}/root/lib/x86_64-linux-gnu`,
        process.env.LD_LIBRARY_PATH ?? "",
      ]
        .filter(Boolean)
        .join(":"),
      FONTCONFIG_FILE: `${TEST_LIBS}/fonts.conf`,
    }
  : {};

const e2e = (script: string, flow: string, extra: string[] = [], timeoutMs = 300_000): Test => ({
  name: script,
  critical: true,
  flow,
  program: bun,
  args: [`scripts/${script}`, ...extra],
  timeoutMs,
});

/** The flows that must never break, each with the test that drives it. */
const CRITICAL: Test[] = [
  { ...e2e("auth-api", "sign-in with a code"), args: ["run", "test:api"], name: "auth-api tests" },
  e2e("agent-dm-e2e.ts", "sending a message to an agent"),
  e2e("guardrails-smoke.ts", "tool and owner-only money approvals, and blocked actions"),
  e2e("browser-secret-host-e2e.ts", "the password and code cards"),
  e2e("team-api-legacy-clients-e2e.ts", "the password card and other answers over the phone's connection"),
  e2e("needs-you-host-e2e.ts", "browser takeover reaching the owner"),
  e2e("web-live-view-e2e.ts", "browser takeover on the phone", ["--only=phone"]),
  e2e("needs-you-ui-e2e.ts", "answering a Motion ticket on the phone"),
  {
    ...e2e("runtime-snapshot-roster", "a host with more than 100 agents"),
    name: "runtime-snapshot-roster.test.ts",
    args: ["run", "test:desktop", "--", "src/main/team-api/runtime-snapshot-roster.test.ts"],
  },
];

/**
 * An E2E script needs a dev stack, an account, a real provider or a flag when its header says so; those
 * run by hand. The rest run here.
 */
const NEEDS_SETUP = /bun run dev|--allow-mutations|--api=|signed in|real provider|Start the app|--host=|electron/iu;

function standaloneE2e(): Test[] {
  const critical = new Set(CRITICAL.map((test) => test.name));
  return readdirSync(join(root, "scripts"))
    .filter((file) => /-e2e\.ts$/u.test(file) && !critical.has(file))
    .filter((file) => {
      const head = readFileSync(join(root, "scripts", file), "utf8")
        .split("\n")
        .slice(0, 30)
        .join("\n");
      return !NEEDS_SETUP.test(head);
    })
    .sort()
    .map((file) => ({ ...e2e(file, file.replace(/-e2e\.ts$/u, "")), critical: false }));
}

const tests = criticalOnly
  ? CRITICAL
  : [
      ...CRITICAL,
      ...standaloneE2e(),
      {
        name: "vitest",
        critical: false,
        flow: "unit tests",
        program: bun,
        args: ["run", "test:desktop"],
        timeoutMs: 1_800_000,
      },
    ];

mkdirSync(join(out, "logs"), { recursive: true });
const results: Result[] = [];
const startedAt = new Date().toISOString();

function save(done: boolean): void {
  const failed = results.filter((result) => result.status !== "passed");
  writeFileSync(
    join(out, "deploy-tests.json"),
    `${JSON.stringify(
      {
        label,
        startedAt,
        done,
        criticalOnly,
        total: tests.length,
        passed: results.length - failed.length,
        failed: failed.length,
        results,
      },
      null,
      2,
    )}\n`,
  );
}

function run(test: Test): Promise<Result> {
  const log = join(out, "logs", `${test.name.replace(/[^\w.-]+/gu, "_")}.log`);
  const started = Date.now();
  return new Promise((resolve) => {
    const child = spawn(test.program, test.args, {
      cwd: root,
      env: { ...process.env, ...BROWSER_ENV, CI: "1" },
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });
    const chunks: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => chunks.push(chunk));
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      if (child.pid === undefined) return;
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        // It ended on its own.
      }
    }, test.timeoutMs);
    child.on("close", (code) => {
      clearTimeout(timer);
      writeFileSync(log, Buffer.concat(chunks));
      resolve({
        name: test.name,
        flow: test.flow,
        critical: test.critical,
        status: timedOut ? "timed-out" : code === 0 ? "passed" : "failed",
        exitCode: code,
        durationMs: Date.now() - started,
        log,
      });
    });
  });
}

async function runAll(list: Test[]): Promise<void> {
  const queue = [...list];
  await Promise.all(
    Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
      for (let test = queue.shift(); test; test = queue.shift()) {
        const result = await run(test);
        results.push(result);
        save(false);
        say(
          `${result.status === "passed" ? "PASS" : "FAIL"} ${result.name} (${Math.round(result.durationMs / 1000)} s)`,
        );
      }
    }),
  );
}

/** The owner hears of a failure on their phone, through the live host's control socket. */
function alertOwner(failed: Result[]): void {
  const critical = failed.filter((result) => result.critical);
  const named = (critical.length > 0 ? critical : failed).slice(0, 4);
  const title = critical.length > 0 ? `Critical flow failed after ${label}` : `Tests failed after ${label}`;
  const body = `${named.map((result) => result.flow).join("; ")}${failed.length > named.length ? `; ${failed.length - named.length} more` : ""}. Being fixed.`;
  const alert = spawnSync(
    "sudo",
    [
      "-n",
      "docker",
      "exec",
      "-i",
      "openbot",
      "curl",
      "-s",
      "--unix-socket",
      "/run/openbot/control.sock",
      "-X",
      "POST",
      "-H",
      "content-type: application/json",
      "--data-binary",
      "@-",
      "http://openbot/v1/owner-alert",
    ],
    { input: JSON.stringify({ title, text: body }), encoding: "utf8", timeout: 30_000 },
  );
  say(`Owner alert: ${alert.status === 0 ? alert.stdout.trim() : `not sent (${alert.stderr.trim()})`}`);
}

await runAll(CRITICAL);
if (!criticalOnly) await runAll(tests.filter((test) => !test.critical));
save(true);
const failed = results.filter((result) => result.status !== "passed");
if (failed.length > 0) {
  writeFileSync(
    join(out, "FAILED"),
    `${failed.map((result) => `${result.critical ? "critical " : ""}${result.name}`).join("\n")}\n`,
  );
  alertOwner(failed);
}
say(`${results.length - failed.length}/${results.length} passed. Report: ${join(out, "deploy-tests.json")}`);
process.exit(failed.length > 0 ? 1 : 0);
