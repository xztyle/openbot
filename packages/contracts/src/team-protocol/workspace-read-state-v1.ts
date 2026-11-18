// Optional read state wire contract of this fork, under `fork-host-v1`.
//
// What it adds, recorded here because freezing it makes it permanent:
//
// - A read position and a follow for each person in each thread, apart from the channel position of
//   channels-v1: reading a channel does not read its threads. A thread state is `{ channelId, rootId,
//   followed, throughSequence, unreadCount }`; `throughSequence` is 0 for a thread the person never
//   read, and `unreadCount` counts the replies after it that the person did not write.
// - `POST /v1/workspace/threads/states` `{ channelId, rootIds? }` (at most 200 ids) answers
//   `{ channelId, threads }` (at most 500): the state of each named root that is a thread root of the
//   channel, or without `rootIds` the threads of the channel that the person follows, newest reply first.
// - `POST /v1/workspace/threads/read` `{ operationId, channelId, threadRootId, throughSequence }`
//   moves the person's position in the thread forward, never back, and answers the thread state.
// - `POST /v1/workspace/threads/follow` `{ operationId, channelId, threadRootId, followed }` makes the
//   person follow the thread or stop following it, and answers the thread state. A person follows a
//   thread by themselves when they write its root or a reply, or a reply mentions them, and every
//   thread of a DM or a group; a choice to stop wins over a later mention, not over their own reply.
// - `POST /v1/workspace/channels/mark-unread` `{ operationId, channelId, messageId, threadRootId? }`
//   moves the person's position in the channel, or in the thread, to just before the message, also
//   back, and answers `{ channelId, threadRootId?, throughSequence, unreadCount }`. Without
//   `threadRootId` the message must show in the channel; with it, it must be the root or a reply of
//   that thread. A message the person cannot see answers 404. The channel `read` command of
//   channels-v1 still moves the channel position forward only.
// - The event `workspace-read-state-changed` (`{ channelId, threadRootId? }` beside its type): a read
//   position or a follow of the member of the session changed. Only that member's sessions get it.
//   A client reads the thread states or the activity again. An older client ignores it.
//
// The `threads` of `POST /v1/workspace/activity` (workspace-v1) keep their shape: from this contract
// on they are the threads that the member follows, and `unreadCount` counts from the thread position.
//
// A fork host built before these routes answers 404; a client then keeps the thread state of the
// channel position, as before. A present malformed value fails closed. The bounds are written out:
// this file must not move with an IPC limit.
import { isDynamicRecord } from "../runtime-values";
import { adminRoute, boolean, count, fields, identifier, list, type OptionalRouteCodec } from "./admin-wire";
import { FORK_HOST_CAPABILITY } from "./fork-host-v1";

export const WORKSPACE_READ_STATE_CAPABILITY = FORK_HOST_CAPABILITY;

export const WORKSPACE_READ_STATE_ROUTES = {
  threadStates: "/v1/workspace/threads/states",
  readThread: "/v1/workspace/threads/read",
  followThread: "/v1/workspace/threads/follow",
  markUnread: "/v1/workspace/channels/mark-unread",
} as const;

const threadState = fields({
  channelId: identifier,
  rootId: identifier,
  followed: boolean,
  throughSequence: count,
  unreadCount: count,
});

export const WORKSPACE_READ_STATE_CODECS: ReadonlyMap<string, OptionalRouteCodec> = new Map([
  [
    WORKSPACE_READ_STATE_ROUTES.threadStates,
    adminRoute(
      fields({ channelId: identifier }, { rootIds: list(identifier, 200) }),
      fields({ channelId: identifier, threads: list(threadState, 500) }),
    ),
  ],
  [
    WORKSPACE_READ_STATE_ROUTES.readThread,
    adminRoute(
      fields({ operationId: identifier, channelId: identifier, threadRootId: identifier, throughSequence: count }),
      threadState,
    ),
  ],
  [
    WORKSPACE_READ_STATE_ROUTES.markUnread,
    adminRoute(
      fields({ operationId: identifier, channelId: identifier, messageId: identifier }, { threadRootId: identifier }),
      fields({ channelId: identifier, throughSequence: count, unreadCount: count }, { threadRootId: identifier }),
    ),
  ],
  [
    WORKSPACE_READ_STATE_ROUTES.followThread,
    adminRoute(
      fields({ operationId: identifier, channelId: identifier, threadRootId: identifier, followed: boolean }),
      threadState,
    ),
  ],
]);

export const WORKSPACE_READ_STATE_CHANGED_EVENT = "workspace-read-state-changed";

export interface WorkspaceReadStateChangedEvent {
  type: typeof WORKSPACE_READ_STATE_CHANGED_EVENT;
  channelId: string;
  threadRootId?: string;
}

/** The read state event in `value`, or null for any other event. A malformed one throws. */
export function workspaceReadStateEvent(value: unknown): WorkspaceReadStateChangedEvent | null {
  if (!isDynamicRecord(value) || value.type !== WORKSPACE_READ_STATE_CHANGED_EVENT) return null;
  const decoded = fields({ channelId: identifier }, { threadRootId: identifier })(value);
  if (!isDynamicRecord(decoded) || typeof decoded.channelId !== "string") throw new Error("Invalid read state event.");
  return {
    type: WORKSPACE_READ_STATE_CHANGED_EVENT,
    channelId: decoded.channelId,
    ...(typeof decoded.threadRootId === "string" ? { threadRootId: decoded.threadRootId } : {}),
  };
}
