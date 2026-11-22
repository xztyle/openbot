// A Claude agent's MCP servers can carry tokens in their headers. The real Claude Agent SDK starts a
// stand-in Claude executable that records its arguments and environment, and the check is that:
// 1. no header token is on the command line, which every process of the user reads in /proc;
// 2. the servers come in a 0600 file that `--mcp-config` names, and that file is gone after the stop;
// 3. on a server, a variable of the operator's environment that no agent needs does not reach Claude.
// `bun run test:claude:mcp-config-secrecy`. Writes .openbot-build/claude-mcp-config-secrecy-e2e/report.json.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { McpServerConfig } from "@openbot/contracts/ipc";
import { ClaudeAgentClient } from "../src/backend/claude-client";
import { runCauseEffect } from "../src/backend/effect-boundary";

const OUT = resolve(import.meta.dirname, "../.openbot-build/claude-mcp-config-secrecy-e2e");
const HEADER_SECRET = "header-secret-5e1b77";
const OPERATOR_SECRET = "operator-secret-90ac12";
const report: { passed: boolean; checks: string[]; error?: string } = { passed: false, checks: [] };

const root = await mkdtemp(join(tmpdir(), "openbot-claude-mcp-secrecy-e2e-"));
let client: ClaudeAgentClient | null = null;
let passed = false;

try {
  process.env.OPENBOT_SERVER = "1";
  process.env.STRIPE_SECRET_KEY = OPERATOR_SECRET;
  const recorded = join(root, "start.json");
  const executable = join(root, "claude");
  // The stand-in records what it got, with the config file as it is at the start, then waits.
  await writeFile(
    executable,
    `#!${process.execPath}
const fs = require("node:fs");
const args = process.argv.slice(2);
const files = [];
args.forEach((arg, index) => {
  if (args[index - 1] !== "--mcp-config" || arg.startsWith("{")) return;
  files.push({ path: arg, mode: fs.statSync(arg).mode & 0o777, text: fs.readFileSync(arg, "utf8") });
});
fs.writeFileSync(${JSON.stringify(`${recorded}.tmp`)}, JSON.stringify({ args, env: process.env, files }));
fs.renameSync(${JSON.stringify(`${recorded}.tmp`)}, ${JSON.stringify(recorded)});
process.stdin.resume();
`,
  );
  await chmod(executable, 0o755);
  const workspace = join(root, "workspace");
  const state = join(root, "state");
  await mkdir(workspace);
  const server: McpServerConfig = {
    id: "mcp-1",
    name: "board",
    transport: "http",
    enabled: true,
    command: "",
    args: [],
    env: [],
    envPassthrough: [],
    workingDirectory: "",
    url: "http://127.0.0.1:9/mcp",
    headers: [{ key: "Authorization", value: `Bearer ${HEADER_SECRET}` }],
  };

  client = new ClaudeAgentClient(
    { executable, version: "2.1.302", source: "system" },
    undefined,
    undefined,
    undefined,
    () => [server],
    undefined,
    undefined,
    undefined,
    state,
  );
  client.start();
  await runCauseEffect(client.request("thread/start", { cwd: workspace, persistSession: false }, (value) => value));

  const start = await new Promise<{
    args: string[];
    env: Record<string, string>;
    files: { path: string; mode: number; text: string }[];
  }>((done, fail) => {
    const deadline = Date.now() + 10_000;
    const poll = () =>
      readFile(recorded, "utf8").then(
        (text) => done(JSON.parse(text)),
        () => (Date.now() > deadline ? fail(new Error("The Claude process did not start.")) : setTimeout(poll, 50)),
      );
    poll();
  });

  assert.ok(!start.args.join(" ").includes(HEADER_SECRET), "No MCP header token is on the command line.");
  report.checks.push("no header token in argv");
  const file = start.files[0];
  assert.ok(file, "A --mcp-config file names the servers.");
  assert.equal(file.mode, 0o600, "Only the user can read the MCP config file.");
  assert.ok(file.text.includes(HEADER_SECRET) && file.text.includes('"board"'), "The file has the board server.");
  report.checks.push("servers in a 0600 --mcp-config file");
  assert.ok(
    !start.args.some((arg) => arg.startsWith("{") && arg.includes('"board"')),
    "The board server is not also passed inline.",
  );
  report.checks.push("no inline copy of the servers");
  assert.equal(start.env.STRIPE_SECRET_KEY, undefined, "An operator variable no agent needs does not reach Claude.");
  assert.equal(start.env.OPENBOT_SERVER, "1");
  report.checks.push("server environment allowlist applied");

  await runCauseEffect(client.stop());
  client = null;
  const deadline = Date.now() + 5_000;
  while (existsSync(file.path) && Date.now() < deadline) await new Promise((done) => setTimeout(done, 50));
  assert.ok(!existsSync(file.path), "The MCP config file is removed when the process ends.");
  report.checks.push("config file removed");
  passed = true;
} catch (error) {
  report.error = error instanceof Error ? error.message : String(error);
} finally {
  if (client) await runCauseEffect(client.stop()).catch(() => undefined);
  await rm(root, { recursive: true, force: true });
}

report.passed = passed;
await mkdir(OUT, { recursive: true });
await writeFile(join(OUT, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
process.exit(passed ? 0 : 1);
