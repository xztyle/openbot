// The reader's own workspace sidebar: the order they dragged the channel and DM rows into, the
// conversations they muted, the groups they collapsed, the Starred section, the sections they made,
// and the sort and filter of each group. Each save gets a revision, so a session
// that saves from an older value keeps the changes of the others. The host keeps one value per member, so it follows the account to each
// computer and browser. A host that has none for the member answers null.

import { isBoundedString } from "./ipc-bounded-values";
import { isDynamicRecord, isOneOf } from "./runtime-values";

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
   * The conversations in the Starred section, in the reader's order. A starred conversation shows
   * there and in no other group. Absent from an older client or host.
   */
  starred?: string[];
  /**
   * The sections that the reader made, as Slack's custom sections, in the order they show. A
   * conversation is in one section at most; it shows there and not in its own group. Absent from an
   * older client or host.
   */
  sections?: WorkspaceSidebarSection[];
  /**
   * The sort and the filter that the reader chose for a group: `channels`, `direct`, `starred` or the
   * id of a section. A group with no entry sorts `custom` and shows `all`. Absent from an older client
   * or host.
   */
  groupOptions?: WorkspaceSidebarGroupOptions[];
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

/** The most sections a reader makes, and the longest section name. */
export const WORKSPACE_SIDEBAR_SECTION_LIMIT = 50;
export const WORKSPACE_SIDEBAR_SECTION_NAME_LENGTH = 80;
/** The most groups with options: every section, Starred, Channels and Direct messages. */
export const WORKSPACE_SIDEBAR_GROUP_OPTIONS_LIMIT = 60;

/** A section that the reader made: its name and its conversations, in the reader's order. */
export interface WorkspaceSidebarSection {
  id: string;
  name: string;
  ids: string[];
}

/**
 * How a group sorts, as Slack's "Sort": `custom` is the order the reader dragged (and the group's own
 * order for the rest), `alpha` by name, `recent` newest activity first, `priority` mentions, then
 * unread, then newest.
 */
export const WORKSPACE_SIDEBAR_SORTS = ["custom", "alpha", "recent", "priority"] as const;
export type WorkspaceSidebarSort = (typeof WORKSPACE_SIDEBAR_SORTS)[number];
/** Which rows a group shows, as Slack's "Show": all, only unread ones, or only those with mentions. */
export const WORKSPACE_SIDEBAR_SHOWS = ["all", "unreads", "mentions"] as const;
export type WorkspaceSidebarShow = (typeof WORKSPACE_SIDEBAR_SHOWS)[number];

export interface WorkspaceSidebarGroupOptions {
  id: string;
  sort?: WorkspaceSidebarSort;
  show?: WorkspaceSidebarShow;
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

function sectionName(value: unknown): string {
  if (!isBoundedString(value, WORKSPACE_SIDEBAR_SECTION_NAME_LENGTH) || !value.trim())
    throw new Error("Invalid workspace sidebar section name.");
  return value;
}

function sections(value: unknown): WorkspaceSidebarSection[] {
  if (!Array.isArray(value) || value.length > WORKSPACE_SIDEBAR_SECTION_LIMIT)
    throw new Error("Invalid workspace sidebar sections.");
  const seen = new Set<string>();
  return value.flatMap((section): WorkspaceSidebarSection[] => {
    if (!isDynamicRecord(section) || !isSidebarId(section.id)) throw new Error("Invalid workspace sidebar section.");
    const decoded = { id: section.id, name: sectionName(section.name), ids: idList(section.ids, "section") };
    // A repeated section keeps its first place, as a repeated id does.
    if (seen.has(decoded.id)) return [];
    seen.add(decoded.id);
    return [decoded];
  });
}

function groupOptions(value: unknown): WorkspaceSidebarGroupOptions[] {
  if (!Array.isArray(value) || value.length > WORKSPACE_SIDEBAR_GROUP_OPTIONS_LIMIT)
    throw new Error("Invalid workspace sidebar group options.");
  const seen = new Set<string>();
  return value.flatMap((entry): WorkspaceSidebarGroupOptions[] => {
    if (
      !isDynamicRecord(entry) ||
      !isSidebarId(entry.id) ||
      !(entry.sort === undefined || isOneOf(WORKSPACE_SIDEBAR_SORTS, entry.sort)) ||
      !(entry.show === undefined || isOneOf(WORKSPACE_SIDEBAR_SHOWS, entry.show))
    )
      throw new Error("Invalid workspace sidebar group options.");
    if (seen.has(entry.id)) return [];
    seen.add(entry.id);
    return [
      {
        id: entry.id,
        ...(isOneOf(WORKSPACE_SIDEBAR_SORTS, entry.sort) ? { sort: entry.sort } : {}),
        ...(isOneOf(WORKSPACE_SIDEBAR_SHOWS, entry.show) ? { show: entry.show } : {}),
      },
    ];
  });
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
    ...(value.starred === undefined ? {} : { starred: idList(value.starred, "starred conversations") }),
    ...(value.sections === undefined ? {} : { sections: sections(value.sections) }),
    ...(value.groupOptions === undefined ? {} : { groupOptions: groupOptions(value.groupOptions) }),
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
 * The id lists that a rebase merges by id; every other field is one choice. The sections and the group
 * options merge whole: a section's name and its rows belong together.
 */
const WORKSPACE_SIDEBAR_ID_SETS = new Set([
  "muted",
  "closed",
  "collapsed",
  "notifyMentions",
  "notifyNothing",
  "starred",
]);

function idsOf(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every((id) => typeof id === "string") ? value : undefined;
}

/**
 * The value that keeps the changes of another session (`theirs`, the host value now) and adds the
 * changes that this session made to `base`, the host value it started from (`mine`). A list of ids
 * (mutes, closed DMs, collapsed groups, bells) loses the ids that `mine` took out of `base` and gets the
 * ids that `mine` added. Each order, and every other field (the space, and any later field), is that
 * of `mine` when it changed it, else that of `theirs`. A field that `mine` leaves out, as an older
 * client does, is not a change.
 */
export function rebaseWorkspaceSidebar(
  base: WorkspaceSidebarPrefs,
  mine: WorkspaceSidebarPrefs,
  theirs: WorkspaceSidebarPrefs,
): WorkspaceSidebarPrefs {
  const before = new Map<string, unknown>(Object.entries(base));
  const after = new Map<string, unknown>(Object.entries(mine));
  const now = new Map<string, unknown>(Object.entries(theirs));
  const changed = (left: unknown, right: unknown) => JSON.stringify(left) !== JSON.stringify(right);
  const order = (group: "channels" | "direct") =>
    changed(mine.order[group], base.order[group]) ? mine.order[group] : theirs.order[group];
  const merged = new Map<string, unknown>();
  for (const key of new Set([...now.keys(), ...after.keys()])) {
    if (key === "baseRevision") continue;
    if (key === "order") merged.set(key, { channels: order("channels"), direct: order("direct") });
    else if (WORKSPACE_SIDEBAR_ID_SETS.has(key) && after.has(key)) {
      const removed = new Set(idsOf(before.get(key)) ?? []);
      const added = idsOf(after.get(key)) ?? [];
      for (const id of added) removed.delete(id);
      const known = new Set(idsOf(before.get(key)) ?? []);
      const kept = (idsOf(now.get(key)) ?? []).filter((id) => !removed.has(id));
      merged.set(key, [...kept, ...added.filter((id) => !known.has(id) && !kept.includes(id))]);
    } else if (after.has(key) && changed(after.get(key), before.get(key))) merged.set(key, after.get(key));
    else if (now.has(key)) merged.set(key, now.get(key));
  }
  return decodeWorkspaceSidebarPrefs(Object.fromEntries(merged));
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
    ...(prefs.starred === undefined ? {} : { starred: bounded(prefs.starred) }),
    ...(prefs.sections === undefined
      ? {}
      : {
          sections: prefs.sections
            .filter(
              (section, index, all) =>
                isSidebarId(section.id) &&
                section.name.trim().length > 0 &&
                all.findIndex((other) => other.id === section.id) === index,
            )
            .slice(0, WORKSPACE_SIDEBAR_SECTION_LIMIT)
            .map((section) => ({
              id: section.id,
              name: section.name.slice(0, WORKSPACE_SIDEBAR_SECTION_NAME_LENGTH),
              ids: bounded(section.ids),
            })),
        }),
    ...(prefs.groupOptions === undefined
      ? {}
      : {
          groupOptions: prefs.groupOptions
            .filter(
              (entry, index, all) => isSidebarId(entry.id) && all.findIndex((other) => other.id === entry.id) === index,
            )
            .slice(0, WORKSPACE_SIDEBAR_GROUP_OPTIONS_LIMIT)
            .map((entry) => ({
              id: entry.id,
              ...(entry.sort ? { sort: entry.sort } : {}),
              ...(entry.show ? { show: entry.show } : {}),
            })),
        }),
    ...(prefs.baseRevision === undefined ? {} : { baseRevision: prefs.baseRevision }),
  };
}
