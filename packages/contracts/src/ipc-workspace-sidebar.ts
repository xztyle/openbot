// The reader's own workspace sidebar: the order they dragged the channel and DM rows into, and the
// conversations they muted. The host keeps one value per member, so it follows the account to each
// computer and browser. A host that has none for the member answers null.

import { isBoundedString } from "./ipc-bounded-values";
import { isDynamicRecord } from "./runtime-values";

/** The most ids in each list: the channel order, the DM order and the mutes. */
export const WORKSPACE_SIDEBAR_ID_LIMIT = 500;
/** The longest id: a channel id, or `agent:` and an agent id for the owner's DM with an agent. */
export const WORKSPACE_SIDEBAR_ID_LENGTH = 200;

export interface WorkspaceSidebarPrefs {
  order: { channels: string[]; direct: string[] };
  muted: string[];
}

/** The value of the member on the host. Null: the host has none for them yet. */
export interface WorkspaceSidebar {
  sidebar: WorkspaceSidebarPrefs | null;
}

export const EMPTY_WORKSPACE_SIDEBAR: WorkspaceSidebarPrefs = { order: { channels: [], direct: [] }, muted: [] };

function isSidebarId(value: unknown): value is string {
  return isBoundedString(value, WORKSPACE_SIDEBAR_ID_LENGTH) && value.length > 0;
}

function idList(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.length > WORKSPACE_SIDEBAR_ID_LIMIT || !value.every(isSidebarId))
    throw new Error(`Invalid workspace sidebar ${label}.`);
  return [...new Set(value)];
}

/** A sidebar value. A repeated id keeps its first place; a list that is too long or not ids throws. */
export function decodeWorkspaceSidebarPrefs(value: unknown): WorkspaceSidebarPrefs {
  if (!isDynamicRecord(value) || !isDynamicRecord(value.order)) throw new Error("Invalid workspace sidebar.");
  return {
    order: { channels: idList(value.order.channels, "order"), direct: idList(value.order.direct, "order") },
    muted: idList(value.muted, "mutes"),
  };
}

export function decodeWorkspaceSidebar(value: unknown): WorkspaceSidebar {
  if (!isDynamicRecord(value) || !("sidebar" in value)) throw new Error("Invalid workspace sidebar.");
  return { sidebar: value.sidebar === null ? null : decodeWorkspaceSidebarPrefs(value.sidebar) };
}

/** The value that a client may send: each list without repeats and cut to the limit, ids that fit. */
export function boundedWorkspaceSidebar(prefs: WorkspaceSidebarPrefs): WorkspaceSidebarPrefs {
  const bounded = (ids: readonly string[]) =>
    [...new Set(ids)]
      .filter((id) => id.length > 0 && id.length <= WORKSPACE_SIDEBAR_ID_LENGTH)
      .slice(0, WORKSPACE_SIDEBAR_ID_LIMIT);
  return {
    order: { channels: bounded(prefs.order.channels), direct: bounded(prefs.order.direct) },
    muted: bounded(prefs.muted),
  };
}
