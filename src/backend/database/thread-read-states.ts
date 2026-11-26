import type { DatabaseSync, StatementSync } from "node:sqlite";
import { CHAT_VISUAL_ITEM_TYPE_PREFIX } from "@openbot/contracts/chat-visual";
import { EVENT_CHECK_ITEM_TYPE_PREFIX } from "@openbot/contracts/event-checks";
import {
  AGENT_EXCHANGE_ITEM_TYPE,
  CONTEXT_RESET_ITEM_TYPE,
  CONVERSATION_MEMORY_CHANGES_ITEM_TYPE,
  type ConversationReadState,
  HOSTED_SITE_EVENT_ITEM_TYPE_PREFIX,
  MARKETPLACE_SUGGESTION_ITEM_TYPE_PREFIX,
  MODEL_SWITCH_ITEM_TYPE_PREFIX,
  ROUTINE_EVENT_ITEM_TYPE_PREFIX,
  ROUTINE_QUIET_ANSWER_ITEM_TYPE,
  ROUTINE_RUN_EVENT_ITEM_TYPE_PREFIX,
  SKILL_EVENT_ITEM_TYPE_PREFIX,
  SYSTEM_NOTICE_ITEM_TYPE_PREFIX,
} from "@openbot/contracts/ipc";
import { OWNER_MESSAGE_ITEM_TYPE } from "@openbot/contracts/owner-conversation";
import { isDynamicRecord, isNumber, isString } from "@openbot/contracts/runtime-values";
import {
  type ConversationMarkerExclusions,
  ORDER_KEY_COLUMNS,
  ORDER_KEY_DESC,
  ORDERED_THREAD_MESSAGES,
} from "./conversation-queries";

/** How many computed read states one instance keeps. Each is a few strings; the oldest goes first. */
const READ_STATE_CACHE_LIMIT = 2_000;

interface CachedReadState {
  /** The thread row's `last_event_sequence` and `updated_at` when the state was read. */
  version: string;
  state: ConversationReadState;
}

/**
 * One member's stored cursors and every thread's version, read once for a list of chats. `versions` is
 * null when a version cannot be trusted, as `threadVersion` is.
 */
export interface ReadLookups {
  cursors: ReadonlyMap<string, string | null>;
  versions: ReadonlyMap<string, string> | null;
}

export interface ThreadReadStatesOptions {
  /** Only its connection: the main connection, or the read connection of a read worker. */
  core: { readonly connection: DatabaseSync };
  conversations: {
    supportedConversationCursor(
      threadId: string,
      throughMessageId: string | null,
      options?: ConversationMarkerExclusions,
    ): string | null;
  };
  /**
   * Whether a thread version that this connection reads now can key the cache. The main connection
   * answers no inside a transaction: a ROLLBACK can remove rows that it already shows, and the next
   * write can then take the same sequence number. A read worker reads only committed rows, so its
   * versions are always final.
   */
  versionsAreFinal: () => boolean;
}

/**
 * The read side of each member's unread state: the stored cursor, the unread count after it, and the
 * cache of computed states by thread version.
 *
 * It only reads. A thread whose member has no cursor yet, or whose cursor names a message that the
 * thread no longer holds, needs a cursor write first: `knownState` answers null for it, and the
 * caller that owns writes (`ConversationReadStore` on the main connection) handles it. The main
 * process and the read worker each hold one instance over their own connection, so both compute a
 * state with the same SQL. Never imports the facade.
 */
export class ThreadReadStates {
  readonly #core: { readonly connection: DatabaseSync };
  readonly #conversations: ThreadReadStatesOptions["conversations"];
  readonly #versionsAreFinal: () => boolean;
  /**
   * Read states by thread, cursor and marker exclusions. A state depends only on the thread's rows
   * and the cursor, and every write to the rows of a thread moves the thread row's version, so an
   * entry with the current version is still right. Computing one runs the unread query over the
   * whole thread: a few milliseconds each, and about 100 ms for the list of every agent, which each
   * client reads after each chat change of an agent it does not show.
   */
  readonly #cache = new Map<string, CachedReadState>();
  /** By connection: a database that is opened again has a new one, and a statement belongs to one. */
  readonly #statements = new WeakMap<DatabaseSync, Map<string, StatementSync>>();

  constructor(options: ThreadReadStatesOptions) {
    this.#core = options.core;
    this.#conversations = options.conversations;
    this.#versionsAreFinal = options.versionsAreFinal;
  }

  /** The member's cursors and the thread versions, each in one query, for a list of chats. */
  lookups(memberId: string): ReadLookups {
    const connection = this.#core.connection;
    const cursors = new Map<string, string | null>();
    for (const row of connection
      .prepare("SELECT thread_id, through_message_id FROM projection_thread_reads WHERE member_id = ?")
      .all(memberId)) {
      if (!isDynamicRecord(row) || !isString(row.thread_id))
        throw new Error("The stored conversation read state is malformed.");
      const cursor = row.through_message_id;
      if (cursor !== null && !isString(cursor)) throw new Error("The stored conversation read cursor is malformed.");
      cursors.set(row.thread_id, cursor);
    }
    if (!this.#versionsAreFinal()) return { cursors, versions: null };
    const versions = new Map<string, string>();
    for (const row of connection
      .prepare("SELECT thread_id, last_event_sequence, updated_at FROM projection_threads")
      .all()) {
      if (
        isDynamicRecord(row) &&
        isString(row.thread_id) &&
        isNumber(row.last_event_sequence) &&
        isString(row.updated_at)
      )
        versions.set(row.thread_id, `${row.last_event_sequence}\u0000${row.updated_at}`);
    }
    return { cursors, versions };
  }

  /**
   * The member's state of a thread whose stored cursor the thread still holds, from the cache when the
   * thread did not change. Null when the cursor must be written first: none is stored yet, or it names
   * a message that the thread no longer holds.
   */
  knownState(
    memberId: string,
    threadId: string,
    options: ConversationMarkerExclusions = {},
    lookups?: ReadLookups,
  ): ConversationReadState | null {
    const stored = lookups ? lookups.cursors.get(threadId) : this.storedCursor(threadId, memberId);
    if (stored === undefined) return null;
    // Only a stored cursor that the thread still holds goes in the cache, so a hit needs no other check.
    const cacheKey = readStateCacheKey(threadId, stored, options);
    const version = lookups ? (lookups.versions?.get(threadId) ?? null) : this.threadVersion(threadId);
    const cached = this.#cache.get(cacheKey);
    if (cached && version !== null && cached.version === version) return { ...cached.state };
    if (stored !== null && !this.messageExists(threadId, stored)) return null;
    const result = this.withSupportedCursor(threadId, this.stateFromDatabase(threadId, stored), options);
    if (version !== null) this.#remember(cacheKey, version, result);
    return result;
  }

  withSupportedCursor(
    threadId: string,
    state: ConversationReadState,
    options: ConversationMarkerExclusions,
  ): ConversationReadState {
    return {
      ...state,
      throughMessageId: this.#conversations.supportedConversationCursor(threadId, state.throughMessageId, options),
    };
  }

  /**
   * What changes with every write to the rows of a thread. Null when versions cannot key the cache
   * now (see `versionsAreFinal`).
   */
  threadVersion(threadId: string): string | null {
    if (!this.#versionsAreFinal()) return null;
    const row = this.#core.connection
      .prepare("SELECT last_event_sequence, updated_at FROM projection_threads WHERE thread_id = ?")
      .get(threadId);
    if (!isDynamicRecord(row) || !isNumber(row.last_event_sequence) || !isString(row.updated_at)) return null;
    return `${row.last_event_sequence}\u0000${row.updated_at}`;
  }

  #remember(key: string, version: string, state: ConversationReadState): void {
    this.#cache.delete(key);
    this.#cache.set(key, { version, state: { ...state } });
    if (this.#cache.size > READ_STATE_CACHE_LIMIT) {
      const oldest = this.#cache.keys().next().value;
      if (oldest !== undefined) this.#cache.delete(oldest);
    }
  }

  /**
   * The unread query, compiled once for each connection: it is long, and compiling it took about as
   * long as running it, once for each agent of a list.
   */
  #prepared(sql: string): StatementSync {
    const connection = this.#core.connection;
    let statements = this.#statements.get(connection);
    if (!statements) {
      statements = new Map();
      this.#statements.set(connection, statements);
    }
    let statement = statements.get(sql);
    if (!statement) {
      statement = connection.prepare(sql);
      statements.set(sql, statement);
    }
    return statement;
  }

  storedCursor(threadId: string, memberId: string): string | null | undefined {
    const row = this.#core.connection
      .prepare(
        `SELECT through_message_id FROM projection_thread_reads
         WHERE thread_id = ? AND member_id = ?`,
      )
      .get(threadId, memberId);
    if (row === undefined) return undefined;
    if (!isDynamicRecord(row)) {
      throw new Error("The stored conversation read state is malformed.");
    }
    const value = row.through_message_id;
    if (value === null || isString(value)) return value;
    throw new Error("The stored conversation read cursor is malformed.");
  }

  messageExists(threadId: string, messageId: string): boolean {
    return Boolean(
      this.#core.connection
        .prepare(
          `SELECT 1 FROM projection_thread_messages
           WHERE thread_id = ? AND message_id = ? LIMIT 1`,
        )
        .get(threadId, messageId),
    );
  }

  /** Where a message is in the shown order, which pages use too: a cursor is read through what was shown. */
  messageOrderKey(threadId: string, messageId: string): MessageOrderKey | undefined {
    const row = this.#core.connection
      .prepare(
        `${ORDERED_THREAD_MESSAGES}
         SELECT ${ORDER_KEY_COLUMNS} FROM ordered WHERE message_id = ?`,
      )
      .get(threadId, messageId);
    if (row === undefined) return undefined;
    if (
      !isDynamicRecord(row) ||
      !isString(row.group_start) ||
      !isNumber(row.group_first) ||
      !isString(row.group_id) ||
      !isNumber(row.turn_rank) ||
      !isString(row.created_at) ||
      !isNumber(row.ordinal) ||
      !isString(row.message_id)
    ) {
      throw new Error("The conversation message order is malformed.");
    }
    return [row.group_start, row.group_first, row.group_id, row.turn_rank, row.created_at, row.ordinal, row.message_id];
  }

  isAfter(threadId: string, candidateMessageId: string, boundary: MessageOrderKey | undefined): boolean {
    if (!boundary) return false;
    return Boolean(
      this.#core.connection
        .prepare(
          `${ORDERED_THREAD_MESSAGES}
           SELECT 1 FROM ordered
           WHERE message_id = ? AND (${ORDER_KEY_COLUMNS}) > (?, ?, ?, ?, ?, ?, ?)`,
        )
        .get(threadId, candidateMessageId, ...boundary),
    );
  }

  latestMessageId(threadId: string): string | null {
    const row = this.#core.connection
      .prepare(
        `${ORDERED_THREAD_MESSAGES}
         SELECT message_id FROM ordered ORDER BY ${ORDER_KEY_DESC} LIMIT 1`,
      )
      .get(threadId);
    if (row === undefined) return null;
    if (!isDynamicRecord(row) || !isString(row.message_id)) {
      throw new Error("The latest conversation message is malformed.");
    }
    return row.message_id;
  }

  migrationCursor(threadId: string): string | null {
    const row = this.#core.connection
      .prepare(
        `SELECT through_message_id FROM projection_thread_read_baselines
         WHERE thread_id = ?`,
      )
      .get(threadId);
    if (row === undefined) return null;
    if (!isDynamicRecord(row)) {
      throw new Error("The conversation read baseline is malformed.");
    }
    const value = row.through_message_id;
    if (value === null || isString(value)) return value;
    throw new Error("The conversation read baseline cursor is malformed.");
  }

  stateFromDatabase(threadId: string, throughMessageId: string | null): ConversationReadState {
    const boundaryKey = throughMessageId ? this.messageOrderKey(threadId, throughMessageId) : undefined;
    const afterBoundary = boundaryKey ? `AND (${ORDER_KEY_COLUMNS}) > (?, ?, ?, ?, ?, ?, ?)` : "";
    const parameters = boundaryKey ? [threadId, ...boundaryKey] : [threadId];
    const unreadFilter = `author != 'user'
      AND COALESCE(item_type, '') != 'commentary'
      AND COALESCE(item_type, '') != 'plan'
      AND COALESCE(item_type, '') != 'subagents'
      AND COALESCE(item_type, '') != '${CONVERSATION_MEMORY_CHANGES_ITEM_TYPE}'
      AND COALESCE(item_type, '') != '${ROUTINE_QUIET_ANSWER_ITEM_TYPE}'
      AND COALESCE(item_type, '') != 'agent_attachment'
      AND COALESCE(item_type, '') NOT LIKE '${CHAT_VISUAL_ITEM_TYPE_PREFIX}%'
      AND COALESCE(item_type, '') != '${AGENT_EXCHANGE_ITEM_TYPE}'
      AND COALESCE(item_type, '') NOT LIKE '${SKILL_EVENT_ITEM_TYPE_PREFIX}%' AND COALESCE(item_type, '') NOT LIKE '${ROUTINE_EVENT_ITEM_TYPE_PREFIX}%'
      AND COALESCE(item_type, '') NOT LIKE '${ROUTINE_RUN_EVENT_ITEM_TYPE_PREFIX}%' AND COALESCE(item_type, '') NOT LIKE '${EVENT_CHECK_ITEM_TYPE_PREFIX}%'
      AND COALESCE(item_type, '') NOT LIKE '${HOSTED_SITE_EVENT_ITEM_TYPE_PREFIX}%'
      AND COALESCE(item_type, '') NOT LIKE '${MARKETPLACE_SUGGESTION_ITEM_TYPE_PREFIX}%'
      AND COALESCE(item_type, '') NOT LIKE '${MODEL_SWITCH_ITEM_TYPE_PREFIX}%'
      AND COALESCE(item_type, '') NOT LIKE '${SYSTEM_NOTICE_ITEM_TYPE_PREFIX}%'
      AND COALESCE(item_type, '') != '${CONTEXT_RESET_ITEM_TYPE}'
      AND NOT (
        author = 'assistant' AND turn_id IS NOT NULL
        AND COALESCE(item_type, '') NOT IN ('${OWNER_MESSAGE_ITEM_TYPE}', 'question_prompt')
        AND ${backgroundTurn("ordered.turn_id")}
      )`;
    // One pass over the ordered thread: the first unread row carries the count of all of them.
    const firstRow = this.#prepared(
      `${ORDERED_THREAD_MESSAGES}
         SELECT message_id, COUNT(*) OVER () AS unread_count FROM ordered
         WHERE 1 = 1 ${afterBoundary} AND ${unreadFilter}
         ORDER BY ${ORDER_KEY_COLUMNS} LIMIT 1`,
    ).get(...parameters);
    if (firstRow === undefined) return { unreadCount: 0, firstUnreadMessageId: null, throughMessageId };
    if (!isDynamicRecord(firstRow) || !isString(firstRow.message_id) || !isNumber(firstRow.unread_count)) {
      throw new Error("The conversation unread count is malformed.");
    }
    return {
      unreadCount: firstRow.unread_count,
      firstUnreadMessageId: firstRow.message_id,
      throughMessageId,
    };
  }
}

/**
 * The turns of a person's request chain in the thread that `ordered` reads, as `ownerChainTurns` in
 * `@openbot/contracts/owner-conversation`: each turn that a person's own message (not a routine run)
 * started, and each turn that a teammate's report started that answers (`replyToMessageId`) a request
 * that OpenBot sent (`messageId`) in a turn of the chain, at any depth.
 *
 * It names no outer row, so SQLite reads it once for a statement, not once for each unread row.
 */
const OWNER_CHAIN_TURNS = `WITH RECURSIVE links AS MATERIALIZED (
    SELECT exchange.turn_id, exchange.author,
      json_extract(stored.message_json, '$.exchange.messageId') AS exchange_id,
      json_extract(stored.message_json, '$.exchange.replyToMessageId') AS reply_to,
      json_extract(stored.message_json, '$.exchange.expectsReply') AS expects_reply
    FROM ordered exchange
    JOIN projection_thread_messages stored ON stored.thread_id = exchange.thread_id AND stored.message_id = exchange.message_id
    WHERE exchange.item_type = '${AGENT_EXCHANGE_ITEM_TYPE}' AND exchange.turn_id IS NOT NULL
  ), chain(turn_id) AS (
    SELECT asked.turn_id FROM ordered asked
    JOIN projection_thread_messages person ON person.thread_id = asked.thread_id AND person.message_id = asked.message_id
    WHERE asked.author = 'user' AND asked.turn_id IS NOT NULL
      AND COALESCE(asked.item_type, '') != 'routine' AND COALESCE(asked.item_type, '') NOT LIKE '${SYSTEM_NOTICE_ITEM_TYPE_PREFIX}%'
      AND COALESCE(json_extract(person.message_json, '$.source'), 'user') != 'routine'
    UNION
    SELECT report.turn_id FROM chain
    JOIN links request ON request.turn_id = chain.turn_id AND request.author != 'agent'
    JOIN links report ON report.author = 'agent' AND report.expects_reply = 0
      AND report.reply_to = request.exchange_id AND report.turn_id != request.turn_id
  )
  SELECT turn_id FROM chain`;

/**
 * The test that the turn `turn` (an SQL expression) of the thread that `ordered` reads is the agent's
 * own activity, by the rule of `backgroundTurns` with whole turns (`@openbot/contracts/owner-conversation`):
 * no person wrote in it, the agent wrote nothing in it to the owner on purpose and asked them nothing,
 * and it is not a teammate's report of a person's request chain (`OWNER_CHAIN_TURNS`) that the agent
 * passes on to the person. A report stays the agent's own in a turn that a teammate's request also
 * started, or when OpenBot sent the answer on to an agent (an outgoing exchange with the answer's text).
 * A message stored before the exchange summary counts as a request.
 *
 * The tests of the turn's own rows read them through the turn index.
 */
function backgroundTurn(turn: string): string {
  return `(NOT EXISTS (
      SELECT 1 FROM ordered person WHERE person.turn_id = ${turn} AND person.author = 'user'
        AND COALESCE(person.item_type, '') != 'routine' AND COALESCE(person.item_type, '') NOT LIKE '${SYSTEM_NOTICE_ITEM_TYPE_PREFIX}%'
    ) AND NOT EXISTS (
      SELECT 1 FROM ordered addressed WHERE addressed.turn_id = ${turn}
        AND addressed.item_type IN ('${OWNER_MESSAGE_ITEM_TYPE}', 'question_prompt')
    ) AND (
      EXISTS (
        SELECT 1 FROM ordered exchange
        JOIN projection_thread_messages stored ON stored.thread_id = exchange.thread_id AND stored.message_id = exchange.message_id
        WHERE exchange.turn_id = ${turn} AND exchange.item_type = '${AGENT_EXCHANGE_ITEM_TYPE}' AND (
          (exchange.author = 'agent' AND COALESCE(json_extract(stored.message_json, '$.exchange.expectsReply'), 1) != 0)
          OR (exchange.author != 'agent' AND EXISTS (
            SELECT 1 FROM ordered answer
            JOIN projection_thread_messages said ON said.thread_id = answer.thread_id AND said.message_id = answer.message_id
            WHERE answer.turn_id = exchange.turn_id AND answer.author = 'assistant' AND COALESCE(answer.item_type, 'agentMessage') = 'agentMessage'
              AND trim(json_extract(said.message_json, '$.text')) = trim(json_extract(stored.message_json, '$.text'))
          ))
        )
      )
      OR ${turn} NOT IN (${OWNER_CHAIN_TURNS})
    ))`;
}

/**
 * Whether a turn of the thread is the agent's own activity (`backgroundTurn`). A turn that completes with this tells nothing: no "Finished"
 * notification, sound or push, as it adds nothing unread.
 */
export function isBackgroundTurn(database: { readonly connection: DatabaseSync }, threadId: string, turnId: string) {
  return (
    database.connection
      .prepare(
        `${ORDERED_THREAD_MESSAGES}
         SELECT 1 WHERE ${backgroundTurn("?2")}`,
      )
      .get(threadId, turnId) !== undefined
  );
}

/** The shown-order key of a message: its group's start, first ordinal and id, its rank in the turn, then its own time, ordinal and id. */
export type MessageOrderKey = [
  groupStart: string,
  groupFirst: number,
  groupId: string,
  turnRank: number,
  createdAt: string,
  ordinal: number,
  messageId: string,
];

function readStateCacheKey(threadId: string, cursor: string | null, options: ConversationMarkerExclusions): string {
  const exclusions = [
    options.excludeRoutineEvents,
    options.excludeRoutineRunEvents,
    options.excludeHostedSiteEvents,
    options.excludeRoutineQuietAnswers,
    options.excludeEventCheckEvents,
  ]
    .map((value) => (value ? "1" : "0"))
    .join("");
  return `${threadId}\u0000${cursor ?? ""}\u0000${cursor === null ? "none" : "cursor"}\u0000${exclusions}`;
}
