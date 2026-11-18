// The read state of a person in each thread, apart from the channel: the reply up to which they
// read it, how many replies after it they did not write, and whether they follow it. Reading a
// channel does not read its threads. A person follows a thread that they started, replied to or
// were mentioned in, and every thread of a DM or a group; they can also follow or stop following one
// themselves, which an automatic follow does not change. The Threads view lists the followed ones.
//
// `ipc-chat-channels.ts` re-exports this file. It imports no value from that file, so the two
// modules do not form an import cycle.

import { integerInRange, isIdentifier } from "./ipc-bounded-values";
import { isBoolean, isDynamicRecord } from "./runtime-values";

/** The most roots that one thread state request names. */
export const WORKSPACE_THREAD_STATES_LIMIT = 200;
/** The most followed threads of one channel that a request without roots gives. */
export const WORKSPACE_FOLLOWED_THREADS_LIMIT = 500;

export interface WorkspaceThreadStatesInput {
  channelId: string;
  /**
   * The threads to read, at most `WORKSPACE_THREAD_STATES_LIMIT`, such as the roots of a loaded page.
   * Absent: the followed threads of the channel, newest reply first.
   */
  rootIds?: string[];
}

export interface WorkspaceThreadState {
  channelId: string;
  rootId: string;
  followed: boolean;
  /** The sequence up to which the reader read the thread; 0 when they never read it. */
  throughSequence: number;
  /** The replies after `throughSequence` that the reader did not write. Activity and notes are not replies. */
  unreadCount: number;
}

export interface WorkspaceThreadStates {
  channelId: string;
  threads: WorkspaceThreadState[];
}

export interface WorkspaceReadThreadInput {
  operationId: string;
  channelId: string;
  threadRootId: string;
  /** The read position only moves forward; an older position changes nothing. */
  throughSequence: number;
}

export interface WorkspaceFollowThreadInput {
  operationId: string;
  channelId: string;
  threadRootId: string;
  followed: boolean;
}

function sequence(value: unknown): value is number {
  return integerInRange(value, 0, Number.MAX_SAFE_INTEGER);
}

function rootList(value: unknown): value is string[] {
  return Array.isArray(value) && value.length <= WORKSPACE_THREAD_STATES_LIMIT && value.every(isIdentifier);
}

export function parseWorkspaceThreadStatesInput(value: unknown): WorkspaceThreadStatesInput {
  if (
    !isDynamicRecord(value) ||
    !isIdentifier(value.channelId) ||
    !(value.rootIds === undefined || rootList(value.rootIds))
  )
    throw new Error("Provide a valid channel and thread list.");
  return { channelId: value.channelId, ...(rootList(value.rootIds) ? { rootIds: [...new Set(value.rootIds)] } : {}) };
}

export function parseWorkspaceReadThreadInput(value: unknown): WorkspaceReadThreadInput {
  if (
    !isDynamicRecord(value) ||
    !isIdentifier(value.operationId) ||
    !isIdentifier(value.channelId) ||
    !isIdentifier(value.threadRootId) ||
    !sequence(value.throughSequence)
  )
    throw new Error("Provide a valid thread and read position.");
  return {
    operationId: value.operationId,
    channelId: value.channelId,
    threadRootId: value.threadRootId,
    throughSequence: value.throughSequence,
  };
}

export function parseWorkspaceFollowThreadInput(value: unknown): WorkspaceFollowThreadInput {
  if (
    !isDynamicRecord(value) ||
    !isIdentifier(value.operationId) ||
    !isIdentifier(value.channelId) ||
    !isIdentifier(value.threadRootId) ||
    !isBoolean(value.followed)
  )
    throw new Error("Provide a valid thread and follow choice.");
  return {
    operationId: value.operationId,
    channelId: value.channelId,
    threadRootId: value.threadRootId,
    followed: value.followed,
  };
}

function isThreadState(value: unknown): value is WorkspaceThreadState {
  return (
    isDynamicRecord(value) &&
    isIdentifier(value.channelId) &&
    isIdentifier(value.rootId) &&
    isBoolean(value.followed) &&
    sequence(value.throughSequence) &&
    sequence(value.unreadCount)
  );
}

/** Only the known fields, in the bounds above. Any other value throws. */
export function decodeWorkspaceThreadState(value: unknown): WorkspaceThreadState {
  if (!isThreadState(value)) throw new Error("Invalid thread state.");
  return {
    channelId: value.channelId,
    rootId: value.rootId,
    followed: value.followed,
    throughSequence: value.throughSequence,
    unreadCount: value.unreadCount,
  };
}

export function decodeWorkspaceThreadStates(value: unknown): WorkspaceThreadStates {
  if (
    !isDynamicRecord(value) ||
    !isIdentifier(value.channelId) ||
    !Array.isArray(value.threads) ||
    value.threads.length > WORKSPACE_FOLLOWED_THREADS_LIMIT ||
    !value.threads.every(isThreadState)
  )
    throw new Error("Invalid thread states.");
  return { channelId: value.channelId, threads: value.threads.map(decodeWorkspaceThreadState) };
}

/**
 * Mark unread: the reader's position in the channel, or in the thread `threadRootId`, moves to just
 * before `messageId`, also back, so that message and the ones after it are unread again. Without
 * `threadRootId` the message must show in the channel; with it, it must be the root or a reply of
 * that thread.
 */
export interface WorkspaceMarkUnreadInput {
  operationId: string;
  channelId: string;
  messageId: string;
  threadRootId?: string;
}

/** The reader's position in a channel, or in one thread of it, and what is unread after it. */
export interface WorkspaceReadPosition {
  channelId: string;
  threadRootId?: string;
  throughSequence: number;
  /** In a channel: as `ChannelSummary.unreadCount`. In a thread: as `WorkspaceThreadState.unreadCount`. */
  unreadCount: number;
}

export function parseWorkspaceMarkUnreadInput(value: unknown): WorkspaceMarkUnreadInput {
  if (
    !isDynamicRecord(value) ||
    !isIdentifier(value.operationId) ||
    !isIdentifier(value.channelId) ||
    !isIdentifier(value.messageId) ||
    !(value.threadRootId === undefined || isIdentifier(value.threadRootId))
  )
    throw new Error("Provide a valid message to mark unread.");
  return {
    operationId: value.operationId,
    channelId: value.channelId,
    messageId: value.messageId,
    ...(value.threadRootId === undefined ? {} : { threadRootId: value.threadRootId }),
  };
}

export function decodeWorkspaceReadPosition(value: unknown): WorkspaceReadPosition {
  if (
    !isDynamicRecord(value) ||
    !isIdentifier(value.channelId) ||
    !(value.threadRootId === undefined || isIdentifier(value.threadRootId)) ||
    !sequence(value.throughSequence) ||
    !sequence(value.unreadCount)
  )
    throw new Error("Invalid read position.");
  return {
    channelId: value.channelId,
    ...(value.threadRootId === undefined ? {} : { threadRootId: value.threadRootId }),
    throughSequence: value.throughSequence,
    unreadCount: value.unreadCount,
  };
}
