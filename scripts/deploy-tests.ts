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
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { homedir } from "node:os";
import { extname, join, normalize } from "node:path";

interface Test {
  name: string;
  critical: boolean;
  /** The flow it covers, for the owner's alert. */
  flow: string;
  /** The program, then its arguments. */
  program: string;
  args: string[];
  timeoutMs: number;
  /** What the server must give the script first: a static Storybook, or the account service's build. */
  needs?: ("storybook" | "api-build")[];
  /** Set when this server cannot give what the script needs; the script then does not run. */
  setup?: string;
}

interface Result {
  name: string;
  flow: string;
  critical: boolean;
  status: "passed" | "failed" | "timed-out" | "needs-setup";
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
 * What an E2E script needs that this server does not have, read from its header: those run by hand,
 * and the report names each one with its reason. Everything else runs here.
 */
const NEEDS_SETUP: [RegExp, string][] = [
  [/bun run dev|Start the app|--allow-mutations|--host=|--api=/iu, "a running dev stack or app"],
  [/signed[ -]in|real provider|a real account/iu, "a signed-in provider account"],
  [/real `codex app-server`|real Codex/u, "the Codex CLI"],
  [/OPENBOT_OPENCODE_PATH|<opencode binary>/u, "the OpenCode CLI"],
  [/Windows only/u, "Windows"],
  [/STRIPE_SECRET_KEY|--print-user-ids/u, "a Stripe test-mode key"],
  [/\belectron\b/iu, "Electron with a display"],
];

/** The newest Playwright headless Chromium, for scripts that take `--browser-executable`. */
function headlessChromium(): string | null {
  const cache = join(homedir(), ".cache", "ms-playwright");
  if (!existsSync(cache)) return null;
  const folder = readdirSync(cache)
    .filter((name) => name.startsWith("chromium_headless_shell-"))
    .sort()
    .at(-1);
  const path = folder ? join(cache, folder, "chrome-headless-shell-linux64", "chrome-headless-shell") : null;
  return path && existsSync(path) ? path : null;
}
const browserExecutable = headlessChromium();

function standaloneE2e(): Test[] {
  const critical = new Set(CRITICAL.map((test) => test.name));
  return readdirSync(join(root, "scripts"))
    .filter((file) => /-e2e\.ts$/u.test(file) && !critical.has(file))
    .sort()
    .map((file) => {
      const source = readFileSync(join(root, "scripts", file), "utf8");
      const head = source.split("\n").slice(0, 30).join("\n");
      // A script that needs longer than the 20 minutes of the others says so in its header:
      // `deploy-tests timeout: 3600s`.
      const seconds = Number(/deploy-tests timeout: (\d+)s/u.exec(source.slice(0, 4_000))?.[1] ?? 0);
      const test: Test = {
        ...e2e(file, file.replace(/-e2e\.ts$/u, ""), [], seconds > 0 ? seconds * 1_000 : 1_200_000),
        critical: false,
      };
      const setup = NEEDS_SETUP.find(([pattern]) => pattern.test(head));
      if (setup) return { ...test, setup: setup[1] };
      // A script that needs Node's inspector or `node:sqlite` says how it runs.
      if (head.includes(`node --import tsx scripts/${file}`))
        Object.assign(test, {
          program: process.env.OPENBOT_NODE ?? "node",
          args: ["--import", "tsx", `scripts/${file}`],
        });
      const needs: Test["needs"] = [];
      if (source.includes("--storybook=")) needs.push("storybook");
      if (source.includes("bun run api:build")) needs.push("api-build");
      // A script that compares a run before and after a change keeps each in its own folder.
      if (/--phase=before( or --phase=|\|)after/u.test(source)) test.args.push("--phase=after");
      if (browserExecutable && source.includes("browser-executable"))
        test.args.push(`--browser-executable=${browserExecutable}`);
      return needs.length > 0 ? { ...test, needs } : test;
    });
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
/** A script that this server cannot run is listed with its reason, and is no failure. */
const isFailure = (result: Result) => result.status !== "passed" && result.status !== "needs-setup";
const results: Result[] = [];
const startedAt = new Date().toISOString();

function save(done: boolean): void {
  const failed = results.filter(isFailure);
  writeFileSync(
    join(out, "deploy-tests.json"),
    `${JSON.stringify(
      {
        label,
        startedAt,
        done,
        criticalOnly,
        total: tests.length,
        passed: results.filter((result) => result.status === "passed").length,
        failed: failed.length,
        needsSetup: results.filter((result) => result.status === "needs-setup").length,
        results,
      },
      null,
      2,
    )}\n`,
  );
}

const MIME: Record<string, string> = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".woff2": "font/woff2",
};

/** Serves a folder on a free local port; answers its URL. The server ends with this process. */
function serveFolder(folder: string): Promise<string> {
  const server = createServer((request, response) => {
    const path = decodeURIComponent(new URL(request.url ?? "/", "http://localhost").pathname);
    let file = normalize(join(folder, path));
    if (!file.startsWith(folder)) return void response.writeHead(403).end();
    if (existsSync(file) && statSync(file).isDirectory()) file = join(file, "index.html");
    if (!existsSync(file)) return void response.writeHead(404).end();
    response.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream" });
    response.end(readFileSync(file));
  });
  server.unref();
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve(typeof address === "object" && address ? `http://127.0.0.1:${address.port}` : "");
    }),
  );
}

/** Runs one command to its end; its output goes to `log`. Answers whether it succeeded. */
function build(args: string[], log: string): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn(bun, args, { cwd: root, env: { ...process.env, CI: "1" }, stdio: ["ignore", "pipe", "pipe"] });
    const chunks: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.on("close", (code) => {
      writeFileSync(log, Buffer.concat(chunks));
      resolve(code === 0);
    });
  });
}

/** Each build that scripts need, made once: the arguments it gives them, or why it failed. */
const prepared = new Map<string, Promise<{ args: string[] } | { error: string }>>();
function prepare(need: NonNullable<Test["needs"]>[number]): Promise<{ args: string[] } | { error: string }> {
  const known = prepared.get(need);
  if (known) return known;
  const log = join(out, "logs", `prepare-${need}.log`);
  const made =
    need === "storybook"
      ? (async () => {
          const folder = join(root, ".openbot-build", "deploy-tests-storybook");
          if (!(await build(["run", "build-storybook", "--", "-o", folder, "--quiet"], log)))
            return { error: `The Storybook build failed: ${log}` };
          return { args: [`--storybook=${await serveFolder(folder)}`] };
        })()
      : build(["run", "api:build"], log).then((built) =>
          built ? { args: [] } : { error: `The account service build failed: ${log}` },
        );
  prepared.set(need, made);
  return made;
}

async function run(test: Test): Promise<Result> {
  const log = join(out, "logs", `${test.name.replace(/[^\w.-]+/gu, "_")}.log`);
  const started = Date.now();
  const result = (status: Result["status"], text: string): Result => {
    writeFileSync(log, `${text}\n`);
    const { name, flow, critical } = test;
    return { name, flow, critical, status, exitCode: null, durationMs: Date.now() - started, log };
  };
  if (test.setup) return result("needs-setup", `Not run on this server: it needs ${test.setup}.`);
  const args = [...test.args];
  for (const need of test.needs ?? []) {
    const made = await prepare(need);
    if ("error" in made) return result("failed", made.error);
    args.push(...made.args);
  }
  return new Promise((resolve) => {
    const child = spawn(test.program, args, {
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
          `${result.status === "passed" ? "PASS" : result.status === "needs-setup" ? "SETUP" : "FAIL"} ${result.name} (${Math.round(result.durationMs / 1000)} s)`,
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
const failed = results.filter(isFailure);
if (failed.length > 0) {
  writeFileSync(
    join(out, "FAILED"),
    `${failed.map((result) => `${result.critical ? "critical " : ""}${result.name}`).join("\n")}\n`,
  );
  alertOwner(failed);
}
say(
  `${results.filter((result) => result.status === "passed").length}/${results.length} passed, ${failed.length} failed. Report: ${join(out, "deploy-tests.json")}`,
);
process.exit(failed.length > 0 ? 1 : 0);
