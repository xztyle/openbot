// @vitest-environment node

import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HostedServerMemory } from "./hosted-server-memory";

const GIB = 1024 ** 3;

function meminfo(totalBytes: number, availableBytes: number): string {
  return `MemTotal:       ${totalBytes / 1024} kB\nMemFree:        1 kB\nMemAvailable:   ${availableBytes / 1024} kB\n`;
}

/** A fake of `/proc` and `/sys/fs/cgroup`. A path that is not in the map does not exist. */
function memory(files: Record<string, string>) {
  const onError = vi.fn();
  const guard = new HostedServerMemory({
    onError,
    adjustChildOomScores: false,
    readText: async (path) => {
      const text = files[path];
      if (text === undefined) throw Object.assign(new Error(`ENOENT: ${path}`), { code: "ENOENT" });
      return text;
    },
  });
  return { guard, onError };
}

describe("HostedServerMemory in a container", () => {
  it("takes the limit of the container cgroup, so a full container is held although the host has memory", async () => {
    const { guard, onError } = memory({
      "/proc/meminfo": meminfo(11 * GIB, 9 * GIB),
      "/proc/self/cgroup": "0::/\n",
      "/sys/fs/cgroup/memory.max": `${2 * GIB}\n`,
      "/sys/fs/cgroup/memory.current": `${Math.round(1.95 * GIB)}\n`,
      "/sys/fs/cgroup/memory.stat": "anon 1\ninactive_file 0\n",
    });
    await Effect.runPromise(guard.tick());
    expect(guard.level()).toBe("critical");
    expect(guard.turnLimit()).toBe(4);
    expect(onError).not.toHaveBeenCalled();
  });

  it("counts the file cache of the container as free", async () => {
    const { guard } = memory({
      "/proc/meminfo": meminfo(11 * GIB, 9 * GIB),
      "/proc/self/cgroup": "0::/\n",
      "/sys/fs/cgroup/memory.max": `${4 * GIB}\n`,
      "/sys/fs/cgroup/memory.current": `${Math.round(3.9 * GIB)}\n`,
      "/sys/fs/cgroup/memory.stat": `inactive_file ${3 * GIB}\n`,
    });
    await Effect.runPromise(guard.tick());
    expect(guard.level()).toBe("ok");
  });

  it("uses the totals of the machine when the container has no memory limit", async () => {
    const { guard } = memory({
      "/proc/meminfo": meminfo(11 * GIB, 400 * 1024 ** 2),
      "/proc/self/cgroup": "0::/\n",
      "/sys/fs/cgroup/memory.max": "max\n",
    });
    await Effect.runPromise(guard.tick());
    expect(guard.level()).toBe("critical");
    expect(guard.turnLimit()).toBe(16);
  });

  it("still guards by the totals of the machine when the cgroup files are missing", async () => {
    const { guard, onError } = memory({
      "/proc/meminfo": meminfo(8 * GIB, 300 * 1024 ** 2),
      "/proc/self/cgroup": "0::/system.slice/openbot\n",
    });
    await Effect.runPromise(guard.tick());
    expect(guard.level()).toBe("critical");
    expect(guard.turnLimit()).toBe(8);
    expect(onError).not.toHaveBeenCalled();
  });

  it("keeps the level ok, and says so once, when the memory of the machine cannot be read", async () => {
    const { guard, onError } = memory({});
    await Effect.runPromise(guard.tick());
    await Effect.runPromise(guard.tick());
    expect(guard.level()).toBe("ok");
    expect(onError).toHaveBeenCalledOnce();
  });
});

describe("HostedServerMemory child OOM values", () => {
  const roots: string[] = [];
  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  const MAIN = 100;
  const ELECTRON = "/opt/openbot/electron";

  /** A fake `/proc`: main is process 100 and its binary is the Electron one. */
  async function fakeProc() {
    const root = await mkdtemp(join(tmpdir(), "openbot-proc-"));
    roots.push(root);
    await mkdir(join(root, "self"));
    await symlink(ELECTRON, join(root, "self", "exe"));
    const add = async (pid: number, parent: number, startedAt: number, exe: string, adj = "0") => {
      const dir = join(root, String(pid));
      await rm(dir, { recursive: true, force: true });
      await mkdir(dir);
      const fields = ["S", parent, 1, 1, 0, -1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 20, 0, 1, 0, startedAt, 0];
      // The name holds a space and a bracket, as a real one can.
      await writeFile(join(dir, "stat"), `${pid} (agent ) tool) ${fields.join(" ")}\n`);
      await symlink(exe, join(dir, "exe"));
      await writeFile(join(dir, "oom_score_adj"), adj);
    };
    const adj = async (pid: number) => (await readFile(join(root, String(pid), "oom_score_adj"), "utf8")).trim();
    return { root, add, adj };
  }

  function sampler(root: string, now: () => number) {
    const guard = new HostedServerMemory({
      onError: vi.fn(),
      now,
      proc: { root, pid: MAIN },
      readText: async (path) => {
        if (path === "/proc/meminfo") return meminfo(8 * GIB, 6 * GIB);
        throw Object.assign(new Error(`ENOENT: ${path}`), { code: "ENOENT" });
      },
    });
    return guard;
  }

  it("raises the children and grandchildren of main, and leaves Electron processes and others alone", async () => {
    const proc = await fakeProc();
    await proc.add(200, MAIN, 10, "/usr/bin/codex");
    await proc.add(300, 200, 11, "/usr/bin/node");
    await proc.add(400, MAIN, 12, ELECTRON, "-500");
    await proc.add(500, 1, 13, "/usr/bin/other");
    await proc.add(600, MAIN, 14, "/usr/bin/mcp", "900");
    const guard = sampler(proc.root, () => 0);

    await Effect.runPromise(guard.tick());

    expect(await proc.adj(200)).toBe("500");
    expect(await proc.adj(300)).toBe("500");
    expect(await proc.adj(400)).toBe("-500");
    expect(await proc.adj(500)).toBe("0");
    expect(await proc.adj(600)).toBe("900");
  });

  it("walks every 30 seconds and does not touch a process it already adjusted, but adjusts a reused number", async () => {
    const proc = await fakeProc();
    await proc.add(200, MAIN, 10, "/usr/bin/codex");
    let now = 1_000;
    const guard = sampler(proc.root, () => now);
    await Effect.runPromise(guard.tick());
    expect(await proc.adj(200)).toBe("500");

    // Two things a walk would change if it ran: a new child, and the value of the adjusted one.
    await proc.add(201, MAIN, 20, "/usr/bin/new");
    await writeFile(join(proc.root, "200", "oom_score_adj"), "0");
    now += 5_000;
    await Effect.runPromise(guard.tick());
    expect(await proc.adj(201)).toBe("0");

    now += 25_000;
    await Effect.runPromise(guard.tick());
    expect(await proc.adj(201)).toBe("500");
    // The adjusted process is remembered, so the walk did not write to it again.
    expect(await proc.adj(200)).toBe("0");

    // The process ended and another one got its number: another start time, so it is adjusted.
    await proc.add(200, MAIN, 99, "/usr/bin/other-codex");
    now += 30_000;
    await Effect.runPromise(guard.tick());
    expect(await proc.adj(200)).toBe("500");
  });

  it("looks again at a child that still shows the binary of main", async () => {
    const proc = await fakeProc();
    // Forked and not yet executed: its binary is main's.
    await proc.add(200, MAIN, 10, ELECTRON);
    let now = 0;
    const guard = sampler(proc.root, () => now);
    await Effect.runPromise(guard.tick());
    expect(await proc.adj(200)).toBe("0");

    await proc.add(200, MAIN, 10, "/usr/bin/codex");
    now += 30_000;
    await Effect.runPromise(guard.tick());
    expect(await proc.adj(200)).toBe("500");
  });
});
