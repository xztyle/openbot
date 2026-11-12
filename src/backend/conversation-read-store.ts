import { randomUUID } from "node:crypto";
import { CHAT_VISUAL_ITEM_TYPE_PREFIX } from "@openbot/contracts/chat-visual";
import { EVENT_CHECK_ITEM_TYPE_PREFIX } from "@openbot/contracts/event-checks";
import {
  AGENT_EXCHANGE_ITEM_TYPE,
  type AgentSummary,
  CONTEXT_RESET_ITEM_TYPE,
  CONVERSATION_MEMORY_CHANGES_ITEM_TYPE,
  CONVERSATION_PLAN_ITEM_TYPE,
  CONVERSATION_SUBAGENTS_ITEM_TYPE,
  type ConversationReadState,
  type ConversationSnapshot,
  HOSTED_SITE_EVENT_ITEM_TYPE_PREFIX,
  MARKETPLACE_SUGGESTION_ITEM_TYPE_PREFIX,
  MODEL_SWITCH_ITEM_TYPE_PREFIX,
  ROUTINE_EVENT_ITEM_TYPE_PREFIX,
  ROUTINE_QUIET_ANSWER_ITEM_TYPE,
  ROUTINE_RUN_EVENT_ITEM_TYPE_PREFIX,
  SKILL_EVENT_ITEM_TYPE_PREFIX,
} from "@openbot/contracts/ipc";
import { isDynamicRecord, isNumber, isString } from "@openbot/contracts/runtime-values";
import { sourceText } from "@openbot/i18n/source";
import {
  type ConversationMarkerExclusions,
  ORDER_KEY_COLUMNS,
  ORDER_KEY_DESC,
  ORDERED_THREAD_MESSAGES,
} from "./database/conversation-queries";
import type { OpenBotDatabase } from "./openbot-database";

export type { ConversationMarkerExclusions } from "./database/conversation-queries";

export class ConversationReadStore {
  constructor(readonly database: OpenBotDatabase) {}

  listStates(
    memberId: string,
    agents: AgentSummary[],
    options: ConversationMarkerExclusions = {},
  ): Record<string, ConversationReadState> {
    return Object.fromEntries(
      agents.map((agent) => [agent.id, this.readStateForThread(memberId, agent.threadId, options)]),
    );
  }

  readStateForThread(
    memberId: string,
    threadId: string | null,
    options: ConversationMarkerExclusions = {},
  ): ConversationReadState {
    if (!threadId) return emptyReadState();
    const stored = this.#storedCursor(threadId, memberId);
    let state: ConversationReadState;
    if (stored === undefined) {
      const baseline = this.#migrationCursor(threadId);
      const initialCursor =
        baseline && !this.#messageExists(threadId, baseline) ? this.#latestMessageId(threadId) : baseline;
      this.#saveCursor(threadId, memberId, initialCursor, "initialized");
      state = this.#stateFromDatabase(threadId, initialCursor);
    } else if (stored !== null && !this.#messageExists(threadId, stored)) {
      const latestMessageId = this.#latestMessageId(threadId);
      this.#saveCursor(threadId, memberId, latestMessageId, "initialized");
      state = this.#stateFromDatabase(threadId, latestMessageId);
    } else {
      state = this.#stateFromDatabase(threadId, stored);
    }
    return this.#withSupportedCursor(threadId, state, options);
  }

  adoptMemberState(sourceMemberId: string, targetMemberId: string): void {
    if (sourceMemberId === targetMemberId) return;
    const rows = this.database.connection
      .prepare(
        `SELECT thread_id, through_message_id FROM projection_thread_reads
         WHERE member_id = ?`,
      )
      .all(sourceMemberId);
    if (!Array.isArray(rows)) throw new Error("The conversation read states are malformed.");
    for (const value of rows) {
      if (!isDynamicRecord(value) || !isString(value.thread_id)) {
        throw new Error("The conversation read state is malformed.");
      }
      const cursor = value.through_message_id;
      if (cursor !== null && !isString(cursor)) {
        throw new Error("The conversation read cursor is malformed.");
      }
      if (this.#storedCursor(value.thread_id, targetMemberId) === undefined) {
        this.#saveCursor(value.thread_id, targetMemberId, cursor, "initialized");
      }
    }
  }

  readState(memberId: string, snapshot: ConversationSnapshot): ConversationReadState {
    if (!snapshot.threadId) return emptyReadState();
    const stored = this.#storedCursor(snapshot.threadId, memberId);
    if (stored === undefined) {
      const baseline = this.#migrationCursor(snapshot.threadId);
      const initialCursor =
        baseline && !snapshot.messages.some((message) => message.id === baseline)
          ? (snapshot.messages.at(-1)?.id ?? null)
          : baseline;
      return this.#initialize(memberId, snapshot, initialCursor);
    }
    if (stored !== null && !snapshot.messages.some((message) => message.id === stored)) {
      return this.#initialize(memberId, snapshot, snapshot.messages.at(-1)?.id ?? null);
    }
    return stateFromSnapshot(snapshot, stored);
  }

  markRead(
    memberId: string,
    snapshot: ConversationSnapshot,
    throughMessageId: string | null,
    options: ConversationMarkerExclusions = {},
  ): ConversationReadState {
    if (!snapshot.threadId) return emptyReadState();
    const requestedIndex = throughMessageId
      ? snapshot.messages.findIndex((message) => message.id === throughMessageId)
      : -1;
    if (throughMessageId && requestedIndex < 0) {
      throw new Error(sourceText("error.backend.readBoundaryUnavailable"));
    }
    const stored = this.#storedCursor(snapshot.threadId, memberId);
    const storedIndex = stored ? snapshot.messages.findIndex((message) => message.id === stored) : -1;
    const nextThroughMessageId = storedIndex > requestedIndex ? (stored ?? null) : (throughMessageId ?? null);
    this.#saveCursor(snapshot.threadId, memberId, nextThroughMessageId, "marked");
    return this.#withSupportedCursor(snapshot.threadId, stateFromSnapshot(snapshot, nextThroughMessageId), options);
  }

  /**
   * Marks a database boundary without loading the thread messages. The public conversation reader
   * uses this for marker actions because a marker can target a message older than the working
   * cache. The ordering key keeps the monotonic cursor rule from the snapshot implementation.
   */
  markReadForThread(
    memberId: string,
    threadId: string | null,
    throughMessageId: string | null,
    options: ConversationMarkerExclusions = {},
  ): ConversationReadState {
    if (!threadId) return emptyReadState();
    const requestedKey = throughMessageId ? this.#messageOrderKey(threadId, throughMessageId) : undefined;
    // A device can name a message the thread does not hold: a queued message that is not saved yet,
    // or one that was cancelled or removed. The cursor stays, and the next mark moves it.
    if (throughMessageId && !requestedKey) return this.readStateForThread(memberId, threadId, options);
    const stored = this.#storedCursor(threadId, memberId);
    let nextThroughMessageId = throughMessageId;
    if (stored && (!throughMessageId || this.#isAfter(threadId, stored, requestedKey))) {
      nextThroughMessageId = stored;
    }
    this.#saveCursor(threadId, memberId, nextThroughMessageId, "marked");
    return this.#withSupportedCursor(threadId, this.#stateFromDatabase(threadId, nextThroughMessageId), options);
  }

  markUnread(memberId: string, snapshot: ConversationSnapshot): ConversationReadState {
    if (!snapshot.threadId) return emptyReadState();
    // Explicit user action only. Ordinary read acknowledgements remain monotonic.
    this.#saveCursor(snapshot.threadId, memberId, null, "marked");
    return stateFromSnapshot(snapshot, null);
  }

  /** Marks a thread unread without reading its message rows. */
  markUnreadForThread(memberId: string, threadId: string | null): ConversationReadState {
    if (!threadId) return emptyReadState();
    this.#saveCursor(threadId, memberId, null, "marked");
    return this.#stateFromDatabase(threadId, null);
  }

  #withSupportedCursor(
    threadId: string,
    state: ConversationReadState,
    options: ConversationMarkerExclusions,
  ): ConversationReadState {
    return {
      ...state,
      throughMessageId: this.database.supportedConversationCursor(threadId, state.throughMessageId, options),
    };
  }

  #storedCursor(threadId: string, memberId: string): string | null | undefined {
    const row = this.database.connection
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

  #messageExists(threadId: string, messageId: string): boolean {
    return Boolean(
      this.database.connection
        .prepare(
          `SELECT 1 FROM projection_thread_messages
           WHERE thread_id = ? AND message_id = ? LIMIT 1`,
        )
        .get(threadId, messageId),
    );
  }

  /** Where a message is in the shown order, which pages use too: a cursor is read through what was shown. */
  #messageOrderKey(threadId: string, messageId: string): MessageOrderKey | undefined {
    const row = this.database.connection
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

  #isAfter(threadId: string, candidateMessageId: string, boundary: MessageOrderKey | undefined): boolean {
    if (!boundary) return false;
    return Boolean(
      this.database.connection
        .prepare(
          `${ORDERED_THREAD_MESSAGES}
           SELECT 1 FROM ordered
           WHERE message_id = ? AND (${ORDER_KEY_COLUMNS}) > (?, ?, ?, ?, ?, ?, ?)`,
        )
        .get(threadId, candidateMessageId, ...boundary),
    );
  }

  #latestMessageId(threadId: string): string | null {
    const row = this.database.connection
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

  #stateFromDatabase(threadId: string, throughMessageId: string | null): ConversationReadState {
    const boundaryKey = throughMessageId ? this.#messageOrderKey(threadId, throughMessageId) : undefined;
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
      AND COALESCE(item_type, '') != '${CONTEXT_RESET_ITEM_TYPE}'
      AND NOT (
        author = 'assistant' AND turn_id IS NOT NULL
        AND turn_id IN (${AGENT_TALK_TURNS})
        AND turn_id NOT IN (SELECT turn_id FROM ordered WHERE author = 'user' AND turn_id IS NOT NULL)
      )`;
    // One pass over the ordered thread: the first unread row carries the count of all of them.
    const firstRow = this.database.connection
      .prepare(
        `${ORDERED_THREAD_MESSAGES}
         SELECT message_id, COUNT(*) OVER () AS unread_count FROM ordered
         WHERE 1 = 1 ${afterBoundary} AND ${unreadFilter}
         ORDER BY ${ORDER_KEY_COLUMNS} LIMIT 1`,
      )
      .get(...parameters);
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

  #migrationCursor(threadId: string): string | null {
    const row = this.database.connection
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

  #initialize(
    memberId: string,
    snapshot: ConversationSnapshot,
    throughMessageId: string | null,
  ): ConversationReadState {
    if (!snapshot.threadId) return emptyReadState();
    this.#saveCursor(snapshot.threadId, memberId, throughMessageId, "initialized");
    return stateFromSnapshot(snapshot, throughMessageId);
  }

  #saveCursor(
    threadId: string,
    memberId: string,
    throughMessageId: string | null,
    event: "initialized" | "marked",
  ): void {
    if (this.#storedCursor(threadId, memberId) === throughMessageId) return;
    const updatedAt = new Date().toISOString();
    this.database.dispatch(
      // A cursor can be visited again after an explicit mark-unread. Do not reuse
      // an old command receipt and silently skip the next read/unread transition.
      `thread-read:${event}:${threadId}:${memberId}:${randomUUID()}`,
      [
        {
          aggregateType: "thread-read",
          aggregateId: `${threadId}:${memberId}`,
          eventType: `thread-read.${event}`,
          payload: { threadId, memberId, throughMessageId },
          occurredAt: updatedAt,
        },
      ],
      (db) => {
        db.prepare(
          `INSERT INTO projection_thread_reads (
             thread_id, member_id, through_message_id, updated_at
           ) VALUES (?, ?, ?, ?)
           ON CONFLICT(thread_id, member_id) DO UPDATE SET
             through_message_id = excluded.through_message_id,
             updated_at = excluded.updated_at`,
        ).run(threadId, memberId, throughMessageId, updatedAt);
        return null;
      },
    );
  }
}

/**
 * The turns of the agent's talk with another agent: no person wrote in them, and their answer is not
 * for the person who reads the chat, because another agent's request started the turn, OpenBot sent
 * the answer on to an agent, or a teammate's report started it that does not answer a request the
 * agent sent while it worked on a person's own message (not a routine run). A report that does answer
 * such a request, and whose answer goes nowhere else, is the agent telling the person, so it counts.
 * The same rule as `AGENT_TALK_TURNS` and the renderer's `agentOnlyTurns`.
 */
/**
 * The turns, of the thread that `ordered` reads, whose answer is not for the person: an agent's
 * request started them, a teammate's report started them that does not answer a request sent in a
 * turn a person's own message (not a routine run) started, or OpenBot sent the answer on to an agent (an outgoing
 * exchange with the answer's text). A message stored before the exchange summary counts as a request.
 */
const AGENT_TALK_TURNS = `SELECT exchange.turn_id FROM ordered exchange
  JOIN projection_thread_messages stored ON stored.thread_id = exchange.thread_id AND stored.message_id = exchange.message_id
  WHERE exchange.item_type = '${AGENT_EXCHANGE_ITEM_TYPE}' AND exchange.turn_id IS NOT NULL AND (
    (exchange.author = 'agent' AND COALESCE(json_extract(stored.message_json, '$.exchange.expectsReply'), 1) != 0)
    OR (exchange.author = 'agent' AND NOT EXISTS (
      SELECT 1 FROM ordered request
      JOIN projection_thread_messages sent ON sent.thread_id = request.thread_id AND sent.message_id = request.message_id
      WHERE request.item_type = '${AGENT_EXCHANGE_ITEM_TYPE}' AND request.author != 'agent' AND request.turn_id IS NOT NULL
        AND json_extract(sent.message_json, '$.exchange.messageId') = json_extract(stored.message_json, '$.exchange.replyToMessageId')
        AND request.turn_id IN (
          SELECT asked.turn_id FROM ordered asked
          JOIN projection_thread_messages person ON person.thread_id = asked.thread_id AND person.message_id = asked.message_id
          WHERE asked.author = 'user' AND asked.turn_id IS NOT NULL
            AND COALESCE(json_extract(person.message_json, '$.source'), 'user') != 'routine'
        )
    ))
    OR (exchange.author != 'agent' AND EXISTS (
      SELECT 1 FROM ordered answer
      JOIN projection_thread_messages said ON said.thread_id = answer.thread_id AND said.message_id = answer.message_id
      WHERE answer.turn_id = exchange.turn_id AND answer.author = 'assistant' AND COALESCE(answer.item_type, 'agentMessage') = 'agentMessage'
        AND trim(json_extract(said.message_json, '$.text')) = trim(json_extract(stored.message_json, '$.text'))
    ))
  )`;

function agentOnlyTurns(messages: ConversationSnapshot["messages"]): Set<string> {
  const talk = new Set<string>();
  const reports = new Map<string, string | null>();
  const answers = new Map<string, Set<string>>();
  const forwarded = new Map<string, string[]>();
  const requestTurns = new Map<string, string>();
  const fromPerson = new Set<string>();
  // A person's own message, not a routine run's: only work a person asked for reports to them.
  const personAsked = new Set<string>();
  for (const message of messages) {
    const turnId = message.turnId;
    if (!turnId) continue;
    if (message.author === "user") fromPerson.add(turnId);
    if (message.author === "user" && message.source !== "routine") personAsked.add(turnId);
    if (message.itemType === AGENT_EXCHANGE_ITEM_TYPE) {
      // A message stored before the exchange summary counts as a request, as it did before.
      const direction = message.exchange?.direction ?? (message.author === "agent" ? "incoming" : "outgoing");
      if (direction === "incoming") {
        if (message.exchange?.expectsReply === false) {
          if (!reports.has(turnId)) reports.set(turnId, message.exchange.replyToMessageId);
        } else talk.add(turnId);
      } else {
        forwarded.set(turnId, [...(forwarded.get(turnId) ?? []), message.text.trim()]);
        if (message.exchange) requestTurns.set(message.exchange.messageId, turnId);
      }
    } else if (message.author === "assistant" && (!message.itemType || message.itemType === "agentMessage"))
      answers.set(turnId, (answers.get(turnId) ?? new Set()).add(message.text.trim()));
  }
  for (const [turnId, replyTo] of reports) {
    const said = answers.get(turnId);
    const sentOn = Boolean(said && (forwarded.get(turnId) ?? []).some((text) => said.has(text)));
    const requestTurn = replyTo ? requestTurns.get(replyTo) : undefined;
    if (sentOn || requestTurn === undefined || !personAsked.has(requestTurn)) talk.add(turnId);
  }
  for (const turnId of fromPerson) talk.delete(turnId);
  return talk;
}

function stateFromSnapshot(snapshot: ConversationSnapshot, throughMessageId: string | null): ConversationReadState {
  const throughIndex = throughMessageId
    ? snapshot.messages.findIndex((message) => message.id === throughMessageId)
    : -1;
  const agentTurns = agentOnlyTurns(snapshot.messages);
  const unread = snapshot.messages
    .slice(throughIndex + 1)
    .filter(
      (message) =>
        message.author !== "user" &&
        !(message.author === "assistant" && message.turnId !== undefined && agentTurns.has(message.turnId)) &&
        message.itemType !== "commentary" &&
        message.itemType !== CONVERSATION_PLAN_ITEM_TYPE &&
        message.itemType !== CONVERSATION_SUBAGENTS_ITEM_TYPE &&
        message.itemType !== CONVERSATION_MEMORY_CHANGES_ITEM_TYPE &&
        message.itemType !== ROUTINE_QUIET_ANSWER_ITEM_TYPE &&
        message.itemType !== "agent_attachment" &&
        !message.itemType?.startsWith(CHAT_VISUAL_ITEM_TYPE_PREFIX) &&
        message.itemType !== AGENT_EXCHANGE_ITEM_TYPE &&
        !message.itemType?.startsWith(SKILL_EVENT_ITEM_TYPE_PREFIX) &&
        !message.itemType?.startsWith(EVENT_CHECK_ITEM_TYPE_PREFIX) &&
        !message.itemType?.startsWith(ROUTINE_EVENT_ITEM_TYPE_PREFIX) &&
        !message.itemType?.startsWith(ROUTINE_RUN_EVENT_ITEM_TYPE_PREFIX) &&
        !message.itemType?.startsWith(HOSTED_SITE_EVENT_ITEM_TYPE_PREFIX) &&
        !message.itemType?.startsWith(MARKETPLACE_SUGGESTION_ITEM_TYPE_PREFIX) &&
        !message.itemType?.startsWith(MODEL_SWITCH_ITEM_TYPE_PREFIX) &&
        message.itemType !== CONTEXT_RESET_ITEM_TYPE,
    );
  return {
    unreadCount: unread.length,
    firstUnreadMessageId: unread[0]?.id ?? null,
    throughMessageId,
  };
}

/** The shown-order key of a message: its group's start, first ordinal and id, its rank in the turn, then its own time, ordinal and id. */
type MessageOrderKey = [
  groupStart: string,
  groupFirst: number,
  groupId: string,
  turnRank: number,
  createdAt: string,
  ordinal: number,
  messageId: string,
];

function emptyReadState(): ConversationReadState {
  return { unreadCount: 0, firstUnreadMessageId: null, throughMessageId: null };
}
