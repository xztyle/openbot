/**
 * Finds agent turns whose provider has sent nothing for a long time, and says so once in the log.
 * It only watches. It never stops, interrupts or retries a turn: a long tool run can be silent for
 * a long time and still be right. The operator reads `longest_turn_idle_s` in `openbot status` and
 * decides.
 *
 * The provider clients have no inactivity watchdog of their own. Their request timeouts cover one
 * request, not a turn that is running.
 */

export interface RunningTurnActivity {
  turnId: string;
  agentId: string;
  /** Epoch milliseconds. */
  startedAt: number;
  /** Epoch milliseconds of the last provider event of the agent, never before `startedAt`. */
  lastEventAt: number;
}

export interface TurnActivityReport {
  running: number;
  longestTurnSeconds: number;
  longestIdleSeconds: number;
  /** Running turns that are silent for longer than the threshold. */
  silent: number;
}

export interface SilentTurnMonitorOptions {
  activity: () => RunningTurnActivity[];
  thresholdMs: number;
  warn: (message: string, details: { agentId: string; turnId: string; idleMinutes: number }) => void;
  now?: () => number;
}

const CHECK_INTERVAL_MS = 60_000;
export const DEFAULT_SILENT_TURN_MINUTES = 30;
const MAX_SILENT_TURN_MINUTES = 24 * 60;

/** `OPENBOT_SILENT_TURN_MINUTES`: whole minutes, 1 to 1440. Anything else means the default. */
export function readSilentTurnThresholdMs(value: string | undefined): number {
  const minutes = value !== undefined && /^\d+$/u.test(value.trim()) ? Number(value.trim()) : Number.NaN;
  const valid = Number.isInteger(minutes) && minutes >= 1 && minutes <= MAX_SILENT_TURN_MINUTES;
  return (valid ? minutes : DEFAULT_SILENT_TURN_MINUTES) * 60_000;
}

export class SilentTurnMonitor {
  readonly #options: SilentTurnMonitorOptions;
  /** The turns that were already reported, so each one is reported once. */
  readonly #reported = new Set<string>();
  #timer: ReturnType<typeof setInterval> | null = null;

  constructor(options: SilentTurnMonitorOptions) {
    this.#options = options;
  }

  start(): void {
    if (this.#timer) return;
    this.#timer = setInterval(() => this.check(), CHECK_INTERVAL_MS);
    this.#timer.unref();
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
    this.#reported.clear();
  }

  /** The numbers for `openbot status`. Has no side effect. */
  report(): TurnActivityReport {
    const now = this.#now();
    const turns = this.#options.activity();
    let longestTurnMs = 0;
    let longestIdleMs = 0;
    let silent = 0;
    for (const turn of turns) {
      longestTurnMs = Math.max(longestTurnMs, now - turn.startedAt);
      const idleMs = Math.max(0, now - turn.lastEventAt);
      longestIdleMs = Math.max(longestIdleMs, idleMs);
      if (idleMs >= this.#options.thresholdMs) silent += 1;
    }
    return {
      running: turns.length,
      longestTurnSeconds: Math.floor(longestTurnMs / 1000),
      longestIdleSeconds: Math.floor(longestIdleMs / 1000),
      silent,
    };
  }

  /** Warns once for each turn that went silent. A turn that ends, or speaks again, can be reported again later. */
  check(): void {
    const now = this.#now();
    const live = new Set<string>();
    for (const turn of this.#options.activity()) {
      const idleMs = now - turn.lastEventAt;
      if (idleMs < this.#options.thresholdMs) {
        this.#reported.delete(turn.turnId);
        continue;
      }
      live.add(turn.turnId);
      if (this.#reported.has(turn.turnId)) continue;
      this.#reported.add(turn.turnId);
      this.#options.warn("A turn has made no progress for a long time. OpenBot does not stop it.", {
        agentId: turn.agentId,
        turnId: turn.turnId,
        idleMinutes: Math.floor(idleMs / 60_000),
      });
    }
    for (const turnId of this.#reported) if (!live.has(turnId)) this.#reported.delete(turnId);
  }

  #now(): number {
    return this.#options.now?.() ?? Date.now();
  }
}
