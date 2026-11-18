// The reader's own workspace sidebar: the order they dragged the channel and DM rows into, the
// conversations they muted, and the groups they collapsed. The host keeps one value per member, so it follows the account to each
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
  /**
   * The DMs that the reader closed: they leave the list until the reader opens them again, or a new
   * message comes in a DM channel. Absent from an older client or host.
   */
  closed?: string[];
  /** The space that the reader looked at last. Absent from an older client or host: `general`. */
  space?: string;
  /**
   * The groups that the reader collapsed: `channels`, `direct`. A collapsed group still shows its
   * unread rows and the open conversation. Absent from an older client or host: all open.
   */
  collapsed?: string[];
  /**
   * The conversations that notify the reader only about mentions, and those that notify them about
   * nothing, as Slack's bell: "Just mentions" and "Nothing". A conversation in neither list follows
   * the reader's level for the server. Absent from an older client or host.
   */
  notifyMentions?: string[];
  notifyNothing?: string[];
}

/** The value of the member on the host. Null: the host has none for them yet. */
export interface WorkspaceSidebar {
  sidebar: WorkspaceSidebarPrefs | null;
  /** The host keeps `notifyMentions` and `notifyNothing`. An older host drops them and sends no flag. */
  notifyLevels?: boolean;
}

/** The notification level of one conversation, as Slack's bell offers it. */
export const WORKSPACE_NOTIFY_LEVELS = ["all", "mentions", "nothing"] as const;
export type WorkspaceNotifyLevel = (typeof WORKSPACE_NOTIFY_LEVELS)[number];

/**
 * The level that the reader chose for a conversation, or null when they chose none and the server's
 * level applies. A muted conversation notifies about nothing.
 */
export function workspaceNotifyLevel(
  prefs: Pick<WorkspaceSidebarPrefs, "muted" | "notifyMentions" | "notifyNothing">,
  conversationId: string,
): WorkspaceNotifyLevel | null {
  if (prefs.muted.includes(conversationId) || prefs.notifyNothing?.includes(conversationId)) return "nothing";
  if (prefs.notifyMentions?.includes(conversationId)) return "mentions";
  return null;
}

/** The prefs with `level` for the conversation; `null` takes the server's level again. */
export function withWorkspaceNotifyLevel(
  prefs: WorkspaceSidebarPrefs,
  conversationId: string,
  level: WorkspaceNotifyLevel | null,
): WorkspaceSidebarPrefs {
  const without = (ids: readonly string[] | undefined) => (ids ?? []).filter((id) => id !== conversationId);
  return {
    ...prefs,
    notifyMentions:
      level === "mentions" ? [...without(prefs.notifyMentions), conversationId] : without(prefs.notifyMentions),
    notifyNothing:
      level === "nothing" ? [...without(prefs.notifyNothing), conversationId] : without(prefs.notifyNothing),
  };
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

function spaceId(value: unknown): string {
  if (!isSidebarId(value)) throw new Error("Invalid workspace sidebar space.");
  return value;
}

/** A sidebar value. A repeated id keeps its first place; a list that is too long or not ids throws. */
export function decodeWorkspaceSidebarPrefs(value: unknown): WorkspaceSidebarPrefs {
  if (!isDynamicRecord(value) || !isDynamicRecord(value.order)) throw new Error("Invalid workspace sidebar.");
  return {
    order: { channels: idList(value.order.channels, "order"), direct: idList(value.order.direct, "order") },
    muted: idList(value.muted, "mutes"),
    ...(value.closed === undefined ? {} : { closed: idList(value.closed, "closed conversations") }),
    ...(value.space === undefined ? {} : { space: spaceId(value.space) }),
    ...(value.collapsed === undefined ? {} : { collapsed: idList(value.collapsed, "collapsed groups") }),
    ...(value.notifyMentions === undefined
      ? {}
      : { notifyMentions: idList(value.notifyMentions, "notification levels") }),
    ...(value.notifyNothing === undefined ? {} : { notifyNothing: idList(value.notifyNothing, "notification levels") }),
  };
}

export function decodeWorkspaceSidebar(value: unknown): WorkspaceSidebar {
  if (!isDynamicRecord(value) || !("sidebar" in value)) throw new Error("Invalid workspace sidebar.");
  return {
    sidebar: value.sidebar === null ? null : decodeWorkspaceSidebarPrefs(value.sidebar),
    ...(value.notifyLevels === true ? { notifyLevels: true } : {}),
  };
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
    ...(prefs.closed === undefined ? {} : { closed: bounded(prefs.closed) }),
    ...(prefs.space === undefined || !isSidebarId(prefs.space) ? {} : { space: prefs.space }),
    ...(prefs.collapsed === undefined ? {} : { collapsed: bounded(prefs.collapsed) }),
    ...(prefs.notifyMentions === undefined ? {} : { notifyMentions: bounded(prefs.notifyMentions) }),
    ...(prefs.notifyNothing === undefined ? {} : { notifyNothing: bounded(prefs.notifyNothing) }),
  };
}
