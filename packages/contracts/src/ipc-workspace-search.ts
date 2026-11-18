// The message search of the workspace: the channel, group and DM messages, thread replies too, that
// the reader can see, found by their words. The host reads a full-text index; it checks who may see
// each channel before it reads, so a result never names a channel the reader cannot open.
//
// `ipc-chat-channels.ts` re-exports this file. It imports no value from that file, so the two
// modules do not form an import cycle.

import { integerInRange, isBoundedString, isIdentifier } from "./ipc-bounded-values";
import { isBoolean, isDynamicRecord, isOneOf } from "./runtime-values";

/** The longest query text. */
export const WORKSPACE_SEARCH_QUERY_LIMIT = 500;
/** The most results of one page. */
export const WORKSPACE_SEARCH_PAGE_LIMIT = 50;
export const WORKSPACE_SEARCH_DEFAULT_LIMIT = 20;
/** The most channels and authors one search names. */
export const WORKSPACE_SEARCH_CHANNEL_LIMIT = 100;
export const WORKSPACE_SEARCH_AUTHOR_LIMIT = 50;
/** The longest snippet, and the most highlighted ranges in it. */
export const WORKSPACE_SEARCH_SNIPPET_LIMIT = 300;
export const WORKSPACE_SEARCH_HIGHLIGHT_LIMIT = 20;
const CURSOR_LIMIT = 32;
const TIME_LIMIT = 80;

export const WORKSPACE_SEARCH_SORTS = ["relevance", "recent"] as const;
export type WorkspaceSearchSort = (typeof WORKSPACE_SEARCH_SORTS)[number];

export interface WorkspaceSearchInput {
  /**
   * The words to find, at most `WORKSPACE_SEARCH_QUERY_LIMIT` characters. A word finds the words that
   * start with it, also without accents ("cafe" finds "Café"); `"two words"` finds the phrase; `-word`
   * leaves out the messages that have it. A client turns modifiers such as `in:` and `from:` into the
   * fields below. With no words and with `authorIds`, the search lists every message of those
   * authors that it can find, newest first: the reader's sent messages.
   */
  query: string;
  /** Only these channels (`in:`). */
  channelIds?: string[];
  /** Only messages these people or agents wrote (`from:`). */
  authorIds?: string[];
  /** Only messages written at or after this time (`after:`, `on:`), an ISO time. */
  after?: string;
  /** Only messages written before this time (`before:`), an ISO time. */
  before?: string;
  /** Only thread replies and the roots of threads (`is:thread`). */
  threadsOnly?: boolean;
  /** Only the channels of this space. */
  spaceId?: string;
  /** `relevance` (default): best match first, then newest. `recent`: newest first. */
  sort?: WorkspaceSearchSort;
  /** The `nextCursor` of the page before. */
  cursor?: string;
  /** At most `WORKSPACE_SEARCH_PAGE_LIMIT`. Absent: `WORKSPACE_SEARCH_DEFAULT_LIMIT`. */
  limit?: number;
}

/** A range of `snippet` that matches a word of the query. */
export interface WorkspaceSearchHighlight {
  start: number;
  length: number;
}

export interface WorkspaceSearchHit {
  channelId: string;
  messageId: string;
  sequence: number;
  /** Set when the message is a thread reply. */
  threadRootId?: string;
  /** `external` is the author of a message that a bridge brought, such as from Discord. */
  author: { kind: "member" | "agent" | "coordinator" | "external"; id: string; name: string };
  at: string;
  /** Plain text around the first match, at most `WORKSPACE_SEARCH_SNIPPET_LIMIT` characters. */
  snippet: string;
  highlights: WorkspaceSearchHighlight[];
  /** The space of the channel, when the host has spaces. */
  spaceId?: string;
}

export interface WorkspaceSearchPage {
  hits: WorkspaceSearchHit[];
  /** Every match, over all pages. */
  total: number;
  nextCursor: string | null;
}

function identifiers(value: unknown, maximum: number): value is string[] {
  return Array.isArray(value) && value.length <= maximum && value.every(isIdentifier);
}

function time(value: unknown): value is string {
  return isBoundedString(value, TIME_LIMIT) && !Number.isNaN(Date.parse(value));
}

export function parseWorkspaceSearchInput(value: unknown): WorkspaceSearchInput {
  if (
    !isDynamicRecord(value) ||
    !isBoundedString(value.query, WORKSPACE_SEARCH_QUERY_LIMIT) ||
    !(value.channelIds === undefined || identifiers(value.channelIds, WORKSPACE_SEARCH_CHANNEL_LIMIT)) ||
    !(value.authorIds === undefined || identifiers(value.authorIds, WORKSPACE_SEARCH_AUTHOR_LIMIT)) ||
    !(value.after === undefined || time(value.after)) ||
    !(value.before === undefined || time(value.before)) ||
    !(value.threadsOnly === undefined || isBoolean(value.threadsOnly)) ||
    !(value.spaceId === undefined || isIdentifier(value.spaceId)) ||
    !(value.sort === undefined || isOneOf(WORKSPACE_SEARCH_SORTS, value.sort)) ||
    !(value.cursor === undefined || (isBoundedString(value.cursor, CURSOR_LIMIT) && /^\d+$/u.test(value.cursor))) ||
    !(value.limit === undefined || integerInRange(value.limit, 1, WORKSPACE_SEARCH_PAGE_LIMIT))
  )
    throw new Error("Provide a valid message search.");
  return {
    query: value.query,
    ...(identifiers(value.channelIds, WORKSPACE_SEARCH_CHANNEL_LIMIT) ? { channelIds: [...value.channelIds] } : {}),
    ...(identifiers(value.authorIds, WORKSPACE_SEARCH_AUTHOR_LIMIT) ? { authorIds: [...value.authorIds] } : {}),
    ...(time(value.after) ? { after: value.after } : {}),
    ...(time(value.before) ? { before: value.before } : {}),
    ...(isBoolean(value.threadsOnly) ? { threadsOnly: value.threadsOnly } : {}),
    ...(isIdentifier(value.spaceId) ? { spaceId: value.spaceId } : {}),
    ...(isOneOf(WORKSPACE_SEARCH_SORTS, value.sort) ? { sort: value.sort } : {}),
    ...(typeof value.cursor === "string" ? { cursor: value.cursor } : {}),
    ...(typeof value.limit === "number" ? { limit: value.limit } : {}),
  };
}

/** The page size that a search asks for, in the allowed range. */
export function workspaceSearchLimit(input: Pick<WorkspaceSearchInput, "limit">): number {
  return Math.min(Math.max(1, Math.trunc(input.limit ?? WORKSPACE_SEARCH_DEFAULT_LIMIT)), WORKSPACE_SEARCH_PAGE_LIMIT);
}

function isHighlight(value: unknown): value is WorkspaceSearchHighlight {
  return (
    isDynamicRecord(value) &&
    integerInRange(value.start, 0, WORKSPACE_SEARCH_SNIPPET_LIMIT) &&
    integerInRange(value.length, 1, WORKSPACE_SEARCH_SNIPPET_LIMIT)
  );
}

function isHit(value: unknown): value is WorkspaceSearchHit {
  const author = isDynamicRecord(value) ? value.author : undefined;
  return (
    isDynamicRecord(value) &&
    isIdentifier(value.channelId) &&
    isIdentifier(value.messageId) &&
    integerInRange(value.sequence, 0, Number.MAX_SAFE_INTEGER) &&
    (value.threadRootId === undefined || isIdentifier(value.threadRootId)) &&
    isDynamicRecord(author) &&
    isOneOf(["member", "agent", "coordinator", "external"] as const, author.kind) &&
    isIdentifier(author.id) &&
    isBoundedString(author.name, 120) &&
    isBoundedString(value.at, TIME_LIMIT) &&
    isBoundedString(value.snippet, WORKSPACE_SEARCH_SNIPPET_LIMIT) &&
    Array.isArray(value.highlights) &&
    value.highlights.length <= WORKSPACE_SEARCH_HIGHLIGHT_LIMIT &&
    value.highlights.every(isHighlight) &&
    (value.spaceId === undefined || isIdentifier(value.spaceId))
  );
}

/** Only the known fields, in the bounds above. Any other value throws. */
export function decodeWorkspaceSearchPage(value: unknown): WorkspaceSearchPage {
  if (
    !isDynamicRecord(value) ||
    !Array.isArray(value.hits) ||
    value.hits.length > WORKSPACE_SEARCH_PAGE_LIMIT ||
    !value.hits.every(isHit) ||
    !integerInRange(value.total, 0, Number.MAX_SAFE_INTEGER) ||
    !(value.nextCursor === null || (isBoundedString(value.nextCursor, CURSOR_LIMIT) && /^\d+$/u.test(value.nextCursor)))
  )
    throw new Error("Invalid message search response.");
  return {
    hits: value.hits.map((hit) => ({
      channelId: hit.channelId,
      messageId: hit.messageId,
      sequence: hit.sequence,
      ...(hit.threadRootId === undefined ? {} : { threadRootId: hit.threadRootId }),
      author: { kind: hit.author.kind, id: hit.author.id, name: hit.author.name },
      at: hit.at,
      snippet: hit.snippet,
      highlights: hit.highlights.map((range) => ({ start: range.start, length: range.length })),
      ...(hit.spaceId === undefined ? {} : { spaceId: hit.spaceId }),
    })),
    total: value.total,
    nextCursor: value.nextCursor,
  };
}
