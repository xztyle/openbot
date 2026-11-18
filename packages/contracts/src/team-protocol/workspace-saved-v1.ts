// Optional saved items ("Later") and pins wire contract of this fork, under `fork-host-v1`.
//
// What it adds, recorded here because freezing it makes it permanent:
//
// - `POST /v1/workspace/saved` `{ state?: "saved" | "done", channelId?, cursor? (32, digits), limit?
//   (1 to 100, default 50) }` answers `{ items, total, nextCursor }`: the messages that the member of
//   the session saved, newest first, in the channels they can still see. An item (at most 100) is
//   `{ channelId, messageId, threadRootId?, state, savedAt (80), author: { kind: "member" | "agent" |
//   "coordinator" | "external", id, name (120) }, at (80), preview (160), deleted }`; `preview` is
//   empty for a message deleted after it was saved.
// - `POST /v1/workspace/saved/set` `{ operationId, channelId, messageId, state: "saved" | "done" | null
//   }` saves the message, marks it done, or removes it (null), and answers `{ item }` (null after a
//   removal). Only the member sees their items. A deleted message cannot be saved.
// - `POST /v1/workspace/pins` `{ channelId }` answers `{ channelId, pins }` (at most 100, newest pin
//   first), each `{ messageId, threadRootId?, author, at (80), preview (160), pinnedBy: { kind:
//   "member" | "agent", id }, pinnedAt (80) }`.
// - `POST /v1/workspace/pins/set` `{ operationId, channelId, messageId, pinned }` pins the message to
//   its channel or unpins it, and answers the pins. A channel holds at most 100 pins; an archived one
//   takes none. A pinned message carries `pinned` (workspace-v1), so every client that shows the
//   channel gets the change with the `channel-message` event.
// - The event `workspace-saved-changed` (`{}` beside its type): the member's saved items changed.
//   Only that member's sessions get it. A client reads the saved items again. An older client
//   ignores it.
//
// A fork host built before these routes answers 404; a client then offers neither. A present
// malformed value fails closed. The bounds are written out: this file must not move with an IPC limit.
import { isDynamicRecord } from "../runtime-values";
import {
  adminRoute,
  boolean,
  count,
  fields,
  identifier,
  list,
  nullable,
  type OptionalRouteCodec,
  oneOf,
  string,
} from "./admin-wire";
import { FORK_HOST_CAPABILITY } from "./fork-host-v1";

export const WORKSPACE_SAVED_CAPABILITY = FORK_HOST_CAPABILITY;

export const WORKSPACE_SAVED_ROUTES = {
  saved: "/v1/workspace/saved",
  setSaved: "/v1/workspace/saved/set",
  pins: "/v1/workspace/pins",
  setPinned: "/v1/workspace/pins/set",
} as const;

const author = fields({ kind: oneOf("member", "agent", "coordinator", "external"), id: identifier, name: string(120) });
const item = fields(
  {
    channelId: identifier,
    messageId: identifier,
    state: oneOf("saved", "done"),
    savedAt: string(80),
    author,
    at: string(80),
    preview: string(160),
    deleted: boolean,
  },
  { threadRootId: identifier },
);
const pin = fields(
  {
    messageId: identifier,
    author,
    at: string(80),
    preview: string(160),
    pinnedBy: fields({ kind: oneOf("member", "agent"), id: identifier }),
    pinnedAt: string(80),
  },
  { threadRootId: identifier },
);
const pins = fields({ channelId: identifier, pins: list(pin, 100) });

export const WORKSPACE_SAVED_CODECS: ReadonlyMap<string, OptionalRouteCodec> = new Map([
  [
    WORKSPACE_SAVED_ROUTES.saved,
    adminRoute(
      fields({}, { state: oneOf("saved", "done"), channelId: identifier, cursor: string(32), limit: count }),
      fields({ items: list(item, 100), total: count, nextCursor: nullable(string(32)) }),
    ),
  ],
  [
    WORKSPACE_SAVED_ROUTES.setSaved,
    adminRoute(
      fields({
        operationId: identifier,
        channelId: identifier,
        messageId: identifier,
        state: nullable(oneOf("saved", "done")),
      }),
      fields({ item: nullable(item) }),
    ),
  ],
  [WORKSPACE_SAVED_ROUTES.pins, adminRoute(fields({ channelId: identifier }), pins)],
  [
    WORKSPACE_SAVED_ROUTES.setPinned,
    adminRoute(
      fields({ operationId: identifier, channelId: identifier, messageId: identifier, pinned: boolean }),
      pins,
    ),
  ],
]);

export const WORKSPACE_SAVED_CHANGED_EVENT = "workspace-saved-changed";

export interface WorkspaceSavedChangedEvent {
  type: typeof WORKSPACE_SAVED_CHANGED_EVENT;
}

/** The saved items event in `value`, or null for any other event. It carries nothing else. */
export function workspaceSavedEvent(value: unknown): WorkspaceSavedChangedEvent | null {
  if (!isDynamicRecord(value) || value.type !== WORKSPACE_SAVED_CHANGED_EVENT) return null;
  return { type: WORKSPACE_SAVED_CHANGED_EVENT };
}
