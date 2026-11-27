import { execFile, spawn } from "node:child_process";
import { constants, existsSync, lstatSync, mkdirSync, readlinkSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import {
  copyFile,
  lstat,
  mkdir,
  readdir,
  readFile,
  readlink,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { type DynamicRecord, isDynamicRecord, isString } from "@openbot/contracts/runtime-values";
import { createOpenBotLogger } from "@openbot/logging";
import type { AgentClient } from "./agent-client";

const logger = createOpenBotLogger("agent-jail");

/**
 * The jail of an agent's provider process on a Linux server: `resources/agent-runtime/agent-jail.py`
 * restricts the process with Landlock and then starts the provider CLI, so the CLI and every program
 * it starts (the shell, its MCP servers, the build tools) can reach only what this plan names. Agents
 * run as the same user as main, so without it an agent could read the other agents' key files, the
 * other spaces, the database, the provider sign-ins, the keyring and `/proc/<pid>/environ` of main
 * and PID 1. See docs/self-hosted-server.md#agent-jail.
 *
 * The jail reaches:
 * - the system folders, `/proc` and `/sys`, to read and run;
 * - the agent's workspace, the shared folder of its space, `/tmp`, the browser downloads, the
 *   provider's own config folder (its sign-in and sessions), and a home folder of the agent's own;
 * - the workspaces of its teammates in the same space, its own key folder and the shared keys, to
 *   read, and the files that main gives this
 *   start (the MCP config, the settings file, the skill plugins, the MCP server programs).
 *
 * The agent's home is a folder of links: each folder of the real home links there, except the ones
 * below that hold sign-ins and secrets, so the toolchains in `~/.cargo`, `~/.bun` or `~/.cache` stay
 * shared, and a new file in `~` stays the agent's own.
 *
 * What it does not stop: a connection to a UNIX socket file (the control socket checks who connects
 * by itself, and appctl and benchctl are reached that way on purpose), the network, the names of
 * other processes in `ps`, and the D-Bus session bus. The jail takes `DBUS_SESSION_BUS_ADDRESS` away,
 * and the keyring's files are out of reach, but a process that finds the bus socket in `/tmp` can
 * still ask it.
 */

/**
 * `off` turns the jail off for a server's operator. Any other value, or none, jails the agents.
 *
 * The jail belongs to how OpenBot starts an agent's process, not to a provider: every provider is
 * jailed the same way. Claude starts a process for each session and jails it there
 * (`claude-client.ts`); every other provider runs each agent in a process of its own, which
 * `ProviderRuntime` starts through `AgentJailPlan.wrapTarget` (`process-confinement.ts`). A provider
 * that cannot start in the jail does not start: no agent runs outside it.
 */
export const AGENT_JAIL_VARIABLE = "OPENBOT_AGENT_JAIL";
/** The exit code of the launcher when it cannot make the jail. */
const LAUNCHER_FAILED = 125;

/** Whether the variable leaves the jail on. Only a Linux server jails at all. */
export function agentJailEnabled(environment: NodeJS.ProcessEnv): boolean {
  const value = environment[AGENT_JAIL_VARIABLE]?.trim().toLowerCase();
  return !(value === "off" || value === "0" || value === "none");
}

/**
 * Names in the real home that never link into an agent's home: sign-ins, keys, histories and
 * backups. The folders that hold main's own data (the OpenBot folder, the profile) are left out by
 * path as well, wherever they are.
 */
const HOME_SECRETS = new Set([
  ".ssh",
  ".gnupg",
  ".pki",
  ".netrc",
  ".git-credentials",
  ".docker",
  ".kube",
  ".aws",
  ".azure",
  ".bash_history",
  ".zsh_history",
  ".python_history",
  ".node_repl_history",
  ".psql_history",
  ".mysql_history",
  ".lesshst",
  ".viminfo",
  // The provider homes. The jailed provider's own folder is given by its variable.
  ".claude",
  ".claude.json",
  ".claude.json.backup",
  ".codex",
  ".grok",
  ".gemini",
  ".cursor",
  ".cline",
  ".pi",
  ".muse",
  ".opencode",
  ".snapshots",
  "Agents",
  "backups",
  "Backups",
]);
/** In `~/.config`: the keyring password of the container, and sign-ins. */
const CONFIG_SECRETS = new Set([
  "openbot-container",
  "gh",
  "gcloud",
  "rclone",
  "opencode",
  "cursor",
  "cline",
  "github-copilot",
  "Code",
  "op",
]);
/** In `~/.local/share` and `~/.local/state`: the keyrings, and the sign-ins of providers. */
const LOCAL_SECRETS = new Set(["keyrings", "opencode", "muse", "gnome-keyring", "Trash"]);

/** The folders under the root that the jail reads and runs, without what is protected below them. */
const SYSTEM_READ = [
  "/usr",
  "/bin",
  "/sbin",
  "/lib",
  "/lib32",
  "/lib64",
  "/libx32",
  "/etc",
  "/opt",
  "/var",
  "/srv",
  "/snap",
  "/nix",
  "/sys",
  "/proc",
  "/run",
];
const SYSTEM_WRITE = ["/tmp", "/var/tmp", "/dev/shm", "/dev/mqueue"];

export interface AgentJailHost {
  /** `python3`, which runs the launcher. */
  readonly python: string;
  /** `agent-jail.py`. */
  readonly launcher: string;
  /** The real home of the service user. */
  readonly home: string;
  /** Main's profile, `~/.config/OpenBot`: the database, the keys, the encrypted stores. */
  readonly userDataPath: string;
  /** `~/OpenBot`, with every workspace and space. */
  readonly openbotRoot: string;
  /** `<userData>/agent-api-keys`. */
  readonly apiKeysRoot: string;
  /** Where the agents' homes and temporary folders go. */
  readonly jailRoot: string;
  /** The browser's download folder, which the browser tool hands to agents. */
  readonly downloadsRoot: string;
  /** Main's `XDG_RUNTIME_DIR`, with the control socket and the keyring. */
  readonly runtimeDirectory: string | undefined;
}

export interface AgentJailRequest {
  readonly agentId: string;
  readonly cwd: string;
  /** The workspace and the shared folder of the agent's space. */
  readonly writableRoots: readonly string[];
  /** The workspaces of the agent's teammates in its space, to read only. */
  readonly readRoots: readonly string[];
  /**
   * The provider's own folder: its sign-in, settings and sessions, such as `CLAUDE_CONFIG_DIR`. A
   * provider in its own process gives its folders to `wrapTarget` instead.
   */
  readonly providerHome?: string;
  /** The provider program. */
  readonly executable: string;
  /** Files that main wrote for this start, such as the MCP config. */
  readonly readFiles: readonly string[];
  /** Folders whose entries the provider reads through links, such as the skill plugins. */
  readonly linkFolders: readonly string[];
  /** Programs the provider starts, such as the stdio MCP servers. */
  readonly commands: readonly string[];
  /** The environment the provider would start with unjailed. */
  readonly environment: NodeJS.ProcessEnv;
}

export type AgentJailRuleKind = "read" | "write" | "device";
export interface AgentJailRule {
  readonly kind: AgentJailRuleKind;
  readonly path: string;
}

export interface AgentJailPlan {
  readonly rules: readonly AgentJailRule[];
  /** The environment of the jailed process. */
  readonly environment: NodeJS.ProcessEnv;
  /** The command and arguments that start `command` in the jail, with `environment` given by the caller. */
  wrap(command: string, args: readonly string[]): { command: string; args: string[] };
  /**
   * The command and arguments that start a provider's own process in the jail. `state` names the
   * provider's folders (its sign-in, settings and sessions), which it may write; each one in the real
   * home is linked into the agent's home. The launcher sets the jail's environment itself, so the
   * caller keeps the environment that it would give the process unjailed.
   */
  wrapTarget(
    target: { command: string; args: readonly string[] },
    state: readonly string[],
  ): { command: string; args: string[] };
}

export class AgentJailUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentJailUnavailableError";
  }
}

/** The Landlock version the launcher found, read once. 0: no jail on this machine. */
function probeLandlock(python: string, launcher: string): Promise<number> {
  return new Promise((done) => {
    execFile(python, ["-I", "-S", launcher, "--probe"], { timeout: 10_000 }, (error, stdout) => {
      const version = error ? 0 : Number.parseInt(stdout.trim(), 10);
      done(Number.isFinite(version) ? version : 0);
    });
  });
}

export class AgentJail {
  readonly #host: AgentJailHost;
  #version: Promise<number> | null = null;
  #warned = false;
  #emptied: Promise<void> | null = null;

  constructor(host: AgentJailHost) {
    this.#host = host;
  }

  /** Whether this machine can make the jail. Landlock 3 is the first version that controls truncation. */
  async available(): Promise<boolean> {
    if (!this.#version) {
      this.#version = probeLandlock(this.#host.python, this.#host.launcher);
      void this.#version.then((version) => {
        if (version >= 3) logger.info("Agents start in their jail.", { landlock: version, providers: "all" });
      });
    }
    return (await this.#version) >= 3;
  }

  /**
   * The temporary and runtime folders of every agent, emptied once per run of main before the first
   * jailed start: they are in the data volume, which a restart of the container does not empty as it
   * empties `/tmp`, and no agent process outlives main.
   */
  #emptyTemporaryFolders(): Promise<void> {
    this.#emptied ??= (async () => {
      for (const agent of await folderEntries(this.#host.jailRoot))
        for (const name of ["tmp", "run"])
          await rm(join(this.#host.jailRoot, agent, name), { recursive: true, force: true }).catch(() => undefined);
    })();
    return this.#emptied;
  }

  /**
   * The plan of one provider start. It throws when the machine cannot make the jail: the agent then
   * does not start, and never runs outside the jail.
   */
  async prepare(request: AgentJailRequest): Promise<AgentJailPlan> {
    if (!(await this.available())) {
      if (!this.#warned) {
        this.#warned = true;
        logger.warn("Agents do not start: this server has no Landlock 3, or no python3, for their jail.", {});
      }
      throw new AgentJailUnavailableError("This server cannot make the agent jail (Landlock).");
    }
    await this.#emptyTemporaryFolders();
    const own = join(this.#host.jailRoot, request.agentId);
    const home = join(own, "home");
    const temporary = join(own, "tmp");
    const runtime = join(own, "run");
    for (const folder of [home, temporary, runtime]) await mkdir(folder, { recursive: true, mode: 0o700 });
    const protectedRoots = await this.#protectedRoots();
    const linked = await linkHome(this.#host.home, home, protectedRoots);
    const rules: AgentJailRule[] = [];
    const add = (kind: AgentJailRuleKind, path: string) => rules.push({ kind, path });
    for (const root of SYSTEM_READ) for (const path of await uncovered(root, protectedRoots)) add("read", path);
    add("device", "/dev");
    for (const path of SYSTEM_WRITE) add("write", path);
    for (const path of [own, request.cwd, ...request.writableRoots, this.#host.downloadsRoot]) add("write", path);
    if (request.providerHome) add("write", request.providerHome);
    // The default folder of `appctl deploy --src`, from before spaces.
    add("write", join(this.#host.openbotRoot, "Shared", "apps"));
    for (const path of linked) add("write", path);
    for (const path of request.readRoots) add("read", path);
    add("read", join(this.#host.apiKeysRoot, request.agentId));
    add("read", join(this.#host.apiKeysRoot, "_shared"));
    // The keys given to this agent beyond its own and the shared ones (a space's, a listed one).
    // Never the store's `_vault` folder, or another agent's grants.
    const grants = join(this.#host.apiKeysRoot, "_grants", request.agentId);
    await mkdir(grants, { recursive: true, mode: 0o700 }).catch(() => undefined);
    add("read", grants);
    add("read", join(this.#host.userDataPath, "provider-runtimes"));
    for (const path of request.readFiles) add("read", path);
    for (const folder of request.linkFolders) {
      add("read", folder);
      for (const target of await linkTargets(folder)) add("read", target);
    }
    for (const command of [request.executable, ...request.commands]) {
      if (!isAbsolute(command)) continue;
      add("read", command);
      const real = await realpath(command).catch(() => null);
      if (real) add("read", dirname(real));
    }
    for (const path of nodeRequires(request.environment.NODE_OPTIONS)) add("read", path);
    // The GitHub connection: `gh` keeps its state in its folder, and git's helper reads the token next to it.
    const gh = request.environment.GH_CONFIG_DIR;
    if (gh && isAbsolute(gh)) {
      add("write", gh);
      add("read", dirname(gh));
    }
    const xauthority = request.environment.XAUTHORITY;
    if (xauthority && isAbsolute(xauthority)) add("read", xauthority);
    const kept = await safeRules(rules, protectedRoots);
    const environment = jailEnvironment(request.environment, this.#host.home, home, temporary, runtime);
    const { python, launcher } = this.#host;
    const realHome = await realOrResolved(this.#host.home);
    const flags = (list: readonly AgentJailRule[]) => list.flatMap((rule) => [`--${rule.kind}`, rule.path]);
    return {
      rules: kept,
      environment,
      wrap: (command, args) => ({
        command: python,
        args: ["-I", "-S", launcher, ...flags(kept), "--", command, ...args],
      }),
      wrapTarget: (target, state) => {
        const extra = stateRules(state, kept, protectedRoots, realHome, home);
        return {
          command: python,
          args: [
            "-I",
            "-S",
            launcher,
            ...flags([...kept, ...extra]),
            "--jail-env",
            realHome,
            home,
            temporary,
            runtime,
            "--",
            target.command,
            ...target.args,
          ],
        };
      },
    };
  }

  async #protectedRoots(): Promise<string[]> {
    const { home, userDataPath, openbotRoot, apiKeysRoot, jailRoot, runtimeDirectory } = this.#host;
    const roots = [home, userDataPath, openbotRoot, apiKeysRoot, jailRoot, "/run/openbot", "/run/user"];
    if (runtimeDirectory) roots.push(runtimeDirectory);
    return unique(await Promise.all(roots.map(realOrResolved)));
  }
}

/**
 * The write rules for a provider's own folders, without the ones that reach a protected root. A
 * folder in the real home is linked into the agent's home at the same place, because `HOME` names the
 * agent's home in the jail. A folder under a link of the agent's home is reached through that link.
 */
function stateRules(
  state: readonly string[],
  kept: readonly AgentJailRule[],
  protectedRoots: readonly string[],
  realHome: string,
  jailHome: string,
): AgentJailRule[] {
  const rules: AgentJailRule[] = [];
  for (const folder of state) {
    // A folder the provider has not made yet stays out: its driver makes the ones it needs first.
    if (!isAbsolute(folder) || !lstatOrNull(folder)) continue;
    const path = realSync(folder);
    if (protectedRoots.some((root) => contains(path, root))) {
      logger.warn("The agent jail leaves out a provider folder that holds main's data.", {});
      continue;
    }
    if (!kept.some((rule) => rule.kind === "write" && rule.path === path)) rules.push({ kind: "write", path });
    const inside = relative(realHome, path);
    if (inside === "" || inside.startsWith("..") || isAbsolute(inside)) continue;
    linkIntoHome(jailHome, inside, path);
  }
  return rules;
}

/** Links `target` at `inside` in the agent's home, unless a link or a folder of the agent's own is on the way. */
function linkIntoHome(jailHome: string, inside: string, target: string): void {
  const parts = inside.split("/");
  let current = jailHome;
  for (const part of parts.slice(0, -1)) {
    current = join(current, part);
    const entry = lstatOrNull(current);
    if (entry?.isSymbolicLink()) return;
    if (!entry) mkdirSync(current, { mode: 0o700 });
  }
  const entry = join(jailHome, inside);
  const existing = lstatOrNull(entry);
  if (existing && !existing.isSymbolicLink()) return;
  if (existing) {
    if (readLinkOrNull(entry) === target) return;
    rmSync(entry, { force: true });
  }
  try {
    symlinkSync(target, entry);
  } catch {
    // Two starts of one agent can make the same link at once: the other one's link counts.
  }
}

function lstatOrNull(path: string) {
  try {
    return lstatSync(path);
  } catch {
    return null;
  }
}

function readLinkOrNull(path: string): string | null {
  try {
    return readlinkSync(path);
  } catch {
    return null;
  }
}

function realSync(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

/**
 * Drops each rule that would reach a protected root: one on the root itself or on a folder above
 * it. A rule below one, such as the workspace in `~/OpenBot`, stays.
 */
async function safeRules(rules: readonly AgentJailRule[], protectedRoots: readonly string[]): Promise<AgentJailRule[]> {
  const kept: AgentJailRule[] = [];
  const seen = new Set<string>();
  for (const rule of rules) {
    const path = await realOrResolved(rule.path);
    const key = `${rule.kind}\0${path}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (protectedRoots.some((root) => contains(path, root))) {
      logger.warn("The agent jail leaves out a folder that holds main's data.", { kind: rule.kind });
      continue;
    }
    kept.push({ kind: rule.kind, path });
  }
  return kept;
}

/**
 * `root` when no protected root is inside it, else the entries of `root` that hold none, at any
 * depth. `root` itself is then left out, so its entries cannot be listed or added to.
 */
export async function uncovered(root: string, protectedRoots: readonly string[]): Promise<string[]> {
  const path = await realOrResolved(root);
  if (protectedRoots.some((entry) => entry === path)) return [];
  if (!protectedRoots.some((entry) => contains(path, entry))) {
    return (await exists(path)) ? [path] : [];
  }
  const entries = await folderEntries(path);
  const nested = await Promise.all(entries.map((name) => uncovered(join(path, name), protectedRoots)));
  return nested.flat();
}

/**
 * Makes `jailHome` a home of links into `home`, without the secrets, and returns what the links
 * point at. `~/.config`, `~/.local`, `~/.local/share` and `~/.local/state` are folders of the agent
 * with links in them, so a program that adds a folder there adds it for this agent only. A link
 * left from a folder that is now a secret, or gone, is removed.
 */
export async function linkHome(home: string, jailHome: string, protectedRoots: readonly string[]): Promise<string[]> {
  const targets: string[] = [];
  const realHome = await realOrResolved(home);
  // Every entry is inside the home: what matters is a link out of it into main's data, or an entry
  // that holds main's data, such as `~/OpenBot`.
  const guarded = protectedRoots.filter((root) => root !== realHome);
  const level = async (
    from: string,
    to: string,
    secrets: ReadonlySet<string>,
    folders: Record<string, ReadonlySet<string> | null>,
  ) => {
    await mkdir(to, { recursive: true, mode: 0o700 });
    const names = new Set(await folderEntries(from));
    for (const name of await folderEntries(to)) {
      if (names.has(name) && !secrets.has(name)) continue;
      const entry = join(to, name);
      if ((await lstat(entry).catch(() => null))?.isSymbolicLink()) await rm(entry, { force: true });
    }
    for (const name of names) {
      if (secrets.has(name)) continue;
      const source = join(from, name);
      const entry = join(to, name);
      const real = await realOrResolved(source);
      if (
        Object.hasOwn(folders, name) &&
        real.startsWith(`${realHome}/`) &&
        (await stat(real).catch(() => null))?.isDirectory()
      ) {
        const inner = folders[name];
        await level(source, entry, inner ?? new Set(), inner ? {} : LOCAL_FOLDERS);
        continue;
      }
      if (guarded.some((root) => contains(real, root) || contains(root, real))) continue;
      const current = await lstat(entry).catch(() => null);
      // The agent's own file or folder of that name wins over the shared one.
      if (current && !current.isSymbolicLink()) continue;
      if (current && (await readlink(entry).catch(() => null)) !== source) await rm(entry, { force: true });
      if (!current || !(await isLinkTo(entry, source))) {
        // Two starts of one agent can make the same link at once: the other one's link counts.
        await symlink(source, entry).catch(() => undefined);
        if (!(await isLinkTo(entry, source))) continue;
      }
      targets.push(source);
    }
  };
  await level(home, jailHome, HOME_SECRETS, { ".config": CONFIG_SECRETS, ".local": null });
  return targets;
}

async function isLinkTo(entry: string, source: string): Promise<boolean> {
  return (await readlink(entry).catch(() => null)) === source;
}

/** In `~/.local`, the folders that are themselves folders of links. */
const LOCAL_FOLDERS: Record<string, ReadonlySet<string>> = { share: LOCAL_SECRETS, state: LOCAL_SECRETS };

/** What the links in a folder point at, one level down and in `skills`: the skill plugins of Claude. */
async function linkTargets(folder: string): Promise<string[]> {
  const targets: string[] = [];
  for (const parent of [folder, join(folder, "skills")]) {
    for (const name of await folderEntries(parent)) {
      const entry = join(parent, name);
      if (!(await lstat(entry).catch(() => null))?.isSymbolicLink()) continue;
      const real = await realpath(entry).catch(() => null);
      if (real) targets.push(real);
    }
  }
  return targets;
}

/** The `--require` files in NODE_OPTIONS, such as the CPU limit module. Node stops when one is missing. */
function nodeRequires(options: string | undefined): string[] {
  if (!options) return [];
  const paths: string[] = [];
  for (const match of options.matchAll(/--require(?:=|\s+)("(?:[^"\\]|\\.)*"|\S+)/g)) {
    const value = match[1] ?? "";
    try {
      const path = value.startsWith('"') ? JSON.parse(value) : value;
      if (isString(path)) paths.push(path);
    } catch {
      // A value that is not JSON names no file.
    }
  }
  return paths.filter((path) => isAbsolute(path));
}

/**
 * The environment of the jailed process: the agent's own home, temporary and runtime folders, the
 * XDG folders that pointed into the real home moved into the agent's, and no bus, keyring or SSH
 * agent of the host.
 */
export function jailEnvironment(
  environment: NodeJS.ProcessEnv,
  home: string,
  jailHome: string,
  temporary: string,
  runtime: string,
): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = { ...environment };
  for (const name of ["DBUS_SESSION_BUS_ADDRESS", "GNOME_KEYRING_CONTROL", "SSH_AUTH_SOCK", "OPENBOT_AUTOMATION_DIR"])
    delete result[name];
  for (const name of ["XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME"]) {
    const value = result[name];
    if (!value || !isAbsolute(value)) continue;
    const inside = relative(home, value);
    if (inside === "" || (!inside.startsWith("..") && !isAbsolute(inside))) result[name] = join(jailHome, inside);
  }
  return {
    ...result,
    HOME: jailHome,
    TMPDIR: temporary,
    TMP: temporary,
    TEMP: temporary,
    XDG_RUNTIME_DIR: runtime,
    OPENBOT_AGENT_JAILED: "1",
  };
}

/**
 * Starts the jailed process for the Claude Agent SDK, which reads stdin and stdout. The launcher
 * writes why it could not make the jail to stderr and exits with 125; the log gets that line.
 */
export function spawnJailed(
  plan: AgentJailPlan,
  options: { command: string; args: string[]; cwd?: string; env: NodeJS.ProcessEnv; signal: AbortSignal },
) {
  const target = plan.wrap(options.command, options.args);
  const child = spawn(target.command, target.args, {
    cwd: options.cwd,
    env: options.env,
    signal: options.signal,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  let tail = "";
  child.stderr?.on("data", (chunk: Buffer) => {
    tail = (tail + chunk.toString("utf8")).slice(-2048);
  });
  child.once("exit", (code) => {
    if (code !== LAUNCHER_FAILED) return;
    const line = tail
      .split("\n")
      .reverse()
      .find((entry) => entry.startsWith("openbot agent jail:"));
    logger.warn("An agent process could not enter its jail.", { reason: line ?? "unknown" });
  });
  return child;
}

/**
 * The global config of Claude Code lives in the config folder when `CLAUDE_CONFIG_DIR` is set, and in
 * `~/.claude.json` when not. A jailed default account gets the variable, so the CLI never writes in
 * the real home; its first start copies the file it had there.
 */
export async function seedClaudeGlobalConfig(home: string, configDirectory: string): Promise<void> {
  const source = join(home, ".claude.json");
  const target = join(configDirectory, ".claude.json");
  if (
    await copyFile(source, target, constants.COPYFILE_EXCL).then(
      () => true,
      () => false,
    )
  )
    return;
  // A sign-in from OpenBot writes the account to `~/.claude.json`: the copy takes the new account.
  const [own, copy] = await Promise.all([readJson(source), readJson(target)]);
  if (!own || !copy || JSON.stringify(own.oauthAccount) === JSON.stringify(copy.oauthAccount)) return;
  const staged = `${target}.openbot-${process.pid}-${Date.now()}`;
  await writeFile(staged, JSON.stringify({ ...copy, oauthAccount: own.oauthAccount }, null, 2), { mode: 0o600 });
  await rename(staged, target).catch(() => rm(staged, { force: true }));
}

async function readJson(path: string): Promise<DynamicRecord | null> {
  try {
    const value = JSON.parse(await readFile(path, "utf8"));
    return isDynamicRecord(value) ? value : null;
  } catch {
    return null;
  }
}

function contains(parent: string, child: string): boolean {
  if (parent === child) return true;
  const inside = relative(parent, child);
  return inside !== "" && !inside.startsWith("..") && !isAbsolute(inside);
}

/** The entries of a folder, or none when it cannot be read. */
async function folderEntries(path: string): Promise<string[]> {
  return readdir(path).catch((): string[] => []);
}

async function exists(path: string): Promise<boolean> {
  return (await stat(path).catch(() => null)) !== null;
}

async function realOrResolved(path: string): Promise<string> {
  const absolute = resolve(path);
  const real = await realpath(absolute).catch(() => null);
  if (real) return real;
  const parent = dirname(absolute);
  return parent === absolute ? absolute : join(await realOrResolved(parent), basename(absolute));
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

/**
 * The jail of a server, or undefined: off on a desktop, on another system than Linux, and when
 * `OPENBOT_AGENT_JAIL=off`. An agent that cannot be jailed on a server does not start.
 */
export function createAgentJail(options: {
  platform: NodeJS.Platform;
  environment: NodeJS.ProcessEnv;
  launcher: string;
  home: string;
  userDataPath: string;
  openbotRoot: string;
  downloadsRoot: string;
}): AgentJail | undefined {
  if (options.platform !== "linux" || !agentJailEnabled(options.environment)) return undefined;
  return new AgentJail({
    python: existsSync("/usr/bin/python3") ? "/usr/bin/python3" : "python3",
    launcher: options.launcher,
    home: options.home,
    userDataPath: options.userDataPath,
    openbotRoot: options.openbotRoot,
    apiKeysRoot: join(options.userDataPath, "agent-api-keys"),
    jailRoot: join(options.userDataPath, "agent-jail"),
    downloadsRoot: options.downloadsRoot,
    runtimeDirectory: options.environment.XDG_RUNTIME_DIR?.trim() || undefined,
  });
}

/** The clients whose agent processes run in the jail. */
const jailedClients = new WeakSet<AgentClient>();

/** Records that `client` starts its agent processes in the jail. */
export function markClientJailed(client: AgentClient): void {
  jailedClients.add(client);
}

/**
 * True when `client` runs its agents in the jail. The jail is then the limit of the agent: the
 * provider's own sandbox stays off, as it cannot start in the container and would ask the owner to
 * approve each command, and a command or file approval is answered without a card.
 */
export function clientRunsJailed(client: AgentClient): boolean {
  return jailedClients.has(client);
}
