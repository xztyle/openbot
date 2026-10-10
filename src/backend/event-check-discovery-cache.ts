import { createHash } from "node:crypto";
import type { EventCheckPickerOptions } from "@openbot/contracts/event-check-templates";
import { Cause, Deferred, Effect, Exit } from "effect";

/** How long a list counts as current. A list this young is served without asking the app again. */
export const DISCOVERY_FRESH_MS = 10 * 60_000;
/** How long an older list can still stand in for one that the app cannot give now. */
export const DISCOVERY_STALE_MS = 24 * 60 * 60_000;
/** The most lists kept. The one used longest ago leaves first. */
export const DISCOVERY_CACHE_ENTRIES = 32;

interface Entry {
  options: EventCheckPickerOptions;
  /** When the program answered, in milliseconds. */
  readAt: number;
}

/**
 * What tells one list from another. Every part is an ordinary value: IDs, a program digest and the
 * settings that are not private. A private value, or anything made from one, is never a part.
 */
export interface DiscoveryKeyParts {
  agentId: string;
  checkId: string;
  field: string;
  /** The digest of the reviewed program that listed the options. */
  digest: string;
  /** The settings of the check other than the picker itself, by name. Ordinary text, never a private variable. */
  settings: Readonly<Record<string, string>>;
  /** The IDs that the call named. Empty for the whole list. */
  ids: readonly string[];
}

/**
 * Owns the lists that installed checks listed for their pickers, in memory only. A list holds the
 * names of conversations and nothing private. Nothing here is written to disk, a log, a diagnostic or
 * the audit file, and the result of a draft discovery never enters it: a draft runs with a token that
 * was only typed, so nobody can say that the list belongs to a check.
 *
 * The owner decides whether a caller may read at all, before it asks this class. A list leaves here
 * only for a call that already passed that decision.
 */
export class EventCheckDiscoveryCache<E> {
  readonly #entries = new Map<string, Entry>();
  readonly #running = new Map<string, Deferred.Deferred<EventCheckPickerOptions, E>>();
  /**
   * Part of every key. Anything that can change what a check's private values or program allow
   * bumps it, so a list read under the old state is never served for the new one.
   */
  #generation = 0;

  /** `now` is read at each call, so a test can move the clock. */
  constructor(readonly now: () => number = () => Date.now()) {}

  /** Forgets every list: the private values, the approval, the program or the account of a check changed. */
  invalidate(): void {
    this.#generation += 1;
    this.#entries.clear();
  }

  key(parts: DiscoveryKeyParts): string {
    const settings = Object.entries(parts.settings).sort(([left], [right]) => (left < right ? -1 : 1));
    return createHash("sha256")
      .update(
        JSON.stringify([
          this.#generation,
          parts.agentId,
          parts.checkId,
          parts.field,
          parts.digest,
          settings,
          [...parts.ids].sort(),
        ]),
      )
      .digest("hex");
  }

  /**
   * The names of `ids` from a current whole list, or null when there is none or it lacks one of
   * them. A call that asks for a few IDs then costs no request at all.
   */
  named(wholeKey: string, ids: readonly string[]): EventCheckPickerOptions | null {
    const held = this.#current(wholeKey);
    if (!held) return null;
    const byId = new Map(held.options.options.map((option) => [option.id, option]));
    const chosen = ids.map((id) => byId.get(id));
    if (chosen.some((option) => option === undefined)) return null;
    return answer(
      {
        readAt: held.readAt,
        options: {
          options: chosen.flatMap((option) => (option ? [option] : [])),
          ...(held.options.account ? { account: held.options.account } : {}),
        },
      },
      false,
    );
  }

  /**
   * The list for `key`: a current one from memory, the call that is already running for the same
   * key, or a new call to `load`. A failed `load` is answered with an older list that is marked
   * stale when `standIn` says the failure is the kind that waiting can fix.
   */
  read(
    key: string,
    load: Effect.Effect<EventCheckPickerOptions, E>,
    options: { refresh: boolean; standIn(failure: unknown): boolean },
  ): Effect.Effect<EventCheckPickerOptions, E> {
    return Effect.suspend(() => {
      if (!options.refresh) {
        const held = this.#current(key);
        if (held) return Effect.succeed(answer(held, false));
      }
      const running = this.#running.get(key);
      if (running) return Deferred.await(running);
      const shared = Deferred.makeUnsafe<EventCheckPickerOptions, E>();
      this.#running.set(key, shared);
      const generation = this.#generation;
      return Effect.gen({ self: this }, function* () {
        const exit = yield* Effect.exit(load);
        this.#running.delete(key);
        let outcome: Exit.Exit<EventCheckPickerOptions, E>;
        if (Exit.isSuccess(exit)) {
          const entry: Entry = { options: exit.value, readAt: this.now() };
          // A list that was read before a change is not kept for the state after it.
          if (generation === this.#generation) this.#store(key, entry);
          outcome = Exit.succeed(answer(entry, false));
        } else {
          const older = this.#entries.get(key);
          outcome =
            older && this.now() - older.readAt < DISCOVERY_STALE_MS && options.standIn(Cause.squash(exit.cause))
              ? Exit.succeed(answer(older, true))
              : exit;
        }
        yield* Deferred.done(shared, outcome);
        return yield* outcome;
      }).pipe(Effect.uninterruptible);
    });
  }

  #current(key: string): Entry | null {
    const held = this.#entries.get(key);
    if (!held || this.now() - held.readAt >= DISCOVERY_FRESH_MS) return null;
    this.#entries.delete(key);
    this.#entries.set(key, held);
    return held;
  }

  #store(key: string, entry: Entry): void {
    this.#entries.delete(key);
    this.#entries.set(key, entry);
    const cutoff = this.now() - DISCOVERY_STALE_MS;
    for (const [other, held] of this.#entries) if (held.readAt < cutoff) this.#entries.delete(other);
    while (this.#entries.size > DISCOVERY_CACHE_ENTRIES) {
      const oldest = this.#entries.keys().next();
      if (oldest.done) break;
      this.#entries.delete(oldest.value);
    }
  }
}

/** The list as the caller reads it: with the time that the app answered, and a mark when it is old. */
function answer(entry: Entry, stale: boolean): EventCheckPickerOptions {
  return {
    ...entry.options,
    readAt: new Date(entry.readAt).toISOString(),
    ...(stale ? { stale: true } : {}),
  };
}
