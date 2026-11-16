import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readTaskLimit, taskLimitReachedSince } from "./process-limit";

const roots: string[] = [];

function cgroupTree(files: Record<string, string>, cgroup = "0::/system.slice/app.scope\n") {
  const root = mkdtempSync(join(tmpdir(), "openbot-cgroup-"));
  roots.push(root);
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(root, "fs", path, ".."), { recursive: true });
    writeFileSync(join(root, "fs", path), text);
  }
  writeFileSync(join(root, "cgroup"), cgroup);
  return { fs: join(root, "fs"), cgroup: join(root, "cgroup") };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("readTaskLimit", () => {
  it("reads the smallest limit and the refusals of the cgroup and its parents", () => {
    const tree = cgroupTree({
      "system.slice/app.scope/pids.current": "722\n",
      "system.slice/app.scope/pids.max": "1024\n",
      "system.slice/app.scope/pids.events": "max 3\n",
      "system.slice/pids.max": "max\n",
      "system.slice/pids.events": "max 1\n",
    });
    expect(readTaskLimit(tree.fs, tree.cgroup)).toEqual({ current: 722, max: 1024, refused: 4 });
  });

  it("reads a container's own cgroup at the namespace root", () => {
    const tree = cgroupTree({ "pids.current": "10\n", "pids.max": "1024\n", "pids.events": "max 0\n" }, "0::/\n");
    expect(readTaskLimit(tree.fs, tree.cgroup)).toEqual({ current: 10, max: 1024, refused: 0 });
  });

  it("gives null without the pids controller or cgroup v2", () => {
    const withoutPids = cgroupTree({ "system.slice/app.scope/cpu.max": "max 100000\n" });
    expect(readTaskLimit(withoutPids.fs, withoutPids.cgroup)).toBeNull();
    const v1 = cgroupTree({ "pids.current": "1\n" }, "12:pids:/docker/abc\n");
    expect(readTaskLimit(v1.fs, v1.cgroup)).toBeNull();
  });
});

describe("taskLimitReachedSince", () => {
  it("is true only when the kernel refused a task after the first read", () => {
    const before = { current: 900, max: 1024, refused: 2 };
    expect(taskLimitReachedSince(before, { current: 1024, max: 1024, refused: 3 })).toBe(true);
    expect(taskLimitReachedSince(before, { current: 1000, max: 1024, refused: 2 })).toBe(false);
    expect(taskLimitReachedSince(null, { current: 1024, max: 1024, refused: 3 })).toBe(false);
  });
});
