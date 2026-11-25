// End-to-end check of the copies to a cloud drive (Server settings > Backups > Copy in the cloud): the
// main process's `CloudBackups` (secrets, schedule, alerts) against the real backup broker
// (`scripts/backup-broker/backupd.py` of the private release scripts, or `--broker=<path>`), which runs
// the pinned restic and rclone. The drive is a folder: a stand-in for rclone's Proton Drive backend
// signs in with a fixed account (2FA included), keeps a session, and can expire it or lose the network.
// No Proton account is used.
//
// It covers the sign-in (wrong password, 2FA, session tokens kept), the first copy and what it holds
// (consistent databases, no build output, no big media, clones with a remote as a bundle of unpushed
// work), client-side encryption, the deploy hold, skipping a run while one goes, retention, the
// restore test, a failure push (once), the expired sign-in path, and a restore into its own folder
// that becomes a restorable local backup.
//
//   bun scripts/cloud-backup-e2e.ts [--broker=<backupd.py>]
//
// It needs python3, git, zstd, rsync, and network access once for the pinned restic and rclone
// (cached in .openbot-build/cloud-tools). The report is .openbot-build/cloud-backup-e2e/report.json.
import assert from "node:assert/strict";
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { translateFor } from "@openbot/i18n";
import { CloudBackups } from "../src/main/cloud-backups";
import { HostBackups } from "../src/main/host-backups";

const OUT = resolve(import.meta.dirname, "../.openbot-build/cloud-backup-e2e");
const TOOLS = resolve(import.meta.dirname, "../.openbot-build/cloud-tools");
const brokerArg = process.argv.find((arg) => arg.startsWith("--broker="))?.slice("--broker=".length);
const BROKER = resolve(
  brokerArg ??
    [
      resolve(import.meta.dirname, "../../openbot-release/scripts/backup-broker/backupd.py"),
      "/opt/openbot/backups/atelier/backupd.py",
    ].find((path) => existsSync(path)) ??
    "backupd.py",
);
const t = translateFor("en");
const EMAIL = "owner@proton.me";
const PASSWORD = "correct horse battery";
const TWO_FA = "123456";
const MARKER = "plain-text-marker-4b1d";

const results: { name: string; ok: boolean; detail: string }[] = [];
function check(name: string, ok: boolean, detail = ""): void {
  results.push({ name, ok, detail });
  process.stdout.write(`${ok ? "pass" : "FAIL"} ${name}${detail ? `: ${detail}` : ""}\n`);
}

function must(
  command: string,
  args: string[],
  options: { cwd?: string; input?: string; env?: NodeJS.ProcessEnv } = {},
) {
  const result = spawnSync(command, args, { encoding: "utf8", maxBuffer: 256 << 20, ...options });
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")}: ${result.stderr || result.stdout}`);
  return result.stdout;
}

/** Every file under a folder, as paths relative to it. */
function walk(root: string, prefix = ""): string[] {
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) return walk(join(root, entry.name), rel);
    return entry.isFile() ? [rel] : [];
  });
}

mkdirSync(OUT, { recursive: true });
mkdirSync(TOOLS, { recursive: true });
assert.ok(existsSync(BROKER), `No backup broker at ${BROKER}. Pass --broker=<backupd.py>.`);
// A short path: a unix socket path has a 107-byte limit.
const root = mkdtempSync(join(tmpdir(), "acb-"));
const data = join(root, "data");
const motion = join(root, "motion");
const drive = join(root, "drive");
const stub = join(root, "stub");
const userData = join(root, "userdata");
let broker: ChildProcess | undefined;

function fixture(): void {
  for (const dir of [
    ".config/OpenBot/Cache",
    ".claude/projects/agent-1",
    ".codex/sessions/2026",
    "OpenBot/Agents/Ana",
    "OpenBot/Spaces/shop/Shared/site/node_modules/left-pad",
    "OpenBot/Spaces/shop/Shared/site/dist",
    "OpenBot/Spaces/shop/Shared/videos",
  ])
    mkdirSync(join(data, dir), { recursive: true });
  mkdirSync(join(motion, "data/files"), { recursive: true });
  for (const dir of [drive, stub, userData]) mkdirSync(dir, { recursive: true });
  must("python3", [
    "-I",
    "-c",
    `import sqlite3,sys
c=sqlite3.connect(sys.argv[1]); c.execute('PRAGMA journal_mode=WAL')
c.execute('create table schema_migrations(version)'); c.execute('insert into schema_migrations values(47)')
c.execute('create table projection_agents(id, name)'); c.executemany('insert into projection_agents values(?,?)', [(i, 'agent ${MARKER}') for i in range(50)])
c.commit()
m=sqlite3.connect(sys.argv[2]); m.execute('create table issues(id, title)'); m.execute("insert into issues values(1,'ticket')"); m.commit()`,
    join(data, ".config/OpenBot/openbot.db"),
    join(motion, "data/motion.db"),
  ]);
  writeFileSync(join(data, ".config/OpenBot/openbot-settings-v1.json"), `{"note":"${MARKER}"}\n`);
  writeFileSync(join(data, ".config/OpenBot/Cache/blob"), "cache");
  writeFileSync(join(data, ".claude/projects/agent-1/turn.jsonl"), `{"text":"${MARKER}"}\n`);
  writeFileSync(join(data, ".codex/sessions/2026/s.jsonl"), "{}\n");
  writeFileSync(join(data, "OpenBot/Agents/Ana/notes.md"), "notes\n");
  writeFileSync(join(data, "OpenBot/Spaces/shop/Shared/site/index.html"), "<h1>shop</h1>\n");
  writeFileSync(join(data, "OpenBot/Spaces/shop/Shared/site/node_modules/left-pad/index.js"), "x\n");
  writeFileSync(join(data, "OpenBot/Spaces/shop/Shared/site/dist/bundle.js"), "x\n");
  writeFileSync(join(data, "OpenBot/Spaces/shop/Shared/videos/launch.mp4"), Buffer.alloc(3 << 20, 7));
  writeFileSync(join(motion, "data/files/attachment.txt"), "file\n");
  // A clone with a remote and one commit that was never pushed, and an uncommitted change.
  const clone = join(data, "OpenBot/Spaces/shop/Shared/app");
  mkdirSync(clone);
  const git = (...args: string[]) =>
    must("git", ["-c", "user.email=e2e@atelier", "-c", "user.name=e2e", "-C", clone, ...args]);
  git("init", "-q");
  writeFileSync(join(clone, "main.ts"), "export {}\n");
  git("add", ".");
  git("commit", "-q", "-m", "pushed");
  git("remote", "add", "origin", "https://example.invalid/shop/app.git");
  git("update-ref", "refs/remotes/origin/main", "HEAD");
  writeFileSync(join(clone, "feature.ts"), "export const x = 1\n");
  git("add", ".");
  git("commit", "-q", "-m", "unpushed work");
  writeFileSync(join(clone, "main.ts"), "export const changed = true\n");
}

/** A stand-in for rclone's Proton Drive backend: a fixed account, a session, and a folder as the drive. */
function writeStub(realRclone: string): string {
  const path = join(stub, "rclone");
  writeFileSync(
    path,
    `#!/usr/bin/env python3
import os, secrets, subprocess, sys, tempfile
REAL = ${JSON.stringify(realRclone)}
STATE = ${JSON.stringify(stub)}
DRIVE = ${JSON.stringify(drive)}
args = sys.argv[1:]
conf = None
if "--config" in args:
    i = args.index("--config"); conf = args[i + 1]; del args[i:i + 2]
conf = conf or os.environ.get("RCLONE_CONFIG")
def real(extra_env=None, argv=None):
    os.execve(REAL, [REAL, *(argv if argv is not None else sys.argv[1:])], {**os.environ, **(extra_env or {})})
if not conf or not args or args[0] in ("obscure", "reveal", "version") or not os.path.exists(conf):
    real()
text = open(conf).read()
if "type = protondrive" not in text:
    real()
values = {}
for line in text.splitlines():
    if " = " in line:
        key, value = line.split(" = ", 1); values[key.strip()] = value.strip()
def fail(message):
    sys.stderr.write(message + "\\n"); sys.exit(1)
with open(os.path.join(STATE, "calls"), "a") as log:
    log.write(args[0] + "\\n")
if os.path.exists(os.path.join(STATE, "network")):
    fail("Failed to create file system: dial tcp: lookup drive-api.proton.me: no such host")
session_file = os.path.join(STATE, "session")
if values.get("client_refresh_token"):
    if os.path.exists(os.path.join(STATE, "expired")) or not os.path.exists(session_file) \\
            or open(session_file).read() != values["client_refresh_token"]:
        fail("401 POST https://drive-api.proton.me/auth/refresh: Invalid refresh token (Code=10013, Status=401)")
else:
    password = subprocess.run([REAL, "reveal", values.get("password", "")], capture_output=True, text=True).stdout.strip()
    if values.get("username") != ${JSON.stringify(EMAIL)} or password != ${JSON.stringify(PASSWORD)}:
        fail("422 POST https://drive-api.proton.me/auth/v4: Incorrect login credentials. Please try again. (Code=8002, Status=422)")
    if values.get("2fa") != ${JSON.stringify(TWO_FA)}:
        fail("couldn't initialize a new proton drive instance: this account requires a 2FA code")
    token = secrets.token_hex(16)
    open(session_file, "w").write(token)
    lines = [line for line in text.splitlines() if not line.startswith("2fa")]
    lines += ["client_uid = uid-" + token[:6], "client_access_token = acc-" + token,
              "client_refresh_token = " + token, "client_salted_key_pass = salt-" + token[:8]]
    open(conf, "w").write("\\n".join(lines) + "\\n")
local = tempfile.NamedTemporaryFile("w", suffix=".conf", delete=False)
local.write("[drive]\\ntype = local\\n"); local.close()
os.chdir(DRIVE)
real({"RCLONE_CONFIG": local.name}, ["--config", local.name, *args])
`,
  );
  must("chmod", ["755", path]);
  return path;
}

async function waitFor<T>(what: string, read: () => Promise<T | null | undefined>, seconds = 300): Promise<T> {
  const deadline = Date.now() + seconds * 1000;
  while (Date.now() < deadline) {
    const value = await read();
    if (value) return value;
    await new Promise((done) => setTimeout(done, 500));
  }
  throw new Error(`Timed out waiting for ${what}.`);
}

let clock = Date.now();
const alerts: string[] = [];
let draining = false;

try {
  fixture();
  // The pinned tools, as the broker fetches and checks them (cached between runs).
  const tools: { rclone: string; restic: string } = JSON.parse(
    must("python3", ["-I", BROKER, "cloud-tools"], {
      env: { ...process.env, ATELIER_BACKUP_ROOT: join(root, "b"), ATELIER_CLOUD_TOOLS_DIR: TOOLS },
    }),
  );
  check(
    "pinned tools fetched and checked",
    existsSync(tools.rclone) && existsSync(tools.restic),
    JSON.stringify(tools),
  );
  const rclone = writeStub(tools.rclone);
  const brokerRoot = join(root, "b");
  mkdirSync(brokerRoot, { recursive: true });
  const uid = process.getuid?.() ?? 1000;
  writeFileSync(
    join(brokerRoot, "config.json"),
    JSON.stringify({
      data_dir: data,
      host_dir: root,
      compose_file: join(root, "none.yaml"),
      data_uid: uid,
      motion: { enabled: true, dir: motion, uid },
      peer_policy: "any",
      min_free_gb: 0,
      cloud: { rclone, restic: tools.restic },
    }),
  );
  broker = spawn("python3", ["-I", BROKER, "serve"], {
    env: { ...process.env, ATELIER_BACKUP_ROOT: brokerRoot, ATELIER_CLOUD_TOOLS_DIR: TOOLS },
    stdio: ["ignore", "inherit", "inherit"],
  });
  const socket = join(brokerRoot, "client/backupd.sock");
  await waitFor("the broker socket", async () => existsSync(socket), 30);

  const cipher = {
    encrypt: (value: string) => Buffer.from(Buffer.from(value).map((byte) => byte ^ 0x5a)),
    decrypt: (value: Buffer) => Buffer.from(value.map((byte) => byte ^ 0x5a)).toString(),
  };
  const host = new HostBackups(socket);
  const cloud = new CloudBackups({
    broker: host,
    directory: userData,
    cipher,
    isDraining: () => draining,
    alertOwner: (text) => alerts.push(text(t).title),
    log: (line) => process.stdout.write(`  ${line}\n`),
    now: () => clock,
    serverName: () => "Test Host",
  });
  const ready = async () => {
    const view = await cloud.overview();
    assert.ok(view.available);
    return view;
  };
  /** Waits until the schedule has collected the job that was started (its tokens and its result). */
  const settle = async () => {
    await waitFor(
      "the job to end",
      async () => {
        await cloud.tick();
        const saved = JSON.parse(readFileSync(join(userData, "openbot-cloud-backups-v1.json"), "utf8"));
        return saved.pendingJob === null;
      },
      600,
    );
    return ready();
  };

  // ---- sign-in -------------------------------------------------------------------------------------
  const wrong = await cloud.connect({ provider: "proton", email: EMAIL, password: "wrong" });
  check("a wrong password is named as such", !wrong.ok && wrong.problem === "credentials", JSON.stringify(wrong));
  const noCode = await cloud.connect({ provider: "proton", email: EMAIL, password: PASSWORD });
  check("an account with 2FA asks for the code", !noCode.ok && noCode.problem === "two-factor", JSON.stringify(noCode));
  const connected = await cloud.connect({
    provider: "proton",
    email: EMAIL,
    password: PASSWORD,
    twoFactorCode: TWO_FA,
  });
  assert.ok(connected.ok, `connect failed: ${JSON.stringify(connected)}`);
  const repositoryPassword = connected.repositoryPassword ?? "";
  check("the copies' password is answered once", repositoryPassword.length >= 30);
  check(
    "a new repository was made in the default folder of the drive",
    existsSync(join(drive, "Atelier Backups/Test Host/config")),
  );
  const secretsFile = readFileSync(join(userData, "openbot-cloud-backups-secrets-v1.json"), "utf8");
  check(
    "the sign-in, session and password are only in the encrypted store",
    !secretsFile.includes(PASSWORD) &&
      !secretsFile.includes(repositoryPassword) &&
      !readFileSync(join(userData, "openbot-cloud-backups-v1.json"), "utf8").includes(PASSWORD),
  );
  const brokerFiles = walk(brokerRoot)
    .map((rel) => join(brokerRoot, rel))
    .filter((path) => statSync(path).isFile() && statSync(path).size < 1 << 20);
  check(
    "the broker keeps no secret after a command",
    !brokerFiles.some((path) => {
      const text = readFileSync(path, "utf8");
      return text.includes(PASSWORD) || text.includes(repositoryPassword);
    }),
  );
  const again = await cloud.connect({ provider: "proton", email: EMAIL, password: PASSWORD, twoFactorCode: TWO_FA });
  check(
    "connecting again opens the same copies, without a new password",
    again.ok && !("repositoryPassword" in again && again.repositoryPassword),
  );
  check("the drive's space is shown", (await ready()).destinations[0]?.space?.totalBytes !== undefined);

  await cloud.setPlan({ ...(await ready()).plan, largeFileMb: 1 });
  // ---- the first copy ------------------------------------------------------------------------------
  draining = true;
  clock += 2 * 3_600_000;
  await cloud.tick();
  {
    const held = await ready();
    check("no copy starts while a deploy drains the host", held.running === null && held.lastBackup === null);
  }
  draining = false;
  await cloud.tick();
  let view = await ready();
  check(
    "a due copy starts by itself",
    JSON.parse(readFileSync(join(userData, "openbot-cloud-backups-v1.json"), "utf8")).pendingJob?.kind === "backup",
  );
  view = await settle();
  check("the first copy succeeded", view.lastBackup?.ok === true, JSON.stringify(view.lastBackup));
  check(
    "each group has a size",
    view.sizes.length === 6 && (view.sizes.find((row) => row.group === "work")?.bytes ?? 0) > 0,
    JSON.stringify(view.sizes),
  );
  check("the typical run is measured", (view.typical?.runs ?? 0) >= 1, JSON.stringify(view.typical));
  check("the session (no 2FA again) was used", !readFileSync(join(stub, "calls"), "utf8").split("\n").includes("2fa"));

  let repoFolder = "Atelier Backups/Test Host";
  const restic = (...args: string[]) =>
    must(tools.restic, ["-r", join(drive, repoFolder), ...args], {
      env: { ...process.env, RESTIC_PASSWORD: repositoryPassword },
    });
  const listing = restic("ls", "latest");
  check(
    "the database is a consistent copy",
    /cloud-stage\/db\/openbot\.db/u.test(listing) && /cloud-stage\/db\/motion\.db/u.test(listing),
  );
  check(
    "conversations, agents, settings and Motion files are in",
    ["turn.jsonl", "Agents/Ana/notes.md", "openbot-settings-v1.json", "files/attachment.txt", "s.jsonl"].every((part) =>
      listing.includes(part),
    ),
  );
  check("finished work is in", listing.includes("Shared/site/index.html"));
  check("build output and caches are out", !/node_modules|\/dist\/|Cache\/blob/u.test(listing));
  check("very large media is out", !listing.includes("launch.mp4"));
  check(
    "a clone with a remote is replaced by a bundle and a patch",
    !listing.includes("Shared/app/main.ts") &&
      /git\/0000\/unpushed\.bundle/u.test(listing) &&
      /git\/0000\/uncommitted\.patch/u.test(listing),
  );
  check("the live WAL files are not copied", !/openbot\.db-wal|openbot\.db-shm/u.test(listing));
  const rawDrive = walk(drive).map((rel) => readFileSync(join(drive, rel)));
  check("the drive holds only encrypted data", rawDrive.length > 0 && !rawDrive.some((blob) => blob.includes(MARKER)));

  // ---- busy, retention, restore test -------------------------------------------------------------------
  await cloud.runNow("backup");
  let busy = "";
  try {
    await cloud.runNow("backup");
  } catch (error) {
    busy = String(error);
  }
  check("a second run while one goes is refused, not queued", busy.length > 0, busy);
  await settle();
  await cloud.setPlan({
    ...(await ready()).plan,
    retention: { keepAll: false, allWithinHours: 0, daily: 1, weekly: 0, monthly: 0 },
  });
  await cloud.runNow("backup");
  view = await settle();
  const snapshots: unknown[] = JSON.parse(restic("snapshots", "--json"));
  check(
    "retention keeps what the plan says",
    view.lastBackup?.ok === true && snapshots.length === 1,
    `${snapshots.length} snapshots`,
  );
  await cloud.setPlan({
    ...(await ready()).plan,
    retention: { keepAll: true, allWithinHours: 48, daily: 14, weekly: 8, monthly: 12 },
  });
  await cloud.runNow("test");
  view = await settle();
  check(
    "the restore test restores a sample and checks the copies",
    view.lastTest?.ok === true,
    JSON.stringify(view.lastTest),
  );

  // ---- a failure pushes once -----------------------------------------------------------------------
  writeFileSync(join(stub, "network"), "");
  await cloud.runNow("backup");
  view = await settle();
  await cloud.runNow("backup");
  view = await settle();
  rmSync(join(stub, "network"));
  check(
    "a failed copy is explained in plain words",
    view.lastBackup?.ok === false && view.lastBackup.problem === "network",
    JSON.stringify(view.lastBackup),
  );
  check(
    "the owner is pushed once per failure, not each run",
    alerts.filter((title) => title === t("backups.cloud.push.failedTitle")).length === 1,
    JSON.stringify(alerts),
  );

  // ---- the sign-in expires ---------------------------------------------------------------------------
  writeFileSync(join(stub, "expired"), "");
  await cloud.runNow("backup");
  view = await settle();
  check(
    "an expired session asks the owner to sign in again",
    view.destinations[0]?.status === "relogin" && view.warnings.includes("relogin"),
  );
  check(
    "the owner gets the sign-in push",
    alerts.includes(t("backups.cloud.push.reloginTitle")),
    JSON.stringify(alerts),
  );
  clock += 3 * 3_600_000;
  await cloud.tick();
  check("no copy starts while the sign-in is needed", (await ready()).running === null);
  rmSync(join(stub, "expired"));
  rmSync(join(stub, "session"), { force: true });
  const relogin = await cloud.connect({ provider: "proton", email: EMAIL, password: PASSWORD, twoFactorCode: TWO_FA });
  check(
    "signing in again resumes the copies",
    relogin.ok && relogin.overview.available && relogin.overview.destinations[0]?.status === "ok",
  );
  await cloud.runNow("backup");
  view = await settle();
  check("the next copy succeeds", view.lastBackup?.ok === true);

  // ---- restore -------------------------------------------------------------------------------------
  const list = await cloud.snapshots();
  check("the copies are listed", list.ok && list.snapshots.length >= 1);
  const newest = list.snapshots[0]?.id ?? "";
  writeFileSync(join(data, ".claude/projects/agent-1/turn.jsonl"), "changed after the copy\n");
  await cloud.restore(newest, newest);
  view = await settle();
  const restored = view.restores.at(-1);
  check("a copy restores into its own folder", restored?.status === "ok", JSON.stringify(restored));
  check(
    "live data is not touched by a restore",
    readFileSync(join(data, ".claude/projects/agent-1/turn.jsonl"), "utf8") === "changed after the copy\n",
  );
  const prepared = await cloud.prepareRestore(restored?.id ?? "");
  const local: { ok: boolean; restore: string[] } = JSON.parse(
    must("python3", ["-I", BROKER, "check", prepared.backupId], {
      env: { ...process.env, ATELIER_BACKUP_ROOT: brokerRoot },
    }),
  );
  check(
    "the restored copy becomes a backup that Restore can put back",
    local.ok && local.restore.includes("database") && local.restore.includes("files:.claude/projects"),
    JSON.stringify(local.restore),
  );
  check(
    "each copy says what it holds",
    ["database", "conversations", "agents", "settings", "motion", "work"].every((group) =>
      list.snapshots[0]?.groups.some((held) => held === group),
    ),
    JSON.stringify(list.snapshots[0]?.groups),
  );

  // ---- a part of a copy, and one file ------------------------------------------------------------------
  const restoredFiles = (id: string | undefined) => walk(join(brokerRoot, "cloud-restores", id ?? "missing"));
  await cloud.restore(newest, newest, { groups: ["conversations"] });
  view = await settle();
  const some = restoredFiles(view.restores.at(-1)?.id);
  check(
    "a restore of some parts takes only those parts",
    view.restores.at(-1)?.partial === true &&
      some.some((rel) => rel.endsWith("turn.jsonl")) &&
      !some.some((rel) => rel.endsWith("Ana/notes.md") || rel.endsWith("openbot.db")),
    some.join(", "),
  );
  const notes = join(data, "OpenBot/Agents/Ana/notes.md");
  const browsed = await cloud.browse(newest, join(data, "OpenBot/Agents/Ana"));
  check(
    "a copy's folders can be browsed",
    browsed.ok && browsed.entries.some((entry) => entry.path === notes),
    JSON.stringify(browsed),
  );
  await cloud.restore(newest, newest, { paths: [notes] });
  view = await settle();
  const one = restoredFiles(view.restores.at(-1)?.id);
  check("one file restores by itself", one.length === 1 && (one[0] ?? "").endsWith("Ana/notes.md"), one.join(", "));

  // ---- round trip: back up, wipe a staging copy, restore, compare ------------------------------------------
  const { createHash } = await import("node:crypto");
  const kept = (rel: string) => !/node_modules|\/dist\/|Cache\/|launch\.mp4|Shared\/app\/|openbot\.db/u.test(rel);
  const fingerprint = (dir: string) =>
    new Map(
      walk(dir)
        .filter(kept)
        .map((rel) => [
          rel,
          createHash("sha256")
            .update(readFileSync(join(dir, rel)))
            .digest("hex"),
        ]),
    );
  await cloud.runNow("backup");
  view = await settle();
  const before = fingerprint(data);
  const staging = join(root, "staging");
  must("cp", ["-a", data, staging]);
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(staging);
  const latest = (await cloud.snapshots()).snapshots[0]?.id ?? "";
  await cloud.restore(latest, latest);
  view = await settle();
  const full = join(brokerRoot, "cloud-restores", view.restores.at(-1)?.id ?? "missing");
  must("cp", ["-a", `${join(full, data)}/.`, staging]);
  const after = fingerprint(staging);
  const differing = [...before].filter(([rel, hash]) => after.get(rel) !== hash).map(([rel]) => rel);
  check(
    "a full restore brings every file back equal",
    before.size >= 5 && differing.length === 0,
    `${before.size} files; differing: ${differing.join(", ")}`,
  );
  const rows = must("python3", [
    "-I",
    "-c",
    "import sqlite3,sys; print(sqlite3.connect(sys.argv[1]).execute('select count(*) from projection_agents').fetchone()[0])",
    join(full, brokerRoot, "cloud-stage/db/openbot.db"),
  ]).trim();
  check("the restored database holds the same rows", rows === "50", rows);

  // ---- the drive folder --------------------------------------------------------------------------------
  const top = await cloud.folders("Atelier Backups", false);
  check("the drive's folders are listed", top.ok && top.folders.includes("Test Host"), JSON.stringify(top));
  check("a folder with copies is recognized", (await cloud.folders("Atelier Backups/Test Host", false)).hasCopies);
  const made = await cloud.folders("Atelier Backups/Moved", true);
  check("a folder can be made", made.ok && !made.hasCopies && existsSync(join(drive, "Atelier Backups/Moved")));
  const moved = await cloud.changeFolder("Atelier Backups/Moved", "move");
  view = await settle();
  repoFolder = "Atelier Backups/Moved";
  check(
    "the copies move to another folder",
    moved.ok &&
      view.destinations[0]?.folder === "Atelier Backups/Moved" &&
      existsSync(join(drive, "Atelier Backups/Moved/config")) &&
      !existsSync(join(drive, "Atelier Backups/Test Host/config")),
    JSON.stringify(view.destinations[0]),
  );
  const movedSnapshots: unknown[] = JSON.parse(restic("snapshots", "--json"));
  const movedCount = movedSnapshots.length;
  await cloud.runNow("backup");
  view = await settle();
  check("copies go on in the moved folder", view.lastBackup?.ok === true && movedCount >= 1);
  const fresh = await cloud.changeFolder("Fresh start", "use");
  check(
    "another folder can start fresh",
    fresh.ok && existsSync(join(drive, "Fresh start/config")),
    JSON.stringify(fresh),
  );
  await cloud.runNow("backup");
  view = await settle();
  repoFolder = "Fresh start";
  const freshCount: unknown[] = JSON.parse(restic("snapshots", "--json"));
  check("the fresh folder keeps its own copies", view.lastBackup?.ok === true && freshCount.length === 1);
} catch (error) {
  check("the run finished", false, error instanceof Error ? (error.stack ?? error.message) : String(error));
} finally {
  broker?.kill();
  const failed = results.filter((row) => !row.ok);
  writeFileSync(join(OUT, "report.json"), `${JSON.stringify({ passed: failed.length === 0, results }, null, 2)}\n`);
  if (failed.length === 0) rmSync(root, { recursive: true, force: true });
  else process.stdout.write(`Kept ${root} for a look.\n`);
  process.stdout.write(
    `${results.length - failed.length}/${results.length} passed. Report: ${join(OUT, "report.json")}\n`,
  );
  process.exit(failed.length === 0 ? 0 : 1);
}
