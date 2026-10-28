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
}
