/**
 * Debug routes of the local control socket, for an operator who looks into a slow server. They need
 * no restart and no `--inspect` flag: they use `node:inspector` inside the main process.
 *
 * - `POST /v1/debug/cpu-profile` with `seconds` (1 to 120, default 30) records a V8 CPU profile of the
 *   main process at a 1 ms sampling interval. It answers when the profile is written, with the path of
 *   the `.cpuprofile` file under `<userData>/debug-profiles`. Chrome DevTools (Performance) and
 *   `scripts/cpuprofile-report.ts` read the file. One profile runs at a time; the folder keeps the
 *   newest files only.
 * - `POST /v1/debug/stall-watch` with `seconds` (10 to 3600, default 600) and `threshold_ms` (50 to
 *   10000, default 200) starts a stall recorder for that time. A worker thread watches a heartbeat of
 *   the main thread. When the main thread does not answer within the threshold, the worker pauses it
 *   through the inspector for one moment and keeps the JavaScript stack of that long task. `stop=1`
 *   stops the recorder.
 * - `GET /v1/debug/stalls` answers JSON: the state of the recorder and the newest recorded stalls.
 *
 * Only the service user reaches the socket. Profiles and stacks hold function names and file
 * positions of the app's own code, never message text. Every start and end is logged.
 */

import { mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import { Session } from "node:inspector/promises";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import { isDynamicRecord, isString } from "@openbot/contracts/runtime-values";

const PROFILE_DIRECTORY = "debug-profiles";
const DEFAULT_PROFILE_SECONDS = 30;
const MAX_PROFILE_SECONDS = 120;
/** V8 takes the sampling interval in microseconds. */
const SAMPLING_INTERVAL_US = 1_000;
/** The newest profiles that the folder keeps; a profile of 120 s is about 10 to 40 MB. */
const KEPT_PROFILES = 6;
const DEFAULT_WATCH_SECONDS = 600;
const MIN_WATCH_SECONDS = 10;
const MAX_WATCH_SECONDS = 3_600;
const DEFAULT_STALL_THRESHOLD_MS = 200;
const MIN_STALL_THRESHOLD_MS = 50;
const MAX_STALL_THRESHOLD_MS = 10_000;
const HEARTBEAT_MS = 20;
const KEPT_STALLS = 50;
const STACK_FRAMES = 40;
/** At most one stall line in the log in this time, so a slow minute does not flood it. */
const STALL_LOG_INTERVAL_MS = 2_000;

export interface DebugAnswer {
  status: number;
  lines: Record<string, string | number | null>;
  body?: string;
}

export interface ServerDebugRoutesOptions {
  /** The userData folder. Profiles go into its `debug-profiles` folder. */
  userDataPath: string;
  log: (message: string) => void;
  /** Tests only: a shorter wait than `seconds`. */
  sleep?: (milliseconds: number) => Promise<void>;
}

export interface StallFrame {
  functionName: string;
  url: string;
  line: number;
  column: number;
}

export interface RecordedStall {
  /** When the main thread stopped answering. */
  at: string;
  /** How long the main thread did not answer: the whole long task. */
  blockedMs: number;
  /** How far into the long task the stack was taken. */
  sampledAfterMs: number;
  /** True when the long task had ended before the pause took effect: the stack may be of a later task. */
  late: boolean;
  frames: StallFrame[];
}

interface StallWatch {
  worker: Worker;
  heartbeat: NodeJS.Timeout;
  stopTimer: NodeJS.Timeout;
  until: number;
  thresholdMs: number;
}

export function createServerDebugRoutes(options: ServerDebugRoutesOptions) {
  const directory = join(options.userDataPath, PROFILE_DIRECTORY);
  const sleep = options.sleep ?? ((milliseconds: number) => new Promise((done) => setTimeout(done, milliseconds)));
  let profiling: { startedAt: number; seconds: number } | null = null;
  let watch: StallWatch | null = null;
  const stalls: RecordedStall[] = [];
  let lastStallLog = 0;

  async function route(method: string | undefined, path: string, rawBody: string): Promise<DebugAnswer | null> {
    if (path === "/v1/debug/cpu-profile") {
      if (method !== "POST") return failure(405, "method_not_allowed");
      return cpuProfile(readFields(rawBody));
    }
    if (path === "/v1/debug/stall-watch") {
      if (method !== "POST") return failure(405, "method_not_allowed");
      return stallWatch(readFields(rawBody));
    }
    if (path === "/v1/debug/stalls") {
      if (method !== "GET") return failure(405, "method_not_allowed");
      return { status: 200, lines: {}, body: `${JSON.stringify(stallReport(), null, 2)}\n` };
    }
    return null;
  }

  async function cpuProfile(fields: Fields): Promise<DebugAnswer> {
    const seconds = boundedNumber(fields.seconds, DEFAULT_PROFILE_SECONDS, 1, MAX_PROFILE_SECONDS);
    if (seconds === null) return failure(400, "invalid_seconds", `Send seconds from 1 to ${MAX_PROFILE_SECONDS}.`);
    if (profiling) {
      const left = Math.max(0, Math.ceil((profiling.startedAt + profiling.seconds * 1_000 - Date.now()) / 1_000));
      return failure(409, "profile_running", `A profile runs for ${left} more seconds.`);
    }
    profiling = { startedAt: Date.now(), seconds };
    const session = new Session();
    try {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      session.connect();
      await session.post("Profiler.enable");
      await session.post("Profiler.setSamplingInterval", { interval: SAMPLING_INTERVAL_US });
      options.log(`A CPU profile of the main process started for ${seconds} s.`);
      await session.post("Profiler.start");
      await sleep(seconds * 1_000);
      const { profile } = await session.post("Profiler.stop");
      const file = join(
        directory,
        `cpu-${new Date(profiling.startedAt).toISOString().replace(/[:.]/gu, "-")}.cpuprofile`,
      );
      const text = JSON.stringify(profile);
      await writeFile(file, text, { mode: 0o600 });
      await pruneProfiles(directory);
      options.log(
        `The CPU profile was written: ${file} (${text.length} bytes, ${profile.samples?.length ?? 0} samples).`,
      );
      return {
        status: 200,
        lines: {
          path: file,
          bytes: text.length,
          seconds,
          samples: profile.samples?.length ?? 0,
          interval_us: SAMPLING_INTERVAL_US,
        },
      };
    } catch (error) {
      options.log(`The CPU profile failed: ${errorMessage(error)}`);
      return failure(500, "profile_failed", errorMessage(error));
    } finally {
      await session.post("Profiler.disable").catch(() => undefined);
      session.disconnect();
      profiling = null;
    }
  }

  function stallWatch(fields: Fields): DebugAnswer {
    if (fields.stop) {
      const was = watch !== null;
      stopWatch("an operator stopped it");
      return { status: 200, lines: { watching: "no", stopped: was ? "yes" : "no", stalls: stalls.length } };
    }
    const seconds = boundedNumber(fields.seconds, DEFAULT_WATCH_SECONDS, MIN_WATCH_SECONDS, MAX_WATCH_SECONDS);
    if (seconds === null)
      return failure(400, "invalid_seconds", `Send seconds from ${MIN_WATCH_SECONDS} to ${MAX_WATCH_SECONDS}.`);
    const thresholdMs = boundedNumber(
      fields.thresholdMs,
      DEFAULT_STALL_THRESHOLD_MS,
      MIN_STALL_THRESHOLD_MS,
      MAX_STALL_THRESHOLD_MS,
    );
    if (thresholdMs === null)
      return failure(
        400,
        "invalid_threshold",
        `Send threshold_ms from ${MIN_STALL_THRESHOLD_MS} to ${MAX_STALL_THRESHOLD_MS}.`,
      );
    if (watch)
      return failure(409, "watch_running", `A stall recorder runs until ${new Date(watch.until).toISOString()}.`);
    const beat = new BigInt64Array(new SharedArrayBuffer(8));
    Atomics.store(beat, 0, BigInt(Date.now()));
    const worker = new Worker(STALL_WORKER_SOURCE, {
      eval: true,
      workerData: { beat, thresholdMs, frames: STACK_FRAMES },
    });
    worker.unref();
    const heartbeat = setInterval(() => Atomics.store(beat, 0, BigInt(Date.now())), HEARTBEAT_MS);
    heartbeat.unref();
    const until = Date.now() + seconds * 1_000;
    const stopTimer = setTimeout(() => stopWatch("its time ended"), seconds * 1_000);
    stopTimer.unref();
    const current: StallWatch = { worker, heartbeat, stopTimer, until, thresholdMs };
    watch = current;
    worker.on("message", (message: unknown) => {
      const stall = decodeStall(message);
      if (!stall) {
        if (isDynamicRecord(message) && isString(message.error))
          options.log(`The stall recorder could not watch the main thread: ${message.error}`);
        return;
      }
      stalls.push(stall);
      if (stalls.length > KEPT_STALLS) stalls.splice(0, stalls.length - KEPT_STALLS);
      const now = Date.now();
      if (now - lastStallLog >= STALL_LOG_INTERVAL_MS) {
        lastStallLog = now;
        const top = stall.frames
          .slice(0, 4)
          .map((frame) => frame.functionName || "(anonymous)")
          .join(" < ");
        options.log(`Main thread stall of ${stall.blockedMs} ms${stall.late ? " (late stack)" : ""}: ${top}`);
      }
    });
    worker.on("error", (error) => {
      options.log(`The stall recorder stopped after an error: ${errorMessage(error)}`);
      if (watch === current) stopWatch("of an error");
    });
    options.log(`The stall recorder started for ${seconds} s with a threshold of ${thresholdMs} ms.`);
    return {
      status: 200,
      lines: { watching: "yes", until: new Date(until).toISOString(), threshold_ms: thresholdMs },
    };
  }

  function stopWatch(reason: string): void {
    const current = watch;
    if (!current) return;
    watch = null;
    clearInterval(current.heartbeat);
    clearTimeout(current.stopTimer);
    // The worker disconnects its session first, so that the main thread is never left paused.
    current.worker.postMessage("stop");
    const terminate = setTimeout(() => void current.worker.terminate(), 1_000);
    terminate.unref();
    current.worker.once("exit", () => clearTimeout(terminate));
    options.log(`The stall recorder stopped because ${reason}; it recorded ${stalls.length} stalls.`);
  }

  function stallReport() {
    return {
      watching: watch !== null,
      until: watch ? new Date(watch.until).toISOString() : null,
      thresholdMs: watch?.thresholdMs ?? null,
      profiling: profiling !== null,
      stalls: [...stalls].reverse(),
    };
  }

  /** Stops a running stall recorder. A running profile ends with its request. */
  function close(): void {
    stopWatch("the app stops");
  }

  return { route, close };
}

/**
 * The stall worker. It reads the heartbeat that the main thread writes every 20 ms. When the beat is
 * older than the threshold, it asks the main thread's inspector to pause once for that long task,
 * keeps the stack and resumes at once. When the beat moves again, it sends the stall with its length.
 */
const STALL_WORKER_SOURCE = `
const { parentPort, workerData } = require("node:worker_threads");
const { Session } = require("node:inspector");
const { beat, thresholdMs, frames: frameLimit } = workerData;
const session = new Session();
let pending = null;
let ready = false;
let stopped = false;
const keepAlive = setInterval(() => {}, 60000);
const now = () => Date.now();
const lastBeat = () => Number(Atomics.load(beat, 0));
function finish() {
  if (stopped) return;
  stopped = true;
  clearInterval(poll);
  clearInterval(keepAlive);
  try { session.disconnect(); } catch {}
  parentPort.close();
}
session.on("Debugger.paused", (message) => {
  const callFrames = message.params.callFrames || [];
  const frames = callFrames.slice(0, frameLimit).map((frame) => ({
    functionName: frame.functionName || "",
    url: frame.url || "",
    line: frame.location.lineNumber + 1,
    column: frame.location.columnNumber + 1,
  }));
  session.post("Debugger.resume", {}, () => {});
  if (pending && !pending.frames) {
    pending.frames = frames;
    pending.sampledAfterMs = now() - pending.since;
    pending.late = lastBeat() !== pending.beat;
  }
});
const poll = setInterval(() => {
  if (!ready || stopped) return;
  const last = lastBeat();
  if (pending) {
    if (last !== pending.beat && pending.frames) {
      parentPort.postMessage({
        at: new Date(pending.since).toISOString(),
        blockedMs: last - pending.since,
        sampledAfterMs: pending.sampledAfterMs,
        late: pending.late,
        frames: pending.frames,
      });
      pending = null;
    } else if (last !== pending.beat && now() - pending.requestedAt > 5000) {
      pending = null;
    }
    return;
  }
  if (now() - last > thresholdMs) {
    pending = { beat: last, since: last, requestedAt: now(), frames: null, sampledAfterMs: 0, late: false };
    session.post("Debugger.pause", {}, () => {});
  }
}, 10);
parentPort.on("message", (message) => { if (message === "stop") finish(); });
try {
  session.connectToMainThread();
  session.post("Debugger.enable", {}, (error) => {
    if (error) {
      parentPort.postMessage({ error: String(error && error.message || error) });
      finish();
      return;
    }
    ready = true;
  });
} catch (error) {
  parentPort.postMessage({ error: String(error && error.message || error) });
  finish();
}
`;

interface Fields {
  seconds: number | undefined;
  thresholdMs: number | undefined;
  stop: boolean;
}

/** A JSON object, or form fields. */
function readFields(rawBody: string): Fields {
  const trimmed = rawBody.trim();
  if (trimmed.startsWith("{")) {
    let value: unknown = null;
    try {
      value = JSON.parse(trimmed);
    } catch {
      value = null;
    }
    const record = isDynamicRecord(value) ? value : {};
    return {
      seconds: numberField(record.seconds),
      thresholdMs: numberField(record.thresholdMs ?? record.threshold_ms),
      stop: record.stop === true || record.stop === 1,
    };
  }
  const form = new URLSearchParams(trimmed);
  return {
    seconds: numberField(form.get("seconds")),
    thresholdMs: numberField(form.get("threshold_ms")),
    stop: form.get("stop") === "1" || form.get("stop") === "yes",
  };
}

function numberField(value: unknown): number | undefined {
  if (typeof value === "number") return value;
  if (isString(value) && value.trim() !== "") return Number(value);
  return undefined;
}

/** The value, the fallback when it is absent, or null when it is out of range. */
function boundedNumber(value: number | undefined, fallback: number, min: number, max: number): number | null {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value) || value < min || value > max) return null;
  return Math.round(value);
}

function decodeStall(message: unknown): RecordedStall | null {
  if (!isDynamicRecord(message) || !isString(message.at) || !Array.isArray(message.frames)) return null;
  return {
    at: message.at,
    blockedMs: Number(message.blockedMs) || 0,
    sampledAfterMs: Number(message.sampledAfterMs) || 0,
    late: message.late === true,
    frames: message.frames.flatMap((frame) =>
      isDynamicRecord(frame)
        ? [
            {
              functionName: isString(frame.functionName) ? frame.functionName : "",
              url: isString(frame.url) ? shortUrl(frame.url) : "",
              line: Number(frame.line) || 0,
              column: Number(frame.column) || 0,
            },
          ]
        : [],
    ),
  };
}

/** The part of a script URL after the app folder, so a stack stays short and names no home folder. */
function shortUrl(url: string): string {
  const asar = url.lastIndexOf("app.asar/");
  if (asar >= 0) return url.slice(asar + "app.asar/".length);
  const nodeModules = url.lastIndexOf("node_modules/");
  if (nodeModules >= 0) return url.slice(nodeModules);
  const out = url.lastIndexOf("/out/");
  if (out >= 0) return url.slice(out + 1);
  return url.slice(url.lastIndexOf("/") + 1);
}

/** Keeps the newest profiles. */
async function pruneProfiles(directory: string): Promise<void> {
  const names = (await readdir(directory)).filter((name) => name.endsWith(".cpuprofile"));
  const files = await Promise.all(
    names.map(async (name) => ({ path: join(directory, name), modified: (await stat(join(directory, name))).mtimeMs })),
  );
  files.sort((left, right) => right.modified - left.modified);
  for (const file of files.slice(KEPT_PROFILES)) await rm(file.path, { force: true });
}

function failure(status: number, error: string, message: string | null = null): DebugAnswer {
  return { status, lines: { error, message } };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
