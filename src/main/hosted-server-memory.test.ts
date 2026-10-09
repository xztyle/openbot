// @vitest-environment node

import { Effect } from "effect";
import { describe, expect, it, vi } from "vitest";
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
