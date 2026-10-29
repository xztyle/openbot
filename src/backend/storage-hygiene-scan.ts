// The storage hygiene scan: the disk use of the agents' shared projects and workspaces, sorted into
// real work, regenerable output, stale copies and evidence media, and the cleanup plan.
//
// It runs in the storage hygiene host process (`storage-hygiene-host.ts`), so its runtime imports are
// `node:*` and the small contract value guards. It never follows a symbolic link and never leaves the device of an area root.
// Rules, in short (docs/storage-hygiene.md has the full list):
//
// - Regenerable: `target/` next to `Cargo.toml` (or tagged with `CACHEDIR.TAG`), `node_modules`,
//   `.godot`, `dist|build|out` next to a project manifest that git ignores, and, inside evidence
//   folders (`notes`, `evidence`, ...), repository copies (a `.git` folder whose commits are all in a
//   canonical repository of the area) and game export files (`.pck .x86_64 .exe .zip`).
// - Stale: a git worktree that is clean, merged and idle; a repository nested in another work tree
//   that is clean, idle and has no commit of its own; a folder without git in a `work`, `worktrees` or
//   `copies` folder that is idle.
// - Evidence media: screenshots and recordings in evidence folders, by age.
// - Everything else is real work, and a canonical repository is never removable.
//
// Incremental: a folder whose modification time did not change keeps the file sizes of the scan
// before, and a regenerable folder keeps its size for `OPAQUE_TTL_MS`. A cleanup checks every item
// again from the disk, so a size that is out of date never decides a deletion.

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import type { Dirent, Stats } from "node:fs";
import { lstat, mkdir, readdir, readFile, rename, rm, statfs, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, sep } from "node:path";
import type {
  StorageHygieneArea,
  StorageHygieneAreaKind,
  StorageHygieneBreakdown,
  StorageHygieneClass,
  StorageHygieneDisk,
  StorageHygieneFolder,
  StorageHygieneItem,
  StorageHygieneReport,
  StorageHygieneRule,
} from "@openbot/contracts/ipc";
import { isDynamicRecord } from "@openbot/contracts/runtime-values";

export interface StorageHygieneScanArea {
  kind: StorageHygieneAreaKind;
  /** The folder name of a project, or the agent id. */
  name: string;
  agentId?: string;
  root: string;
}

export interface StorageHygieneScanRequest {
  areas: StorageHygieneScanArea[];
  /** A path on the disk that holds the data, for the free space. */
  diskPath: string;
  now: number;
  staleIdleHours: number;
  evidenceDeleteAfterDays: number;
  /** PNG screenshots older than this are listed for the WebP conversion. Null: none. */
  evidenceConvertAfterDays: number | null;
  /** Do not use the sizes of the scan before. */
  force: boolean;
  /** The JSON file of the folder sizes of the scan before. Null: no cache. */
  cachePath: string | null;
  entryLimit: number;
}

/** A plan item with what the host needs to check it again and to remove it. Never sent to a client. */
export interface StorageHygienePlannedItem extends StorageHygieneItem {
  absolutePath: string;
  areaRoot: string;
  /** `files` scope: the extensions (lowercase, with the dot) of the files that go. */
  extensions?: string[];
  /** `files` scope: only files last changed before this time go. */
  modifiedBefore?: number;
  /** `stale-worktree`: the main repository, for `git worktree remove`. */
  mainRepository?: string;
  /** `stale-worktree` and `repo-copy`: the commits the scan saw, to see a change before removal. */
  heads?: string;
}

/** PNG screenshots of one evidence folder that the WebP rule may convert. Never sent to a client. */
export interface StorageHygieneConvertible {
  directory: string;
  areaRoot: string;
  names: string[];
}

export interface StorageHygieneScanResult {
  report: StorageHygieneReport;
  plan: StorageHygienePlannedItem[];
  convertible: StorageHygieneConvertible[];
}

export const STORAGE_HYGIENE_ENTRY_LIMIT = 20_000_000;
/** A regenerable folder whose root did not change keeps its measured size this long. */
const OPAQUE_TTL_MS = 6 * 60 * 60 * 1_000;
const STAT_BATCH = 64;
const CACHE_VERSION = 1;
const FOLDER_LIMIT = 40;
const ITEM_LIMIT = 3_000;

const EVIDENCE_FOLDERS = new Set(["notes", "evidence", "screenshots", "captures", "recordings"]);
const COPY_CONTAINERS = new Set(["work", "worktrees", ".worktrees", "copies"]);
const BUILD_OUTPUTS = new Set(["dist", "build", "out"]);
const PROJECT_MANIFESTS = [
  "package.json",
  "Cargo.toml",
  "pyproject.toml",
  "setup.py",
  "go.mod",
  "CMakeLists.txt",
  "meson.build",
  "build.gradle",
  "build.gradle.kts",
  "pom.xml",
  "project.godot",
  "deno.json",
];
/** File names a folder's decisions read. Only these are kept per folder in the cache. */
const MARKERS = new Set([...PROJECT_MANIFESTS, "CACHEDIR.TAG"]);
export const STORAGE_HYGIENE_MEDIA_EXTENSIONS = [
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".mp4",
  ".webm",
  ".mov",
  ".mkv",
];
export const STORAGE_HYGIENE_EXPORT_EXTENSIONS = [".pck", ".x86_64", ".exe", ".zip"];
const MEDIA = new Set(STORAGE_HYGIENE_MEDIA_EXTENSIONS);
const EXPORTS = new Set(STORAGE_HYGIENE_EXPORT_EXTENSIONS);

/** One folder as the cache keeps it: its own files, by kind, and the names of its folders. */
interface CachedFolder {
  /** Modification time of the folder. */
  m: number;
  /** Bytes, count and newest change of the files that are neither media nor exports. */
  b: number;
  c: number;
  t: number;
  /** Media and export files: name, bytes, modification time. */
  x: [string, number, number][];
  /** Folder names. */
  d: string[];
  /** Marker files present, and `.git` when the folder has a `.git` file (a worktree or submodule). */
  s: string[];
}

/** A regenerable or repository folder, measured as one. */
interface CachedOpaque {
  m: number;
  b: number;
  c: number;
  t: number;
  at: number;
}

interface ScanCache {
  version: number;
  folders: Record<string, CachedFolder>;
  opaque: Record<string, CachedOpaque>;
}

interface Summary {
  breakdown: StorageHygieneBreakdown;
  files: number;
  /** Newest change of the real files, which decides whether a copy is idle. */
  newestReal: number;
  newestAll: number;
  complete: boolean;
}

interface Context {
  areaId: string;
  areaRoot: string;
  depth: number;
  evidence: boolean;
  /** The work tree that holds this folder: a folder with a `.git` folder or a `.git` file. */
  workTree: string | null;
}

const execGit = (args: string[], options: { input?: string } = {}) =>
  new Promise<{ ok: boolean; stdout: string }>((resolve) => {
    const child = execFile(
      "git",
      ["-c", "safe.directory=*", ...args],
      {
        timeout: 30_000,
        maxBuffer: 16 * 1_024 * 1_024,
        env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0", LC_ALL: "C" },
      },
      (error, stdout) => resolve({ ok: !error, stdout: String(stdout) }),
    );
    if (options.input !== undefined) child.stdin?.end(options.input);
  });

export const storageHygieneGit = execGit;

function emptyBreakdown(): StorageHygieneBreakdown {
  return { real: 0, regenerable: 0, stale: 0, evidence: 0 };
}

function emptySummary(): Summary {
  return { breakdown: emptyBreakdown(), files: 0, newestReal: 0, newestAll: 0, complete: true };
}

function totalBytes(breakdown: StorageHygieneBreakdown): number {
  return breakdown.real + breakdown.regenerable + breakdown.stale + breakdown.evidence;
}

function addSummary(target: Summary, source: Summary): void {
  target.breakdown.real += source.breakdown.real;
  target.breakdown.regenerable += source.breakdown.regenerable;
  target.breakdown.stale += source.breakdown.stale;
  target.breakdown.evidence += source.breakdown.evidence;
  target.files += source.files;
  target.newestReal = Math.max(target.newestReal, source.newestReal);
  target.newestAll = Math.max(target.newestAll, source.newestAll);
  target.complete &&= source.complete;
}

/** The disk use of a file, as `du` counts it, or its size where the system reports no blocks. */
function diskBytes(stats: Stats): number {
  return typeof stats.blocks === "number" && stats.blocks >= 0 ? stats.blocks * 512 : stats.size;
}

function extension(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot).toLowerCase() : "";
}

export function storageHygieneId(prefix: string, value: string): string {
  return `${prefix}${createHash("sha256").update(value).digest("hex").slice(0, 24)}`;
}

function relativePath(root: string, path: string): string {
  const result = relative(root, path).split(sep).join("/");
  return result === "" ? "." : result;
}

export function isWithin(root: string, path: string): boolean {
  return path !== root && path.startsWith(root.endsWith(sep) ? root : `${root}${sep}`);
}

function isScanCache(value: unknown): value is ScanCache {
  return (
    isDynamicRecord(value) &&
    value.version === CACHE_VERSION &&
    isDynamicRecord(value.folders) &&
    isDynamicRecord(value.opaque)
  );
}

async function readCache(path: string | null): Promise<ScanCache | null> {
  if (!path) return null;
  try {
    const value = JSON.parse(await readFile(path, "utf8"));
    return isScanCache(value) ? value : null;
  } catch {
    // A missing or damaged cache means a full scan.
    return null;
  }
}

export async function storageHygieneDisk(path: string): Promise<StorageHygieneDisk> {
  try {
    const filesystem = await statfs(path);
    const total = filesystem.blocks * filesystem.bsize;
    const free = filesystem.bavail * filesystem.bsize;
    return {
      totalBytes: Number.isSafeInteger(total) ? total : null,
      freeBytes: Number.isSafeInteger(free) ? free : null,
    };
  } catch {
    return { totalBytes: null, freeBytes: null };
  }
}

async function safeLstat(path: string): Promise<Stats | null> {
  try {
    return await lstat(path);
  } catch {
    return null;
  }
}

async function safeReaddir(path: string): Promise<Dirent[] | null> {
  try {
    return await readdir(path, { withFileTypes: true });
  } catch {
    return null;
  }
}

/** The commits a repository holds as its own: HEAD, the branches and the stash. */
export async function repositoryHeads(gitDirectory: string): Promise<string[] | null> {
  const refs = await execGit([
    `--git-dir=${gitDirectory}`,
    "for-each-ref",
    "--format=%(objectname)",
    "refs/heads",
    "refs/stash",
  ]);
  const head = await execGit([`--git-dir=${gitDirectory}`, "rev-parse", "--verify", "-q", "HEAD"]);
  if (!refs.ok) return null;
  const heads = new Set(refs.stdout.split("\n").filter((line) => /^[0-9a-f]{40,64}$/.test(line)));
  const headLine = head.stdout.trim();
  if (head.ok && /^[0-9a-f]{40,64}$/.test(headLine)) heads.add(headLine);
  return [...heads].sort();
}

/** Whether every commit in `heads` is in one of the repositories. */
export async function headsContained(heads: readonly string[], repositories: readonly string[]): Promise<boolean> {
  if (!heads.length) return repositories.length > 0;
  let missing = [...heads];
  for (const repository of repositories) {
    const check = await execGit([`--git-dir=${repository}`, "cat-file", "--batch-check"], {
      input: `${missing.map((sha) => `${sha}^{commit}`).join("\n")}\n`,
    });
    if (!check.ok) continue;
    const lines = check.stdout.split("\n");
    missing = missing.filter((_, index) => !lines[index] || lines[index].endsWith(" missing"));
    if (!missing.length) return true;
  }
  return false;
}

/** The git folder that a `.git` file points to, and the main repository of a worktree. */
export async function worktreeLink(
  folder: string,
): Promise<{ gitDirectory: string; mainRepository: string; commonDirectory: string } | null> {
  let text: string;
  try {
    text = await readFile(join(folder, ".git"), "utf8");
  } catch {
    return null;
  }
  const match = /^gitdir:\s*(.+)\s*$/m.exec(text);
  if (!match?.[1]) return null;
  const gitDirectory = match[1].startsWith("/") ? match[1] : join(folder, match[1]);
  // A worktree's git folder is `<repo>/.git/worktrees/<name>`; a submodule's is `.git/modules/...`.
  const parts = gitDirectory.split(sep);
  const index = parts.lastIndexOf("worktrees");
  if (index < 1 || parts[index - 1] !== ".git") return null;
  const commonDirectory = parts.slice(0, index).join(sep);
  return { gitDirectory, mainRepository: parts.slice(0, index - 1).join(sep) || sep, commonDirectory };
}

/** A worktree is merged when its HEAD is in the main repository's HEAD, `main` or `master`. */
export async function worktreeMerged(folder: string, mainRepository: string): Promise<string | null> {
  const head = await execGit(["-C", folder, "rev-parse", "HEAD"]);
  if (!head.ok) return null;
  const sha = head.stdout.trim();
  const branch = await execGit(["-C", mainRepository, "symbolic-ref", "--short", "-q", "HEAD"]);
  const targets = [branch.ok ? branch.stdout.trim() : "", "main", "master", "origin/main", "origin/master"].filter(
    (target, index, all) => target && all.indexOf(target) === index,
  );
  for (const target of targets) {
    const merged = await execGit(["-C", mainRepository, "merge-base", "--is-ancestor", sha, target]);
    if (merged.ok) return target;
  }
  return null;
}

/** Clean: no change and no untracked file that git does not ignore. */
export async function workTreeClean(folder: string): Promise<boolean> {
  const status = await execGit(["-C", folder, "status", "--porcelain", "--untracked-files=normal"]);
  return status.ok && status.stdout.trim() === "";
}

async function gitIgnores(workTree: string, path: string): Promise<boolean> {
  const result = await execGit(["-C", workTree, "check-ignore", "-q", "--", relative(workTree, path)]);
  return result.ok;
}

/** Runs the scan of every area. */
export async function scanStorageHygiene(
  request: StorageHygieneScanRequest,
  onProgress?: (entries: number) => void,
): Promise<StorageHygieneScanResult> {
  const started = Date.now();
  const previous = request.force ? null : await readCache(request.cachePath);
  const next: ScanCache = { version: CACHE_VERSION, folders: {}, opaque: {} };
  const seenInodes = new Set<string>();
  const plan: StorageHygienePlannedItem[] = [];
  const convertible: StorageHygieneConvertible[] = [];
  const folders: StorageHygieneFolder[] = [];
  const staleBefore = request.now - request.staleIdleHours * 3_600_000;
  const mediaBefore = request.now - request.evidenceDeleteAfterDays * 86_400_000;
  const convertBefore =
    request.evidenceConvertAfterDays === null ? null : request.now - request.evidenceConvertAfterDays * 86_400_000;
  let entries = 0;
  let truncated = false;
  let lastProgress = 0;

  const count = (amount: number) => {
    entries += amount;
    if (entries > request.entryLimit) truncated = true;
    if (onProgress && entries - lastProgress >= 20_000) {
      lastProgress = entries;
      onProgress(entries);
    }
  };

  /** Measures a folder as one block, with the cached size while its root keeps its time. */
  async function measureOpaque(path: string, stats: Stats, device: number): Promise<CachedOpaque> {
    const cached = previous?.opaque[path];
    if (cached && cached.m === stats.mtimeMs && request.now - cached.at < OPAQUE_TTL_MS) {
      next.opaque[path] = cached;
      count(cached.c);
      return cached;
    }
    const result: CachedOpaque = { m: stats.mtimeMs, b: 0, c: 0, t: stats.mtimeMs, at: request.now };
    const pending = [path];
    while (pending.length && !truncated) {
      const folder = pending.pop() ?? path;
      const children = await safeReaddir(folder);
      if (!children) continue;
      count(children.length);
      const files: string[] = [];
      for (const child of children) {
        const childPath = join(folder, child.name);
        if (child.isDirectory()) pending.push(childPath);
        else if (child.isFile()) files.push(childPath);
      }
      for (let index = 0; index < files.length; index += STAT_BATCH) {
        const batch = await Promise.all(files.slice(index, index + STAT_BATCH).map(safeLstat));
        for (const file of batch) {
          if (!file || file.dev !== device) continue;
          if (file.nlink > 1) {
            const key = `${file.dev}:${file.ino}`;
            if (seenInodes.has(key)) continue;
            seenInodes.add(key);
          }
          result.b += diskBytes(file);
          result.c += 1;
          result.t = Math.max(result.t, file.mtimeMs);
        }
      }
    }
    // The blocks of the folders themselves are left out, except the root's: they are small, and
    // counting them would take one more call per folder.
    result.b += diskBytes(stats);
    if (!truncated) next.opaque[path] = result;
    return result;
  }

  async function readFolder(path: string, stats: Stats, device: number): Promise<CachedFolder | null> {
    const cached = previous?.folders[path];
    if (cached && cached.m === stats.mtimeMs) {
      next.folders[path] = cached;
      count(cached.c + cached.x.length + cached.d.length);
      return cached;
    }
    const children = await safeReaddir(path);
    if (!children) return null;
    count(children.length);
    const folder: CachedFolder = { m: stats.mtimeMs, b: diskBytes(stats), c: 0, t: 0, x: [], d: [], s: [] };
    const files: Dirent[] = [];
    for (const child of children) {
      if (child.isDirectory()) folder.d.push(child.name);
      else if (child.isFile()) {
        files.push(child);
        if (MARKERS.has(child.name)) folder.s.push(child.name);
        if (child.name === ".git") folder.s.push(".git");
      }
    }
    for (let index = 0; index < files.length; index += STAT_BATCH) {
      const batch = files.slice(index, index + STAT_BATCH);
      const stats = await Promise.all(batch.map((file) => safeLstat(join(path, file.name))));
      stats.forEach((file, position) => {
        const name = batch[position]?.name;
        if (!file || name === undefined || file.dev !== device) return;
        if (file.nlink > 1) {
          const key = `${file.dev}:${file.ino}`;
          if (seenInodes.has(key)) return;
          seenInodes.add(key);
        }
        const bytes = diskBytes(file);
        const kind = extension(name);
        if (MEDIA.has(kind) || EXPORTS.has(kind)) folder.x.push([name, bytes, file.mtimeMs]);
        else {
          folder.b += bytes;
          folder.c += 1;
          folder.t = Math.max(folder.t, file.mtimeMs);
        }
      });
    }
    if (!truncated) next.folders[path] = folder;
    return folder;
  }

  function addItem(item: Omit<StorageHygienePlannedItem, "id" | "path">): StorageHygienePlannedItem {
    const planned: StorageHygienePlannedItem = {
      ...item,
      id: storageHygieneId("i", `${item.rule}\0${item.absolutePath}`),
      path: relativePath(item.areaRoot, item.absolutePath),
    };
    plan.push(planned);
    return planned;
  }

  /** Walks a folder that is not regenerable and returns what it holds, by class. */
  async function walk(path: string, stats: Stats, device: number, context: Context): Promise<Summary> {
    const summary = emptySummary();
    if (truncated) {
      summary.complete = false;
      return summary;
    }
    const folder = await readFolder(path, stats, device);
    if (!folder) return summary;
    summary.files += folder.c;
    summary.breakdown.real += folder.b;
    summary.newestReal = Math.max(summary.newestReal, folder.t);
    summary.newestAll = Math.max(summary.newestAll, folder.t);

    // Media and game exports are evidence only in an evidence folder; elsewhere they are real files.
    const exports = folder.x.filter(([name]) => EXPORTS.has(extension(name)));
    const media = folder.x.filter(([name]) => MEDIA.has(extension(name)));
    if (context.evidence) {
      if (exports.length) {
        const bytes = exports.reduce((sum, [, size]) => sum + size, 0);
        summary.breakdown.regenerable += bytes;
        summary.files += exports.length;
        const newest = Math.max(...exports.map(([, , time]) => time));
        summary.newestAll = Math.max(summary.newestAll, newest);
        addItem({
          areaId: context.areaId,
          areaRoot: context.areaRoot,
          absolutePath: path,
          rule: "build-export",
          scope: "files",
          bytes,
          files: exports.length,
          modifiedAt: Math.round(newest),
          recommended: true,
          extensions: STORAGE_HYGIENE_EXPORT_EXTENSIONS,
        });
      }
      if (media.length) {
        summary.breakdown.evidence += media.reduce((sum, [, size]) => sum + size, 0);
        summary.files += media.length;
        summary.newestAll = Math.max(summary.newestAll, ...media.map(([, , time]) => time));
        const old = media.filter(([, , time]) => time < mediaBefore);
        if (old.length)
          addItem({
            areaId: context.areaId,
            areaRoot: context.areaRoot,
            absolutePath: path,
            rule: "evidence-media",
            scope: "files",
            bytes: old.reduce((sum, [, size]) => sum + size, 0),
            files: old.length,
            modifiedAt: Math.round(Math.max(...old.map(([, , time]) => time))),
            detail: `${request.evidenceDeleteAfterDays}d`,
            recommended: false,
            extensions: STORAGE_HYGIENE_MEDIA_EXTENSIONS,
            modifiedBefore: mediaBefore,
          });
        if (convertBefore !== null) {
          const names = media
            .filter(([name, , time]) => extension(name) === ".png" && time < convertBefore)
            .map(([name]) => name);
          if (names.length) convertible.push({ directory: path, areaRoot: context.areaRoot, names });
        }
      }
    } else if (folder.x.length) {
      summary.breakdown.real += folder.x.reduce((sum, [, size]) => sum + size, 0);
      summary.files += folder.x.length;
      const newest = Math.max(...folder.x.map(([, , time]) => time));
      summary.newestReal = Math.max(summary.newestReal, newest);
      summary.newestAll = Math.max(summary.newestAll, newest);
    }

    const markers = new Set(folder.s);
    const hasManifest = PROJECT_MANIFESTS.some((name) => markers.has(name));
    const hasGitFolder = folder.d.includes(".git");
    const ownWorkTree = hasGitFolder || markers.has(".git") ? path : context.workTree;
    // Evidence folders last, so the canonical repositories next to them are known first.
    const names = [...folder.d].sort(
      (left, right) => Number(EVIDENCE_FOLDERS.has(left)) - Number(EVIDENCE_FOLDERS.has(right)),
    );
    for (const name of names) {
      if (truncated) {
        summary.complete = false;
        break;
      }
      const childPath = join(path, name);
      const childStats = await safeLstat(childPath);
      if (!childStats?.isDirectory() || childStats.dev !== device) continue;
      const child = await walkChild(childPath, name, childStats, device, context, {
        markers,
        hasManifest,
        workTree: ownWorkTree,
        parentName: basename(path),
      });
      addSummary(summary, child);
    }
    if (context.depth >= 1 && context.depth <= 2)
      folders.push({
        areaId: context.areaId,
        path: relativePath(context.areaRoot, path),
        bytes: totalBytes(summary.breakdown),
        breakdown: { ...summary.breakdown },
      });
    return summary;
  }

  function opaqueSummary(measured: CachedOpaque, kind: StorageHygieneClass): Summary {
    const summary = emptySummary();
    summary.breakdown[kind] = measured.b;
    summary.files = measured.c;
    summary.newestAll = measured.t;
    if (kind === "real") summary.newestReal = measured.t;
    summary.complete = !truncated;
    return summary;
  }

  async function walkChild(
    path: string,
    name: string,
    stats: Stats,
    device: number,
    context: Context,
    parent: {
      markers: ReadonlySet<string>;
      hasManifest: boolean;
      workTree: string | null;
      parentName: string;
    },
  ): Promise<Summary> {
    const regenerable = async (rule: StorageHygieneRule, detail?: string): Promise<Summary> => {
      const measured = await measureOpaque(path, stats, device);
      addItem({
        areaId: context.areaId,
        areaRoot: context.areaRoot,
        absolutePath: path,
        rule,
        scope: "path",
        bytes: measured.b,
        files: measured.c,
        modifiedAt: Math.round(measured.t),
        recommended: true,
        ...(detail ? { detail } : {}),
      });
      return opaqueSummary(measured, "regenerable");
    };

    if (name === ".git") {
      const measured = await measureOpaque(path, stats, device);
      // A repository copy in an evidence folder: decided after the area, against its canonical ones.
      if (context.evidence) repositoryCopies.push({ path, context, measured });
      else canonicalRepositories.push(path);
      return opaqueSummary(measured, "real");
    }
    if (name === "node_modules") return regenerable("node-modules");
    if (name === ".godot") return regenerable("godot-cache");
    if (name === "target" && parent.markers.has("Cargo.toml")) return regenerable("cargo-target");
    if ((name === "target" || name === "cargo-target") && (await safeLstat(join(path, "CACHEDIR.TAG"))))
      return regenerable("cargo-target");
    if (BUILD_OUTPUTS.has(name) && parent.hasManifest) {
      // Only output that git ignores: a project can keep a built folder under version control.
      if (!parent.workTree || (await gitIgnores(parent.workTree, path))) return regenerable("build-output");
    }

    const childContext: Context = {
      ...context,
      depth: context.depth + 1,
      evidence: context.evidence || EVIDENCE_FOLDERS.has(name),
      workTree: parent.workTree,
    };
    const itemsBefore = plan.length;
    const summary = await walk(path, stats, device, childContext);
    const idle = summary.complete && summary.newestReal < staleBefore;
    if (!idle || context.evidence) return summary;

    const folder = next.folders[path] ?? previous?.folders[path];
    const isWorktree = folder?.s.includes(".git") ?? false;
    const hasGitFolder = folder?.d.includes(".git") ?? false;
    let stale: { rule: StorageHygieneRule; detail?: string; mainRepository?: string; heads?: string } | null = null;
    if (isWorktree) {
      const link = await worktreeLink(path);
      if (link && (await workTreeClean(path))) {
        const merged = await worktreeMerged(path, link.mainRepository);
        const heads = await repositoryHeads(link.gitDirectory);
        if (merged)
          stale = {
            rule: "stale-worktree",
            detail: merged,
            mainRepository: link.mainRepository,
            heads: (heads ?? []).join(","),
          };
      }
    } else if (hasGitFolder && parent.workTree && parent.workTree !== path) {
      // A repository inside another work tree, with nothing of its own: a copy.
      const heads = await repositoryHeads(join(path, ".git"));
      if (
        heads &&
        (await workTreeClean(path)) &&
        (await headsContained(heads, [join(parent.workTree, ".git"), ...canonicalRepositories]))
      )
        stale = { rule: "stale-copy", detail: "git", heads: heads.join(",") };
    } else if (
      !hasGitFolder &&
      context.depth >= 1 &&
      COPY_CONTAINERS.has(parent.parentName) &&
      parent.workTree === null
    ) {
      // A plain copy in a `work` folder that no repository holds.
      stale = { rule: "stale-copy" };
    }
    if (!stale) return summary;
    const item = addItem({
      areaId: context.areaId,
      areaRoot: context.areaRoot,
      absolutePath: path,
      rule: stale.rule,
      scope: "path",
      bytes: totalBytes(summary.breakdown),
      files: summary.files,
      modifiedAt: Math.round(summary.newestAll),
      recommended: true,
      ...(stale.detail ? { detail: stale.detail } : {}),
      ...(stale.mainRepository ? { mainRepository: stale.mainRepository } : {}),
      ...(stale.heads !== undefined ? { heads: stale.heads } : {}),
    });
    for (let index = itemsBefore; index < plan.length - 1; index += 1) {
      const nested = plan[index];
      if (nested && !nested.nestedIn) nested.nestedIn = item.id;
    }
    // Its real bytes are stale now; regenerable and evidence bytes keep their class. The folder rows
    // of it and of the folders in it are already written.
    for (const row of folders)
      if (row.areaId === context.areaId && (row.path === item.path || row.path.startsWith(`${item.path}/`))) {
        row.breakdown.stale += row.breakdown.real;
        row.breakdown.real = 0;
      }
    summary.breakdown.stale += summary.breakdown.real;
    summary.breakdown.real = 0;
    return summary;
  }

  /** Moves the bytes of a repository copy to regenerable in the rows of the folders that hold it. */
  function moveCopyBytes(areaId: string, path: string, bytes: number): void {
    for (const row of folders)
      if (row.areaId === areaId && (row.path === path || path.startsWith(`${row.path}/`))) {
        row.breakdown.real -= bytes;
        row.breakdown.regenerable += bytes;
      }
  }

  let repositoryCopies: { path: string; context: Context; measured: CachedOpaque }[] = [];
  let canonicalRepositories: string[] = [];
  const areas: StorageHygieneArea[] = [];

  for (const area of request.areas) {
    const areaId = storageHygieneId("a", `${area.kind}\0${area.root}`);
    const rootStats = await safeLstat(area.root);
    if (!rootStats?.isDirectory()) continue;
    repositoryCopies = [];
    canonicalRepositories = [];
    const context: Context = { areaId, areaRoot: area.root, depth: 0, evidence: false, workTree: null };
    const summary = await walk(area.root, rootStats, rootStats.dev, context);
    for (const copy of repositoryCopies) {
      const heads = await repositoryHeads(copy.path);
      const workTree = copy.context.workTree;
      const references = [
        ...canonicalRepositories,
        ...(workTree && workTree !== join(copy.path, "..") ? [join(workTree, ".git")] : []),
      ];
      if (!heads || !(await headsContained(heads, references))) continue;
      const item = addItem({
        areaId,
        areaRoot: area.root,
        absolutePath: copy.path,
        rule: "repo-copy",
        scope: "path",
        bytes: copy.measured.b,
        files: copy.measured.c,
        modifiedAt: Math.round(copy.measured.t),
        recommended: true,
        heads: heads.join(","),
      });
      moveCopyBytes(areaId, item.path, copy.measured.b);
      summary.breakdown.real -= copy.measured.b;
      summary.breakdown.regenerable += copy.measured.b;
    }
    areas.push({
      id: areaId,
      kind: area.kind,
      name: area.name.slice(0, 255),
      ...(area.agentId ? { agentId: area.agentId } : {}),
      bytes: totalBytes(summary.breakdown),
      files: summary.files,
      breakdown: summary.breakdown,
      complete: summary.complete,
    });
  }

  plan.sort((left, right) => right.bytes - left.bytes);
  folders.sort((left, right) => right.bytes - left.bytes);
  const shown = plan.slice(0, ITEM_LIMIT);
  const shownIds = new Set(shown.map((item) => item.id));
  const report: StorageHygieneReport = {
    scannedAt: request.now,
    durationMs: Date.now() - started,
    entries,
    incremental: previous !== null,
    truncated,
    disk: await storageHygieneDisk(request.diskPath),
    areas: areas.sort((left, right) => right.bytes - left.bytes),
    folders: folders.slice(0, FOLDER_LIMIT),
    items: shown.map(({ absolutePath, areaRoot, extensions, modifiedBefore, mainRepository, heads, ...item }) => {
      // An item whose outer item was cut keeps no link to it.
      if (item.nestedIn && !shownIds.has(item.nestedIn)) delete item.nestedIn;
      return item;
    }),
    itemsTruncated: plan.length > ITEM_LIMIT,
  };
  if (request.cachePath && !truncated) await writeCache(request.cachePath, next);
  return { report, plan: shown, convertible };
}

async function writeCache(path: string, cache: ScanCache): Promise<void> {
  const temporary = `${path}.${process.pid}.tmp`;
  try {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await writeFile(temporary, JSON.stringify(cache), { mode: 0o600 });
    await rename(temporary, path);
  } catch {
    // The next scan is a full one.
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}
