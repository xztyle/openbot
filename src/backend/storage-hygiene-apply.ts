// The storage hygiene cleanup and the WebP conversion of old evidence screenshots. Both run in the
// storage hygiene host process (`storage-hygiene-host.ts`), so the runtime imports are `node:*` only.
//
// A cleanup deletes only items of the plan the host made, and checks each one on the disk first: it
// keeps an item that a process works in, that holds a file changed in the last minutes, that is not
// idle any more, that crosses into another file system, or whose repository changed. Every deletion
// and every kept item is a line in the audit file.

import { execFile } from "node:child_process";
import type { Dirent, Stats } from "node:fs";
import {
  appendFile,
  lstat,
  mkdir,
  readdir,
  readFile,
  readlink,
  realpath,
  rename,
  rm,
  stat,
  unlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, extname, join, sep } from "node:path";
import type { StorageHygieneSkipped, StorageHygieneSkipReason, StorageHygieneWebpTool } from "@openbot/contracts/ipc";
import {
  isWithin,
  repositoryHeads,
  type StorageHygieneConvertible,
  type StorageHygienePlannedItem,
  storageHygieneGit,
  workTreeClean,
  worktreeLink,
  worktreeMerged,
} from "./storage-hygiene-scan";

export interface StorageHygieneApplyRequest {
  items: StorageHygienePlannedItem[];
  now: number;
  /** Anything changed in the last minutes stays. */
  recentMinutes: number;
  /** A stale worktree or copy must still be idle this long. */
  staleIdleHours: number;
  /** The automatic rule: a regenerable item must be idle this long. Null for a manual cleanup. */
  minimumIdleHours: number | null;
  trigger: "manual" | "automatic";
  actor?: string;
  auditPath: string;
}

export interface StorageHygieneApplyOutcome {
  freedBytes: number;
  deleted: number;
  skipped: StorageHygieneSkipped[];
}

export interface StorageHygieneConvertRequest {
  convertible: StorageHygieneConvertible[];
  tool: StorageHygieneWebpTool;
  now: number;
  recentMinutes: number;
  /** At most this many files in one run. */
  limit: number;
  trigger: "manual" | "automatic";
  auditPath: string;
}

export interface StorageHygieneConvertOutcome {
  converted: number;
  savedBytes: number;
}

/** Folder names whose changes do not make a copy active: build output and caches. */
const REGENERABLE_NAMES = new Set(["target", "node_modules", ".godot", "dist", "build", "out"]);
const TEXT_REFERENCES = new Set([".md", ".html", ".htm"]);
const TEXT_REFERENCE_LIMIT = 2 * 1_024 * 1_024;
const PROCESS_CHECK_MS = 5_000;

const run = (command: string, args: string[], timeout = 120_000) =>
  new Promise<{ ok: boolean; stdout: string }>((resolve) => {
    execFile(command, args, { timeout, maxBuffer: 8 * 1_024 * 1_024 }, (error, stdout) =>
      resolve({ ok: !error, stdout: String(stdout) }),
    );
  });

/** The tool that converts PNG to WebP on this host, or null. ImageMagick's `convert` on Windows is another program. */
export async function detectWebpTool(): Promise<StorageHygieneWebpTool | null> {
  if ((await run("cwebp", ["-version"], 10_000)).ok) return "cwebp";
  if ((await run("magick", ["-version"], 10_000)).ok) return "magick";
  if (process.platform !== "win32") {
    const convert = await run("convert", ["-version"], 10_000);
    if (convert.ok && convert.stdout.includes("ImageMagick")) return "convert";
  }
  return null;
}

/** The working folders of the processes on this computer. Empty where the system does not say. */
async function processFolders(): Promise<string[]> {
  if (process.platform === "linux") {
    const entries = await readdir("/proc").catch((): string[] => []);
    const folders = await Promise.all(
      entries
        .filter((name) => /^\d+$/.test(name) && Number(name) !== process.pid)
        .map((pid) => readlink(`/proc/${pid}/cwd`).catch(() => null)),
    );
    return folders.filter((folder): folder is string => folder !== null);
  }
  if (process.platform === "darwin") {
    const result = await run("lsof", ["-a", "-d", "cwd", "-F", "n"], 30_000);
    return result.stdout
      .split("\n")
      .filter((line) => line.startsWith("n/"))
      .map((line) => line.slice(1));
  }
  return [];
}

interface TreeCheck {
  bytes: number;
  files: number;
  /** Newest change of all files, and of the files outside build output and caches. */
  newestAll: number;
  newestReal: number;
  /** A folder of another file system, or a file changed after `recentAfter`. */
  problem: "recent" | "failed" | null;
}

function diskBytes(stats: Stats): number {
  return typeof stats.blocks === "number" && stats.blocks >= 0 ? stats.blocks * 512 : stats.size;
}

/** Walks a folder from the disk, without the cache: sizes, newest changes, mounts. */
async function checkTree(root: string, rootStats: Stats, recentAfter: number): Promise<TreeCheck> {
  const result: TreeCheck = { bytes: diskBytes(rootStats), files: 0, newestAll: 0, newestReal: 0, problem: null };
  const pending: { path: string; regenerable: boolean }[] = [{ path: root, regenerable: false }];
  while (pending.length) {
    const folder = pending.pop();
    if (!folder) break;
    let children: Dirent[];
    try {
      children = await readdir(folder.path, { withFileTypes: true });
    } catch {
      result.problem = "failed";
      return result;
    }
    for (const child of children) {
      const path = join(folder.path, child.name);
      const stats = await lstat(path).catch(() => null);
      if (!stats) continue;
      if (stats.dev !== rootStats.dev) {
        result.problem = "failed";
        return result;
      }
      if (stats.mtimeMs > recentAfter && !stats.isDirectory()) {
        result.problem = "recent";
        return result;
      }
      result.bytes += diskBytes(stats);
      if (stats.isDirectory()) {
        pending.push({ path, regenerable: folder.regenerable || REGENERABLE_NAMES.has(child.name) });
        continue;
      }
      result.files += 1;
      result.newestAll = Math.max(result.newestAll, stats.mtimeMs);
      if (!folder.regenerable) result.newestReal = Math.max(result.newestReal, stats.mtimeMs);
    }
  }
  return result;
}

/** One line of the audit file: a deletion, a kept item or a conversion. */
interface AuditLine {
  at: number;
  trigger: "manual" | "automatic";
  actor?: string;
  rule: string;
  path: string;
  outcome: "deleted" | "kept" | "converted";
  reason?: StorageHygieneSkipReason;
  to?: string;
  bytes: number;
  files?: number;
  savedBytes?: number;
}

async function audit(path: string, line: AuditLine): Promise<void> {
  try {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await appendFile(path, `${JSON.stringify(line)}\n`, { mode: 0o600 });
  } catch {
    // The cleanup goes on; the outcome still reports each item.
  }
}

/** Deletes the planned items that are still what the plan found. */
export async function applyStorageHygiene(request: StorageHygieneApplyRequest): Promise<StorageHygieneApplyOutcome> {
  const outcome: StorageHygieneApplyOutcome = { freedBytes: 0, deleted: 0, skipped: [] };
  const selected = new Set(request.items.map((item) => item.id));
  const recentAfter = request.now - request.recentMinutes * 60_000;
  const staleBefore = request.now - request.staleIdleHours * 3_600_000;
  const idleBefore = request.minimumIdleHours === null ? null : request.now - request.minimumIdleHours * 3_600_000;
  let folders: string[] = [];
  let foldersAt = 0;
  const prunes = new Set<string>();

  const record = async (
    item: StorageHygienePlannedItem,
    result: { reason?: StorageHygieneSkipReason; bytes?: number; files?: number },
  ) => {
    if (result.reason) outcome.skipped.push({ path: item.path, rule: item.rule, reason: result.reason });
    await audit(request.auditPath, {
      at: Date.now(),
      trigger: request.trigger,
      ...(request.actor ? { actor: request.actor } : {}),
      rule: item.rule,
      path: item.absolutePath,
      outcome: result.reason ? "kept" : "deleted",
      ...(result.reason ? { reason: result.reason } : {}),
      bytes: result.bytes ?? item.bytes,
      files: result.files ?? item.files,
    });
  };

  // Outer items first: an item inside one that goes needs no check of its own.
  const ordered = [...request.items].sort(
    (left, right) => Number(Boolean(left.nestedIn)) - Number(Boolean(right.nestedIn)),
  );
  for (const item of ordered) {
    if (item.nestedIn && selected.has(item.nestedIn)) continue;
    const reason = await applyItem(item);
    if (reason) await record(item, { reason });
  }
  for (const repository of prunes) await storageHygieneGit(["-C", repository, "worktree", "prune"]);
  return outcome;

  async function busy(path: string): Promise<boolean> {
    if (Date.now() - foldersAt > PROCESS_CHECK_MS) {
      folders = await processFolders();
      foldersAt = Date.now();
    }
    return folders.some((folder) => folder === path || isWithin(path, folder));
  }

  async function applyItem(item: StorageHygienePlannedItem): Promise<StorageHygieneSkipReason | null> {
    const stats = await lstat(item.absolutePath).catch(() => null);
    if (!stats) return "missing";
    if (stats.isSymbolicLink() || !stats.isDirectory()) return "changed";
    // Only inside the area, never the area itself, after links are resolved.
    const [root, resolved] = await Promise.all([
      realpath(item.areaRoot).catch(() => null),
      realpath(item.absolutePath).catch(() => null),
    ]);
    if (!root || !resolved || !isWithin(root, resolved)) return "changed";
    if (await busy(resolved)) return "busy";
    if (item.scope === "files") return applyFiles(item, resolved);

    const tree = await checkTree(resolved, stats, recentAfter);
    if (tree.problem) return tree.problem;
    const stale = item.rule === "stale-worktree" || item.rule === "stale-copy";
    if (stale && tree.newestReal >= staleBefore) return "recent";
    if (idleBefore !== null && tree.newestAll >= idleBefore) return "recent";
    if (item.heads !== undefined) {
      const gitDirectory =
        item.rule === "stale-worktree"
          ? (await worktreeLink(resolved))?.gitDirectory
          : item.rule === "repo-copy"
            ? resolved
            : join(resolved, ".git");
      const heads = gitDirectory ? await repositoryHeads(gitDirectory) : null;
      if (!heads || heads.join(",") !== item.heads) return "changed";
    }
    if (item.rule === "stale-worktree") {
      if (!item.mainRepository || !(await workTreeClean(resolved))) return "changed";
      if (!(await worktreeMerged(resolved, item.mainRepository))) return "changed";
      const removed = await storageHygieneGit(["-C", item.mainRepository, "worktree", "remove", "--force", resolved]);
      if (!removed.ok) await rm(resolved, { recursive: true, force: true }).catch(() => undefined);
      prunes.add(item.mainRepository);
    } else if (item.rule === "stale-copy" && item.heads !== undefined && !(await workTreeClean(resolved))) {
      return "changed";
    } else {
      try {
        await rm(resolved, { recursive: true, force: true });
      } catch {
        return "failed";
      }
    }
    if (await lstat(resolved).catch(() => null)) return "failed";
    outcome.freedBytes += tree.bytes;
    outcome.deleted += 1;
    await record(item, { bytes: tree.bytes, files: tree.files });
    return null;
  }

  async function applyFiles(item: StorageHygienePlannedItem, folder: string): Promise<StorageHygieneSkipReason | null> {
    const extensions = new Set(item.extensions ?? []);
    if (!extensions.size) return "changed";
    const children = await readdir(folder, { withFileTypes: true }).catch(() => null);
    if (!children) return "missing";
    let bytes = 0;
    let files = 0;
    let recent = false;
    for (const child of children) {
      if (!child.isFile() || !extensions.has(extname(child.name).toLowerCase())) continue;
      const path = join(folder, child.name);
      const stats = await lstat(path).catch(() => null);
      if (!stats?.isFile()) continue;
      if (stats.mtimeMs > recentAfter) {
        recent = true;
        continue;
      }
      if (item.modifiedBefore !== undefined && stats.mtimeMs >= item.modifiedBefore) continue;
      if (idleBefore !== null && stats.mtimeMs >= idleBefore) continue;
      try {
        await unlink(path);
        bytes += diskBytes(stats);
        files += 1;
      } catch {
        // Counted by what did go.
      }
    }
    if (!files) return recent ? "recent" : "missing";
    outcome.freedBytes += bytes;
    outcome.deleted += 1;
    await record(item, { bytes, files });
    return null;
  }
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Points the Markdown and HTML files of a folder at the new WebP names. `prefix` is the path from
 * that folder to the screenshots: empty for their own folder, `shots/` for the folder above.
 */
async function rewriteReferences(folder: string, renamed: ReadonlyMap<string, string>, prefix = ""): Promise<void> {
  if (!renamed.size) return;
  const children = await readdir(folder, { withFileTypes: true }).catch((): Dirent[] => []);
  const names = new Map([...renamed].map(([from, to]) => [`${prefix}${from}`, `${prefix}${to}`]));
  const pattern = new RegExp(`(?<![\\w.-])(${[...names.keys()].map(escapeRegExp).join("|")})(?![\\w.-])`, "g");
  for (const child of children) {
    if (!child.isFile() || !TEXT_REFERENCES.has(extname(child.name).toLowerCase())) continue;
    const path = join(folder, child.name);
    const stats = await stat(path).catch(() => null);
    if (!stats || stats.size > TEXT_REFERENCE_LIMIT) continue;
    const text = await readFile(path, "utf8").catch(() => null);
    if (text === null) continue;
    const next = text.replace(pattern, (name) => names.get(name) ?? name);
    if (next === text) continue;
    const temporary = `${path}.openbot-webp.tmp`;
    try {
      await writeFile(temporary, next, { mode: stats.mode & 0o777 });
      await rename(temporary, path);
      await utimes(path, stats.atime, stats.mtime);
    } catch {
      await rm(temporary, { force: true }).catch(() => undefined);
    }
  }
}

function webpArguments(tool: StorageHygieneWebpTool, input: string, output: string): string[] {
  return tool === "cwebp" ? ["-quiet", "-q", "80", input, "-o", output] : [input, "-quality", "80", output];
}

/**
 * Converts old PNG screenshots of evidence folders to WebP at quality 80. A file stays when the WebP
 * is not smaller or a file of that name exists. The WebP keeps the time of the PNG, so the age rules
 * still see the screenshot's age, and Markdown and HTML files in the folder point at the new name.
 */
export async function convertEvidenceScreenshots(
  request: StorageHygieneConvertRequest,
): Promise<StorageHygieneConvertOutcome> {
  const outcome: StorageHygieneConvertOutcome = { converted: 0, savedBytes: 0 };
  const recentAfter = request.now - request.recentMinutes * 60_000;
  for (const group of request.convertible) {
    if (outcome.converted >= request.limit) break;
    const [root, folder] = await Promise.all([
      realpath(group.areaRoot).catch(() => null),
      realpath(group.directory).catch(() => null),
    ]);
    if (!root || !folder || !(folder === root || isWithin(root, folder))) continue;
    const renamed = new Map<string, string>();
    for (const name of group.names) {
      if (outcome.converted >= request.limit) break;
      if (name.includes(sep) || name.includes("/")) continue;
      const input = join(folder, name);
      const stats = await lstat(input).catch(() => null);
      if (!stats?.isFile() || stats.mtimeMs > recentAfter) continue;
      const webpName = `${basename(name, extname(name))}.webp`;
      const output = join(folder, webpName);
      if (await lstat(output).catch(() => null)) continue;
      const temporary = join(folder, `.${webpName}.openbot-tmp.webp`);
      const converted = await run(request.tool, webpArguments(request.tool, input, temporary));
      const result = converted.ok ? await lstat(temporary).catch(() => null) : null;
      if (!result?.isFile() || result.size === 0 || result.size >= stats.size) {
        await rm(temporary, { force: true }).catch(() => undefined);
        continue;
      }
      try {
        await rename(temporary, output);
        await utimes(output, stats.atime, stats.mtime);
        await unlink(input);
      } catch {
        await rm(temporary, { force: true }).catch(() => undefined);
        continue;
      }
      outcome.converted += 1;
      outcome.savedBytes += Math.max(0, diskBytes(stats) - diskBytes(result));
      renamed.set(name, webpName);
      await audit(request.auditPath, {
        at: Date.now(),
        trigger: request.trigger,
        rule: "evidence-media",
        path: input,
        outcome: "converted",
        to: output,
        bytes: diskBytes(stats),
        savedBytes: Math.max(0, diskBytes(stats) - diskBytes(result)),
      });
    }
    await rewriteReferences(folder, renamed);
    // A report often sits one folder above its screenshots.
    const parent = dirname(folder);
    if (parent === root || isWithin(root, parent)) await rewriteReferences(parent, renamed, `${basename(folder)}/`);
  }
  return outcome;
}
