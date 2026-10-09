import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { extname } from "node:path";
import { sourceText } from "@openbot/i18n/source";
import { Effect } from "effect";
import type { EventCheckArguments } from "./event-check-reader";
import { CHECK_MAX_BYTES } from "./event-check-result";
import { mcpFailure } from "./mcp-effects";
import { redactMcpResult } from "./mcp-result-redaction";
import { stopWindowsProcessTree } from "./windows-process-tree";

/** The only error codes a program can report. The host maps each one to fixed text and never echoes the program's own text. */
const EVENT_CHECK_ERROR_CODES = ["auth", "rate_limited", "config", "upstream"] as const;
type EventCheckErrorCode = (typeof EVENT_CHECK_ERROR_CODES)[number];
const ERROR_CODE_LINE = new RegExp(`^openbot-error: (${EVENT_CHECK_ERROR_CODES.join("|")})$`, "mu");
const STDERR_CODE_BYTES = 8192;
const ERROR_CODE_TEXT: Record<EventCheckErrorCode | "generic", () => string> = {
  auth: () => sourceText("error.backend.eventCheckAuth"),
  rate_limited: () => sourceText("error.backend.eventCheckRateLimited"),
  config: () => sourceText("error.backend.eventCheckConfig"),
  upstream: () => sourceText("error.backend.eventCheckUpstream"),
  generic: () => sourceText("error.backend.eventCheckFailed"),
};
/** The code a failed program printed as one `openbot-error: <code>` line on stderr, or null. Other stderr text is dropped. */
function eventCheckErrorCode(stderr: string): EventCheckErrorCode | null {
  const code = ERROR_CODE_LINE.exec(stderr.replaceAll("\r", ""))?.[1];
  return EVENT_CHECK_ERROR_CODES.find((candidate) => candidate === code) ?? null;
}
/** A program that exited with an error. Its message is a fixed catalog text, never program output. */
class EventCheckProgramError extends Error {
  constructor(readonly code: EventCheckErrorCode | null) {
    super(ERROR_CODE_TEXT[code ?? "generic"]());
  }
}
/** Finds the program failure in the cause chain that the effect runtime hands to a catch. */
export function eventCheckProgramError(cause: unknown): EventCheckProgramError | null {
  let current: unknown = cause;
  for (let depth = 0; depth < 8 && current !== null && typeof current === "object"; depth++) {
    if (current instanceof EventCheckProgramError) return current;
    current = "cause" in current ? current.cause : "failure" in current ? current.failure : null;
  }
  return null;
}

function launch(path: string, cwd: string, variables: Record<string, string>, nodeExecutable: string) {
  const extension = extname(path),
    javascript = extension === ".js" || extension === ".mjs";
  const executable = javascript ? nodeExecutable : extension === ".py" ? "/usr/bin/python3" : "/bin/sh";
  return spawn(executable, [path], {
    cwd,
    shell: false,
    detached: process.platform !== "win32",
    env: { PATH: "/usr/local/bin:/usr/bin:/bin", LANG: "C.UTF-8", ...variables },
    stdio: ["pipe", "pipe", "pipe"],
  });
}
function killGroup(child: ChildProcessWithoutNullStreams) {
  if (child.pid === undefined) return;
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    /* Already exited. */
  }
}
function stop(child: ChildProcessWithoutNullStreams) {
  child.stdin.destroy();
  child.stdout.destroy();
  child.stderr.destroy();
  return process.platform === "win32"
    ? stopWindowsProcessTree(child).pipe(Effect.catchCause(() => Effect.void))
    : Effect.sync(() => killGroup(child));
}
function output(
  child: ChildProcessWithoutNullStreams,
  args: EventCheckArguments,
  signal: AbortSignal,
  valid: () => boolean,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const errors: Buffer[] = [];
    let size = 0,
      errorSize = 0,
      settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", abort);
      clearInterval(stale);
      if (error) reject(error);
      else resolve(Buffer.concat(chunks).toString("utf8"));
    };
    const abort = () => {
      killGroup(child);
      finish(new Error("Program cancelled."));
    };
    const stale = setInterval(() => {
      try {
        if (!valid()) abort();
      } catch {
        abort();
      }
    }, 250);
    signal.addEventListener("abort", abort, { once: true });
    child.stdout.on("data", (chunk: Buffer) => {
      size += chunk.byteLength;
      if (size > CHECK_MAX_BYTES) abort();
      else chunks.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      size += chunk.byteLength;
      if (size > CHECK_MAX_BYTES) abort();
      else if (errorSize < STDERR_CODE_BYTES) {
        errors.push(chunk);
        errorSize += chunk.byteLength;
      }
    });
    const failure = () => new EventCheckProgramError(eventCheckErrorCode(Buffer.concat(errors).toString("utf8")));
    child.on("error", () => finish(new Error("Program could not start.")));
    // Not settled on "exit": stderr can still hold the code. The group is killed, so "close" follows.
    child.once("exit", () => killGroup(child));
    child.once("close", (code) => finish(code === 0 ? undefined : failure()));
    child.stdin.on("error", () => finish(new Error("Program input failed.")));
    child.stdin.end(JSON.stringify(args));
    if (signal.aborted) abort();
  });
}
export const runEventCheckProgram = Effect.fn("EventCheck.program")(function* (
  path: string,
  cwd: string,
  variables: Record<string, string>,
  args: EventCheckArguments,
  valid: () => boolean,
  nodeExecutable = "/usr/bin/node",
) {
  return yield* Effect.acquireUseRelease(
    Effect.try({
      try: () => {
        if (!valid()) throw new Error("Stale check.");
        return launch(path, cwd, variables, nodeExecutable);
      },
      catch: mcpFailure,
    }),
    (child) =>
      Effect.tryPromise({
        try: async (signal) => {
          const raw = await output(child, args, signal, valid);
          return redactMcpResult(
            JSON.parse(raw),
            Object.values(variables).flatMap((value) => [
              value,
              encodeURIComponent(value),
              Buffer.from(value).toString("base64"),
            ]),
          );
        },
        catch: (error) =>
          mcpFailure(error instanceof EventCheckProgramError ? error : new EventCheckProgramError(null)),
      }),
    stop,
  ).pipe(Effect.timeout("40 seconds"), Effect.mapError(mcpFailure));
});
