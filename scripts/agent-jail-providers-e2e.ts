// Every provider runs in the Atelier agent jail (src/backend/agent-jail.ts), the same way, and a Codex
// agent in it runs a read command with no approval card.
//
// 1. For each provider runtime on this server (`<profile>/provider-runtimes/<provider>`), the CLI
//    starts through the jail with the provider's folders, as `confineSpawnTarget` starts it, and runs:
//    its `--version` ends as it ends outside the jail. A probe through the same jail reads the agent's workspace and not
//    another agent's key.
// 2. For each provider but Claude, the real driver starts the agent's own process with the jailed
//    confinement, as `ProviderRuntime` does: that process has the jail's environment
//    (`OPENBOT_AGENT_JAILED=1`, the agent's `HOME`). Claude jails each session itself; its client is
//    marked jailed.
// 3. A Codex agent with Workspace only access, in the jail: `codexSandboxMode` gives
//    `danger-full-access`, and a fake model has it `cat` its skill file and then another agent's key.
//    The skill file is read, the key is refused by the jail, and Codex sends no approval request.
// 4. The same Codex turn has the fake model start a Codex helper (`spawn_agent`), and the helper runs
//    a command in the jail too. Neither Codex process writes the bubblewrap user-namespace error: the
//    jailed app-server starts with `CODEX_JAILED_CONFIG_OVERRIDES`. A control process started without
//    them shows that the check is real where Codex reports the error. The runtime guards
//    (`isCodexSandboxUnavailableDiagnostic`, `refusedSessionFailure`) read the error as a session to
//    start again in plain words, and the renderer's toast text for it is the plain Spanish sentence.
//
// Needs Linux with Landlock 3 and python3. `bun scripts/agent-jail-providers-e2e.ts`.
// The control reports the error only with the server's container settings, where the owner met it:
// `sudo docker run --rm --security-opt seccomp=/opt/openbot/seccomp.json --security-opt
// no-new-privileges:true --user 1000:1000 -e HOME=/tmp -e OPENBOT_PROVIDER_RUNTIMES=/rt -v $PWD:/wt
// -v <runtimes>:/rt:ro -v <bun folder>:/bt -w /wt --entrypoint /bt/bun <host image>
// scripts/agent-jail-providers-e2e.ts` (also mount the `node_modules` that the worktree links to).
// `OPENBOT_PROVIDER_RUNTIMES` names the runtimes folder; the default is the server's data volume.
// Writes .openbot-build/agent-jail-providers-e2e/report.json.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync, readlinkSync } from "node:fs";
import { chmod, mkdir, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { isAgentProvider } from "@openbot/contracts/agent-providers";
import type { AgentSummary } from "@openbot/contracts/ipc";
import { localizeSourceText } from "@openbot/i18n";
import { isCodexSandboxUnavailableDiagnostic } from "../src/backend/agent/provider-diagnostics";
import { isNonActionableCodexWarning, refusedSessionFailure } from "../src/backend/agent/thread-items";
import { CODEX_JAILED_CONFIG_OVERRIDES, codexSandboxMode } from "../src/backend/agent/workspace-sandbox";
import { AgentJail, type AgentJailPlan, clientRunsJailed } from "../src/backend/agent-jail";
import { CodexAppServerClient } from "../src/backend/app-server-client";
import type { AgentCliInfo } from "../src/backend/cli";
import { runCauseEffect } from "../src/backend/effect-boundary";
import {
  codexStatePaths,
  confineSpawnTarget,
  type ProcessConfinement,
  type ProviderStatePaths,
} from "../src/backend/process-confinement";
import { decodeRecordResponse, getRecord, getString, isRecord } from "../src/backend/protocol";
import { BUILT_IN_PROVIDER_DRIVERS, NO_PROVIDER_CREDENTIALS } from "../src/backend/provider-drivers";
import { providerProcessIds } from "../src/backend/provider-processes";

const OUT = resolve(import.meta.dirname, "../.openbot-build/agent-jail-providers-e2e");
const NL = String.fromCharCode(10);
const DEADLINE_MS = 60_000;
// Not in /tmp: the jail gives /tmp to every agent.
const root = join(OUT, "root");
const home = join(root, "home");
const userData = join(home, ".config", "OpenBot");
const openbotRoot = join(home, "OpenBot");
const workspace = join(openbotRoot, "Agents", "agent-a");
const sharedFolder = join(openbotRoot, "Spaces", "one", "Shared");
const otherKey = join(userData, "agent-api-keys", "agent-b", "KEY_B");
const skillFile = join(workspace, ".agents", "skills", "openbot-motion", "SKILL.md");
const SKILL_TEXT = "motion-skill-7d21";
const OTHER_SECRET = "other-agent-key-5e90";
const RUNTIMES =
  process.env.OPENBOT_PROVIDER_RUNTIMES ??
  [
    join(homedir(), ".config", "OpenBot", "provider-runtimes"),
    "/opt/openbot/data/.config/OpenBot/provider-runtimes",
  ].find((folder) => existsSync(folder)) ??
  "";

interface ProviderOutcome {
  provider: string;
  version: string;
  cliRuns: boolean;
  probe: string;
  ownProcess: string;
}
const report: {
  passed: boolean;
  runtimes: string;
  providers: ProviderOutcome[];
  codex?: {
    sandbox: string;
    approvals: string[];
    commands: Array<{ command: string; exitCode: unknown; output: string; threadId: string }>;
    /** The commands of the Codex helper that the agent's turn started, in its own thread. */
    helper: { offered: boolean; threadId: string | null; commands: string[]; tools: string[] };
    /** What the jailed Codex processes wrote to stderr that reads as its sandbox failing. */
    sandboxErrors: string[];
    /** A jailed app-server started without `CODEX_JAILED_CONFIG_OVERRIDES`: does Codex report the error? */
    control: { overrides: string[]; sandboxErrors: string[] };
    /** The runtime guard for the error: the session starts again, the owner reads plain Spanish. */
    guard: { retried: boolean; warningHidden: boolean; owner: string };
  };
  error?: string;
} = { passed: false, runtimes: RUNTIMES, providers: [] };

async function put(path: string, text: string): Promise<void> {
  await mkdir(resolve(path, ".."), { recursive: true, mode: 0o700 });
  await writeFile(path, text, { mode: 0o600 });
}

function run(
  command: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
): Promise<{ code: number | null; out: string }> {
  return new Promise((done) => {
    const child = spawn(command, args, { env, cwd: workspace, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (chunk: Buffer) => {
      out += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      out += chunk.toString("utf8");
    });
    const timer = setTimeout(() => child.kill("SIGKILL"), 30_000);
    child.once("exit", (code) => {
      clearTimeout(timer);
      done({ code, out: out.slice(-2000) });
    });
  });
}

/** The newest version folder of a runtime, and its program for an agent. */
function runtimeExecutable(provider: string): { version: string; executable: string } | null {
  const platformFolder = join(RUNTIMES, provider, "linux-x64");
  if (!existsSync(platformFolder)) return null;
  const versions = readdirSync(platformFolder).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  const version = versions.at(-1);
  if (!version) return null;
  const bin = join(platformFolder, version, "bin");
  const names: Record<string, string> = { antigravity: "localharness_external" };
  const executable = join(bin, names[provider] ?? provider);
  return existsSync(executable) ? { version, executable } : null;
}

async function waitFor<T>(what: string, read: () => T | null | undefined): Promise<T> {
  const deadline = Date.now() + DEADLINE_MS;
  for (;;) {
    const value = read();
    if (value !== null && value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`No ${what} in ${DEADLINE_MS} ms.`);
    await new Promise((done) => setTimeout(done, 50));
  }
}

/** The environment of a process once it runs the provider, no longer the launcher. */
function jailedEnvironment(pid: number): Record<string, string> | null {
  try {
    if (readlinkSync(`/proc/${pid}/exe`).includes("python")) return null;
    const entries = readFileSync(`/proc/${pid}/environ`, "utf8").split("\0").filter(Boolean);
    return Object.fromEntries(
      entries.map((entry) => [entry.slice(0, entry.indexOf("=")), entry.slice(entry.indexOf("=") + 1)]),
    );
  } catch {
    return null;
  }
}

function listen(server: Server): Promise<{ port: number; close: () => Promise<void> }> {
  return new Promise((done) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      assert(address && typeof address === "object");
      done({
        port: address.port,
        close: () =>
          new Promise<void>((closed) => {
            server.closeAllConnections();
            server.close(() => closed());
          }),
      });
    });
  });
}

/** The task the fake model gives the Codex helper; only the helper's requests carry it. */
const HELPER_TASK = "helper-task-4c18: print the jail marker";
const PARENT_TASK = "read the board skill";

/**
 * A model that speaks the Responses API. In the agent's own thread it runs one shell command for each
 * entry of `commands`, with whichever shell tool Codex offers, then starts one Codex helper with
 * `spawn_agent` when Codex offers it, and then answers "done". In the helper's thread it runs each of
 * `helperCommands` and answers "done".
 */
async function startFakeModel(commands: readonly string[], helperCommands: readonly string[]) {
  const offered: string[][] = [];
  const spawnSchemas: unknown[] = [];
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", () => {
      const parsed = JSON.parse(body || "{}");
      const input = isRecord(parsed) && Array.isArray(parsed.input) ? parsed.input : [];
      const tools = isRecord(parsed) && Array.isArray(parsed.tools) ? parsed.tools : [];
      const names = tools.flatMap((tool) => (isRecord(tool) && typeof tool.name === "string" ? [tool.name] : []));
      offered.push(names);
      // Codex 0.172 offers its helper tools in a namespace, such as `multi_agent_v1.spawn_agent`.
      const spawnNamespace = tools.find(
        (tool) =>
          isRecord(tool) &&
          tool.type === "namespace" &&
          Array.isArray(tool.tools) &&
          tool.tools.some((inner) => isRecord(inner) && inner.name === "spawn_agent"),
      );
      const namespace =
        isRecord(spawnNamespace) && typeof spawnNamespace.name === "string" ? spawnNamespace.name : null;
      if (namespace && spawnSchemas.length === 0) spawnSchemas.push(namespace);
      const inputText = JSON.stringify(input);
      const helper = inputText.includes(HELPER_TASK.slice(0, 16)) && !inputText.includes(PARENT_TASK);
      const done = input.filter((item) => isRecord(item) && item.type === "function_call").length;
      const own = helper ? helperCommands : commands;
      const command = own[done];
      const tool = ["shell_command", "exec_command", "shell"].find((name) => names.includes(name));
      const args =
        tool === "exec_command"
          ? { cmd: command }
          : tool === "shell"
            ? { command: ["bash", "-lc", command] }
            : { command };
      const spawn = !helper && done === commands.length && (namespace !== null || names.includes("spawn_agent"));
      // Atelier stops a helper when the turn that started it ends, so the turn waits for it.
      const helperId = /\\?"agent_id\\?":\\?"([0-9a-f-]+)/.exec(inputText)?.[1];
      const wait = !helper && done === commands.length + 1 && helperId !== undefined;
      const item =
        command !== undefined && tool
          ? {
              type: "function_call",
              id: `c${done}`,
              call_id: `call_${done}`,
              name: tool,
              arguments: JSON.stringify(args),
            }
          : wait
            ? {
                type: "function_call",
                id: `c${done}`,
                call_id: `call_${done}`,
                name: "wait_agent",
                ...(namespace ? { namespace } : {}),
                arguments: JSON.stringify({ targets: [helperId], timeout_ms: 30_000 }),
              }
            : spawn
              ? {
                  type: "function_call",
                  id: `c${done}`,
                  call_id: `call_${done}`,
                  name: "spawn_agent",
                  ...(namespace ? { namespace } : {}),
                  arguments: JSON.stringify({ message: HELPER_TASK }),
                }
              : { type: "message", role: "assistant", id: "m", content: [{ type: "output_text", text: "done" }] };
      const send = (event: unknown) => {
        const type = isRecord(event) ? String(event.type) : "";
        response.write(`event: ${type}${NL}data: ${JSON.stringify(event)}${NL}${NL}`);
      };
      response.writeHead(200, { "content-type": "text/event-stream" });
      send({ type: "response.created", response: { id: "r", status: "in_progress" } });
      send({ type: "response.output_item.done", output_index: 0, item });
      send({
        type: "response.completed",
        response: {
          id: "r",
          status: "completed",
          output: [item],
          usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
        },
      });
      response.end();
    });
  });
  return { offered, spawnSchemas, ...(await listen(server)) };
}

const MODEL_CATALOG = {
  models: [
    {
      slug: "jail-model",
      display_name: "Jail model",
      description: "Local E2E model",
      default_reasoning_level: "low",
      supported_reasoning_levels: [{ effort: "low", description: "Local E2E model" }],
      shell_type: "shell_command",
      visibility: "list",
      supported_in_api: true,
      priority: 0,
      support_verbosity: false,
      truncation_policy: { mode: "tokens", limit: 10000 },
      context_window: 272000,
      experimental_supported_tools: [],
      input_modalities: ["text"],
      supports_search_tool: false,
      model_messages: { instructions_template: "Use the available tools." },
    },
  ],
};

const agent: Pick<AgentSummary, "access" | "provider" | "workspacePath"> = {
  access: "workspace",
  provider: "codex",
  workspacePath: workspace,
};

async function codexTurn(
  cli: AgentCliInfo,
  confinement: ProcessConfinement,
): Promise<NonNullable<typeof report.codex>> {
  const helperCommands = ['echo "helper OPENBOT_AGENT_JAILED=$OPENBOT_AGENT_JAILED"'];
  const codexHome = join(home, ".codex");
  const agentHome = join(userData, "agent-jail", "agent-a", "home");
  const commands = [
    `cat ${skillFile}`,
    `cat ${otherKey}`,
    `echo "OPENBOT_AGENT_JAILED=$OPENBOT_AGENT_JAILED HOME=$([ "$HOME" = ${agentHome} ] && echo agent || echo "$HOME")"`,
  ];
  const model = await startFakeModel(commands, helperCommands);
  // In the provider folder: the jail lets Codex read nothing else of the fake server.
  const catalog = join(codexHome, "model-catalog.json");
  await mkdir(codexHome, { recursive: true });
  await writeFile(catalog, JSON.stringify(MODEL_CATALOG));
  await put(
    join(codexHome, "config.toml"),
    [
      'model = "jail-model"',
      `model_catalog_json = ${JSON.stringify(catalog)}`,
      'model_provider = "fake"',
      "[model_providers.fake]",
      'name = "fake"',
      `base_url = "http://127.0.0.1:${model.port}/v1"`,
      'env_key = "FAKE_KEY"',
      'wire_api = "responses"',
      // Codex's own helpers (`spawn_agent`), which an agent's model may start.
      "[features]",
      "multi_agent = true",
      "",
    ].join(NL),
  );
  const driver = BUILT_IN_PROVIDER_DRIVERS.find((entry) => entry.id === "codex");
  assert(driver);
  const client = driver.createClient(
    cli,
    30_000,
    { ...NO_PROVIDER_CREDENTIALS, serverEnvironment: { CODEX_HOME: codexHome, FAKE_KEY: "e2e" } },
    confinement,
  );
  assert(client instanceof CodexAppServerClient);
  // The driver marks a jailed client before it starts, so the start check reads as jailed.
  assert.equal(clientRunsJailed(client), true, "The Codex driver marks its jailed client.");
  const approvals: string[] = [];
  const sandboxErrors: string[] = [];
  const outputs: Array<{ command: string; exitCode: unknown; output: string; threadId: string }> = [];
  client.on("diagnostic", (line) => {
    if (isCodexSandboxUnavailableDiagnostic(line)) sandboxErrors.push(line);
  });
  let turnDone = () => {};
  client.on("request", (request) => {
    if (/approval/i.test(request.method)) approvals.push(request.method);
  });
  client.on("notification", (notification) => {
    if (notification.method === "turn/completed") turnDone();
    if (notification.method !== "item/completed") return;
    const item = getRecord(notification.params, "item");
    if (getString(item, "type") !== "commandExecution") return;
    const output = getString(item, "aggregatedOutput") ?? "";
    if (isCodexSandboxUnavailableDiagnostic(output)) sandboxErrors.push(output);
    outputs.push({
      command: getString(item, "command") ?? "",
      exitCode: isRecord(item) ? item.exitCode : null,
      output,
      threadId: getString(notification.params, "threadId") ?? "",
    });
  });
  client.start();
  try {
    await runCauseEffect(
      client.request(
        "initialize",
        {
          clientInfo: { name: "openbot_e2e", title: "OpenBot E2E", version: "0.0.0" },
          capabilities: { experimentalApi: true },
        },
        decodeRecordResponse,
      ),
    );
    client.notify("initialized");
    const sandbox = codexSandboxMode(agent, clientRunsJailed(client));
    const started = await runCauseEffect(
      client.request(
        "thread/start",
        { cwd: workspace, approvalPolicy: "on-request", approvalsReviewer: "user", sandbox, model: "jail-model" },
        decodeRecordResponse,
      ),
    );
    const threadId = getString(getRecord(started, "thread"), "id");
    assert(threadId, "thread/start returned no thread id");
    const done = new Promise<void>((resolveTurn) => {
      turnDone = resolveTurn;
    });
    await runCauseEffect(
      client.request("turn/start", { threadId, input: [{ type: "text", text: PARENT_TASK }] }, decodeRecordResponse),
    );
    await Promise.race([
      done,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("The Codex turn did not end.")), DEADLINE_MS).unref(),
      ),
    ]);
    const offered = model.spawnSchemas.length > 0 || model.offered.some((names) => names.includes("spawn_agent"));
    // The helper works on after the turn that started it; its command ends in its own thread.
    const helperRun = offered
      ? await waitFor("Codex helper command", () => outputs.find((output) => output.threadId !== threadId))
      : null;
    const helper = {
      offered,
      tools: [...new Set(model.offered.flat())].sort(),
      threadId: helperRun?.threadId ?? null,
      commands: outputs.filter((output) => output.threadId !== threadId).map((output) => output.output.trim()),
    };
    const control = await controlStart(cli, confinement, codexHome);
    // The guard of the runtime, fed the line Codex writes: one more session, and plain Spanish.
    const line = control.sandboxErrors[0] ?? CODEX_SANDBOX_LINE;
    const failure = refusedSessionFailure("codex", line);
    const owner = failure ? localizeSourceText(failure, "es") : "";
    return {
      sandbox,
      approvals,
      commands: outputs.filter((output) => output.threadId === threadId),
      helper,
      sandboxErrors,
      control,
      guard: {
        retried: failure !== null,
        warningHidden: isNonActionableCodexWarning(line) && isCodexSandboxUnavailableDiagnostic(line),
        owner,
      },
    };
  } finally {
    await runCauseEffect(client.stop());
    await model.close();
    if (outputs.length === 0) process.stderr.write(`offered tools ${JSON.stringify(model.offered)}\n`);
  }
}

/** What Codex 0.172 writes when its bubblewrap cannot make a user namespace. */
const CODEX_SANDBOX_LINE =
  "ERROR codex_app_server: Codex's Linux sandbox uses bubblewrap and needs access to create user namespaces.";

/**
 * A jailed Codex app-server with Codex's own default sandbox, as before the fix: started, asked to
 * initialize, and read until it reports the sandbox error or a few seconds pass.
 */
async function controlStart(cli: AgentCliInfo, confinement: ProcessConfinement, codexHome: string) {
  const environment = { CODEX_HOME: codexHome, FAKE_KEY: "e2e" };
  const client = new CodexAppServerClient(cli.executable, 30_000, environment, [], (target) =>
    confineSpawnTarget(target, confinement, codexStatePaths(environment)),
  );
  const sandboxErrors: string[] = [];
  client.on("diagnostic", (line) => {
    if (isCodexSandboxUnavailableDiagnostic(line)) sandboxErrors.push(line);
  });
  client.start();
  try {
    await runCauseEffect(
      client.request(
        "initialize",
        { clientInfo: { name: "openbot_e2e", title: "OpenBot E2E", version: "0.0.0" } },
        decodeRecordResponse,
      ),
    );
    // Codex writes the start check before or soon after it answers; this bound is not a wait for state.
    const deadline = Date.now() + 5_000;
    while (sandboxErrors.length === 0 && Date.now() < deadline) await new Promise((done) => setTimeout(done, 100));
  } finally {
    await runCauseEffect(client.stop());
  }
  return { overrides: [], sandboxErrors };
}

try {
  assert(RUNTIMES, "No provider runtimes folder: set OPENBOT_PROVIDER_RUNTIMES.");
  await rm(OUT, { recursive: true, force: true });
  await put(skillFile, `${SKILL_TEXT}\n`);
  await put(otherKey, `${OTHER_SECRET}\n`);
  await mkdir(sharedFolder, { recursive: true });
  await mkdir(join(openbotRoot, "Downloads"), { recursive: true });
  await mkdir(join(userData, "provider-runtimes"), { recursive: true });
  const probe = join(OUT, "probe.sh");
  await put(
    probe,
    [
      "#!/bin/bash",
      `if grep -q ${SKILL_TEXT} ${skillFile} 2>/dev/null; then echo workspace=ok; else echo workspace=no; fi`,
      `if cat ${otherKey} >/dev/null 2>&1; then echo other_key=ok; else echo other_key=no; fi`,
      'echo "jailed=${OPENBOT_AGENT_JAILED:-0}"',
    ].join(NL),
  );
  await chmod(probe, 0o755);

  const jail = new AgentJail({
    python: "/usr/bin/python3",
    launcher: resolve(import.meta.dirname, "../resources/agent-runtime/agent-jail.py"),
    home,
    userDataPath: userData,
    openbotRoot,
    apiKeysRoot: join(userData, "agent-api-keys"),
    jailRoot: join(userData, "agent-jail"),
    downloadsRoot: join(openbotRoot, "Downloads"),
    runtimeDirectory: undefined,
  });
  assert.ok(await jail.available(), "This machine has Landlock 3 and python3.");
  const environment = { ...process.env, HOME: home };

  const providers = readdirSync(RUNTIMES)
    .filter((name) => isAgentProvider(name))
    .sort();
  assert(providers.length > 0, `No provider runtime in ${RUNTIMES}.`);
  for (const provider of providers) {
    const found = runtimeExecutable(provider);
    if (!found) continue;
    const cli: AgentCliInfo = { executable: found.executable, version: found.version, source: "managed" };
    const plan: AgentJailPlan = await jail.prepare({
      agentId: "agent-a",
      cwd: workspace,
      writableRoots: [workspace, sharedFolder],
      readRoots: [],
      executable: found.executable,
      readFiles: [],
      linkFolders: [],
      commands: [probe],
      environment,
    });
    const confinement: ProcessConfinement = { writableRoots: [workspace, sharedFolder], jail: plan };
    const state: ProviderStatePaths = { writable: [join(home, `.${provider}`)], protected: [] };
    await mkdir(state.writable[0] ?? home, { recursive: true });
    const version = confineSpawnTarget(
      { command: found.executable, args: ["--version"], windowsVerbatimArguments: false },
      confinement,
      state,
    );
    const versionRun = await run(version.command, version.args, environment);
    // Some programs have no `--version`, such as the Antigravity harness: the jail must change nothing.
    const plainRun = await run(found.executable, ["--version"], environment);
    const probeTarget = confineSpawnTarget(
      { command: probe, args: [], windowsVerbatimArguments: false },
      confinement,
      state,
    );
    const probeRun = await run(probeTarget.command, probeTarget.args, environment);
    const outcome: ProviderOutcome = {
      provider,
      version: found.version,
      cliRuns: versionRun.code === plainRun.code && !versionRun.out.includes("openbot agent jail:"),
      probe: probeRun.out.trim().split(NL).join(" "),
      ownProcess: "",
    };
    report.providers.push(outcome);
    assert.equal(
      outcome.cliRuns,
      true,
      `${provider} --version in the jail: ${versionRun.out} / unjailed: ${plainRun.out}`,
    );
    assert.equal(outcome.probe, "workspace=ok other_key=no jailed=1", `${provider}: the jail probe`);

    const driver = BUILT_IN_PROVIDER_DRIVERS.find((entry) => entry.id === provider);
    assert(driver, `No driver for ${provider}.`);
    if (provider === "claude") {
      const client = driver.createClient(cli, 30_000, { ...NO_PROVIDER_CREDENTIALS, agentJail: jail });
      assert.equal(clientRunsJailed(client), true, "Claude's client jails its sessions.");
      outcome.ownProcess = "jails each session";
      continue;
    }
    if (provider === "codex") {
      // Codex makes its process not dumpable, so its environment cannot be read from outside: the
      // turn below prints it from the command that Codex runs.
      report.codex = await codexTurn(cli, confinement);
      const [skill, key, env] = report.codex.commands;
      outcome.ownProcess = env?.output.trim() ?? "";
      assert.equal(report.codex.sandbox, "danger-full-access", "A jailed Codex agent runs without Codex's sandbox.");
      assert.deepEqual(report.codex.approvals, [], "A read command asked for an approval.");
      assert(skill?.output.includes(SKILL_TEXT), `The skill file was not read: ${JSON.stringify(skill)}`);
      assert.equal(skill?.exitCode, 0);
      assert(
        key && !key.output.includes(OTHER_SECRET) && key.exitCode !== 0,
        `The jail let Codex read another agent's key: ${JSON.stringify(key)}`,
      );
      assert.equal(outcome.ownProcess, "OPENBOT_AGENT_JAILED=1 HOME=agent", "codex: the agent's own process");
      assert.deepEqual(report.codex.sandboxErrors, [], "A jailed Codex process reported its own sandbox failing.");
      assert.equal(report.codex.helper.offered, true, "Codex offered no spawn_agent tool to start a helper.");
      assert.deepEqual(report.codex.helper.commands, ["helper OPENBOT_AGENT_JAILED=1"], "The Codex helper's command.");
      assert.equal(report.codex.guard.retried, true, "The sandbox error does not start a new session.");
      assert.equal(report.codex.guard.warningHidden, true, "The sandbox error would show as a banner.");
      assert(
        report.codex.guard.owner.startsWith("Codex no pudo activar") &&
          !/bubblewrap|namespace/i.test(report.codex.guard.owner),
        `The owner reads: ${report.codex.guard.owner}`,
      );
      assert.deepEqual([...CODEX_JAILED_CONFIG_OVERRIDES], ['sandbox_mode="danger-full-access"']);
      continue;
    }
    const before = new Set(providerProcessIds().keys());
    const client = driver.createClient(cli, 30_000, NO_PROVIDER_CREDENTIALS, confinement);
    client.start();
    try {
      const pid = await waitFor(`${provider} process`, () =>
        [...providerProcessIds().keys()].find((id) => !before.has(id)),
      );
      const env = await waitFor(`${provider} jailed environment`, () => jailedEnvironment(pid));
      outcome.ownProcess = `OPENBOT_AGENT_JAILED=${env.OPENBOT_AGENT_JAILED ?? ""} HOME=${env.HOME === join(userData, "agent-jail", "agent-a", "home") ? "agent" : (env.HOME ?? "")}`;
      assert.equal(outcome.ownProcess, "OPENBOT_AGENT_JAILED=1 HOME=agent", `${provider}: the agent's own process`);
    } finally {
      await runCauseEffect(client.stop()).catch(() => undefined);
    }
  }
  assert(report.codex || !providers.includes("codex"), "Codex did not run its turn.");
  report.passed = true;
} catch (error) {
  report.error = error instanceof Error ? (error.stack ?? error.message) : String(error);
  process.exitCode = 1;
} finally {
  await mkdir(OUT, { recursive: true });
  await writeFile(join(OUT, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}
