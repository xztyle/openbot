import { readdir, readFile, readlink, writeFile } from "node:fs/promises";
import { Deferred, Effect, Schema } from "effect";
import { causeHelpers } from "../backend/effect-boundary";
import type { HostMemory, HostMemoryLevel } from "../backend/host-memory";

const SAMPLE_INTERVAL_MS = 5_000;
/**
 * The walk of `/proc` reads one file for every process of the machine, so it runs less often than
 * the memory reading. A new child can wait this long for its OOM value.
 */
const OOM_WALK_INTERVAL_MS = 30_000;
/** At most this many `/proc` reads and writes are in flight, so the walk never floods the file system. */
const PROC_CONCURRENCY = 8;
const MIB = 1024 * 1024;
const GIB = 1024 * MIB;
/** A turn that starts counts this much until its provider processes have grown. */
const TURN_RESERVE_BYTES = 300 * MIB;
const TURN_RESERVE_MS = 60_000;
/** A low level goes back to "ok" only this far above the low threshold, so it does not flap. */
const RECOVER_MARGIN_BYTES = 256 * MIB;
/**
 * The unit starts main at -500. Each process that main starts gets this value, so the OOM killer in
 * the unit picks a provider CLI, an MCP server or an agent tool before main.
 */
const CHILD_OOM_SCORE_ADJ = 500;

export interface HostedServerMemoryOptions {
  /** Called one time when the memory files cannot be read (the level then stays "ok"), and when a listener fails. */
  onError: (message: string, error: unknown) => void;
  now?: () => number;
  /** Tests only. Reads `/proc` and `/sys/fs/cgroup` files. */
  readText?: (path: string) => Promise<string>;
  /** Tests only. Set to false to leave the OOM values of the child processes alone. */
  adjustChildOomScores?: boolean;
  /** Tests only. The directory that holds the process files, and the process that is main. */
  proc?: { root: string; pid: number };
}

interface MemorySample {
  total: number;
  available: number;
}

/**
 * Owns the memory reading of a hosted server and of a self-hosted server, also one in Docker. Every
 * 5 seconds it reads the memory of the systemd unit or container (cgroup v2) and of the machine. Every
 * 30 seconds it gives each new child process of main a high OOM value.
 * The backend reads the level through `HostMemory` and holds new turns while it is not "ok".
 */
export class HostedServerMemory implements HostMemory {
  readonly #options: HostedServerMemoryOptions;
  readonly #listeners = new Set<() => void>();
  /** The start times of the turns reserved in the last `TURN_RESERVE_MS`. Each one is its own object, so its release removes only it. */
  readonly #reservations = new Set<{ at: number }>();
  #timer: ReturnType<typeof setInterval> | null = null;
  #pending: Deferred.Deferred<void> | null = null;
  #sample: MemorySample | null = null;
  #level: HostMemoryLevel = "ok";
  #readErrorLogged = false;
  /** When the `/proc` walk last started, or null before the first one. */
  #lastOomWalkAt: number | null = null;
  /**
   * The children that already have their OOM value, with the start time of each. The start time is
   * part of the identity, so a new process that reuses the number of one that ended is still adjusted.
   */
  readonly #adjusted = new Map<number, string>();

  constructor(options: HostedServerMemoryOptions) {
    this.#options = options;
  }

  start(): void {
    if (this.#timer) return;
    void Effect.runPromise(this.tick());
    this.#timer = setInterval(() => void Effect.runPromise(this.tick()), SAMPLE_INTERVAL_MS);
    this.#timer.unref();
  }

  stop(): Effect.Effect<void> {
    return Effect.suspend(() => {
      if (this.#timer) clearInterval(this.#timer);
      this.#timer = null;
      return this.#pending ? Deferred.await(this.#pending) : Effect.void;
    });
  }

  level(): HostMemoryLevel {
    return this.#level;
  }

  turnLimit(): 4 | 8 | 16 {
    // A margin over the plan sizes of 4 and 8 GB: the kernel keeps some memory for itself.
    const total = this.#sample?.total ?? 0;
    if (total <= 5 * GIB) return 4;
    if (total <= 10 * GIB) return 8;
    return 16;
  }

  reserveTurn(): () => void {
    const reservation = { at: this.#now() };
    this.#reservations.add(reservation);
    this.#level = this.#nextLevel();
    return () => {
      if (this.#reservations.delete(reservation)) this.#level = this.#nextLevel();
    };
  }

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  tick(): Effect.Effect<void> {
    return Effect.suspend(() => {
      if (this.#pending) return Deferred.await(this.#pending);
      const pending = Deferred.makeUnsafe<void>();
      this.#pending = pending;
      return this.#tick().pipe(
        Effect.onExit((exit) =>
          Effect.gen({ self: this }, function* () {
            this.#pending = null;
            yield* Deferred.done(pending, exit);
          }),
        ),
      );
    }).pipe(Effect.uninterruptible);
  }

  #tick = Effect.fn("HostedServerMemory.tick")(function* (this: HostedServerMemory) {
    this.#sample = yield* this.#read();
    this.#level = this.#nextLevel();
    if (this.#options.adjustChildOomScores !== false && this.#oomWalkDue()) yield* this.#raiseChildOomScores();
    for (const listener of this.#listeners) {
      try {
        listener();
      } catch (error) {
        this.#options.onError("A hosted server memory listener failed.", error);
      }
    }
  });

  #read = Effect.fn("HostedServerMemory.read")(function* (this: HostedServerMemory) {
    const read = this.#options.readText ?? ((path: string) => readFile(path, "utf8"));
    const result = yield* Effect.result(
      Effect.gen(function* () {
        const text = yield* memoryIO(() => read("/proc/meminfo"));
        const machine = yield* Effect.try({
          try: () => parseMeminfo(text),
          catch: (cause) => new HostMemoryFailure({ cause }),
        });
        const unit = yield* readUnitMemory(read);
        if (!unit) return machine;
        return {
          total: Math.min(machine.total, unit.max),
          available: Math.min(machine.available, Math.max(0, unit.max - unit.current)),
        };
      }),
    );
    if (result._tag === "Success") return result.success;
    if (!this.#readErrorLogged) {
      this.#readErrorLogged = true;
      this.#options.onError("The hosted server could not read its memory use.", result.failure.cause);
    }
    return null;
  });

  #nextLevel(): HostMemoryLevel {
    const sample = this.#sample;
    if (!sample) return "ok";
    const now = this.#now();
    for (const reservation of this.#reservations) {
      if (now - reservation.at >= TURN_RESERVE_MS) this.#reservations.delete(reservation);
    }
    if (sample.available < Math.max(256 * MIB, sample.total * 0.06)) return "critical";
    const free = sample.available - this.#reservations.size * TURN_RESERVE_BYTES;
    const low = Math.max(512 * MIB, sample.total * 0.12);
    if (free < low) return "low";
    if (this.#level !== "ok" && free < low + RECOVER_MARGIN_BYTES) return "low";
    return "ok";
  }

  #oomWalkDue(): boolean {
    const last = this.#lastOomWalkAt;
    const now = this.#now();
    // A clock that went back starts a walk too, so the walk cannot wait for a time that has passed.
    return last === null || now < last || now - last >= OOM_WALK_INTERVAL_MS;
  }

  #raiseChildOomScores(): Effect.Effect<void> {
    this.#lastOomWalkAt = this.#now();
    return raiseChildOomScores(
      this.#options.proc?.root ?? "/proc",
      this.#options.proc?.pid ?? process.pid,
      this.#adjusted,
    );
  }

  #now(): number {
    return this.#options.now?.() ?? Date.now();
  }
}

function parseMeminfo(text: string): MemorySample {
  const kib = (name: string): number => {
    const match = new RegExp(`^${name}:\\s+(\\d+) kB$`, "m").exec(text);
    if (!match?.[1]) throw new Error(`/proc/meminfo has no ${name}.`);
    return Number(match[1]) * 1024;
  };
  return { total: kib("MemTotal"), available: kib("MemAvailable") };
}

/**
 * The limit and the use of the unit's or container's cgroup, with no reclaimable file cache, or null
 * when it has no limit or no cgroup v2.
 *
 * A file of the cgroup that is missing means "no limit that we can read", not a failure: a container
 * whose cgroup has no memory controller would otherwise lose the whole reading, and with it the
 * levels and the turn limit that the machine totals can still give.
 */
const readUnitMemory = Effect.fn("HostedServerMemory.readUnit")(function* (read: (path: string) => Promise<string>) {
  const cgroup = (yield* optionalMemoryIO(() => read("/proc/self/cgroup")))
    ?.split("\n")
    .find((line) => line.startsWith("0::"));
  if (!cgroup) return null;
  // In a container with its own cgroup namespace this is "0::/", and the files are at the mount root.
  const root = `/sys/fs/cgroup${cgroup.slice(3)}`.replace(/\/+$/u, "");
  const max = (yield* optionalMemoryIO(() => read(`${root}/memory.max`)))?.trim();
  if (max === undefined || max === "max" || !/^\d+$/u.test(max)) return null;
  const current = Number((yield* optionalMemoryIO(() => read(`${root}/memory.current`)))?.trim());
  if (!Number.isFinite(current)) return null;
  // `memory.current` counts the file cache too. The kernel takes the inactive part back before the
  // OOM killer acts, so it is free memory, as it is in `MemAvailable`.
  const inactiveFile = /^inactive_file (\d+)$/m.exec(
    (yield* optionalMemoryIO(() => read(`${root}/memory.stat`))) ?? "",
  )?.[1];
  return { max: Number(max), current: current - Number(inactiveFile ?? 0) };
});

/**
 * Gives each descendant of main, other than the Electron processes, at least `CHILD_OOM_SCORE_ADJ`.
 * A process can end during the walk, so each read and write can fail and is ignored.
 *
 * An Electron process runs the same binary as main. Chromium sets the values of its renderers and GPU
 * process itself, and the zygotes and the GPU broker keep the -500 of main. `app.getAppMetrics()` does
 * not list the zygotes or the broker, so the binary is the test: with 500, the OOM killer could kill a
 * zygote, and then no new renderer can start.
 *
 * `adjusted` holds the children that are done. A process that is not done is looked at again on the
 * next walk: an Electron one, because a child that has forked and not yet executed shows the binary of
 * main, and one whose value could not be written.
 */
const raiseChildOomScores = Effect.fn("HostedServerMemory.raiseChildOomScores")(function* (
  root: string,
  mainPid: number,
  adjusted: Map<number, string>,
) {
  const electron = yield* optionalMemoryIO(() => readlink(`${root}/self/exe`));
  const children = new Map<number, number[]>();
  const startTimes = new Map<number, string>();
  const entries = yield* optionalMemoryIO(() => readdir(root));
  yield* Effect.forEach(
    entries ?? [],
    (entry) =>
      Effect.gen(function* () {
        if (!/^\d+$/.test(entry)) return;
        const stat = yield* optionalMemoryIO(() => readFile(`${root}/${entry}/stat`, "utf8"));
        if (stat === null) return;
        // The name can hold spaces, so the fields start after the last ")". Field 4 is the parent and
        // field 22 is the start time.
        const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
        const parent = Number(fields[1]);
        if (!Number.isInteger(parent)) return;
        const siblings = children.get(parent) ?? [];
        siblings.push(Number(entry));
        children.set(parent, siblings);
        startTimes.set(Number(entry), fields[19] ?? "");
      }),
    { concurrency: PROC_CONCURRENCY, discard: true },
  );
  const descendants: number[] = [];
  const pending = [...(children.get(mainPid) ?? [])];
  for (let pid = pending.pop(); pid !== undefined; pid = pending.pop()) {
    descendants.push(pid);
    pending.push(...(children.get(pid) ?? []));
  }
  // A process that is gone or has another start time is no longer done.
  const alive = new Set(descendants);
  for (const [pid, startedAt] of adjusted) {
    if (!alive.has(pid) || startTimes.get(pid) !== startedAt) adjusted.delete(pid);
  }
  yield* Effect.forEach(
    descendants,
    (pid) =>
      Effect.gen(function* () {
        const startedAt = startTimes.get(pid) ?? "";
        if (startedAt !== "" && adjusted.get(pid) === startedAt) return;
        if (electron === null || (yield* optionalMemoryIO(() => readlink(`${root}/${pid}/exe`))) === electron) return;
        const path = `${root}/${pid}/oom_score_adj`;
        const text = yield* optionalMemoryIO(() => readFile(path, "utf8"));
        if (text === null) return;
        if (Number(text.trim()) >= CHILD_OOM_SCORE_ADJ) {
          if (startedAt !== "") adjusted.set(pid, startedAt);
          return;
        }
        const written = yield* memoryIO(() => writeFile(path, String(CHILD_OOM_SCORE_ADJ))).pipe(
          Effect.as(true),
          Effect.catch(() => Effect.succeed(false)),
        );
        if (written && startedAt !== "") adjusted.set(pid, startedAt);
      }),
    { concurrency: PROC_CONCURRENCY, discard: true },
  );
});

class HostMemoryFailure extends Schema.TaggedError<HostMemoryFailure>()("HostMemoryFailure", {
  cause: Schema.Defect(),
}) {}

const { io: memoryIO } = causeHelpers(HostMemoryFailure);

function optionalMemoryIO<A>(operation: () => Promise<A>): Effect.Effect<A | null> {
  return memoryIO(operation).pipe(Effect.catch(() => Effect.succeed(null)));
}
