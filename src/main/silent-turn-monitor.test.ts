// @vitest-environment node

import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_SILENT_TURN_MINUTES,
  type RunningTurnActivity,
  readSilentTurnThresholdMs,
  SilentTurnMonitor,
} from "./silent-turn-monitor";

const MINUTE = 60_000;

function fixture(thresholdMinutes = 30) {
  let now = 100 * MINUTE;
  let turns: RunningTurnActivity[] = [];
  const warn = vi.fn();
  const monitor = new SilentTurnMonitor({
    activity: () => turns,
    thresholdMs: thresholdMinutes * MINUTE,
    warn,
    now: () => now,
  });
  return {
    monitor,
    warn,
    setTurns: (next: RunningTurnActivity[]) => {
      turns = next;
    },
    advance: (minutes: number) => {
      now += minutes * MINUTE;
    },
    now: () => now,
  };
}

describe("SilentTurnMonitor", () => {
  it("reports the longest turn and the longest silence, in seconds", () => {
    const { monitor, setTurns, now } = fixture();
    expect(monitor.report()).toEqual({ running: 0, longestTurnSeconds: 0, longestIdleSeconds: 0, silent: 0 });
    setTurns([
      { turnId: "a", agentId: "x", startedAt: now() - 50 * MINUTE, lastEventAt: now() - 2 * MINUTE },
      { turnId: "b", agentId: "y", startedAt: now() - 10 * MINUTE, lastEventAt: now() - 10 * MINUTE },
    ]);
    expect(monitor.report()).toEqual({ running: 2, longestTurnSeconds: 3000, longestIdleSeconds: 600, silent: 0 });
  });

  it("warns once for a silent turn and never stops it", () => {
    const { monitor, warn, setTurns, advance, now } = fixture(30);
    setTurns([{ turnId: "a", agentId: "x", startedAt: now(), lastEventAt: now() }]);
    advance(29);
    monitor.check();
    expect(warn).not.toHaveBeenCalled();
    advance(2);
    monitor.check();
    monitor.check();
    expect(warn).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledWith(expect.any(String), { agentId: "x", turnId: "a", idleMinutes: 31 });
    expect(monitor.report().silent).toBe(1);
  });

  it("warns again when a turn speaks and then goes silent again", () => {
    const { monitor, warn, setTurns, advance, now } = fixture(30);
    const started = now();
    setTurns([{ turnId: "a", agentId: "x", startedAt: started, lastEventAt: started }]);
    advance(31);
    monitor.check();
    setTurns([{ turnId: "a", agentId: "x", startedAt: started, lastEventAt: now() }]);
    monitor.check();
    advance(31);
    setTurns([{ turnId: "a", agentId: "x", startedAt: started, lastEventAt: now() - 31 * MINUTE }]);
    monitor.check();
    expect(warn).toHaveBeenCalledTimes(2);
  });
});

describe("readSilentTurnThresholdMs", () => {
  it("accepts whole minutes in range and falls back to the default for anything else", () => {
    expect(readSilentTurnThresholdMs("5")).toBe(5 * MINUTE);
    expect(readSilentTurnThresholdMs(" 90 ")).toBe(90 * MINUTE);
    for (const bad of [undefined, "", "0", "-3", "1.5", "abc", "1441", "99999999999"]) {
      expect(readSilentTurnThresholdMs(bad)).toBe(DEFAULT_SILENT_TURN_MINUTES * MINUTE);
    }
  });
});
