import {
  type ChannelMessage,
  isChannelMessage,
  WORKSPACE_SEARCH_HIGHLIGHT_LIMIT,
  WORKSPACE_SEARCH_SNIPPET_LIMIT,
  type WorkspaceSearchHighlight,
  type WorkspaceSearchSort,
} from "@openbot/contracts/ipc";
import { markdownPreviewText } from "@openbot/contracts/markdown-preview-text";
import type { DatabaseCore } from "./database-core";
import { databaseRow, databaseRows, requiredNumberColumn, requiredStringColumn } from "./database-rows";

/** The words of a query as the full-text index reads them, and as a snippet highlights them. */
export interface ChannelSearchPlan {
  /** An FTS5 query: each word as a prefix, each phrase whole, each excluded word after `NOT`. */
  match: string;
  /** The folded words and phrases to highlight, longest first. */
  terms: string[];
}

/** One search over the channels that the caller already checked the reader may see. */
export interface ChannelSearchRequest {
  /**
   * The words to find. Null lists every message that a search can find, by the other filters only:
   * the reader's sent messages are a search with no words and the reader as the author.
   */
  plan: ChannelSearchPlan | null;
  /** The channels to search: never empty, every one of them visible to the reader. */
  channelIds: string[];
  authorIds?: string[];
  /** Messages of these agents stay out: the reader's peer cannot see them. */
  excludedAgentIds?: string[];
  after?: string;
  before?: string;
  threadsOnly?: boolean;
  sort: WorkspaceSearchSort;
  offset: number;
  limit: number;
}

export interface ChannelSearchRow {
  message: ChannelMessage;
  snippet: string;
  highlights: WorkspaceSearchHighlight[];
}

export interface ChannelSearchResult {
  rows: ChannelSearchRow[];
  total: number;
}

const WORD = /[\p{L}\p{N}]/u;
/** The longest text of a message that a snippet reads, so a huge message does not slow a page. */
const SNIPPET_SOURCE_LIMIT = 20_000;

/** Lowercase without accents, one code unit for each code unit, so an index in it is one in `text`. */
export function foldSearchText(text: string): string {
  let folded = "";
  for (const character of text) {
    const base = character.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
    const lower = character.toLowerCase();
    folded += base.length === character.length ? base : lower.length === character.length ? lower : character;
  }
  return folded;
}

function quoted(text: string): string {
  return `"${text.replaceAll('"', '""')}"`;
}

/**
 * The FTS5 query of a search text: `word` finds the words that start with it, `"two words"` the
 * phrase, `-word` leaves out the messages that have it. A text with nothing to find answers null.
 */
export function channelSearchPlan(query: string): ChannelSearchPlan | null {
  const included: string[] = [];
  const excluded: string[] = [];
  const terms: string[] = [];
  for (const match of query.matchAll(/(-?)"([^"]*)"|(\S+)/gu)) {
    const phrase = match[2];
    const raw = phrase ?? match[3] ?? "";
    const negative = phrase !== undefined ? match[1] === "-" : raw.startsWith("-") && raw.length > 1;
    const text = (phrase !== undefined ? raw : negative ? raw.slice(1) : raw).replace(/\s+/gu, " ").trim();
    if (!WORD.test(text)) continue;
    const expression = phrase !== undefined ? quoted(text) : `${quoted(text)}*`;
    if (negative) excluded.push(expression);
    else {
      included.push(expression);
      terms.push(foldSearchText(text));
    }
  }
  if (!included.length) return null;
  return {
    match: [included.join(" AND "), ...excluded.map((expression) => `NOT ${expression}`)].join(" "),
    terms: [...new Set(terms)].sort((left, right) => right.length - left.length),
  };
}

/** Plain text around the first match, with the ranges of every match in it. */
export function searchSnippet(message: ChannelMessage, terms: readonly string[]): Omit<ChannelSearchRow, "message"> {
  const text = markdownPreviewText(message.message.text.slice(0, SNIPPET_SOURCE_LIMIT));
  const folded = foldSearchText(text);
  const matches: WorkspaceSearchHighlight[] = [];
  for (const term of terms) {
    if (!term) continue;
    for (let at = folded.indexOf(term); at >= 0; at = folded.indexOf(term, at + term.length)) {
      // A word matches at the start of a word, as the index does.
      if (at > 0 && WORD.test(folded[at - 1] ?? "")) continue;
      if (matches.some((range) => at < range.start + range.length && range.start < at + term.length)) continue;
      matches.push({ start: at, length: term.length });
    }
  }
  matches.sort((left, right) => left.start - right.start);
  const first = matches[0]?.start ?? 0;
  const start = Math.max(0, Math.min(first - 60, text.length - WORKSPACE_SEARCH_SNIPPET_LIMIT));
  const lead = start > 0 ? "…" : "";
  const room = WORKSPACE_SEARCH_SNIPPET_LIMIT - lead.length;
  const body = text.slice(start, start + room);
  const tail = start + room < text.length && body.length === room ? 1 : 0;
  const snippet = `${lead}${tail ? body.slice(0, -1) : body}${tail ? "…" : ""}`;
  const end = start + body.length - tail;
  return {
    snippet,
    highlights: matches
      .filter((range) => range.start >= start && range.start + range.length <= end)
      .slice(0, WORKSPACE_SEARCH_HIGHLIGHT_LIMIT)
      .map((range) => ({ start: range.start - start + lead.length, length: range.length })),
  };
}

/**
 * The message search over the full-text index of channel messages (migration 53). It holds only a
 * connection, so a database read worker answers it as the main connection does. It does not decide
 * who may see a channel: the caller passes only the channels the reader can see.
 */
export class ChannelSearchQueries {
  readonly #core: Pick<DatabaseCore, "connection">;

  constructor(options: { core: Pick<DatabaseCore, "connection"> }) {
    this.#core = options.core;
  }

  search(request: ChannelSearchRequest): ChannelSearchResult {
    if (!request.channelIds.length) return { rows: [], total: 0 };
    const filters: string[] = ["message.channel_id IN (SELECT value FROM json_each(?))"];
    const parameters: (string | number)[] = [
      ...(request.plan ? [request.plan.match] : []),
      JSON.stringify(request.channelIds),
    ];
    if (request.authorIds?.length) {
      filters.push(`(json_extract(message.message_json, '$.author.id') IN (SELECT value FROM json_each(?))
        OR json_extract(message.message_json, '$.externalAuthor.id') IN (SELECT value FROM json_each(?)))`);
      parameters.push(JSON.stringify(request.authorIds), JSON.stringify(request.authorIds));
    }
    if (request.excludedAgentIds?.length) {
      filters.push(`NOT (json_extract(message.message_json, '$.author.kind') = 'agent'
        AND json_extract(message.message_json, '$.author.id') IN (SELECT value FROM json_each(?)))`);
      parameters.push(JSON.stringify(request.excludedAgentIds));
    }
    if (request.after) {
      filters.push("json_extract(message.message_json, '$.message.createdAt') >= ?");
      parameters.push(new Date(request.after).toISOString());
    }
    if (request.before) {
      filters.push("json_extract(message.message_json, '$.message.createdAt') < ?");
      parameters.push(new Date(request.before).toISOString());
    }
    if (request.threadsOnly)
      filters.push(`(json_extract(message.message_json, '$.threadRootId') IS NOT NULL
        OR COALESCE(json_extract(message.message_json, '$.threadSummary.replyCount'), 0) > 0)`);
    const order =
      request.sort === "recent" || !request.plan ? "at DESC, sequence DESC, id DESC" : "score, at DESC, id DESC";
    // The index finds the matches; only the page's rows read their message. With no words, the
    // messages in the index are the ones a search can find, newest first.
    const matches = request.plan
      ? `WITH matches AS MATERIALIZED (
        SELECT message.rowid AS id, message.sequence AS sequence, bm25(channel_message_search) AS score,
               json_extract(message.message_json, '$.message.createdAt') AS at
          FROM channel_message_search
          JOIN projection_channel_messages message ON message.rowid = channel_message_search.rowid
         WHERE channel_message_search MATCH ? AND ${filters.join(" AND ")}
      )`
      : `WITH matches AS MATERIALIZED (
        SELECT message.rowid AS id, message.sequence AS sequence, 0 AS score,
               json_extract(message.message_json, '$.message.createdAt') AS at
          FROM projection_channel_messages message
         WHERE message.rowid IN (SELECT rowid FROM channel_message_search) AND ${filters.join(" AND ")}
      )`;
    const rows = databaseRows(
      this.#core.connection
        .prepare(
          `${matches}
           SELECT page.total, message.message_json FROM (
             SELECT id, COUNT(*) OVER () AS total, ROW_NUMBER() OVER (ORDER BY ${order}) AS position
               FROM matches ORDER BY ${order} LIMIT ? OFFSET ?
           ) page JOIN projection_channel_messages message ON message.rowid = page.id
           ORDER BY page.position`,
        )
        .all(...parameters, request.limit, request.offset),
    );
    const total = rows[0]
      ? requiredNumberColumn(rows[0], "total")
      : (() => {
          const row = databaseRow(
            this.#core.connection.prepare(`${matches} SELECT COUNT(*) AS total FROM matches`).get(...parameters),
          );
          return row ? requiredNumberColumn(row, "total") : 0;
        })();
    return {
      total,
      rows: rows.flatMap((row) => {
        const message = JSON.parse(requiredStringColumn(row, "message_json"));
        if (!isChannelMessage(message)) return [];
        return [{ message, ...searchSnippet(message, request.plan?.terms ?? []) }];
      }),
    };
  }
}
