// The agent jail on a Linux server (src/backend/agent-jail.ts): a fake server home with two agents,
// two spaces, main's profile, a keyring and a runtime folder, and a process of "main" with a secret
// in its environment. One probe script runs three times:
// 1. unjailed, to show what an agent reaches today: the other agent's key, the other space, the
//    database and main's environment;
// 2. in the jail that `AgentJail` plans for agent A, started by the launcher;
// 3. through the real Claude CLI and `ClaudeAgentClient`, with a fake model that has the Bash tool
//    run the probe, and a stdio MCP server that the CLI starts and that probes too.
// In the jail the probe must still do its work (its own key, its workspace, its space, git, node,
// python, the toolchains of the home, a broker socket, the loopback network), read the workspace of a
// teammate in its space, and reach nothing else.
// Needs Linux with Landlock 3 and python3. `bun scripts/agent-jail-e2e.ts`.
// Writes .openbot-build/agent-jail-e2e/report.json.
import assert from "node:assert/strict";
import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer as createHttpServer, type Server } from "node:http";
import { createServer as createSocketServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { McpServerConfig } from "@openbot/contracts/ipc";
import { AgentJail, type AgentJailHost } from "../src/backend/agent-jail";
import { ClaudeAgentClient } from "../src/backend/claude-client";
import { runCauseEffect } from "../src/backend/effect-boundary";
import { type AppServerNotification, getRecord, getString } from "../src/backend/protocol";

const OUT = resolve(import.meta.dirname, "../.openbot-build/agent-jail-e2e");
// Not in /tmp: the jail gives /tmp to every agent, so a fake server there would be inside it.
const root = join(OUT, "root");
const home = join(root, "home");
const userData = join(home, ".config", "OpenBot");
const openbotRoot = join(home, "OpenBot");
const runtime = join(root, "run-openbot");
const workspace = join(openbotRoot, "Agents", "agent-a");
const otherWorkspace = join(openbotRoot, "Agents", "agent-b");
// Agent C is in agent A's space, and agent B is in another one.
const teammateWorkspace = join(openbotRoot, "Agents", "agent-c");
const ownSpace = join(openbotRoot, "Spaces", "one", "Shared");
const otherSpace = join(openbotRoot, "Spaces", "two", "Shared");
const providerHome = join(home, ".claude");
const MAIN_SECRET = "main-secret-6c1f0e";
const CLAUDE_CLI = resolve(import.meta.dirname, "../node_modules/@anthropic-ai/claude-agent-sdk-linux-x64/claude");

const report: {
  passed: boolean;
  landlock?: boolean;
  unjailed?: Record<string, string>;
  jailed?: Record<string, string>;
  claude?: Record<string, string>;
  mcpServer?: Record<string, string>;
  error?: string;
} = { passed: false };

/** What a jailed agent must reach, and what it must not. */
const EXPECTED: Record<string, "ok" | "no"> = {
  own_key: "ok",
  shared_key: "ok",
  workspace_write: "ok",
  own_space: "ok",
  provider_signin: "ok",
  downloads: "ok",
  git: "ok",
  node: "ok",
  python: "ok",
  home_toolchain: "ok",
  home_config: "ok",
  home_write: "ok",
  temporary: "ok",
  broker_socket: "ok",
  loopback_http: "ok",
  self_environ: "ok",
  teammate_read: "ok",
  teammate_write: "no",
  other_key: "no",
  other_workspace: "no",
  other_space: "no",
  database: "no",
  profile_list: "no",
  keyring_password: "no",
  keyring: "no",
  ssh: "no",
  real_claude_json: "no",
  runtime_list: "no",
  runtime_file: "no",
  main_environ: "no",
  main_signal: "no",
  pid1_environ: "no",
};
/** What the same probe reaches without the jail: the gap the jail closes. */
const OPEN_UNJAILED = ["other_key", "other_workspace", "other_space", "database", "keyring_password", "main_environ"];

function probeScript(mainPid: number, brokerSocket: string, httpUrl: string, out: string): string {
  const check = (name: string, command: string) =>
    `if ( ${command} ) >/dev/null 2>&1; then echo ${name}=ok; else echo ${name}=no; fi`;
  return [
    "#!/bin/bash",
    `exec > ${JSON.stringify(out)} 2>/dev/null`,
    check("own_key", `grep -q a-key ${userData}/agent-api-keys/agent-a/KEY_A`),
    check("shared_key", `grep -q shared-key ${userData}/agent-api-keys/_shared/SHARED_KEY`),
    check("workspace_write", `echo x > ${workspace}/written.txt && grep -q x ${workspace}/written.txt`),
    check("own_space", `echo y > ${ownSpace}/note.txt && grep -q y ${ownSpace}/note.txt`),
    check("provider_signin", `grep -q token ${providerHome}/.credentials.json`),
    check("downloads", `grep -q file ${openbotRoot}/Downloads/report.txt`),
    check(
      "git",
      `cd ${workspace} && git init -q && git -c user.name=a -c user.email=a@b add . && git -c user.name=a -c user.email=a@b commit -qm start`,
    ),
    check("node", `test "$(${process.execPath} -e 'console.log(6*7)')" = 42`),
    check("python", `test "$(python3 -c 'print(6*7)')" = 42`),
    check("home_toolchain", `test "$("$HOME/.cargo/bin/tool")" = tool-ok`),
    check("home_config", `grep -q shared "$HOME/.config/tool-settings/settings.ini"`),
    check("home_write", `echo z > "$HOME/.agent-note" && grep -q z "$HOME/.agent-note"`),
    check("temporary", `f=$(mktemp) && echo t > "$f" && grep -q t "$f"`),
    check(
      "broker_socket",
      `python3 -c "import socket;s=socket.socket(socket.AF_UNIX);s.connect('${brokerSocket}');assert s.recv(4)==b'pong'"`,
    ),
    check("loopback_http", `curl -sf ${httpUrl} | grep -q motion-ok`),
    check("self_environ", "grep -qa HOME= /proc/self/environ"),
    check("teammate_read", `grep -q teammate ${teammateWorkspace}/notes.txt`),
    check("teammate_write", `echo w >> ${teammateWorkspace}/notes.txt`),
    check("other_key", `cat ${userData}/agent-api-keys/agent-b/KEY_B`),
    check("other_workspace", `cat ${otherWorkspace}/secret.txt`),
    check("other_space", `cat ${otherSpace}/secret.txt`),
    check("database", `cat ${userData}/openbot.db`),
    check("profile_list", `ls ${userData}`),
    check("keyring_password", `cat ${home}/.config/openbot-container/keyring-password`),
    check("keyring", `cat ${home}/.local/share/keyrings/login.keyring`),
    check("ssh", `cat ${home}/.ssh/id_ed25519`),
    check("real_claude_json", `cat ${home}/.claude.json`),
    check("runtime_list", `ls ${runtime}`),
    check("runtime_file", `cat ${runtime}/keyring/control`),
    check("main_environ", `grep -qa ${MAIN_SECRET} /proc/${mainPid}/environ`),
    check("main_signal", `kill -0 ${mainPid}`),
    check("pid1_environ", "cat /proc/1/environ"),
    "",
  ].join("\n");
}

async function file(path: string, text: string): Promise<void> {
  await mkdir(resolve(path, ".."), { recursive: true, mode: 0o700 });
  await writeFile(path, text, { mode: 0o600 });
}

async function makeServer(): Promise<void> {
  await rm(root, { recursive: true, force: true });
  await file(join(userData, "agent-api-keys", "agent-a", "KEY_A"), "a-key");
  await file(join(userData, "agent-api-keys", "agent-b", "KEY_B"), "b-key");
  await file(join(userData, "agent-api-keys", "_shared", "SHARED_KEY"), "shared-key");
  await file(join(userData, "openbot.db"), "database");
  await mkdir(join(userData, "provider-runtimes"), { recursive: true });
  await file(join(home, ".config", "openbot-container", "keyring-password"), "password");
  await file(join(home, ".config", "tool-settings", "settings.ini"), "shared settings");
  await file(join(home, ".local", "share", "keyrings", "login.keyring"), "keyring");
  await file(join(home, ".ssh", "id_ed25519"), "ssh key");
  await file(join(home, ".claude.json"), '{"numStartups":1}');
  await file(join(providerHome, ".credentials.json"), '{"token":"provider"}');
  await file(join(home, ".cargo", "bin", "tool"), "#!/bin/sh\necho tool-ok\n");
  await chmod(join(home, ".cargo", "bin", "tool"), 0o755);
  await file(join(otherWorkspace, "secret.txt"), "other workspace");
  await file(join(teammateWorkspace, "notes.txt"), "teammate notes");
  await file(join(otherSpace, "secret.txt"), "other space");
  await mkdir(workspace, { recursive: true });
  await mkdir(ownSpace, { recursive: true });
  await file(join(openbotRoot, "Downloads", "report.txt"), "file");
  await file(join(runtime, "keyring", "control"), "keyring control");
}

function parse(text: string): Record<string, string> {
  return Object.fromEntries(
    text
      .split("\n")
      .filter((line) => line.includes("="))
      .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]),
  );
}

function assertJailed(name: string, results: Record<string, string>): void {
  for (const [check, expected] of Object.entries(EXPECTED))
    assert.equal(results[check], expected, `${name}: ${check} should be ${expected}`);
}

function run(command: string, args: string[], env: NodeJS.ProcessEnv): Promise<number | null> {
  return new Promise((done, fail) => {
    const child = spawn(command, args, { env, stdio: ["ignore", "ignore", "inherit"] });
    child.once("error", fail);
    child.once("exit", done);
  });
}

/** The fake Anthropic API: the first agent request runs the probe in Bash, the next one ends the turn. */
function fakeModel(command: string, toolResults: string[]) {
  const server = createHttpServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", () => {
      if (request.url?.startsWith("/v1/messages/count_tokens")) {
        response.writeHead(200, { "content-type": "application/json" }).end('{"input_tokens":1}');
        return;
      }
      if (!request.url?.startsWith("/v1/messages")) {
        response.writeHead(404).end();
        return;
      }
      const parsed = JSON.parse(body || "{}");
      const tools: { name?: string }[] = parsed.tools ?? [];
      const last = parsed.messages?.at(-1);
      const results = Array.isArray(last?.content)
        ? last.content.filter((part: { type?: string }) => part.type === "tool_result")
        : [];
      for (const result of results) toolResults.push(JSON.stringify(result.content));
      const runTool = tools.some((tool) => tool.name === "Bash") && results.length === 0;
      const block = runTool
        ? { type: "tool_use", id: "toolu_probe", name: "Bash", input: {} }
        : { type: "text", text: "" };
      const delta = runTool
        ? { type: "input_json_delta", partial_json: JSON.stringify({ command, description: "Probe the jail" }) }
        : { type: "text_delta", text: "Done." };
      const events = [
        {
          type: "message_start",
          message: {
            id: `msg_${Date.now()}`,
            type: "message",
            role: "assistant",
            model: parsed.model,
            content: [],
            stop_reason: null,
            usage: { input_tokens: 1, output_tokens: 1 },
          },
        },
        { type: "content_block_start", index: 0, content_block: block },
        { type: "content_block_delta", index: 0, delta },
        { type: "content_block_stop", index: 0 },
        {
          type: "message_delta",
          delta: { stop_reason: runTool ? "tool_use" : "end_turn" },
          usage: { output_tokens: 1 },
        },
        { type: "message_stop" },
      ];
      response.writeHead(200, { "content-type": "text/event-stream" });
      for (const event of events) response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
      response.end();
    });
  });
  return listen(server);
}

function listen(server: Server): Promise<{ url: string; close: () => void }> {
  return new Promise((done) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("No port.");
      done({ url: `http://127.0.0.1:${address.port}`, close: () => server.close() });
    });
  });
}

/** A stdio MCP server that the CLI starts in its jail: it writes what it reaches, then answers the handshake. */
const MCP_SERVER = `
const fs = require("node:fs");
const [out, own, other] = process.argv.slice(2);
const reach = (path) => { try { fs.readFileSync(path); return "ok"; } catch { return "no"; } };
fs.writeFileSync(out, "own_key=" + reach(own) + "\\nother_key=" + reach(other) + "\\n");
let buffer = "";
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let index;
  while ((index = buffer.indexOf("\\n")) >= 0) {
    const line = buffer.slice(0, index);
    buffer = buffer.slice(index + 1);
    if (!line.trim()) continue;
    const message = JSON.parse(line);
    if (message.id === undefined) continue;
    const result = message.method === "initialize"
      ? { protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "probe", version: "1" } }
      : message.method === "tools/list" ? { tools: [] } : {};
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }) + "\\n");
  }
});
`;

const children: ChildProcess[] = [];
const servers: { close: () => void }[] = [];
let brokersFolder: string | null = null;
let client: ClaudeAgentClient | null = null;
let passed = false;

try {
  process.env.OPENBOT_SERVER = "1";
  await makeServer();
  const main = spawn("sleep", ["300"], { env: { ...process.env, MAIN_SECRET }, stdio: "ignore" });
  children.push(main);
  const mainPid = main.pid ?? 0;
  // A UNIX socket path holds at most 107 bytes, and a checkout's path can be longer than that. The
  // jail does not limit socket connections, so the socket's folder can be anywhere.
  const brokers = await mkdtemp(join(tmpdir(), "openbot-jail-brokers-"));
  brokersFolder = brokers;
  const brokerSocket = join(brokers, "appctl.sock");
  const broker = createSocketServer((socket) => socket.end("pong"));
  await new Promise<void>((done) => broker.listen(brokerSocket, done));
  servers.push(broker);
  const motion = await listen(createHttpServer((_request, response) => response.end("motion-ok")));
  servers.push(motion);

  const host: AgentJailHost = {
    python: "/usr/bin/python3",
    launcher: resolve(import.meta.dirname, "../resources/agent-runtime/agent-jail.py"),
    home,
    userDataPath: userData,
    openbotRoot,
    apiKeysRoot: join(userData, "agent-api-keys"),
    jailRoot: join(userData, "agent-jail"),
    downloadsRoot: join(openbotRoot, "Downloads"),
    runtimeDirectory: runtime,
    providers: new Set(["claude"]),
    strict: true,
  };
  const jail = new AgentJail(host);
  report.landlock = await jail.available();
  assert.ok(report.landlock, "This machine has Landlock 3 and python3.");

  const probe = join(workspace, "probe.sh");
  const write = async (out: string) => {
    await writeFile(probe, probeScript(mainPid, brokerSocket, motion.url, out), { mode: 0o700 });
  };

  // 1. Unjailed.
  const unjailedOut = join(root, "unjailed.txt");
  await write(unjailedOut);
  await run("/bin/bash", [probe], { ...process.env, HOME: home });
  report.unjailed = parse(await readFile(unjailedOut, "utf8"));
  for (const check of OPEN_UNJAILED) assert.equal(report.unjailed[check], "ok", `unjailed: ${check} is reachable`);

  // 2. The launcher, with the plan of agent A.
  const jailedOut = join(workspace, "jailed.txt");
  await write(jailedOut);
  const plan = await jail.prepare({
    agentId: "agent-a",
    cwd: workspace,
    writableRoots: [workspace, ownSpace],
    readRoots: [teammateWorkspace],
    providerHome,
    executable: "/bin/bash",
    readFiles: [],
    linkFolders: [],
    commands: [],
    environment: { ...process.env, HOME: home, DBUS_SESSION_BUS_ADDRESS: "unix:path=/tmp/bus" },
  });
  assert.ok(plan, "The jail is planned.");
  assert.equal(plan.environment.DBUS_SESSION_BUS_ADDRESS, undefined, "The jail takes the session bus away.");
  const target = plan.wrap("/bin/bash", [probe]);
  assert.equal(await run(target.command, target.args, plan.environment), 0);
  report.jailed = parse(await readFile(jailedOut, "utf8"));
  assertJailed("jailed", report.jailed);

  // 3. The real Claude CLI, jailed by `ClaudeAgentClient`, runs the probe with its Bash tool.
  const claudeOut = join(workspace, "claude.txt");
  await write(claudeOut);
  const toolResults: string[] = [];
  const model = await fakeModel(`bash ${probe}`, toolResults);
  servers.push(model);
  const mcpScript = join(home, "tools", "probe-mcp.cjs");
  await file(mcpScript, MCP_SERVER);
  const mcpOut = join(workspace, "mcp.txt");
  const mcpServer: McpServerConfig = {
    id: "probe",
    name: "probe",
    transport: "stdio",
    enabled: true,
    command: process.execPath,
    args: [
      mcpScript,
      mcpOut,
      join(userData, "agent-api-keys", "agent-a", "KEY_A"),
      join(userData, "agent-api-keys", "agent-b", "KEY_B"),
    ],
    env: [],
    envPassthrough: [],
    workingDirectory: "",
    url: "",
    headers: [],
  };
  client = new ClaudeAgentClient(
    {
      executable: CLAUDE_CLI,
      version: execFileSync(CLAUDE_CLI, ["--version"], { encoding: "utf8" }).split(" ")[0] ?? "2.1.309",
      source: "system",
    },
    undefined,
    undefined,
    60_000,
    () => [mcpServer],
    undefined,
    undefined,
    undefined,
    join(userData, "provider-state"),
    () => ({
      ANTHROPIC_BASE_URL: model.url,
      ANTHROPIC_API_KEY: "sk-ant-e2e",
      CLAUDE_CONFIG_DIR: providerHome,
      DISABLE_AUTOUPDATER: "1",
    }),
    undefined,
    undefined,
    () => false,
    jail,
  );
  let completed: () => void = () => undefined;
  const done = new Promise<void>((resolveDone) => {
    completed = resolveDone;
  });
  const failures: string[] = [];
  client.on("notification", (notification: AppServerNotification) => {
    if (notification.method === "error") failures.push(JSON.stringify(notification.params));
    if (notification.method === "turn/completed") completed();
  });
  client.start();
  const threadId = await runCauseEffect(
    client.request(
      "thread/start",
      {
        cwd: workspace,
        runtimeWorkspaceRoots: [workspace, ownSpace],
        persistSession: false,
        model: "claude-haiku-4-5",
        jailAgentId: "agent-a",
        jailReadRoots: [teammateWorkspace],
        developerInstructions: "Run the probe.",
      },
      (value) => {
        const id = getString(getRecord(value, "thread"), "id");
        if (!id) throw new Error("thread/start returned no thread id.");
        return id;
      },
    ),
  );
  await runCauseEffect(
    client.request("turn/start", { threadId, input: [{ type: "text", text: "Run the probe." }] }, (value) => value),
  );
  await Promise.race([
    done,
    new Promise((_, fail) => setTimeout(() => fail(new Error("The Claude turn did not end.")), 120_000)),
  ]);
  assert.deepEqual(failures, [], "The turn has no error.");
  assert.ok(toolResults.length > 0, "The CLI sent the Bash result back.");
  report.claude = parse(await readFile(claudeOut, "utf8"));
  assertJailed("claude", report.claude);
  report.mcpServer = parse(await readFile(mcpOut, "utf8"));
  assert.deepEqual(report.mcpServer, { own_key: "ok", other_key: "no" }, "The MCP server runs in the jail too.");
  passed = true;
} catch (error) {
  report.error = error instanceof Error ? (error.stack ?? error.message) : String(error);
} finally {
  if (client) await runCauseEffect(client.stop()).catch(() => undefined);
  for (const child of children) child.kill();
  for (const server of servers) server.close();
  if (brokersFolder) await rm(brokersFolder, { recursive: true, force: true }).catch(() => undefined);
  if (!process.env.KEEP_AGENT_JAIL_E2E) await rm(root, { recursive: true, force: true }).catch(() => undefined);
}

report.passed = passed;
await mkdir(OUT, { recursive: true });
await writeFile(join(OUT, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
process.exit(passed ? 0 : 1);
