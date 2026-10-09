import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { extname } from "node:path";
import { sourceText } from "@openbot/i18n/source";
import { Effect } from "effect";
import type { EventCheckArguments } from "./event-check-reader";
import { CHECK_MAX_BYTES } from "./event-check-result";
import { mcpFailure } from "./mcp-effects";
import { redactMcpResult } from "./mcp-result-redaction";
import { stopWindowsProcessTree } from "./windows-process-tree";

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
    let size = 0,
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
    });
    child.on("error", () => finish(new Error("Program could not start.")));
    child.once("exit", (code) => {
      if (code !== 0) finish(new Error("Program failed."));
      killGroup(child);
    });
    child.once("close", (code) => finish(code === 0 ? undefined : new Error("Program failed.")));
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
        catch: () => mcpFailure(new Error(sourceText("error.backend.eventCheckFailed"))),
      }),
    stop,
  ).pipe(Effect.timeout("40 seconds"), Effect.mapError(mcpFailure));
});
