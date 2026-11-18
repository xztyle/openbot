// The reader's own workspace sidebar: the order they dragged the channel and DM rows into, the
// conversations they muted, and the groups they collapsed. Each save gets a revision, so a session
// that saves from an older value keeps the changes of the others. The host keeps one value per member, so it follows the account to each
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
  /**
   * Only on a save: the `revision` of the host value that this value was made from. When another
   * session of the member saved since, the host keeps that session's changes and applies only the
   * changes of this one (`rebaseWorkspaceSidebar`). The host never stores it. Absent from an older
   * client: the save replaces the value.
   */
  baseRevision?: number;
}

/** The value of the member on the host. Null: the host has none for them yet. */
export interface WorkspaceSidebar {
  sidebar: WorkspaceSidebarPrefs | null;
  /** The host keeps `notifyMentions` and `notifyNothing`. An older host drops them and sends no flag. */
  notifyLevels?: boolean;
  /**
   * The count of the member's saves on the host; each save makes it larger. A client keeps the
   * revision of the value it shows, sends it as `baseRevision`, and leaves out an answer with a smaller
   * one: that answer is older than a value it already has. Absent from an older host.
   */
  revision?: number;
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

function revision(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
    throw new Error(`Invalid workspace sidebar ${label}.`);
  return value;
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
    ...(value.baseRevision === undefined ? {} : { baseRevision: revision(value.baseRevision, "revision") }),
  };
}

export function decodeWorkspaceSidebar(value: unknown): WorkspaceSidebar {
  if (!isDynamicRecord(value) || !("sidebar" in value)) throw new Error("Invalid workspace sidebar.");
  return {
    sidebar: value.sidebar === null ? null : decodeWorkspaceSidebarPrefs(value.sidebar),
    ...(value.notifyLevels === true ? { notifyLevels: true } : {}),
    ...(value.revision === undefined ? {} : { revision: revision(value.revision, "revision") }),
  };
}

/**
 * The value that keeps the changes of another session (`theirs`, the host value now) and adds the
 * changes that this session made to `base`, the host value it started from (`mine`). A list of ids
 * loses the ids that `mine` took out of `base` and gets the ids that `mine` added; an order and the
 * space are those of `mine` when it changed them, else those of `theirs`. A list that `mine` leaves
 * out, as an older client does, is not a change.
 */
export function rebaseWorkspaceSidebar(
  base: WorkspaceSidebarPrefs,
  mine: WorkspaceSidebarPrefs,
  theirs: WorkspaceSidebarPrefs,
): WorkspaceSidebarPrefs {
  const set = (
    baseIds: readonly string[] | undefined,
    mineIds: readonly string[] | undefined,
    theirIds: readonly string[] | undefined,
  ): string[] | undefined => {
    if (mineIds === undefined) return theirIds === undefined ? undefined : [...theirIds];
    const before = new Set(baseIds ?? []);
    const after = new Set(mineIds);
    const kept = (theirIds ?? []).filter((id) => !(before.has(id) && !after.has(id)));
    const added = mineIds.filter((id) => !before.has(id) && !kept.includes(id));
    return [...kept, ...added];
  };
  const same = (left: readonly string[], right: readonly string[]) =>
    left.length === right.length && left.every((id, index) => right[index] === id);
  const order = (group: "channels" | "direct") =>
    same(mine.order[group], base.order[group]) ? [...theirs.order[group]] : [...mine.order[group]];
  const space = mine.space !== base.space ? mine.space : theirs.space;
  const optional = (key: "closed" | "collapsed" | "notifyMentions" | "notifyNothing") => {
    const ids = set(base[key], mine[key], theirs[key]);
    return ids === undefined ? {} : { [key]: ids };
  };
  return {
    order: { channels: order("channels"), direct: order("direct") },
    muted: set(base.muted, mine.muted, theirs.muted) ?? [],
    ...optional("closed"),
    ...(space === undefined ? {} : { space }),
    ...optional("collapsed"),
    ...optional("notifyMentions"),
    ...optional("notifyNothing"),
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
    ...(prefs.baseRevision === undefined ? {} : { baseRevision: prefs.baseRevision }),
  };
}
