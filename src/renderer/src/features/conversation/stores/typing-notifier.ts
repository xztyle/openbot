/** How long after the last key the person counts as no longer typing. */
export const TYPING_IDLE_MS = 3_000;

/**
 * How often a typing event repeats while keys keep arriving. The other side hides the signal after
 * a few seconds, so one event per key would be traffic for no one: it goes out when typing starts and
 * then at most this often.
 */
export const TYPING_REFRESH_MS = 2_000;

export interface TypingState {
  idleTimer: ReturnType<typeof setTimeout> | undefined;
  /** The agent the last "typing" event named, until a "stopped" event goes out. */
  agentId: string | null;
}

interface TypingNotifierOptions {
  state: TypingState;
  onTypingChange: (agentId: string, typing: boolean) => void;
  /** Sends "stopped" for the agent in `state` and clears the idle timer. */
  stop: () => void;
}

/** Turns the text of the message box into as few typing events as the other side needs. */
export function createTypingNotifier(options: TypingNotifierOptions) {
  let lastSentAt = 0;
  return {
    update(agentId: string | undefined, text: string, now = Date.now()): void {
      const { state } = options;
      if (state.idleTimer) clearTimeout(state.idleTimer);
      if (!agentId || !text.trim()) {
        options.stop();
        return;
      }
      if (state.agentId && state.agentId !== agentId) {
        options.onTypingChange(state.agentId, false);
        state.agentId = null;
      }
      const started = state.agentId === agentId;
      state.agentId = agentId;
      if (!started || now - lastSentAt >= TYPING_REFRESH_MS) {
        options.onTypingChange(agentId, true);
        lastSentAt = now;
      }
      state.idleTimer = setTimeout(options.stop, TYPING_IDLE_MS);
    },
  };
}
