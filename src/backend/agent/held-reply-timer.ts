export interface HeldReplyTimerOptions {
  /** When each agent's oldest held answer stops being held, in epoch milliseconds. */
  releases(): ReadonlyMap<string, number>;
  /** The agents with an answer that is no longer held. */
  due(agentIds: string[]): void;
  now?: () => number;
}

/**
 * Wakes a requester whose held answers reach their time limit. An answer waits while a teammate
 * still works on the same request, and a teammate that stays silent sends nothing that would start
 * the requester, so a timer does. One timer serves every agent: it is set for the earliest release.
 *
 * Owns the timer only. It never imports the facade.
 */
export class HeldReplyTimer {
  readonly #releases: HeldReplyTimerOptions["releases"];
  readonly #due: HeldReplyTimerOptions["due"];
  readonly #now: () => number;
  #timer: ReturnType<typeof setTimeout> | null = null;
  #at = 0;

  constructor(options: HeldReplyTimerOptions) {
    this.#releases = options.releases;
    this.#due = options.due;
    this.#now = options.now ?? Date.now;
  }

  /** Sets the timer for the earliest release, or stops it when no answer is held. */
  arm(): void {
    const releases = this.#releases();
    const next = releases.size === 0 ? null : Math.min(...releases.values());
    if (next === null) {
      this.dispose();
      return;
    }
    if (this.#timer !== null && this.#at === next) return;
    this.dispose();
    this.#at = next;
    this.#timer = setTimeout(
      () => {
        this.#timer = null;
        this.#at = 0;
        const now = this.#now();
        const due = [...this.#releases()].filter(([, release]) => release <= now).map(([agentId]) => agentId);
        if (due.length > 0) this.#due(due);
        this.arm();
      },
      Math.max(0, next - this.#now()),
    );
    // The timer must not keep a closing process alive.
    this.#timer.unref?.();
  }

  dispose(): void {
    if (this.#timer !== null) clearTimeout(this.#timer);
    this.#timer = null;
    this.#at = 0;
  }
}
