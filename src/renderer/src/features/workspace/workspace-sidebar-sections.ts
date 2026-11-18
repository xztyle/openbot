/*
 * The sections of the workspace sidebar, as Slack's: Starred, the sections that the reader made,
 * Channels and Direct messages, each with its own sort and filter. The reader's choices live in the
 * sidebar preferences that the host keeps per member (`WorkspaceSidebarPrefs`); this module turns
 * them and the conversation rows into the sections that the sidebar draws, and makes each change to
 * the preferences. It has no state of its own.
 */

import type {
  WorkspaceSidebarGroupOptions,
  WorkspaceSidebarPrefs,
  WorkspaceSidebarSection,
} from "@openbot/contracts/ipc";
import { type DynamicRecord, isDynamicRecord } from "@openbot/contracts/runtime-values";
import {
  type SidebarChannel,
  type SidebarDirectMessage,
  type SidebarItem,
  type SidebarSection,
  type SidebarSectionOptions,
  type SidebarShow,
  type SidebarSort,
  sidebarItemLabel,
} from "@openbot/ui/features/workspace/WorkspaceSidebar";

export const STARRED_SECTION = "starred";
const BUILT_IN = new Set(["channels", "direct", STARRED_SECTION]);

export interface SidebarSectionsInput {
  /** The channel and DM rows of the space that shows, after the text filter, in their group order. */
  channels: readonly SidebarChannel[];
  direct: readonly SidebarDirectMessage[];
  prefs: WorkspaceSidebarPrefs;
  activeId: string | undefined;
  /** The conversations with a draft that is not sent. */
  draftIds: ReadonlySet<string>;
  /** A text filter is on: every match shows, whatever a section's Show says. */
  filtering: boolean;
}

/** The sort and the filter of a section; a section with no entry sorts `custom` and shows `all`. */
export function sectionOptions(
  prefs: WorkspaceSidebarPrefs,
  sectionId: string,
): { sort: SidebarSort; show: SidebarShow } {
  const entry = prefs.groupOptions?.find((item) => item.id === sectionId);
  return { sort: entry?.sort ?? "custom", show: entry?.show ?? "all" };
}

function needsReader(row: SidebarChannel | SidebarDirectMessage): boolean {
  return (row.unread === true && !row.muted) || (row.mentionCount ?? 0) > 0;
}

function sorted(items: SidebarItem[], sort: SidebarSort): SidebarItem[] {
  if (sort === "custom") return items;
  const label = (item: SidebarItem) => sidebarItemLabel(item).toLocaleLowerCase();
  const byName = (left: SidebarItem, right: SidebarItem) => label(left).localeCompare(label(right));
  const at = (item: SidebarItem) => item.row.activityAt ?? 0;
  const byRecent = (left: SidebarItem, right: SidebarItem) => at(right) - at(left) || byName(left, right);
  if (sort === "alpha") return [...items].sort(byName);
  if (sort === "recent") return [...items].sort(byRecent);
  // Priority: mentions first, then unread conversations, then the newest.
  const rank = (item: SidebarItem) =>
    (item.row.mentionCount ?? 0) > 0 ? 0 : item.row.unread === true && !item.row.muted ? 1 : 2;
  return [...items].sort((left, right) => rank(left) - rank(right) || byRecent(left, right));
}

function shown(items: SidebarItem[], show: SidebarShow, activeId: string | undefined): SidebarItem[] {
  if (show === "all") return items;
  return items.filter(
    (item) =>
      item.row.id === activeId || (show === "mentions" ? (item.row.mentionCount ?? 0) > 0 : needsReader(item.row)),
  );
}

/**
 * The sections in the order they show: Starred (when it has rows), the reader's sections, Channels,
 * Direct messages. A conversation shows in one section only: Starred first, then the first of the
 * reader's sections that has it, else its own group.
 */
export function sidebarSections(input: SidebarSectionsInput): SidebarSection[] {
  const items = new Map<string, SidebarItem>();
  const withDraft = <Row extends { id: string; draft?: boolean | undefined }>(row: Row): Row =>
    input.draftIds.has(row.id) ? { ...row, draft: true } : row;
  for (const row of input.channels) items.set(row.id, { type: "channel", row: withDraft(row) });
  for (const row of input.direct) items.set(row.id, { type: "direct", row: withDraft(row) });
  const claimed = new Set<string>();
  const take = (ids: readonly string[]) =>
    ids.flatMap((id) => {
      const item = items.get(id);
      if (!item || claimed.has(id)) return [];
      claimed.add(id);
      return [item];
    });
  const build = (id: string, kind: SidebarSection["kind"], rows: SidebarItem[], name?: string): SidebarSection => {
    const { sort, show } = sectionOptions(input.prefs, id);
    return {
      id,
      kind,
      ...(name === undefined ? {} : { name }),
      items: shown(sorted(rows, sort), input.filtering ? "all" : show, input.activeId),
      sort,
      show,
    };
  };
  const starred = take(input.prefs.starred ?? []);
  const custom = (input.prefs.sections ?? []).map((section) => ({ section, rows: take(section.ids) }));
  const rest = (rows: readonly { id: string }[]) =>
    rows.flatMap((row) => {
      const item = items.get(row.id);
      return item && !claimed.has(row.id) ? [item] : [];
    });
  const channels = rest(input.channels);
  const direct = rest(input.direct);
  return [
    ...(starred.length ? [build(STARRED_SECTION, "starred", starred)] : []),
    // A filter hides the reader's sections that have no match, as it hides rows.
    ...custom
      .filter((entry) => !input.filtering || entry.rows.length > 0)
      .map((entry) => build(entry.section.id, "custom", entry.rows, entry.section.name)),
    build("channels", "channels", channels),
    build("direct", "direct", direct),
  ];
}

/** The section that a conversation is in now: `starred`, a section id, or null for its own group. */
export function sectionOf(prefs: WorkspaceSidebarPrefs, conversationId: string): string | null {
  if (prefs.starred?.includes(conversationId)) return STARRED_SECTION;
  return prefs.sections?.find((section) => section.ids.includes(conversationId))?.id ?? null;
}

/**
 * The preferences with the conversation in `target`: `starred`, a section id, or `channels` or
 * `direct` (null too) for its own group. `beforeId` places it above that row; null puts it last.
 */
export function withConversationIn(
  prefs: WorkspaceSidebarPrefs,
  conversationId: string,
  target: string | null,
  beforeId: string | null = null,
): WorkspaceSidebarPrefs {
  const place = (ids: readonly string[]) => {
    const others = ids.filter((id) => id !== conversationId);
    const at = beforeId ? others.indexOf(beforeId) : -1;
    return at < 0 ? [...others, conversationId] : [...others.slice(0, at), conversationId, ...others.slice(at)];
  };
  const without = (ids: readonly string[] | undefined) => (ids ?? []).filter((id) => id !== conversationId);
  const home = target === null || target === "channels" || target === "direct";
  const next: WorkspaceSidebarPrefs = {
    ...prefs,
    starred: target === STARRED_SECTION ? place(prefs.starred ?? []) : without(prefs.starred),
    sections: (prefs.sections ?? []).map((section) => ({
      ...section,
      ids: section.id === target ? place(section.ids) : without(section.ids),
    })),
  };
  // Back in its group, a drop above a row places it there in the group's own order.
  if (home && target && beforeId) {
    const group = target === "channels" ? "channels" : "direct";
    next.order = { ...prefs.order, [group]: place(prefs.order[group]) };
  }
  return next;
}

/** A new section id: short, and unlike every built-in group. */
export function newSectionId(): string {
  return `section-${crypto.randomUUID().slice(0, 8)}`;
}

/** The preferences with a new section after the others, holding `conversationId` when one is given. */
export function withNewSection(
  prefs: WorkspaceSidebarPrefs,
  id: string,
  name: string,
  conversationId?: string,
): WorkspaceSidebarPrefs {
  const created: WorkspaceSidebarSection = { id, name: name.trim(), ids: [] };
  const next = { ...prefs, sections: [...(prefs.sections ?? []), created] };
  return conversationId ? withConversationIn(next, conversationId, id) : next;
}

export function withSectionName(prefs: WorkspaceSidebarPrefs, id: string, name: string): WorkspaceSidebarPrefs {
  return {
    ...prefs,
    sections: (prefs.sections ?? []).map((section) =>
      section.id === id ? { ...section, name: name.trim() } : section,
    ),
  };
}

/** The preferences without the section. Its conversations go back to their own groups. */
export function withoutSection(prefs: WorkspaceSidebarPrefs, id: string): WorkspaceSidebarPrefs {
  return {
    ...prefs,
    sections: (prefs.sections ?? []).filter((section) => section.id !== id),
    groupOptions: (prefs.groupOptions ?? []).filter((entry) => entry.id !== id),
    collapsed: (prefs.collapsed ?? []).filter((entry) => entry !== id),
  };
}

/** The preferences with a section's sort or filter changed. */
export function withSectionOptions(
  prefs: WorkspaceSidebarPrefs,
  id: string,
  change: SidebarSectionOptions,
): WorkspaceSidebarPrefs {
  const current = prefs.groupOptions?.find((entry) => entry.id === id);
  const merged: WorkspaceSidebarGroupOptions = {
    id,
    ...((change.sort ?? current?.sort) ? { sort: change.sort ?? current?.sort } : {}),
    ...((change.show ?? current?.show) ? { show: change.show ?? current?.show } : {}),
  };
  const others = (prefs.groupOptions ?? []).filter((entry) => entry.id !== id);
  const plain = (merged.sort ?? "custom") === "custom" && (merged.show ?? "all") === "all";
  return { ...prefs, groupOptions: plain ? others : [...others, merged] };
}

/**
 * The preferences after the reader dragged the rows of a section into a new order. The section then
 * sorts in that order (`custom`), as a drag in Slack does.
 */
export function withSectionOrder(prefs: WorkspaceSidebarPrefs, id: string, ids: string[]): WorkspaceSidebarPrefs {
  const custom = withSectionOptions(prefs, id, { sort: "custom" });
  if (id === "channels" || id === "direct") return { ...custom, order: { ...custom.order, [id]: ids } };
  if (id === STARRED_SECTION) {
    // Rows of another space keep their places after the ones that show.
    const rest = (prefs.starred ?? []).filter((item) => !ids.includes(item));
    return { ...custom, starred: [...ids, ...rest] };
  }
  return {
    ...custom,
    sections: (custom.sections ?? []).map((section) =>
      section.id === id ? { ...section, ids: [...ids, ...section.ids.filter((item) => !ids.includes(item))] } : section,
    ),
  };
}

/** Whether `id` names a section that the reader made. */
export function isCustomSection(prefs: WorkspaceSidebarPrefs, id: string): boolean {
  return !BUILT_IN.has(id) && (prefs.sections ?? []).some((section) => section.id === id);
}

/**
 * The sections, Starred and the group options in a value that this computer kept: what is valid, with
 * the rest left out. The host's decoder is strict; a copy on this computer only has to be safe.
 */
export function localSectionPrefs(
  value: DynamicRecord,
): Pick<WorkspaceSidebarPrefs, "starred" | "sections" | "groupOptions"> {
  const ids = (list: unknown): string[] =>
    Array.isArray(list)
      ? list.filter((item): item is string => typeof item === "string" && item.length > 0).slice(0, 500)
      : [];
  const sections = Array.isArray(value.sections)
    ? value.sections.flatMap((section): WorkspaceSidebarSection[] =>
        isDynamicRecord(section) &&
        typeof section.id === "string" &&
        typeof section.name === "string" &&
        section.name.trim()
          ? [{ id: section.id, name: section.name.slice(0, 80), ids: ids(section.ids) }]
          : [],
      )
    : undefined;
  const sorts: readonly SidebarSort[] = ["custom", "alpha", "recent", "priority"];
  const shows: readonly SidebarShow[] = ["all", "unreads", "mentions"];
  const groupOptions = Array.isArray(value.groupOptions)
    ? value.groupOptions.flatMap((entry): WorkspaceSidebarGroupOptions[] => {
        if (!isDynamicRecord(entry) || typeof entry.id !== "string") return [];
        const sort = sorts.find((item) => item === entry.sort);
        const show = shows.find((item) => item === entry.show);
        return [{ id: entry.id, ...(sort ? { sort } : {}), ...(show ? { show } : {}) }];
      })
    : undefined;
  return {
    ...(Array.isArray(value.starred) ? { starred: ids(value.starred) } : {}),
    ...(sections ? { sections: sections.slice(0, 50) } : {}),
    ...(groupOptions ? { groupOptions: groupOptions.slice(0, 60) } : {}),
  };
}
