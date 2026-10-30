import type { ConversationMessage } from "@openbot/contracts/ipc";
import type { DatabaseCore } from "./database-core";
import {
  databaseRow,
  databaseRows,
  decodeConversationMessageJson,
  optionalNumberColumn,
  optionalStringColumn,
  placeholders,
  requiredNumberColumn,
  requiredStringColumn,
} from "./database-rows";

export interface WorkspaceQueriesOptions {
  core: DatabaseCore;
}

/** One turn, with the agent whose thread ran it. */
export interface WorkspaceTurnRow {
  turnId: string;
  threadId: string;
  agentId: string;
  status: string;
  startedAt: string;
  completedAt: string | null;
}

/** One message of an agent's own conversation (its chat, a task, a messaging thread) that can hold an artifact. */
export interface WorkspaceThreadMessageRow {
  rowId: number;
  threadId: string;
  agentId: string;
  status: string;
  message: ConversationMessage;
}

/** Two agents that sent each other messages. Times are ISO strings, as stored. */
export interface WorkspaceAgentPairRow {
  agentIds: [string, string];
  count: number;
  lastAt: string;
  lastSenderId: string;
  lastText: string;
}

/** One message from an agent to other agents. */
export interface WorkspaceAgentExchangeRow {
  id: string;
  senderAgentId: string;
  recipientAgentIds: string[];
  text: string;
  createdAt: string;
  replyToMessageId: string | null;
  attachmentCount: number;
}

/**
 * The reads of the workspace fleet, step trail and artifact views: today's usage and turn times of
 * each agent, one turn and its messages, and the agent messages that can hold an artifact. Read
 * only; it owns no table and never imports the facade.
 */
export class WorkspaceQueries {
  readonly #core: WorkspaceQueriesOptions["core"];

  constructor(options: WorkspaceQueriesOptions) {
    this.#core = options.core;
  }

  /** The priced usage records since `since`: one row per record. */
  usageSince(since: string): Array<{ agentId: string; occurredAt: string; costUsd: number | null }> {
    return databaseRows(
      this.#core.connection
        .prepare("SELECT agent_id, occurred_at, estimated_cost_usd FROM agent_usage_records WHERE occurred_at >= ?")
        .all(since),
    ).map((row) => ({
      agentId: requiredStringColumn(row, "agent_id"),
      occurredAt: requiredStringColumn(row, "occurred_at"),
      costUsd: optionalNumberColumn(row, "estimated_cost_usd"),
    }));
  }

  /** The turns that started since `since`, with the agent of each. */
  turnsSince(since: string): Array<{ agentId: string; status: string; startedAt: string; completedAt: string | null }> {
    return databaseRows(
      this.#core.connection
        .prepare(
          `SELECT thread.agent_id, turn.status, turn.started_at, turn.completed_at
             FROM projection_turns turn
             JOIN projection_threads thread ON thread.thread_id = turn.thread_id
            WHERE turn.started_at >= ?`,
        )
        .all(since),
    ).map((row) => ({
      agentId: requiredStringColumn(row, "agent_id"),
      status: requiredStringColumn(row, "status"),
      startedAt: requiredStringColumn(row, "started_at"),
      completedAt: optionalStringColumn(row, "completed_at"),
    }));
  }

  turn(turnId: string): WorkspaceTurnRow | null {
    return this.turns([turnId])[0] ?? null;
  }

  turns(turnIds: readonly string[]): WorkspaceTurnRow[] {
    if (turnIds.length === 0) return [];
    return databaseRows(
      this.#core.connection
        .prepare(
          `SELECT turn.turn_id, turn.thread_id, thread.agent_id, turn.status, turn.started_at, turn.completed_at
             FROM projection_turns turn
             JOIN projection_threads thread ON thread.thread_id = turn.thread_id
            WHERE turn.turn_id IN (${placeholders(turnIds)})`,
        )
        .all(...turnIds),
    ).map((row) => ({
      turnId: requiredStringColumn(row, "turn_id"),
      threadId: requiredStringColumn(row, "thread_id"),
      agentId: requiredStringColumn(row, "agent_id"),
      status: requiredStringColumn(row, "status"),
      startedAt: requiredStringColumn(row, "started_at"),
      completedAt: optionalStringColumn(row, "completed_at"),
    }));
  }

  /** The stored messages of one turn of a thread, in thread order. */
  turnMessages(threadId: string, turnId: string): ConversationMessage[] {
    return databaseRows(
      this.#core.connection
        .prepare(
          "SELECT message_json FROM projection_thread_messages WHERE thread_id = ? AND turn_id = ? ORDER BY created_at, ordinal",
        )
        .all(threadId, turnId),
    ).map((row) => decodeConversationMessageJson(requiredStringColumn(row, "message_json")));
  }

  /** The highest row of the thread messages, or 0 for none. */
  lastThreadMessageRow(): number {
    const row = databaseRow(
      this.#core.connection.prepare("SELECT MAX(rowid) AS row_id FROM projection_thread_messages").get(),
    );
    return row ? (optionalNumberColumn(row, "row_id") ?? 0) : 0;
  }

  /**
   * The messages after row `afterRow` (at most `limit` rows scanned), and the rows in `rowIds`, that
   * an agent wrote or that the host wrote for it in a conversation outside the channels, and that can
   * hold an artifact: a visual reply, a hosted site event, a link or an attachment. Returns the last
   * row it scanned, so the next read continues there.
   */
  artifactMessages(
    afterRow: number,
    limit: number,
    rowIds: readonly number[] = [],
  ): { rows: WorkspaceThreadMessageRow[]; lastRow: number } {
    const range = databaseRow(
      this.#core.connection
        .prepare(
          "SELECT MAX(row_id) AS last_row FROM (SELECT rowid AS row_id FROM projection_thread_messages WHERE rowid > ? ORDER BY rowid LIMIT ?)",
        )
        .get(afterRow, limit),
    );
    const lastRow = (range ? optionalNumberColumn(range, "last_row") : null) ?? afterRow;
    const condition = `message.author IN ('assistant', 'system')
        AND context.thread_id IS NULL
        AND (message.item_type LIKE 'visual-reply:%'
          OR message.item_type LIKE 'hosted-site-event:%'
          OR instr(message.message_json, '://') > 0
          OR instr(message.message_json, '"attachments":[{') > 0)`;
    const select = `SELECT message.rowid AS row_id, message.thread_id, thread.agent_id, message.status, message.message_json
        FROM projection_thread_messages message
        JOIN projection_threads thread ON thread.thread_id = message.thread_id
        LEFT JOIN projection_channel_contexts context ON context.thread_id = message.thread_id`;
    const rows = [
      ...(lastRow > afterRow
        ? databaseRows(
            this.#core.connection
              .prepare(`${select} WHERE message.rowid > ? AND message.rowid <= ? AND ${condition}`)
              .all(afterRow, lastRow),
          )
        : []),
      ...(rowIds.length
        ? databaseRows(
            this.#core.connection
              .prepare(`${select} WHERE message.rowid IN (${placeholders(rowIds)}) AND ${condition}`)
              .all(...rowIds),
          )
        : []),
    ];
    return {
      lastRow,
      rows: rows.flatMap((row) => {
        let message: ConversationMessage;
        try {
          message = decodeConversationMessageJson(requiredStringColumn(row, "message_json"));
        } catch {
          return [];
        }
        return [
          {
            rowId: requiredNumberColumn(row, "row_id"),
            threadId: requiredStringColumn(row, "thread_id"),
            agentId: requiredStringColumn(row, "agent_id"),
            status: requiredStringColumn(row, "status"),
            message,
          },
        ];
      }),
    };
  }

  /** The thread messages of `threadId` among `messageIds` that still exist, read through the primary key. */
  existingThreadMessages(threadId: string, messageIds: readonly string[]): Set<string> {
    const found = new Set<string>();
    for (let start = 0; start < messageIds.length; start += 500) {
      const batch = messageIds.slice(start, start + 500);
      for (const row of databaseRows(
        this.#core.connection
          .prepare(
            `SELECT message_id FROM projection_thread_messages WHERE thread_id = ? AND message_id IN (${placeholders(batch)})`,
          )
          .all(threadId, ...batch),
      ))
        found.add(requiredStringColumn(row, "message_id"));
    }
    return found;
  }

  /**
   * Each two agents that sent each other messages, newest first: the count of both directions and
   * the newest message. A message to several agents counts once for each pair.
   */
  agentPairs(): WorkspaceAgentPairRow[] {
    return databaseRows(
      this.#core.connection
        .prepare(
          `WITH exchange AS (
             SELECT message.sender_agent_id AS sender, delivery.recipient_agent_id AS recipient,
                    message.text, message.created_at,
                    MIN(message.sender_agent_id, delivery.recipient_agent_id) AS first_agent,
                    MAX(message.sender_agent_id, delivery.recipient_agent_id) AS second_agent
               FROM projection_deliveries delivery
               JOIN projection_mailbox_messages message ON message.message_id = delivery.message_id
              WHERE message.sender_kind = 'agent' AND message.sender_agent_id IS NOT NULL
                AND message.sender_agent_id != delivery.recipient_agent_id
           ), ranked AS (
             SELECT *, ROW_NUMBER() OVER (PARTITION BY first_agent, second_agent ORDER BY created_at DESC) AS rank,
                    COUNT(*) OVER (PARTITION BY first_agent, second_agent) AS total
               FROM exchange
           )
           SELECT first_agent, second_agent, total, created_at, sender, substr(text, 1, 240) AS last_text
             FROM ranked WHERE rank = 1 ORDER BY created_at DESC`,
        )
        .all(),
    ).map((row) => ({
      agentIds: [requiredStringColumn(row, "first_agent"), requiredStringColumn(row, "second_agent")],
      count: requiredNumberColumn(row, "total"),
      lastAt: requiredStringColumn(row, "created_at"),
      lastSenderId: requiredStringColumn(row, "sender"),
      lastText: requiredStringColumn(row, "last_text"),
    }));
  }

  /** The messages between two agents, newest first, before `before` (an ISO time) when given. */
  agentExchange(first: string, second: string, before: string | null, limit: number): WorkspaceAgentExchangeRow[] {
    return databaseRows(
      this.#core.connection
        .prepare(
          `SELECT DISTINCT message.message_id, message.sender_agent_id, message.text, message.created_at,
                  message.reply_to_message_id,
                  COALESCE(json_array_length(message.message_json, '$.attachments'), 0) AS attachment_count,
                  (SELECT group_concat(other.recipient_agent_id, ',') FROM projection_deliveries other
                    WHERE other.message_id = message.message_id) AS recipients
             FROM projection_deliveries delivery
             JOIN projection_mailbox_messages message ON message.message_id = delivery.message_id
            WHERE message.sender_kind = 'agent'
              AND ((message.sender_agent_id = ? AND delivery.recipient_agent_id = ?)
                OR (message.sender_agent_id = ? AND delivery.recipient_agent_id = ?))
              AND (? IS NULL OR message.created_at < ?)
            ORDER BY message.created_at DESC
            LIMIT ?`,
        )
        .all(first, second, second, first, before, before, limit),
    ).map((row) => ({
      id: requiredStringColumn(row, "message_id"),
      senderAgentId: requiredStringColumn(row, "sender_agent_id"),
      recipientAgentIds: (optionalStringColumn(row, "recipients") ?? "").split(",").filter(Boolean),
      text: requiredStringColumn(row, "text"),
      createdAt: requiredStringColumn(row, "created_at"),
      replyToMessageId: optionalStringColumn(row, "reply_to_message_id"),
      attachmentCount: requiredNumberColumn(row, "attachment_count"),
    }));
  }

  /** The agents whose own chat has a message that a person wrote since `since` (an ISO time). */
  agentsWithPersonMessagesSince(since: string): string[] {
    return databaseRows(
      this.#core.connection
        .prepare(
          `SELECT DISTINCT agent.agent_id
             FROM projection_agents agent
             JOIN projection_thread_messages message ON message.thread_id = agent.thread_id
            WHERE message.author = 'user' AND message.created_at >= ?
              AND COALESCE(json_extract(message.message_json, '$.source'), 'user') = 'user'`,
        )
        .all(since),
    ).map((row) => requiredStringColumn(row, "agent_id"));
  }
}
