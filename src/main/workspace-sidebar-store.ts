import { INPUT_LIMITS } from "@openbot/contracts/input-limits";
import {
  decodeWorkspaceSidebarPrefs,
  rebaseWorkspaceSidebar,
  type WorkspaceSidebarPrefs,
} from "@openbot/contracts/ipc";
import { isDynamicRecord, isNumber, isString } from "@openbot/contracts/runtime-values";
import { Effect, Semaphore } from "effect";
import { type PreferenceFileFailure, PreferenceStore } from "./preference-file";

/** The most members the file keeps. A save past it drops the member who saved longest ago. */
export const WORKSPACE_SIDEBAR_MEMBER_LIMIT = 1_000;
/**
 * The values of a member's last saves that the host keeps in memory, so a save made from one of them
 * keeps the changes saved since. A session that saves from an older value replaces the value.
 */
const HISTORY_LIMIT = 32;

/** A saved value and its revision, as the routes answer them. */
export interface WorkspaceSidebarSaved {
  sidebar: WorkspaceSidebarPrefs;
  revision: number;
}

function isMemberId(value: unknown): value is string {
  return isString(value) && value.length > 0 && value.length <= INPUT_LIMITS.identifier;
}

interface StoredSidebar extends WorkspaceSidebarPrefs {
  /** Epoch milliseconds of the last save, to choose the member to drop past the limit. */
  updatedAt: number;
  /** The count of the member's saves. Absent from a file of an older host: 0. */
  revision: number;
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
      const { baseRevision: _base, ...prefs } = decodeWorkspaceSidebarPrefs(entry);
      members[memberId] = {
        ...prefs,
        updatedAt: isNumber(entry.updatedAt) ? entry.updatedAt : 0,
        revision: isNumber(entry.revision) && Number.isSafeInteger(entry.revision) ? entry.revision : 0,
      };
    } catch {
      // The member reads as having no value; their next save writes one.
    }
  }
  return { members };
}

/**
 * The workspace sidebar of each member of this host: the order they dragged the channel and DM
 * rows into, their muted conversations and the notification level of each conversation they set. One version 1 JSON file, which only this host reads:
 * `{ version: 1, members: { [memberId]: { order: { channels, direct }, muted, updatedAt, revision } } }`.
 * Each save makes the member's revision larger. A save that names the revision it was made from
 * (`baseRevision`) keeps the changes saved since by the member's other sessions.
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
  /** The values of the last saves of each member, by revision. */
  readonly #history = new Map<string, Map<number, WorkspaceSidebarPrefs>>();

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
    return stored ? copy(stored) : null;
  }

  /** The revision of the value of `memberId`: 0 when they have none. */
  revision(memberId: string): number {
    return this.#file.get().members[memberId]?.revision ?? 0;
  }

  /**
   * Replaces the value of `memberId` and answers the value kept and its revision. `prefs` is decoded
   * again, so a list that is too long or not ids fails before anything is written. When
   * `prefs.baseRevision` names an older revision whose value the host still has, the value kept is
   * that of the host now with the changes of `prefs` applied (`rebaseWorkspaceSidebar`).
   */
  set(memberId: string, prefs: WorkspaceSidebarPrefs): Effect.Effect<WorkspaceSidebarSaved, PreferenceFileFailure> {
    return Effect.gen({ self: this }, function* () {
      if (!isMemberId(memberId)) return yield* Effect.die(new Error("Invalid workspace sidebar member."));
      // The routes decode the value first; a value that fails here is a programming error.
      const { baseRevision, ...incoming } = yield* Effect.sync(() => decodeWorkspaceSidebarPrefs(prefs));
      const saved = yield* this.#saves.withPermit(
        Effect.suspend(() => {
          const members = this.#file.get().members;
          const current = members[memberId];
          const revision = (current?.revision ?? 0) + 1;
          if (current) this.#remember(memberId, current.revision, copy(current));
          const base =
            current && baseRevision !== undefined && baseRevision !== current.revision
              ? this.#history.get(memberId)?.get(baseRevision)
              : undefined;
          const value = current && base ? rebaseWorkspaceSidebar(base, incoming, copy(current)) : incoming;
          const others = Object.entries(members)
            .filter(([id]) => id !== memberId)
            // Newest first, so the cut below drops the members who saved longest ago.
            .sort(([, left], [, right]) => right.updatedAt - left.updatedAt)
            .slice(0, WORKSPACE_SIDEBAR_MEMBER_LIMIT - 1);
          const next = Object.fromEntries([...others, [memberId, { ...value, updatedAt: Date.now(), revision }]]);
          return this.#file.set({ members: next }).pipe(
            Effect.map((): WorkspaceSidebarSaved => {
              this.#remember(memberId, revision, value);
              return { sidebar: copy(value), revision };
            }),
          );
        }),
      );
      for (const listener of this.#listeners) listener(memberId);
      return saved;
    }).pipe(Effect.withSpan("WorkspaceSidebarStore.set"));
  }

  #remember(memberId: string, revision: number, value: WorkspaceSidebarPrefs): void {
    let values = this.#history.get(memberId);
    if (!values) {
      values = new Map();
      this.#history.set(memberId, values);
    }
    values.set(revision, value);
    for (const old of values.keys()) {
      if (values.size <= HISTORY_LIMIT) break;
      values.delete(old);
    }
    if (this.#history.size > WORKSPACE_SIDEBAR_MEMBER_LIMIT) {
      const [oldest] = this.#history.keys();
      if (oldest !== undefined && oldest !== memberId) this.#history.delete(oldest);
    }
  }
}

/** A copy of a value without the fields of the file. */
function copy(stored: WorkspaceSidebarPrefs): WorkspaceSidebarPrefs {
  return {
    order: { channels: [...stored.order.channels], direct: [...stored.order.direct] },
    muted: [...stored.muted],
    ...(stored.closed === undefined ? {} : { closed: [...stored.closed] }),
    ...(stored.space === undefined ? {} : { space: stored.space }),
    ...(stored.collapsed === undefined ? {} : { collapsed: [...stored.collapsed] }),
    ...(stored.notifyMentions === undefined ? {} : { notifyMentions: [...stored.notifyMentions] }),
    ...(stored.notifyNothing === undefined ? {} : { notifyNothing: [...stored.notifyNothing] }),
  };
}
