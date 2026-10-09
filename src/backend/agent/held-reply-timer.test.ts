// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { HeldReplyTimer } from "./held-reply-timer";

afterEach(() => {
  vi.useRealTimers();
});

describe("HeldReplyTimer", () => {
  it("wakes the agents whose release has come, and arms the next release", () => {
    vi.useFakeTimers();
    const releases = new Map([
      ["chief", Date.now() + 60_000],
      ["lead", Date.now() + 120_000],
    ]);
    const due = vi.fn<(agentIds: string[]) => void>((agentIds) => {
      for (const agentId of agentIds) releases.delete(agentId);
    });
    const timer = new HeldReplyTimer({ releases: () => releases, due });
    timer.arm();

    vi.advanceTimersByTime(59_999);
    expect(due).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(due).toHaveBeenLastCalledWith(["chief"]);
    vi.advanceTimersByTime(60_000);
    expect(due).toHaveBeenLastCalledWith(["lead"]);
    expect(due).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("moves the timer to an earlier release, and stops when nothing is held", () => {
    vi.useFakeTimers();
    const releases = new Map([["chief", Date.now() + 600_000]]);
    const due = vi.fn<(agentIds: string[]) => void>();
    const timer = new HeldReplyTimer({ releases: () => releases, due });
    timer.arm();
    releases.set("lead", Date.now() + 1_000);
    timer.arm();
    expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(1_000);
    expect(due).toHaveBeenCalledWith(["lead"]);

    releases.clear();
    timer.arm();
    expect(vi.getTimerCount()).toBe(0);
  });
});
