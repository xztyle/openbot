// @vitest-environment node
import { DatabaseSync } from "node:sqlite";
import { isChannelMessage } from "@openbot/contracts/ipc";
import { afterEach, describe, expect, it } from "vitest";
import { migrateOpenBotDatabase } from "./openbot-database-schema";

// Failure modes: the cleanup deletes a live channel message or the only copy of a text; it misses a copy;
// a rebuild of the channel from its events brings a copy back; a summary keeps text of a deleted message.
const databases: DatabaseSync[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});

function databaseAt(version: number): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  databases.push(db);
  db.exec(`CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
    CREATE TEMP TRIGGER stop_at_version BEFORE INSERT ON schema_migrations WHEN new.version > ${version}
    BEGIN SELECT RAISE(ABORT, 'fixture stop'); END;`);
  expect(() => migrateOpenBotDatabase(db)).toThrow(`migration to version ${version + 1} failed`);
  db.exec("DROP TRIGGER stop_at_version");
  return db;
}

const CHANNEL = "channel-markets";
const AGENT = "agent-execution";
const LIVE = "SIP probes are done. Pinning the 15-minute window next.";

interface Seed {
  id: string;
  text: string;
  at: string;
  author?: string;
  /** A Claude history import wrote this message in the task's thread. */
  imported?: "claude" | "codex";
  replyCount?: number;
}

const MESSAGES: readonly Seed[] = [
  { id: "live-turn:narration:0", text: LIVE, at: "02:16:50" },
  { id: "imported-copy", text: LIVE, at: "02:15:29", imported: "claude" },
  // Only the transcript holds it: it stays.
  {
    id: "imported-only",
    text: "The attack tests exposed a missing refusal in the broker.",
    at: "02:20:00",
    imported: "claude",
  },
  { id: "synthetic", text: "No response requested.", at: "02:21:00", imported: "claude" },
  // Another agent said the same: not a copy of this agent's message.
  { id: "other-agent-copy", text: LIVE, at: "02:22:00", author: "agent-risk", imported: "claude" },
  // A short text repeats.
  { id: "done-live", text: "Done.", at: "02:30:00" },
  { id: "done-imported", text: "Done.", at: "02:30:10", imported: "claude" },
];

function seed(db: DatabaseSync): void {
  db.prepare("INSERT INTO projection_channels VALUES (?, ?)").run(
    CHANNEL,
    JSON.stringify({ id: CHANNEL, name: "markets", revision: 7 }),
  );
  const insert = db.prepare("INSERT INTO projection_channel_messages VALUES (?, ?, ?, ?)");
  const importEvent = db.prepare(
    `INSERT INTO orchestration_events (event_id, command_id, aggregate_type, aggregate_id, event_type, occurred_at, payload_json)
     VALUES (?, ?, 'thread', 'openbot-thread-task', 'provider-history.message-imported', ?, ?)`,
  );
  for (const [index, row] of MESSAGES.entries()) {
    const createdAt = `2026-11-01T${row.at}.000Z`;
    const inner = {
      id: row.id,
      turnId: "turn",
      author: "assistant",
      text: row.text,
      createdAt,
      status: "completed",
      itemType: "commentary",
    };
    const message = {
      id: row.id,
      channelId: CHANNEL,
      sequence: index + 1,
      author: { kind: "agent", id: row.author ?? AGENT, name: "Execution" },
      taskId: "task",
      superseded: false,
      message: inner,
      threadRootId: "root",
      reactions: [{ emoji: "👍", count: 1 }],
    };
    insert.run(CHANNEL, row.id, index + 1, JSON.stringify(message));
    if (row.imported)
      importEvent.run(
        `event-${row.id}`,
        `command-${row.id}`,
        createdAt,
        JSON.stringify({ detail: { provider: row.imported }, importedMessage: inner }),
      );
  }
  db.prepare("INSERT INTO projection_channel_summaries VALUES (?, ?, ?, ?)").run(CHANNEL, 1, 5, "A summary");
  // A synthetic reply that an import brought back after migration 49.
  db.prepare(
    `INSERT INTO projection_threads (thread_id, agent_id, title, active_turn_id, created_at, updated_at, last_event_sequence)
     VALUES ('openbot-thread-agent', 'agent', 'Chat', NULL, '2026-11-16T09:00:00.000Z', '2026-11-16T09:00:00.000Z', 1)`,
  ).run();
  const reply = {
    id: "back-again",
    turnId: "turn",
    author: "assistant",
    text: "No response requested.",
    createdAt: "2026-11-16T10:00:00.000Z",
    status: "completed",
  };
  db.prepare(
    `INSERT INTO projection_thread_messages
       (thread_id, message_id, turn_id, author, status, item_type, created_at, ordinal, message_json, last_event_sequence,
        group_start, group_first, group_id, turn_rank)
     VALUES ('openbot-thread-agent', 'back-again', 'turn', 'assistant', 'completed', NULL, ?, 0, ?, 2, ?, 0, 'turn:turn', 3)`,
  ).run(reply.createdAt, JSON.stringify(reply), reply.createdAt);
  db.prepare(
    `INSERT INTO orchestration_events (event_id, command_id, aggregate_type, aggregate_id, event_type, occurred_at, payload_json)
     VALUES ('event-back-again', 'command-back-again', 'thread', 'openbot-thread-agent', 'provider-history.message-imported', ?, ?)`,
  ).run(reply.createdAt, JSON.stringify({ detail: { provider: "claude" }, importedMessage: reply }));
}

function deletedIds(db: DatabaseSync): string[] {
  return db
    .prepare(
      `SELECT message_id FROM projection_channel_messages
       WHERE json_extract(message_json, '$.deletedAt') IS NOT NULL ORDER BY sequence`,
    )
    .all()
    .map((row) => String(row.message_id));
}

describe("imported channel copies migration 51", () => {
  it("deletes the channel copies of imports as a person's deletion does, and nothing else", () => {
    const db = databaseAt(50);
    seed(db);

    migrateOpenBotDatabase(db, { appliedAt: "2026-11-16T12:00:00.000Z" });

    expect(db.prepare("SELECT MAX(version) AS version FROM schema_migrations").get()).toEqual({ version: 54 });
    expect(deletedIds(db)).toEqual(["imported-copy", "synthetic"]);
    expect(db.prepare("SELECT COUNT(*) AS count FROM projection_thread_messages").get()).toEqual({ count: 0 });
    const copy = JSON.parse(
      String(
        db.prepare("SELECT message_json FROM projection_channel_messages WHERE message_id = 'imported-copy'").get()
          ?.message_json,
      ),
    );
    expect(copy).toMatchObject({ deletedAt: "2026-11-16T12:00:00.000Z", message: { text: "" } });
    expect(copy.reactions).toBeUndefined();
    expect(isChannelMessage(copy)).toBe(true);
    // A rebuild reads the channel from its `channel.changed` events: one carries the deletions.
    const events = db
      .prepare(
        "SELECT payload_json FROM orchestration_events WHERE aggregate_type = 'channel' AND event_type = 'channel.changed'",
      )
      .all()
      .map((row) => JSON.parse(String(row.payload_json)));
    expect(events).toHaveLength(1);
    expect(events[0].channel.revision).toBe(8);
    expect(events[0].messages.map((message: { id: string }) => message.id).sort()).toEqual([
      "imported-copy",
      "synthetic",
    ]);
    expect(events[0].messages.every(isChannelMessage)).toBe(true);
    expect(
      JSON.parse(String(db.prepare("SELECT channel_json FROM projection_channels").get()?.channel_json)),
    ).toMatchObject({
      revision: 8,
    });
    // The summary went through a deleted message, so it is written again.
    expect(db.prepare("SELECT through_sequence, text FROM projection_channel_summaries").get()).toEqual({
      through_sequence: 0,
      text: "",
    });
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });

  it("rolls back after a late failure, then deletes the copies once", () => {
    const db = databaseAt(50);
    seed(db);
    db.exec(`CREATE TEMP TRIGGER fail_marker BEFORE INSERT ON schema_migrations WHEN new.version = 51
      BEGIN SELECT RAISE(ABORT, 'late failure'); END;`);
    expect(() => migrateOpenBotDatabase(db)).toThrow("migration to version 51 failed");
    expect(deletedIds(db)).toEqual([]);
    expect(
      db.prepare("SELECT COUNT(*) AS count FROM orchestration_events WHERE aggregate_type = 'channel'").get(),
    ).toEqual({
      count: 0,
    });
    db.exec("DROP TRIGGER fail_marker");
    migrateOpenBotDatabase(db);
    expect(deletedIds(db)).toEqual(["imported-copy", "synthetic"]);
  });
});
