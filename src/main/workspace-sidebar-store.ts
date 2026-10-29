import { INPUT_LIMITS } from "@openbot/contracts/input-limits";
import { decodeWorkspaceSidebarPrefs, type WorkspaceSidebarPrefs } from "@openbot/contracts/ipc";
import { isDynamicRecord, isNumber, isString } from "@openbot/contracts/runtime-values";
import { Effect, Semaphore } from "effect";
import { type PreferenceFileFailure, PreferenceStore } from "./preference-file";

/** The most members the file keeps. A save past it drops the member who saved longest ago. */
export const WORKSPACE_SIDEBAR_MEMBER_LIMIT = 1_000;

function isMemberId(value: unknown): value is string {
  return isString(value) && value.length > 0 && value.length <= INPUT_LIMITS.identifier;
}

interface StoredSidebar extends WorkspaceSidebarPrefs {
  /** Epoch milliseconds of the last save, to choose the member to drop past the limit. */
  updatedAt: number;
}

interface StoredSidebars {
  members: Record<string, StoredSidebar>;
}

/** Each valid member entry of the file. An entry that is not valid is dropped, not the whole file. */
function decodeStoredSidebars(parsed: unknown): StoredSidebars | null {
  if (!isDynamicRecord(parsed) || parsed.version !== 1 || !isDynamicRecord(parsed.members)) return null;
  const members: Record<string, StoredSidebar> = {};
  for (const [memberId, entry] of Object.entries(parsed.members)) {
    if (!isMemberId(memberId) || !isDynamicRecord(entry)) continue;
    try {
      const prefs = decodeWorkspaceSidebarPrefs(entry);
      members[memberId] = { ...prefs, updatedAt: isNumber(entry.updatedAt) ? entry.updatedAt : 0 };
    } catch {
      // The member reads as having no value; their next save writes one.
    }
  }
  return { members };
}

/**
 * The workspace sidebar of each member of this host: the order they dragged the channel and DM
 * rows into, and their muted conversations. One version 1 JSON file, which only this host reads:
 * `{ version: 1, members: { [memberId]: { order: { channels, direct }, muted, updatedAt } } }`.
 * The host user of this computer is one more member, under the id that `HostService.channelActor`
 * gives.
 *
 * It needs no Electron: a script constructs it with a path, calls `load`, then `get` and `set`.
 */
export class WorkspaceSidebarStore {
  readonly #file: PreferenceStore<StoredSidebars>;
  /** A save reads the members and writes them back; two at once would lose one. */
  readonly #saves = Semaphore.makeUnsafe(1);
  readonly #listeners = new Set<(memberId: string) => void>();

  constructor(path: string) {
    this.#file = new PreferenceStore<StoredSidebars>({
      path,
      defaultValue: { members: {} },
      decode: decodeStoredSidebars,
    });
  }

  /** Called after each save with the member whose value changed. */
  onChanged(listener: (memberId: string) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /** Reads the file. A missing or unreadable file reads as no member having a value. */
  load(): Effect.Effect<void, PreferenceFileFailure> {
    return this.#file.load();
  }

  /** The value of `memberId`, or null when they have none. */
  get(memberId: string): WorkspaceSidebarPrefs | null {
    const stored = this.#file.get().members[memberId];
    return stored ? { order: { ...stored.order }, muted: [...stored.muted] } : null;
  }

  /**
   * Replaces the value of `memberId` and answers the value kept. `prefs` is decoded again, so a list
   * that is too long or not ids fails before anything is written.
   */
  set(memberId: string, prefs: WorkspaceSidebarPrefs): Effect.Effect<WorkspaceSidebarPrefs, PreferenceFileFailure> {
    return Effect.gen({ self: this }, function* () {
      if (!isMemberId(memberId)) return yield* Effect.die(new Error("Invalid workspace sidebar member."));
      // The routes decode the value first; a value that fails here is a programming error.
      const value = yield* Effect.sync(() => decodeWorkspaceSidebarPrefs(prefs));
      yield* this.#saves.withPermit(
        Effect.suspend(() => {
          const others = Object.entries(this.#file.get().members)
            .filter(([id]) => id !== memberId)
            // Newest first, so the cut below drops the members who saved longest ago.
            .sort(([, left], [, right]) => right.updatedAt - left.updatedAt)
            .slice(0, WORKSPACE_SIDEBAR_MEMBER_LIMIT - 1);
          const members = Object.fromEntries([...others, [memberId, { ...value, updatedAt: Date.now() }]]);
          return this.#file.set({ members });
        }),
      );
      for (const listener of this.#listeners) listener(memberId);
      return value;
    }).pipe(Effect.withSpan("WorkspaceSidebarStore.set"));
  }
}
