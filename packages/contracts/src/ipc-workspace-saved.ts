// Saved items ("Later") and pins of the workspace. A person saves a message for later, and marks it
// done when they handled it; only they see their saved items. A pin is on the message for everyone
// who can see the channel (`ChannelMessage.pinned`), and each channel lists its pins.
//
// `ipc-chat-channels.ts` re-exports this file. It imports no value from that file, so the two
// modules do not form an import cycle.

import { INPUT_LIMITS } from "./input-limits";
import { integerInRange, isBoundedString, isIdentifier } from "./ipc-bounded-values";
import { isBoolean, isDynamicRecord, isOneOf } from "./runtime-values";

export const WORKSPACE_SAVED_STATES = ["saved", "done"] as const;
/** `saved`: in progress. `done`: the person handled it; it stays in the list of done items. */
export type WorkspaceSavedState = (typeof WORKSPACE_SAVED_STATES)[number];

export const WORKSPACE_SAVED_PAGE_LIMIT = 100;
export const WORKSPACE_SAVED_DEFAULT_LIMIT = 50;
/** The most pins of one channel, as in Slack. */
export const WORKSPACE_PIN_LIMIT = 100;
export const WORKSPACE_SAVED_PREVIEW_LIMIT = 160;
const CURSOR_LIMIT = 32;
const TIME_LIMIT = 80;

export interface WorkspaceSavedInput {
  /** Only items in this state. Absent: both. */
  state?: WorkspaceSavedState;
  /** Only items of this channel, such as the messages of an open channel that show a saved mark. */
  channelId?: string;
  cursor?: string;
  /** At most `WORKSPACE_SAVED_PAGE_LIMIT`. Absent: `WORKSPACE_SAVED_DEFAULT_LIMIT`. */
  limit?: number;
}

/** Who wrote a saved or a pinned message. `external`: a bridge brought it, such as from Discord. */
export interface WorkspaceMessageAuthor {
  kind: "member" | "agent" | "coordinator" | "external";
  id: string;
  name: string;
}

export interface WorkspaceSavedItem {
  channelId: string;
  messageId: string;
  /** Set when the message is a thread reply. */
  threadRootId?: string;
  state: WorkspaceSavedState;
  savedAt: string;
  author: WorkspaceMessageAuthor;
  /** The time of the message. */
  at: string;
  /** Plain one-line text, at most `WORKSPACE_SAVED_PREVIEW_LIMIT` characters; empty for a deleted message. */
  preview: string;
  /** The message was deleted after it was saved. */
  deleted: boolean;
}

export interface WorkspaceSavedPage {
  /** Newest saved first. Only items of channels the person can still see. */
  items: WorkspaceSavedItem[];
  total: number;
  nextCursor: string | null;
}

export interface WorkspaceSetSavedInput {
  operationId: string;
  channelId: string;
  messageId: string;
  /** Null removes the item. */
  state: WorkspaceSavedState | null;
}

export interface WorkspaceSetSavedResult {
  item: WorkspaceSavedItem | null;
}

export interface WorkspacePin {
  messageId: string;
  threadRootId?: string;
  author: WorkspaceMessageAuthor;
  at: string;
  preview: string;
  pinnedBy: { kind: "member" | "agent"; id: string };
  pinnedAt: string;
}

export interface WorkspacePins {
  channelId: string;
  /** Newest pin first, at most `WORKSPACE_PIN_LIMIT`. */
  pins: WorkspacePin[];
}

export interface WorkspaceSetPinnedInput {
  operationId: string;
  channelId: string;
  messageId: string;
  pinned: boolean;
}

function cursor(value: unknown): value is string {
  return isBoundedString(value, CURSOR_LIMIT) && /^\d+$/u.test(value);
}

export function parseWorkspaceSavedInput(value: unknown): WorkspaceSavedInput {
  if (value === undefined || value === null) return {};
  if (
    !isDynamicRecord(value) ||
    !(value.state === undefined || isOneOf(WORKSPACE_SAVED_STATES, value.state)) ||
    !(value.channelId === undefined || isIdentifier(value.channelId)) ||
    !(value.cursor === undefined || cursor(value.cursor)) ||
    !(value.limit === undefined || integerInRange(value.limit, 1, WORKSPACE_SAVED_PAGE_LIMIT))
  )
    throw new Error("Provide a valid saved items request.");
  return {
    ...(isOneOf(WORKSPACE_SAVED_STATES, value.state) ? { state: value.state } : {}),
    ...(isIdentifier(value.channelId) ? { channelId: value.channelId } : {}),
    ...(cursor(value.cursor) ? { cursor: value.cursor } : {}),
    ...(typeof value.limit === "number" ? { limit: value.limit } : {}),
  };
}

export function workspaceSavedLimit(input: Pick<WorkspaceSavedInput, "limit">): number {
  return Math.min(Math.max(1, Math.trunc(input.limit ?? WORKSPACE_SAVED_DEFAULT_LIMIT)), WORKSPACE_SAVED_PAGE_LIMIT);
}

export function parseWorkspaceSetSavedInput(value: unknown): WorkspaceSetSavedInput {
  if (
    !isDynamicRecord(value) ||
    !isIdentifier(value.operationId) ||
    !isIdentifier(value.channelId) ||
    !isIdentifier(value.messageId) ||
    !(value.state === null || isOneOf(WORKSPACE_SAVED_STATES, value.state))
  )
    throw new Error("Provide a valid message and saved state.");
  return {
    operationId: value.operationId,
    channelId: value.channelId,
    messageId: value.messageId,
    state: value.state,
  };
}

export function parseWorkspacePinsInput(value: unknown): { channelId: string } {
  if (!isDynamicRecord(value) || !isIdentifier(value.channelId)) throw new Error("Provide a valid channel.");
  return { channelId: value.channelId };
}

export function parseWorkspaceSetPinnedInput(value: unknown): WorkspaceSetPinnedInput {
  if (
    !isDynamicRecord(value) ||
    !isIdentifier(value.operationId) ||
    !isIdentifier(value.channelId) ||
    !isIdentifier(value.messageId) ||
    !isBoolean(value.pinned)
  )
    throw new Error("Provide a valid message and pin choice.");
  return {
    operationId: value.operationId,
    channelId: value.channelId,
    messageId: value.messageId,
    pinned: value.pinned,
  };
}

function isAuthor(value: unknown): value is WorkspaceMessageAuthor {
  return (
    isDynamicRecord(value) &&
    isOneOf(["member", "agent", "coordinator", "external"] as const, value.kind) &&
    isIdentifier(value.id) &&
    isBoundedString(value.name, INPUT_LIMITS.accountName)
  );
}

function author(value: WorkspaceMessageAuthor): WorkspaceMessageAuthor {
  return { kind: value.kind, id: value.id, name: value.name };
}

function isSavedItem(value: unknown): value is WorkspaceSavedItem {
  return (
    isDynamicRecord(value) &&
    isIdentifier(value.channelId) &&
    isIdentifier(value.messageId) &&
    (value.threadRootId === undefined || isIdentifier(value.threadRootId)) &&
    isOneOf(WORKSPACE_SAVED_STATES, value.state) &&
    isBoundedString(value.savedAt, TIME_LIMIT) &&
    isAuthor(value.author) &&
    isBoundedString(value.at, TIME_LIMIT) &&
    isBoundedString(value.preview, WORKSPACE_SAVED_PREVIEW_LIMIT) &&
    isBoolean(value.deleted)
  );
}

function savedItem(value: WorkspaceSavedItem): WorkspaceSavedItem {
  return {
    channelId: value.channelId,
    messageId: value.messageId,
    ...(value.threadRootId === undefined ? {} : { threadRootId: value.threadRootId }),
    state: value.state,
    savedAt: value.savedAt,
    author: author(value.author),
    at: value.at,
    preview: value.preview,
    deleted: value.deleted,
  };
}

export function decodeWorkspaceSavedPage(value: unknown): WorkspaceSavedPage {
  if (
    !isDynamicRecord(value) ||
    !Array.isArray(value.items) ||
    value.items.length > WORKSPACE_SAVED_PAGE_LIMIT ||
    !value.items.every(isSavedItem) ||
    !integerInRange(value.total, 0, Number.MAX_SAFE_INTEGER) ||
    !(value.nextCursor === null || cursor(value.nextCursor))
  )
    throw new Error("Invalid saved items response.");
  return { items: value.items.map(savedItem), total: value.total, nextCursor: value.nextCursor };
}

export function decodeWorkspaceSetSavedResult(value: unknown): WorkspaceSetSavedResult {
  if (!isDynamicRecord(value) || !(value.item === null || isSavedItem(value.item)))
    throw new Error("Invalid saved item response.");
  return { item: value.item === null ? null : savedItem(value.item) };
}

function isPin(value: unknown): value is WorkspacePin {
  const by = isDynamicRecord(value) ? value.pinnedBy : undefined;
  return (
    isDynamicRecord(value) &&
    isIdentifier(value.messageId) &&
    (value.threadRootId === undefined || isIdentifier(value.threadRootId)) &&
    isAuthor(value.author) &&
    isBoundedString(value.at, TIME_LIMIT) &&
    isBoundedString(value.preview, WORKSPACE_SAVED_PREVIEW_LIMIT) &&
    isDynamicRecord(by) &&
    (by.kind === "member" || by.kind === "agent") &&
    isIdentifier(by.id) &&
    isBoundedString(value.pinnedAt, TIME_LIMIT)
  );
}

export function decodeWorkspacePins(value: unknown): WorkspacePins {
  if (
    !isDynamicRecord(value) ||
    !isIdentifier(value.channelId) ||
    !Array.isArray(value.pins) ||
    value.pins.length > WORKSPACE_PIN_LIMIT ||
    !value.pins.every(isPin)
  )
    throw new Error("Invalid pins response.");
  return {
    channelId: value.channelId,
    pins: value.pins.map((pin) => ({
      messageId: pin.messageId,
      ...(pin.threadRootId === undefined ? {} : { threadRootId: pin.threadRootId }),
      author: author(pin.author),
      at: pin.at,
      preview: pin.preview,
      pinnedBy: { kind: pin.pinnedBy.kind, id: pin.pinnedBy.id },
      pinnedAt: pin.pinnedAt,
    })),
  };
}
