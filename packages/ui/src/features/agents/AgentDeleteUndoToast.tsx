import { type Accessor, createSignal } from "solid-js";

/** How long an undo toast offers Undo: a deleted workflow, a deleted memory. */
export const AGENT_DELETE_UNDO_MS = 8_000;
const TICK_MS = 100;

/** The time to undo. It stops while the pointer or the keyboard focus is on the toast, and while the window is hidden. */
export interface UndoCountdown {
  /** The part of the time that is left, from 1 to 0. */
  readonly left: Accessor<number>;
  hold(source: "pointer" | "focus", held: boolean): void;
  stop(): void;
}

/**
 * Starts the time to undo. The caller owns it and calls `stop()` when the toast settles.
 *
 * The toast cannot count the time itself: sonner renders a toast's content more than once, for
 * example to measure its height, and each copy would get its own timer that the pointer never holds.
 */
export function startUndoCountdown(onExpire: () => void, durationMs = AGENT_DELETE_UNDO_MS): UndoCountdown {
  const [remaining, setRemaining] = createSignal(durationMs);
  const holds = new Set<"pointer" | "focus">();
  let last = performance.now();
  const timer = window.setInterval(() => {
    const now = performance.now();
    const elapsed = now - last;
    last = now;
    if (holds.size > 0 || document.hidden) return;
    const next = Math.max(0, remaining() - elapsed);
    setRemaining(next);
    if (next === 0) {
      window.clearInterval(timer);
      onExpire();
    }
  }, TICK_MS);
  return {
    left: () => remaining() / durationMs,
    hold: (source, held) => {
      if (held) holds.add(source);
      else holds.delete(source);
    },
    stop: () => window.clearInterval(timer),
  };
}
