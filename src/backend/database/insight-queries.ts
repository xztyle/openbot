import { type DynamicRecord, isDynamicRecord } from "@openbot/contracts/runtime-values";
import type { DatabaseCore } from "./database-core";
import {
  databaseRow,
  databaseRows,
  optionalNumberColumn,
  optionalStringColumn,
  requiredStringColumn,
} from "./database-rows";

/** One usage record: the tokens of one request group, with its estimated cost. */
export interface InsightUsageRow {
  agentId: string;
  sessionId: string;
  turnId: string;
  occurredAt: string;
  tokens: number;
  costUsd: number | null;
}

/** One delivery of a message to an agent. Times are ISO strings, as stored. */
export interface InsightDeliveryRow {
  deliveryId: string;
  messageId: string;
  agentId: string;
  status: string;
  turnId: string | null;
  createdAt: string;
  /** The agent that sent the message; null for a person, a routine or the host. */
  senderAgentId: string | null;
}

export interface InsightTurnRow {
  turnId: string;
  status: string;
  startedAt: string;
  completedAt: string | null;
}

export interface InsightWaitRow {
  createdAt: string;
  wokenAt: string | null;
  note: string;
}

const TOKEN_KEYS = ["uncachedInput", "cachedInput", "cacheCreation", "output"] as const;

function tokenTotal(json: string): number {
  try {
    const value = JSON.parse(json);
    if (!isDynamicRecord(value)) return 0;
    let total = 0;
    for (const key of TOKEN_KEYS) {
      const count = value[key];
      if (typeof count === "number" && Number.isFinite(count)) total += count;
    }
    return total;
  } catch {
    return 0;
  }
}

function delivery(row: DynamicRecord): InsightDeliveryRow {
  return {
    deliveryId: requiredStringColumn(row, "delivery_id"),
    messageId: requiredStringColumn(row, "message_id"),
    agentId: requiredStringColumn(row, "recipient_agent_id"),
    status: requiredStringColumn(row, "status"),
    turnId: optionalStringColumn(row, "turn_id"),
    createdAt: requiredStringColumn(row, "created_at"),
    senderAgentId: optionalStringColumn(row, "sender_agent_id"),
  };
}

const DELIVERY_COLUMNS =
  "d.delivery_id, d.message_id, d.recipient_agent_id, d.status, d.turn_id, d.created_at, m.sender_agent_id";

/**
 * The reads of the insight views (`insight/`): usage for the costs, deliveries for the briefing, and
 * the rows behind the timeline of one request. Every read is bounded by time or by a key.
 */
export class InsightQueries {
  readonly #core: Pick<DatabaseCore, "connection">;
  /** A read-only script can give it a bare connection. */
  constructor(core: Pick<DatabaseCore, "connection">) {
    this.#core = core;
  }

  /** The usage records that occurred in `[since, until)`, on the date-leading index. */
  usage(since: string, until: string): InsightUsageRow[] {
    return databaseRows(
      this.#core.connection
        .prepare(
          "SELECT agent_id, session_id, turn_id, occurred_at, tokens_json, estimated_cost_usd FROM agent_usage_records WHERE occurred_at >= ? AND occurred_at < ?",
        )
        .all(since, until),
    ).map((row) => ({
      agentId: requiredStringColumn(row, "agent_id"),
      sessionId: requiredStringColumn(row, "session_id"),
      turnId: requiredStringColumn(row, "turn_id"),
      occurredAt: requiredStringColumn(row, "occurred_at"),
      tokens: tokenTotal(requiredStringColumn(row, "tokens_json")),
      costUsd: optionalNumberColumn(row, "estimated_cost_usd"),
    }));
  }

  /**
   * The turns that left an answer since `since`: an assistant message that people read. Commentary
   * between tool calls, a quiet routine answer and a plan are not one.
   */
  answeredTurns(since: string): Set<string> {
    const rows = databaseRows(
      this.#core.connection
        .prepare(
          "SELECT DISTINCT turn_id FROM projection_thread_messages WHERE created_at >= ? AND author = 'assistant' AND turn_id IS NOT NULL AND (item_type IS NULL OR item_type IN ('agentMessage', 'final_answer'))",
        )
        .all(since),
    );
    return new Set(rows.map((row) => requiredStringColumn(row, "turn_id")));
  }

  /** The deliveries made since `since`, newest first, at most `limit`. */
  deliveriesSince(since: string, limit = 5_000): InsightDeliveryRow[] {
    return databaseRows(
      this.#core.connection
        .prepare(
          `SELECT ${DELIVERY_COLUMNS} FROM projection_deliveries d JOIN projection_mailbox_messages m ON m.message_id = d.message_id WHERE d.created_at >= ? ORDER BY d.created_at DESC LIMIT ?`,
        )
        .all(since, limit),
    ).map(delivery);
  }

  /** An agent's latest deliveries, newest first. */
  agentDeliveries(agentId: string, limit: number): InsightDeliveryRow[] {
    return databaseRows(
      this.#core.connection
        .prepare(
          `SELECT ${DELIVERY_COLUMNS} FROM projection_deliveries d JOIN projection_mailbox_messages m ON m.message_id = d.message_id WHERE d.recipient_agent_id = ? ORDER BY d.created_at DESC LIMIT ?`,
        )
        .all(agentId, limit),
    ).map(delivery);
  }

  /** The deliveries of the channel tasks that a message of a channel asked for, oldest first. */
  channelRequestDeliveries(channelId: string, messageId: string): InsightDeliveryRow[] {
    return databaseRows(
      this.#core.connection
        .prepare(
          `SELECT ${DELIVERY_COLUMNS} FROM projection_channel_assignments a JOIN projection_deliveries d ON d.delivery_id = a.delivery_id JOIN projection_mailbox_messages m ON m.message_id = d.message_id WHERE a.channel_id = ? AND json_extract(a.assignment_json, '$.requestMessageId') = ? ORDER BY d.created_at`,
        )
        .all(channelId, messageId),
    ).map(delivery);
  }

  /** How many of an agent's deliveries wait to start, made before `before`. */
  queuedBefore(agentId: string, before: string): number {
    const row = databaseRow(
      this.#core.connection
        .prepare(
          "SELECT COUNT(*) AS count FROM projection_deliveries WHERE recipient_agent_id = ? AND status = 'queued' AND created_at < ?",
        )
        .get(agentId, before),
    );
    return row ? (optionalNumberColumn(row, "count") ?? 0) : 0;
  }

  turn(turnId: string): InsightTurnRow | null {
    const row = databaseRow(
      this.#core.connection
        .prepare("SELECT turn_id, status, started_at, completed_at FROM projection_turns WHERE turn_id = ?")
        .get(turnId),
    );
    return row
      ? {
          turnId: requiredStringColumn(row, "turn_id"),
          status: requiredStringColumn(row, "status"),
          startedAt: requiredStringColumn(row, "started_at"),
          completedAt: optionalStringColumn(row, "completed_at"),
        }
      : null;
  }

  /** The waits that the work of a delivery opened for a teammate or an event, oldest first. */
  waits(deliveryId: string): InsightWaitRow[] {
    return databaseRows(
      this.#core.connection
        .prepare(
          "SELECT created_at, woken_at, note FROM agent_waits WHERE request_delivery_id = ? ORDER BY created_at LIMIT 20",
        )
        .all(deliveryId),
    ).map((row) => ({
      createdAt: requiredStringColumn(row, "created_at"),
      wokenAt: optionalStringColumn(row, "woken_at"),
      note: requiredStringColumn(row, "note"),
    }));
  }
}
