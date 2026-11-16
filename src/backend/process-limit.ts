import { readFileSync } from "node:fs";

/**
 * The task limit (processes and threads) of this process's cgroup, as a container's `pids_limit` or
 * a systemd unit's `TasksMax` sets it. Linux counts each thread as a task. When a program cannot
 * start a thread at the limit, many runtimes abort with no message: the Claude CLI ends with
 * SIGABRT and an empty stderr.
 */
export interface TaskLimitState {
  /** Tasks in the cgroup now. */
  current: number;
  /** The smallest limit of the cgroup and its parents, or null without one. */
  max: number | null;
  /** How many times the kernel refused a new task at the limit, since the cgroup was made. */
  refused: number;
}

/** Reads the cgroup v2 pids files of this process, or null where there are none (not Linux, cgroup v1). */
export function readTaskLimit(root = "/sys/fs/cgroup", cgroupFile = "/proc/self/cgroup"): TaskLimitState | null {
  try {
    const line = readFileSync(cgroupFile, "utf8")
      .split("\n")
      .find((entry) => entry.startsWith("0::"));
    if (!line) return null;
    let path = line.slice(3).replace(/\/$/, "");
    const current = Number(readFileSync(`${root}${path}/pids.current`, "utf8").trim());
    if (!Number.isFinite(current)) return null;
    let max: number | null = null;
    let refused = 0;
    // A parent's limit applies too, so each level from the process's own cgroup to the root counts.
    for (;;) {
      const limit = readOptional(`${root}${path}/pids.max`);
      if (limit && limit !== "max" && Number.isFinite(Number(limit)))
        max = max === null ? Number(limit) : Math.min(max, Number(limit));
      const events = readOptional(`${root}${path}/pids.events`);
      const count = events ? /^max (\d+)$/m.exec(events)?.[1] : undefined;
      if (count) refused += Number(count);
      if (path === "") break;
      path = path.slice(0, path.lastIndexOf("/"));
    }
    return { current, max, refused };
  } catch {
    return null;
  }
}

function readOptional(path: string): string | null {
  try {
    return readFileSync(path, "utf8").trim();
  } catch {
    // The root cgroup has no pids.max, and a cgroup without the pids controller has no pids files.
    return null;
  }
}

/**
 * True when the kernel refused a new task after `before` was read: a process that ended by a signal
 * since then likely ended because it could not start a thread.
 */
export function taskLimitReachedSince(before: TaskLimitState | null, after: TaskLimitState | null): boolean {
  return before !== null && after !== null && after.refused > before.refused;
}
