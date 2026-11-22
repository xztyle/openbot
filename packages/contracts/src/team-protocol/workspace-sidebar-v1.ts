// Optional workspace sidebar wire contract of this fork, under `fork-host-v1`.
//
// What it adds, recorded here because freezing it makes it permanent:
//
// - `POST /v1/workspace/sidebar` `{}` answers `{ sidebar }`: the sidebar of the member of the
//   session, or `null` when the host has none for them yet. A sidebar is `{ order: { channels,
//   direct }, muted }`: three lists of at most 500 ids each, each id 1 to 200 characters (a channel
//   id, or `agent:` and an agent id for the owner's DM with an agent). `order.channels` and
//   `order.direct` are the rows in the order the member dragged them; `muted` are the conversations
//   that show no unread mark. Later: `closed?`, at most 500 ids, the DMs that the member closed,
//   `space?`, the id of the space that the member looked at last, and `collapsed?`, at most 500 ids,
//   the sidebar groups (`channels`, `direct`) that the member collapsed. Later still:
//   `notifyMentions?` and `notifyNothing?`, at most 500 ids each, the conversations that notify the
//   member only about mentions, or about nothing; a host that keeps them answers `notifyLevels: true`
//   beside `sidebar` on both routes. A host that predates a later field drops it and keeps the rest.
//   Later still: both answers carry `revision?`, a count of the member's saves that each save makes
//   larger, and a save may carry `baseRevision?`, the revision of the value it was made from. A host
//   that has the value of that revision keeps the changes of the member's other sessions since then
//   and applies the changes of this save to them; else the save replaces the value, as before.
//   Later still: `starred?`, at most 500 ids, the conversations of the Starred section; `sections?`,
//   at most 50 sections that the member made, each `{ id, name, ids }` (`name` 1 to 80 characters,
//   `ids` at most 500); and `groupOptions?`, at most 60 entries `{ id, sort?, show? }`, the sort
//   (`custom`, `alpha`, `recent`, `priority`) and the filter (`all`, `unreads`, `mentions`) of a group
//   (`channels`, `direct`, `starred` or a section id). A rebase merges `starred` by id and takes
//   `sections` and `groupOptions` whole. Later still: `agentNoiseImportant?` and `agentNoiseDigest?`,
//   at most 500 agent ids each, the agents whose updates push only when they matter, or wait for one
//   digest push; a host that keeps them and applies them to pushes answers `agentNoise: true`. A
//   rebase merges both by id.
// - `POST /v1/workspace/sidebar/save` with a sidebar replaces the value of the member of the session
//   and answers `{ sidebar }`, the value the host keeps (a repeated id keeps its first place).
//
// - The event `workspace-sidebar-changed` (`{}` beside its type): the member's sidebar changed on
//   the host, from another session of theirs. The host sends it only to that member's sessions; a
//   client reads the sidebar again. An older client ignores it.
//
// The host takes the member from the session, never from the body: a member reads and writes only
// their own value. A fork host built before these routes answers 404; a client then keeps the value
// on its own computer. A present malformed value fails closed. The bounds are written out: this file
// must not move with an IPC limit.
import { isDynamicRecord } from "../runtime-values";
import {
  adminRoute,
  boolean,
  count,
  empty,
  fields,
  list,
  nullable,
  type OptionalRouteCodec,
  oneOf,
  string,
} from "./admin-wire";
import { FORK_HOST_CAPABILITY } from "./fork-host-v1";
import type { TeamProtocolV2Json } from "./v2";

export const WORKSPACE_SIDEBAR_CAPABILITY = FORK_HOST_CAPABILITY;

export const WORKSPACE_SIDEBAR_ROUTES = {
  read: "/v1/workspace/sidebar",
  save: "/v1/workspace/sidebar/save",
} as const;

const sidebarId = (value: unknown): TeamProtocolV2Json => {
  const id = string(200)(value);
  if (!id) throw new Error("Invalid workspace sidebar id.");
  return id;
};
const ids = list(sidebarId, 500);
const sectionName = (value: unknown): TeamProtocolV2Json => {
  const name = string(80)(value);
  if (typeof name !== "string" || !name.trim()) throw new Error("Invalid workspace sidebar section name.");
  return name;
};
const section = fields({ id: sidebarId, name: sectionName, ids });
const groupOptions = fields(
  { id: sidebarId },
  { sort: oneOf("custom", "alpha", "recent", "priority"), show: oneOf("all", "unreads", "mentions") },
);
const sidebarFields = {
  closed: ids,
  space: sidebarId,
  collapsed: ids,
  notifyMentions: ids,
  notifyNothing: ids,
  agentNoiseImportant: ids,
  agentNoiseDigest: ids,
  starred: ids,
  sections: list(section, 50),
  groupOptions: list(groupOptions, 60),
};
const sidebar = fields({ order: fields({ channels: ids, direct: ids }), muted: ids }, sidebarFields);
const save = fields(
  { order: fields({ channels: ids, direct: ids }), muted: ids },
  { ...sidebarFields, baseRevision: count },
);
const answer = fields({ sidebar: nullable(sidebar) }, { notifyLevels: boolean, agentNoise: boolean, revision: count });

export const WORKSPACE_SIDEBAR_CODECS: ReadonlyMap<string, OptionalRouteCodec> = new Map([
  [WORKSPACE_SIDEBAR_ROUTES.read, adminRoute(empty, answer)],
  [WORKSPACE_SIDEBAR_ROUTES.save, adminRoute(save, answer)],
]);

export const WORKSPACE_SIDEBAR_CHANGED_EVENT = "workspace-sidebar-changed";

export interface WorkspaceSidebarChangedEvent {
  type: typeof WORKSPACE_SIDEBAR_CHANGED_EVENT;
}

/** The sidebar event in `value`, or null for any other event. It carries nothing else. */
export function workspaceSidebarEvent(value: unknown): WorkspaceSidebarChangedEvent | null {
  if (!isDynamicRecord(value) || value.type !== WORKSPACE_SIDEBAR_CHANGED_EVENT) return null;
  return { type: WORKSPACE_SIDEBAR_CHANGED_EVENT };
}
