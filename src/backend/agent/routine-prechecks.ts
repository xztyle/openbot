import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { rename, writeFile } from "node:fs/promises";
import { isDynamicRecord, isString } from "@openbot/contracts/runtime-values";
import { createOpenBotLogger } from "@openbot/logging";

/**
 * The cheap checks that a scheduled routine run passes before it wakes its agent. Most runs of a
 * polling routine find nothing (80% on a live server), and each one starts a session of the agent's
 * model that reads ~50,000 tokens before it looks. A check is a shell command the agent wrote:
 *
 * - exit 0: there is work. The run starts, with the command's output after the task.
 * - exit 1: nothing to do. The occurrence is skipped: no run, no turn, no tokens.
 * - any other exit, a timeout or a failed start: the run starts, as it would with no check.
 *
 * The checks live in their own small file, keyed by routine id, so no migration is needed. A
 * routine that is deleted keeps its line until the next write removes it.
 */

const logger = createOpenBotLogger("routine-prechecks");

export const ROUTINE_PRECHECK_MAX_LENGTH = 2_000;
const PRECHECK_TIMEOUT_MS = 60_000;
/** The output that the run receives. The rest is cut. */
const PRECHECK_OUTPUT_LIMIT = 4_000;

export type RoutinePrecheckOutcome =
  | { kind: "work"; output: string }
  | { kind: "quiet" }
  | { kind: "unknown"; reason: string };

export class RoutinePrechecks {
  readonly #path: string;
  #checks = new Map<string, string>();

  constructor(path: string) {
    this.#path = path;
    try {
      const value = JSON.parse(readFileSync(path, "utf8"));
      if (isDynamicRecord(value) && isDynamicRecord(value.checks))
        for (const [routineId, command] of Object.entries(value.checks))
          if (isString(command) && command.trim()) this.#checks.set(routineId, command);
    } catch {
      // A missing or broken file holds no checks.
    }
  }

  get(routineId: string): string | undefined {
    return this.#checks.get(routineId);
  }

  /** Sets or, with null or blank text, removes the check of one routine, and keeps only `live` routines. */
  async set(routineId: string, command: string | null, live: ReadonlySet<string>): Promise<void> {
    const next = new Map([...this.#checks].filter(([id]) => live.has(id) || id === routineId));
    if (command?.trim()) next.set(routineId, command.trim());
    else next.delete(routineId);
    const temporary = `${this.#path}.tmp`;
    await writeFile(temporary, JSON.stringify({ version: 1, checks: Object.fromEntries(next) }), { mode: 0o600 });
    await rename(temporary, this.#path);
    this.#checks = next;
  }
}

/**
 * Runs one check in the agent's workspace with a plain environment (PATH, HOME and the locale), so
 * the host's own variables never reach it.
 */
export function runRoutinePrecheck(
  command: string,
  cwd: string,
  timeoutMs = PRECHECK_TIMEOUT_MS,
): Promise<RoutinePrecheckOutcome> {
  return new Promise<RoutinePrecheckOutcome>((resolve) => {
    let output = "";
    let settled = false;
    const finish = (outcome: RoutinePrecheckOutcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(outcome);
    };
    const child = spawn("/bin/sh", ["-c", command], {
      cwd,
      env: {
        PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
        HOME: process.env.HOME ?? cwd,
        LANG: process.env.LANG ?? "C.UTF-8",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish({ kind: "unknown", reason: "timeout" });
    }, timeoutMs);
    timer.unref?.();
    const collect = (chunk: Buffer) => {
      if (output.length < PRECHECK_OUTPUT_LIMIT) output += chunk.toString("utf8");
    };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    child.on("error", (error) => finish({ kind: "unknown", reason: error.message }));
    child.on("close", (code) => {
      if (code === 0) finish({ kind: "work", output: output.slice(0, PRECHECK_OUTPUT_LIMIT).trim() });
      else if (code === 1) finish({ kind: "quiet" });
      else finish({ kind: "unknown", reason: `exit ${code ?? "signal"}` });
    });
  }).then((outcome) => {
    if (outcome.kind === "unknown")
      logger.info("A routine pre-check gave no answer; the run starts.", { reason: outcome.reason });
    return outcome;
  });
}

/** The text of a run that passed its check: the task, then what the check printed. */
export function withPrecheckOutput(instruction: string, output: string): string {
  return output ? `${instruction}\n\n--- pre-check output ---\n${output}` : instruction;
}
