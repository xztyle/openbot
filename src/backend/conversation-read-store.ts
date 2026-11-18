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
  SYSTEM_NOTICE_ITEM_TYPE_PREFIX,
} from "@openbot/contracts/ipc";
import { isDynamicRecord, isString } from "@openbot/contracts/runtime-values";
import { sourceText } from "@openbot/i18n/source";
import type { ConversationMarkerExclusions } from "./database/conversation-queries";
import { type ReadLookups, ThreadReadStates } from "./database/thread-read-states";
import type { OpenBotDatabase } from "./openbot-database";

export type { ConversationMarkerExclusions } from "./database/conversation-queries";
export { isAgentTalkTurn } from "./database/thread-read-states";

/**
 * Each member's read cursor of each thread and the state it gives: the unread count and the first
 * unread message. The reads and their cache are `ThreadReadStates`; this store owns the cursor writes,
 * which only the main connection makes.
 */
export class ConversationReadStore {
  /** The reads and the cache of computed states; this store adds the cursor writes. */
  readonly states: ThreadReadStates;

  constructor(readonly database: OpenBotDatabase) {
    this.states = new ThreadReadStates({
      core: database,
      conversations: database,
      versionsAreFinal: () => !database.connection.isTransaction,
    });
  }

  listStates(
    memberId: string,
    agents: AgentSummary[],
    options: ConversationMarkerExclusions = {},
  ): Record<string, ConversationReadState> {
    // The member's cursors and the thread versions, each in one query: the app reads every chat's
    // state after each change in a chat, and two queries for each chat took most of a read.
    const lookups = this.states.lookups(memberId);
    return Object.fromEntries(
      agents.map((agent) => [agent.id, this.readStateForThread(memberId, agent.threadId, options, lookups)]),
    );
  }

  readStateForThread(
    memberId: string,
    threadId: string | null,
    options: ConversationMarkerExclusions = {},
    lookups?: ReadLookups,
  ): ConversationReadState {
    if (!threadId) return emptyReadState();
    const known = this.states.knownState(memberId, threadId, options, lookups);
    if (known) return known;
    // The cursor must be written first: none is stored yet, or the thread no longer holds its message.
    const stored = lookups ? lookups.cursors.get(threadId) : this.states.storedCursor(threadId, memberId);
    let cursor: string | null;
    if (stored === undefined) {
      const baseline = this.states.migrationCursor(threadId);
      cursor =
        baseline && !this.states.messageExists(threadId, baseline) ? this.states.latestMessageId(threadId) : baseline;
    } else cursor = this.states.latestMessageId(threadId);
    this.#saveCursor(threadId, memberId, cursor, "initialized");
    return this.states.withSupportedCursor(threadId, this.states.stateFromDatabase(threadId, cursor), options);
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
      if (this.states.storedCursor(value.thread_id, targetMemberId) === undefined) {
        this.#saveCursor(value.thread_id, targetMemberId, cursor, "initialized");
      }
    }
  }

  readState(memberId: string, snapshot: ConversationSnapshot): ConversationReadState {
    if (!snapshot.threadId) return emptyReadState();
    const stored = this.states.storedCursor(snapshot.threadId, memberId);
    if (stored === undefined) {
      const baseline = this.states.migrationCursor(snapshot.threadId);
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
    const stored = this.states.storedCursor(snapshot.threadId, memberId);
    const storedIndex = stored ? snapshot.messages.findIndex((message) => message.id === stored) : -1;
    const nextThroughMessageId = storedIndex > requestedIndex ? (stored ?? null) : (throughMessageId ?? null);
    this.#saveCursor(snapshot.threadId, memberId, nextThroughMessageId, "marked");
    return this.states.withSupportedCursor(
      snapshot.threadId,
      stateFromSnapshot(snapshot, nextThroughMessageId),
      options,
    );
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
    const requestedKey = throughMessageId ? this.states.messageOrderKey(threadId, throughMessageId) : undefined;
    // A device can name a message the thread does not hold: a queued message that is not saved yet,
    // or one that was cancelled or removed. The cursor stays, and the next mark moves it.
    if (throughMessageId && !requestedKey) return this.readStateForThread(memberId, threadId, options);
    const stored = this.states.storedCursor(threadId, memberId);
    let nextThroughMessageId = throughMessageId;
    if (stored && (!throughMessageId || this.states.isAfter(threadId, stored, requestedKey))) {
      nextThroughMessageId = stored;
    }
    this.#saveCursor(threadId, memberId, nextThroughMessageId, "marked");
    return this.states.withSupportedCursor(
      threadId,
      this.states.stateFromDatabase(threadId, nextThroughMessageId),
      options,
    );
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
    return this.states.stateFromDatabase(threadId, null);
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
    if (this.states.storedCursor(threadId, memberId) === throughMessageId) return;
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
        !message.itemType?.startsWith(SYSTEM_NOTICE_ITEM_TYPE_PREFIX) &&
        message.itemType !== CONTEXT_RESET_ITEM_TYPE,
    );
  return {
    unreadCount: unread.length,
    firstUnreadMessageId: unread[0]?.id ?? null,
    throughMessageId,
  };
}

function emptyReadState(): ConversationReadState {
  return { unreadCount: 0, firstUnreadMessageId: null, throughMessageId: null };
}
