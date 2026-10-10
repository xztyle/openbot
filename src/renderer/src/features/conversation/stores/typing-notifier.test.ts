import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTypingNotifier, TYPING_IDLE_MS, TYPING_REFRESH_MS, type TypingState } from "./typing-notifier";

function setup() {
  const state: TypingState = { idleTimer: undefined, agentId: null };
  const onTypingChange = vi.fn<(agentId: string, typing: boolean) => void>();
  const stop = vi.fn(() => {
    if (state.idleTimer) clearTimeout(state.idleTimer);
    state.idleTimer = undefined;
    if (!state.agentId) return;
    onTypingChange(state.agentId, false);
    state.agentId = null;
  });
  return { state, onTypingChange, notifier: createTypingNotifier({ state, onTypingChange, stop }) };
}

describe("typing notifier", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("sends one event when typing starts and not one per key", () => {
    const { notifier, onTypingChange } = setup();
    notifier.update("chief", "H");
    notifier.update("chief", "He");
    notifier.update("chief", "Hel");
    expect(onTypingChange.mock.calls).toEqual([["chief", true]]);
  });

  it("repeats the event at most every refresh period while keys keep arriving", () => {
    const { notifier, onTypingChange } = setup();
    notifier.update("chief", "H");
    vi.advanceTimersByTime(TYPING_REFRESH_MS - 1);
    notifier.update("chief", "He");
    expect(onTypingChange).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1);
    notifier.update("chief", "Hel");
    expect(onTypingChange).toHaveBeenCalledTimes(2);
  });

  it("stops after the idle time and starts again with the next key", () => {
    const { notifier, onTypingChange } = setup();
    notifier.update("chief", "H");
    vi.advanceTimersByTime(TYPING_IDLE_MS);
    expect(onTypingChange.mock.calls).toEqual([
      ["chief", true],
      ["chief", false],
    ]);
    notifier.update("chief", "He");
    expect(onTypingChange).toHaveBeenLastCalledWith("chief", true);
    expect(onTypingChange).toHaveBeenCalledTimes(3);
  });

  it("stops at once when the box is emptied or another agent is chosen", () => {
    const { notifier, onTypingChange } = setup();
    notifier.update("chief", "H");
    notifier.update("sales", "Hi");
    expect(onTypingChange.mock.calls).toEqual([
      ["chief", true],
      ["chief", false],
      ["sales", true],
    ]);
    notifier.update("sales", "   ");
    expect(onTypingChange).toHaveBeenLastCalledWith("sales", false);
  });
});
