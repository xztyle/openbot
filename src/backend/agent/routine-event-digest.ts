import type { RoutineRun } from "@openbot/contracts/ipc";
import { isEventStartedRun } from "./routine-quiet-runs";

/**
 * Runs that events may start for one routine in one hour. The cap is soft: it asks no one to drop an
 * event. Later events wait and leave as one run that carries all of them. A restart ends the wait, and
 * each waiting run then starts on its own, so no event is lost.
 */
const ROUTINE_EVENT_HOURLY_RUN_CAP = 20;
const HOUR_MS = 3_600_000;
const EVENT_BLOCK_STARTS = ["\n--- external event input ---\n", "\n--- event from a local script ---\n"];

interface HeldEvents {
  agentId: string;
  routineId: string;
  releaseAt: number;
  runs: RoutineRun[];
}

/** The part of a run instruction from its event block on, or null when the run has no event block. */
export function eventBlock(instruction: string): string | null {
  const starts = EVENT_BLOCK_STARTS.map((start) => instruction.indexOf(start)).filter((index) => index >= 0);
  return starts.length === 0 ? null : instruction.slice(Math.min(...starts) + 1);
}

/**
 * One instruction for each group of held runs: the routine task once, then every event block. A group
 * ends before it would pass `limit` characters.
 */
export function mergeEventInstructions(
  task: string,
  runs: readonly { instruction: string }[],
  limit: number,
): string[] {
  const merged: string[] = [];
  let blocks: string[] = [];
  let length = task.length;
  const flush = () => {
    if (blocks.length > 0) merged.push([task, "", ...blocks].join("\n"));
    blocks = [];
    length = task.length;
  };
  for (const run of runs) {
    const block = eventBlock(run.instruction);
    if (block === null) continue;
    if (blocks.length > 0 && length + block.length + 2 > limit) flush();
    blocks.push(block);
    length += block.length + 2;
  }
  flush();
  return merged;
}

/** Owns the runs that wait for a free hour slot. Memory only: the run rows are the durable record. */
export class RoutineEventDigest {
  readonly #held = new Map<string, HeldEvents>();

  constructor(readonly cap = ROUTINE_EVENT_HOURLY_RUN_CAP) {}

  /**
   * Whether this new run waits. `others` are the routine's other runs. It waits when the routine
   * already started `cap` runs from events in the last hour, or when a run of the routine already waits.
   */
  hold(run: RoutineRun, others: readonly RoutineRun[], now: number): boolean {
    const waiting = this.#held.get(run.routineId);
    if (waiting) {
      waiting.runs.push(run);
      return true;
    }
    const recent = others
      .filter((other) => other.id !== run.id && other.status !== "cancelled" && isEventStartedRun(other))
      .map((other) => Date.parse(other.createdAt))
      .filter((time) => Number.isFinite(time) && time > now - HOUR_MS)
      .sort((a, b) => a - b);
    if (recent.length < this.cap) return false;
    // The slot frees when enough of the old runs leave the hour.
    const frees = recent[recent.length - this.cap];
    if (frees === undefined) return false;
    this.#held.set(run.routineId, {
      agentId: run.agentId,
      routineId: run.routineId,
      releaseAt: frees + HOUR_MS,
      runs: [run],
    });
    return true;
  }

  isHeld(runId: string): boolean {
    for (const held of this.#held.values()) if (held.runs.some((run) => run.id === runId)) return true;
    return false;
  }

  /** The earliest release, as the ISO string that the shared routine timer compares. */
  nextReleaseAt(): string | null {
    let earliest: number | null = null;
    for (const held of this.#held.values())
      if (earliest === null || held.releaseAt < earliest) earliest = held.releaseAt;
    return earliest === null ? null : new Date(earliest).toISOString();
  }

  /** Puts a group back, for a later release. */
  defer(held: HeldEvents, releaseAt: number): void {
    const waiting = this.#held.get(held.routineId);
    if (waiting) waiting.runs.unshift(...held.runs);
    else this.#held.set(held.routineId, { ...held, releaseAt });
  }

  /** The waiting groups that are due, removed from the wait. */
  takeDue(now: number): HeldEvents[] {
    const due = [...this.#held.values()].filter((held) => held.releaseAt <= now);
    for (const held of due) this.#held.delete(held.routineId);
    return due;
  }
}
