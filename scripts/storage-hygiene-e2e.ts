// Drives the real storage hygiene host process over its stdio transport against a tree it builds in
// a temporary folder: Rust clones with `target/`, a Godot game repository with worktrees, plain
// copies, repository copies and game exports in a `notes` evidence folder, screenshots, and an agent
// workspace. It checks the classification, that a cleanup deletes the planned items and only them,
// that recent and canonical work stays, the audit file, and that the second scan is incremental.
//
// Run: bun scripts/storage-hygiene-e2e.ts [--large=<files>]
// Writes .openbot-build/storage-hygiene-e2e.json. Never touches a folder outside its temporary one.

import { execFileSync, spawn } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import type { StorageHygieneApplyOutcome } from "../src/backend/storage-hygiene-apply";
import type { StorageHygieneHostRequest, StorageHygieneHostResponse } from "../src/backend/storage-hygiene-protocol";
import type { StorageHygieneScanRequest, StorageHygieneScanResult } from "../src/backend/storage-hygiene-scan";

const DAY = 86_400_000;
const large = Number(process.argv.find((arg) => arg.startsWith("--large="))?.slice(8) ?? 0);

function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`storage-hygiene-e2e: ${message}`);
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "e2e",
      GIT_AUTHOR_EMAIL: "e2e@example.invalid",
      GIT_COMMITTER_NAME: "e2e",
      GIT_COMMITTER_EMAIL: "e2e@example.invalid",
    },
    encoding: "utf8",
  }).trim();
}

async function file(path: string, bytes: number): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, Buffer.alloc(bytes, 7));
}

/** Sets every file and folder under `path` (and `path`) to `age` milliseconds ago. */
async function age(path: string, ago: number): Promise<void> {
  const time = new Date(Date.now() - ago);
  const info = await stat(path);
  if (info.isDirectory()) for (const name of await readdir(path)) await age(join(path, name), ago);
  await utimes(path, time, time);
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  );
}

const root = await mkdtemp(join(tmpdir(), "openbot-storage-hygiene-"));
const shared = join(root, "Shared");
const agentRoot = join(root, "Agents", "agent-1");
const state = join(root, "state");

// piks: two clones of one Rust repository, each with build output.
for (const clone of ["a", "b"]) {
  const dir = join(shared, "piks", "clones", clone);
  await mkdir(dir, { recursive: true });
  git(dir, "init", "-q", "-b", "main");
  await writeFile(join(dir, "Cargo.toml"), '[package]\nname = "piks"\n');
  await writeFile(join(dir, ".gitignore"), "target/\n");
  git(dir, "add", ".");
  git(dir, "commit", "-q", "-m", "init");
  for (let index = 0; index < 20; index += 1)
    await file(join(dir, "target", "debug", "deps", `lib${index}.rlib`), 50_000);
}

// cakemaker: the canonical game repository, a merged worktree, plain copies, and notes.
const game = join(shared, "cakemaker", "game");
await mkdir(game, { recursive: true });
git(game, "init", "-q", "-b", "main");
await writeFile(join(game, "project.godot"), "config_version=5\n");
await writeFile(join(game, ".gitignore"), ".godot/\nbuild/\n");
await writeFile(join(game, "main.gd"), "extends Node\n");
git(game, "add", ".");
git(game, "commit", "-q", "-m", "game");
await file(join(game, ".godot", "imported", "a.ctex"), 80_000);
await file(join(game, "build", "game.pck"), 90_000);
const work = join(shared, "cakemaker", "work");
await mkdir(work, { recursive: true });
git(game, "worktree", "add", "-q", "-b", "feature", join(work, "wt-merged"));
await file(join(work, "wt-merged", ".godot", "x.ctex"), 30_000);
git(game, "worktree", "add", "-q", "-b", "unmerged", join(work, "wt-unmerged"));
await writeFile(join(work, "wt-unmerged", "new.gd"), "extends Node2D\n");
git(join(work, "wt-unmerged"), "add", ".");
git(join(work, "wt-unmerged"), "commit", "-q", "-m", "work in progress");
await file(join(work, "copy-old", "main.gd"), 20_000);
await file(join(work, "copy-old", "project.godot"), 100);
await file(join(work, "copy-fresh", "main.gd"), 20_000);
const notes = join(shared, "cakemaker", "notes", "2026-10-01");
await mkdir(notes, { recursive: true });
git(notes, "clone", "-q", game, "game-copy");
await file(join(notes, "builds", "game.x86_64"), 120_000);
await file(join(notes, "builds", "game.pck"), 60_000);
await file(join(notes, "builds", "README.md"), 100);
await file(join(notes, "shots", "old.png"), 40_000);
await file(join(notes, "shots", "new.png"), 40_000);
await writeFile(join(notes, "report.md"), "See shots/old.png\n");
for (let index = 0; index < large; index += 1)
  await file(join(shared, "bulk", `d${Math.floor(index / 500)}`, `f${index}.txt`), 100);

// An agent workspace with installed packages and real files.
await file(join(agentRoot, "site", "package.json"), 20);
await file(join(agentRoot, "site", "node_modules", "left-pad", "index.js"), 30_000);
await file(join(agentRoot, "site", "index.html"), 2_000);

// Everything is old except the fresh copy and the new screenshot.
await age(shared, 40 * DAY);
await age(agentRoot, 3 * DAY);
await age(join(work, "copy-fresh"), 0);
await age(join(notes, "shots", "new.png"), 0);

// A stand-in `cwebp` when none is installed: it writes a small file, so the conversion steps run.
const bin = join(root, "bin");
await mkdir(bin);
let fakeTool = false;
try {
  execFileSync("cwebp", ["-version"], { stdio: "ignore" });
} catch {
  fakeTool = true;
  // `cwebp -version` succeeds; `cwebp ... -o out` writes `out`.
  await writeFile(
    join(bin, "cwebp"),
    '#!/bin/sh\nout=""\nwhile [ $# -gt 0 ]; do [ "$1" = "-o" ] && out="$2"; shift; done\n[ -n "$out" ] && printf "RIFF0000WEBPVP8 " > "$out"\nexit 0\n',
    { mode: 0o755 },
  );
}
const host = spawn(process.execPath, [resolve("src/backend/storage-hygiene-host.ts")], {
  stdio: ["pipe", "pipe", "inherit"],
  env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}` },
});
const responses = createInterface({ input: host.stdout });
const waiting = new Map<number, (response: StorageHygieneHostResponse) => void>();
responses.on("line", (line) => {
  const response: StorageHygieneHostResponse = JSON.parse(line);
  if (response.kind !== "progress") waiting.get(response.id)?.(response);
});
let nextId = 1;
function send(request: StorageHygieneHostRequest): Promise<StorageHygieneHostResponse> {
  return new Promise((done) => {
    waiting.set(request.id, done);
    host.stdin.write(`${JSON.stringify(request)}\n`);
  });
}

const scanRequest = (force: boolean): StorageHygieneScanRequest => ({
  areas: [
    { kind: "project", name: "piks", root: join(shared, "piks") },
    { kind: "project", name: "cakemaker", root: join(shared, "cakemaker") },
    ...(large ? [{ kind: "project" as const, name: "bulk", root: join(shared, "bulk") }] : []),
    { kind: "agent", name: "agent-1", agentId: "agent-1", root: agentRoot },
  ],
  diskPath: root,
  now: Date.now(),
  staleIdleHours: 24,
  evidenceDeleteAfterDays: 30,
  evidenceConvertAfterDays: 7,
  force,
  cachePath: join(state, "scan-cache.json"),
  entryLimit: 20_000_000,
});

async function scan(force: boolean): Promise<StorageHygieneScanResult> {
  const response = await send({ id: nextId++, kind: "scan", request: scanRequest(force) });
  check(response.kind === "scan", `scan failed: ${JSON.stringify(response)}`);
  return response.result;
}

const first = await scan(true);
const byPath = new Map(first.plan.map((item) => [`${item.rule} ${item.absolutePath}`, item]));
const has = (rule: string, path: string) => byPath.has(`${rule} ${path}`);
check(has("cargo-target", join(shared, "piks", "clones", "a", "target")), "clone a target");
check(has("cargo-target", join(shared, "piks", "clones", "b", "target")), "clone b target");
check(has("godot-cache", join(game, ".godot")), "game .godot");
check(has("build-output", join(game, "build")), "ignored build output");
check(has("stale-worktree", join(work, "wt-merged")), "merged worktree");
check(!first.plan.some((item) => item.absolutePath === join(work, "wt-unmerged")), "unmerged worktree stays");
check(has("stale-copy", join(work, "copy-old")), "old plain copy");
check(!first.plan.some((item) => item.absolutePath === join(work, "copy-fresh")), "fresh copy stays");
check(has("repo-copy", join(notes, "game-copy", ".git")), "repository copy in notes");
check(has("build-export", join(notes, "builds")), "game exports in notes");
check(has("evidence-media", join(notes, "shots")), "old screenshots");
check(has("node-modules", join(agentRoot, "site", "node_modules")), "agent node_modules");
check(!first.plan.some((item) => item.absolutePath === join(game, ".git")), "canonical repository stays");
const nested = byPath.get(`godot-cache ${join(work, "wt-merged", ".godot")}`);
const outer = byPath.get(`stale-worktree ${join(work, "wt-merged")}`);
check(nested && outer && nested.nestedIn === outer.id, "worktree cache is nested in the worktree");
check(
  first.convertible.some((group) => group.names.includes("old.png")),
  "old screenshot can be converted",
);
const cakemaker = first.report.areas.find((area) => area.name === "cakemaker");
check(cakemaker && cakemaker.breakdown.regenerable > 0 && cakemaker.breakdown.stale > 0, "cakemaker breakdown");
check(cakemaker.breakdown.evidence > 0 && cakemaker.breakdown.real > 0, "cakemaker evidence and real bytes");

// A cleanup of every recommended item while a process works in clone b.
const busy = spawn("sleep", ["30"], { cwd: join(shared, "piks", "clones", "b", "target") });
const items = first.plan.filter((item) => item.recommended);
const applied = await send({
  id: nextId++,
  kind: "apply",
  request: {
    items,
    now: Date.now(),
    recentMinutes: 30,
    staleIdleHours: 24,
    minimumIdleHours: null,
    trigger: "manual",
    actor: "e2e",
    auditPath: join(state, "audit.jsonl"),
  },
});
busy.kill();
check(applied.kind === "apply", `apply failed: ${JSON.stringify(applied)}`);
const outcome: StorageHygieneApplyOutcome = applied.result;
check(!(await exists(join(shared, "piks", "clones", "a", "target"))), "clone a target deleted");
check(await exists(join(shared, "piks", "clones", "b", "target")), "busy target kept");
check(
  outcome.skipped.some((skip) => skip.reason === "busy" && skip.path.endsWith("clones/b/target")),
  "busy skip reported",
);
check(!(await exists(join(work, "wt-merged"))), "merged worktree removed");
check(!git(game, "worktree", "list").includes("wt-merged"), "worktree pruned");
check(await exists(join(work, "wt-unmerged", "new.gd")), "unmerged worktree kept");
check(!(await exists(join(work, "copy-old"))), "old copy removed");
check(await exists(join(work, "copy-fresh", "main.gd")), "fresh copy kept");
check(!(await exists(join(notes, "game-copy", ".git"))), "repository copy .git removed");
check(await exists(join(notes, "game-copy", "main.gd")), "files of the copy kept");
check(!(await exists(join(notes, "builds", "game.pck"))), "export removed");
check(await exists(join(notes, "builds", "README.md")), "notes text kept");
check(await exists(join(notes, "shots", "old.png")), "evidence media not recommended, kept");
check((await exists(join(game, ".git"))) && git(game, "status", "--porcelain") === "", "canonical repository intact");
check(await exists(join(game, "main.gd")), "game source intact");
check(await exists(join(agentRoot, "site", "index.html")), "agent files intact");
const audit = (await readFile(join(state, "audit.jsonl"), "utf8"))
  .trim()
  .split("\n")
  .map((line) => JSON.parse(line));
check(audit.length === items.filter((item) => !item.nestedIn).length, "one audit line per outer item");

const second = await scan(false);
check(second.report.incremental, "second scan uses the cache");
check(!second.plan.some((item) => item.absolutePath === join(work, "wt-merged")), "removed items are gone");

// The WebP conversion of the old screenshot, which the report links to.
const tool = await send({ id: nextId++, kind: "webp-tool" });
check(tool.kind === "webp-tool" && tool.result === "cwebp", "cwebp found");
const converted = await send({
  id: nextId++,
  kind: "convert",
  request: {
    convertible: second.convertible,
    tool: tool.result,
    now: Date.now(),
    recentMinutes: 30,
    limit: 100,
    trigger: "automatic",
    auditPath: join(state, "audit.jsonl"),
  },
});
check(converted.kind === "convert", `convert failed: ${JSON.stringify(converted)}`);
if (fakeTool) {
  check(converted.result.converted === 1, "one screenshot converted");
  check(!(await exists(join(notes, "shots", "old.png"))), "PNG replaced");
  check(await exists(join(notes, "shots", "old.webp")), "WebP written");
  check((await stat(join(notes, "shots", "old.webp"))).mtimeMs < Date.now() - 30 * DAY, "WebP keeps the old time");
  check(await exists(join(notes, "shots", "new.png")), "new screenshot kept");
  check((await readFile(join(notes, "report.md"), "utf8")).includes("shots/old.webp"), "report points at the WebP");
}
const conversion = converted.result;

host.stdin.end();
const output = resolve(".openbot-build/storage-hygiene-e2e.json");
await mkdir(join(output, ".."), { recursive: true });
await writeFile(
  output,
  JSON.stringify(
    {
      ok: true,
      firstScan: { durationMs: first.report.durationMs, entries: first.report.entries, items: first.plan.length },
      secondScan: { durationMs: second.report.durationMs, entries: second.report.entries, incremental: true },
      cleanup: { freedBytes: outcome.freedBytes, deleted: outcome.deleted, skipped: outcome.skipped },
      webpTool: fakeTool ? "cwebp (stand-in)" : tool.result,
      conversion,
      rules: [...new Set(first.plan.map((item) => item.rule))].sort(),
    },
    null,
    2,
  ),
);
await rm(root, { recursive: true, force: true });
process.stdout.write(`storage-hygiene-e2e: ok (${output})\n`);
