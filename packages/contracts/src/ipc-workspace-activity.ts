// The cross-channel read of the workspace: the Activity view (mentions, thread replies, direct
// messages and reactions for the reader) and the Threads view (the threads the reader takes part in).
// The host computes it for the reader over the channels that the reader can see. It is read-only: a
// client reads it again on each `channel-message` event.
//
// `ipc-chat-channels.ts` re-exports this file. It imports no value from that file, so the two
// modules do not form an import cycle.

import { INPUT_LIMITS } from "./input-limits";
import { integerInRange, isBoundedString, isIdentifier } from "./ipc-bounded-values";
import { CHANNEL_THREAD_PARTICIPANT_LIMIT, isChannelEmoji } from "./ipc-chat-workspace";
import { isBoolean, isDynamicRecord, isOneOf } from "./runtime-values";

export const WORKSPACE_ACTIVITY_DEFAULT_LIMIT = 100;
export const WORKSPACE_ACTIVITY_LIMIT = 200;
export const WORKSPACE_ACTIVITY_THREAD_LIMIT = 50;
export const WORKSPACE_ACTIVITY_PREVIEW_LIMIT = 160;
/** The id of a reaction item holds the message id, the emoji and the actor. */
const ITEM_ID_LIMIT = 512;

export interface WorkspaceActivityInput {
  /** At most `WORKSPACE_ACTIVITY_LIMIT` items. Absent: `WORKSPACE_ACTIVITY_DEFAULT_LIMIT`. */
  limit?: number;
}

export const WORKSPACE_ACTIVITY_KINDS = ["mention", "reply", "dm", "reaction"] as const;
export type WorkspaceActivityKind = (typeof WORKSPACE_ACTIVITY_KINDS)[number];

export const WORKSPACE_ACTIVITY_ACTOR_KINDS = ["member", "agent", "coordinator", "external"] as const;

/** Who did it. `external` is the author of a message that a bridge brought, such as from Discord. */
export interface WorkspaceActivityActor {
  kind: (typeof WORKSPACE_ACTIVITY_ACTOR_KINDS)[number];
  id: string;
  name: string;
}

export interface WorkspaceActivityItem {
  /** Stable: `mention:<messageId>`, `reaction:<messageId>:<emoji>:<actorKind>:<actorId>`. */
  id: string;
  kind: WorkspaceActivityKind;
  channelId: string;
  /** The message to open. For a reaction: the message that has the reaction. */
  messageId: string;
  /** Set when that message is a thread reply. */
  threadRootId?: string;
  actor: WorkspaceActivityActor;
  /** Plain one-line text, at most `WORKSPACE_ACTIVITY_PREVIEW_LIMIT` characters. */
  preview: string;
  /** Only on a reaction. */
  emoji?: string;
  /** The time of the message. The host keeps no time for a reaction, so a reaction has the time of its message. */
  at: string;
  /** The message comes after the read position of the reader in its channel. */
  unread: boolean;
}

export interface WorkspaceThreadActivity {
  channelId: string;
  rootId: string;
  rootAuthor: { kind: "member" | "agent" | "coordinator"; id: string; name: string };
  /** At most `WORKSPACE_ACTIVITY_PREVIEW_LIMIT` characters. */
  rootText: string;
  replyCount: number;
  lastReplyAt: string;
  participantIds: string[];
  /** The replies after the read position of the reader that the reader did not write. */
  unreadCount: number;
}

export interface WorkspaceActivity {
  /** Newest first, at most the requested limit. */
  items: WorkspaceActivityItem[];
  /** Newest `lastReplyAt` first, at most `WORKSPACE_ACTIVITY_THREAD_LIMIT`. */
  threads: WorkspaceThreadActivity[];
}

export function parseWorkspaceActivityInput(value: unknown): WorkspaceActivityInput {
  if (value === undefined || value === null) return {};
  if (
    !isDynamicRecord(value) ||
    !(value.limit === undefined || integerInRange(value.limit, 1, WORKSPACE_ACTIVITY_LIMIT))
  )
    throw new Error("Provide a valid activity limit.");
  return value.limit === undefined ? {} : { limit: value.limit };
}

/** The item count that a request asks for, in the allowed range. */
export function workspaceActivityLimit(input: WorkspaceActivityInput): number {
  return Math.min(Math.max(1, Math.trunc(input.limit ?? WORKSPACE_ACTIVITY_DEFAULT_LIMIT)), WORKSPACE_ACTIVITY_LIMIT);
}

function timestamp(value: unknown): value is string {
  return isBoundedString(value, 80) && value.length > 0;
}

function count(value: unknown): value is number {
  return integerInRange(value, 0, Number.MAX_SAFE_INTEGER);
}

function isActor(value: unknown): value is WorkspaceActivityActor {
  return (
    isDynamicRecord(value) &&
    isOneOf(WORKSPACE_ACTIVITY_ACTOR_KINDS, value.kind) &&
    isIdentifier(value.id) &&
    isBoundedString(value.name, INPUT_LIMITS.accountName)
  );
}

function isItem(value: unknown): value is WorkspaceActivityItem {
  return (
    isDynamicRecord(value) &&
    isBoundedString(value.id, ITEM_ID_LIMIT) &&
    value.id.length > 0 &&
    isOneOf(WORKSPACE_ACTIVITY_KINDS, value.kind) &&
    isIdentifier(value.channelId) &&
    isIdentifier(value.messageId) &&
    (value.threadRootId === undefined || isIdentifier(value.threadRootId)) &&
    isActor(value.actor) &&
    isBoundedString(value.preview, WORKSPACE_ACTIVITY_PREVIEW_LIMIT) &&
    (value.kind === "reaction" ? isChannelEmoji(value.emoji) : value.emoji === undefined) &&
    timestamp(value.at) &&
    isBoolean(value.unread)
  );
}

function isThread(value: unknown): value is WorkspaceThreadActivity {
  const author = isDynamicRecord(value) ? value.rootAuthor : undefined;
  return (
    isDynamicRecord(value) &&
    isIdentifier(value.channelId) &&
    isIdentifier(value.rootId) &&
    isDynamicRecord(author) &&
    isOneOf(["member", "agent", "coordinator"] as const, author.kind) &&
    isIdentifier(author.id) &&
    isBoundedString(author.name, INPUT_LIMITS.accountName) &&
    isBoundedString(value.rootText, WORKSPACE_ACTIVITY_PREVIEW_LIMIT) &&
    count(value.replyCount) &&
    timestamp(value.lastReplyAt) &&
    Array.isArray(value.participantIds) &&
    value.participantIds.length <= CHANNEL_THREAD_PARTICIPANT_LIMIT &&
    value.participantIds.every(isIdentifier) &&
    count(value.unreadCount)
  );
}

function item(value: WorkspaceActivityItem): WorkspaceActivityItem {
  return {
    id: value.id,
    kind: value.kind,
    channelId: value.channelId,
    messageId: value.messageId,
    ...(value.threadRootId === undefined ? {} : { threadRootId: value.threadRootId }),
    actor: { kind: value.actor.kind, id: value.actor.id, name: value.actor.name },
    preview: value.preview,
    ...(value.emoji === undefined ? {} : { emoji: value.emoji }),
    at: value.at,
    unread: value.unread,
  };
}

function thread(value: WorkspaceThreadActivity): WorkspaceThreadActivity {
  return {
    channelId: value.channelId,
    rootId: value.rootId,
    rootAuthor: { kind: value.rootAuthor.kind, id: value.rootAuthor.id, name: value.rootAuthor.name },
    rootText: value.rootText,
    replyCount: value.replyCount,
    lastReplyAt: value.lastReplyAt,
    participantIds: [...value.participantIds],
    unreadCount: value.unreadCount,
  };
}

/** Only the known fields, in the bounds above. Any other value throws. */
export function decodeWorkspaceActivity(value: unknown): WorkspaceActivity {
  if (
    !isDynamicRecord(value) ||
    !Array.isArray(value.items) ||
    value.items.length > WORKSPACE_ACTIVITY_LIMIT ||
    !value.items.every(isItem) ||
    !Array.isArray(value.threads) ||
    value.threads.length > WORKSPACE_ACTIVITY_THREAD_LIMIT ||
    !value.threads.every(isThread)
  )
    throw new Error("Invalid workspace activity response.");
  return { items: value.items.map(item), threads: value.threads.map(thread) };
}
