// Optional workspace sidebar wire contract of this fork, under `fork-host-v1`.
//
// What it adds, recorded here because freezing it makes it permanent:
//
// - `POST /v1/workspace/sidebar` `{}` answers `{ sidebar }`: the sidebar of the member of the
//   session, or `null` when the host has none for them yet. A sidebar is `{ order: { channels,
//   direct }, muted }`: three lists of at most 500 ids each, each id 1 to 200 characters (a channel
//   id, or `agent:` and an agent id for the owner's DM with an agent). `order.channels` and
//   `order.direct` are the rows in the order the member dragged them; `muted` are the conversations
//   that show no unread mark. Later: `closed?`, at most 500 ids, the DMs that the member closed.
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
import { adminRoute, empty, fields, list, nullable, type OptionalRouteCodec, string } from "./admin-wire";
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
const sidebar = fields({ order: fields({ channels: ids, direct: ids }), muted: ids }, { closed: ids });

export const WORKSPACE_SIDEBAR_CODECS: ReadonlyMap<string, OptionalRouteCodec> = new Map([
  [WORKSPACE_SIDEBAR_ROUTES.read, adminRoute(empty, fields({ sidebar: nullable(sidebar) }))],
  [WORKSPACE_SIDEBAR_ROUTES.save, adminRoute(sidebar, fields({ sidebar }))],
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
