/**
 * Reads the files that the grader shows as evidence (`motion-review.ts`): text files inside the
 * assignee's writable roots (its workspace and its space's shared folder), small and clipped. A path
 * outside those roots, through a link or not, a folder, a binary file or a missing one reads as not
 * found, so the grader never reads what the agent itself could not write.
 */

import { open, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { DELIVERABLE_LIMIT, type DeliverableFile } from "./motion-review";

const READ_BYTES = 64 * 1024;

function inside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

async function readOne(roots: readonly string[], path: string): Promise<string | null> {
  const real = await Promise.all(roots.map((root) => realpath(root).catch(() => null)));
  const bases = real.filter((root): root is string => root !== null);
  const candidates = isAbsolute(path) ? [path] : bases.map((root) => resolve(root, path));
  for (const candidate of candidates) {
    const target = await realpath(candidate).catch(() => null);
    if (!target || !bases.some((root) => inside(root, target))) continue;
    const info = await stat(target).catch(() => null);
    if (!info?.isFile()) continue;
    const handle = await open(target, "r");
    try {
      const buffer = Buffer.alloc(Math.min(READ_BYTES, info.size));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      const bytes = buffer.subarray(0, bytesRead);
      if (bytes.includes(0)) return null;
      const text = bytes.toString("utf8");
      return text.length > DELIVERABLE_LIMIT + 1 ? text.slice(0, DELIVERABLE_LIMIT + 1) : text;
    } finally {
      await handle.close();
    }
  }
  return null;
}

/** The text of each path (relative to the first root that has it), or null when it cannot be read. */
export async function readDeliverableFiles(
  roots: readonly string[],
  paths: readonly string[],
): Promise<DeliverableFile[]> {
  return Promise.all(paths.map(async (path) => ({ path, text: await readOne(roots, path).catch(() => null) })));
}
