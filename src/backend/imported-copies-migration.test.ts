// @vitest-environment node
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { ORDER_KEY_COLUMNS, ORDERED_THREAD_MESSAGES } from "./database/conversation-queries";
import { refreshThreadOrder } from "./database/thread-message-order";
import { migrateOpenBotDatabase } from "./openbot-database-schema";

// Failure modes: the cleanup removes a message that a live turn wrote, or the only copy of a text; it
// misses a copy; a read cursor is left on a removed row; a replay or a retry brings a copy back; the
// order keys of a turn that lost a row are stale.
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

const THREAD = "openbot-thread-agent-scout";
const CODEX_THREAD = "openbot-thread-agent-codex";
const LIVE_ANSWER = "The checklist is written and saved in Motion.";
const ROUTINE_PROMPT = "Map the next module of the catalog and report the progress.";

interface Seed {
  thread?: string;
  id: string;
  turn: string;
  author: string;
  itemType?: string;
  text: string;
  at: string;
  /** A Claude history import wrote this row, as an import event records. */
  imported?: "claude" | "codex";
}

const MESSAGES: readonly Seed[] = [
  { id: "live-request", turn: "live-turn", author: "user", text: "Write the checklist.", at: "10:00:00" },
  {
    id: "live-turn:narration:0",
    turn: "live-turn",
    author: "assistant",
    itemType: "commentary",
    text: "Reading the golden rules first.",
    at: "10:00:10",
  },
  {
    id: "live-turn:assistant",
    turn: "live-turn",
    author: "assistant",
    itemType: "agentMessage",
    text: LIVE_ANSWER,
    at: "10:01:00",
  },
  // The import stored the live turn again under the ID of an entry that Claude Code wrote itself.
  {
    id: "copy-narration",
    turn: "meta-entry",
    author: "assistant",
    itemType: "commentary",
    text: "Reading the golden rules first.",
    at: "10:00:02",
    imported: "claude",
  },
  {
    id: "copy-answer",
    turn: "meta-entry",
    author: "assistant",
    itemType: "agentMessage",
    text: LIVE_ANSWER,
    at: "10:00:03",
    imported: "claude",
  },
  {
    id: "synthetic",
    turn: "meta-entry",
    author: "assistant",
    itemType: "agentMessage",
    text: "No response requested.",
    at: "10:00:04",
    imported: "claude",
  },
  // Only the transcript holds this answer: it stays.
  {
    id: "transcript-only",
    turn: "meta-entry",
    author: "assistant",
    itemType: "agentMessage",
    text: "The background export finished after the turn.",
    at: "10:00:05",
    imported: "claude",
  },
  // An import that reconciled a live row writes it under the live ID. A later turn said the same.
  {
    id: "later-turn:assistant",
    turn: "later-turn",
    author: "assistant",
    itemType: "agentMessage",
    text: LIVE_ANSWER,
    at: "11:00:00",
    imported: "claude",
  },
  // Hourly routine prompts with one text, mapped to their deliveries by the import: all live.
  {
    id: "run-1",
    turn: "run-1",
    author: "user",
    itemType: "routine",
    text: ROUTINE_PROMPT,
    at: "12:00:00",
    imported: "claude",
  },
  { id: "run-2", turn: "run-2", author: "user", itemType: "routine", text: ROUTINE_PROMPT, at: "13:00:00" },
  // A short text repeats in a chat: it is no copy.
  { id: "done-live", turn: "run-1", author: "assistant", itemType: "agentMessage", text: "Done.", at: "12:01:00" },
  {
    id: "done-imported",
    turn: "other-entry",
    author: "assistant",
    itemType: "agentMessage",
    text: "Done.",
    at: "12:01:30",
    imported: "claude",
  },
  // A copy from more than a day later is not the same message.
  {
    id: "far-copy",
    turn: "far-entry",
    author: "assistant",
    itemType: "agentMessage",
    text: LIVE_ANSWER,
    at: "next-day",
    imported: "claude",
  },
  // Claude wrote this before the agent moved to Codex.
  {
    thread: CODEX_THREAD,
    id: "codex-synthetic",
    turn: "old-entry",
    author: "assistant",
    itemType: "agentMessage",
    text: "No response requested.",
    at: "09:00:00",
    imported: "claude",
  },
  {
    thread: CODEX_THREAD,
    id: "codex-answer",
    turn: "codex-turn",
    author: "assistant",
    itemType: "agentMessage",
    text: "No response requested.",
    at: "09:30:00",
  },
];

const REMOVED = ["copy-answer", "copy-narration", "synthetic"];

function time(at: string): string {
  return at === "next-day" ? "2026-11-17T12:00:00.000Z" : `2026-11-16T${at}.000Z`;
}

function seed(db: DatabaseSync): void {
  for (const [thread, agent, provider] of [
    [THREAD, "agent-scout", "claude"],
    [CODEX_THREAD, "agent-codex", "codex"],
  ] as const) {
    db.prepare(
      `INSERT INTO projection_threads (thread_id, agent_id, title, active_turn_id, created_at, updated_at, last_event_sequence)
       VALUES (?, ?, 'Chat', NULL, '2026-11-16T09:00:00.000Z', '2026-11-16T09:00:00.000Z', 1)`,
    ).run(thread, agent);
    db.prepare(
      `INSERT INTO projection_agents (agent_id, thread_id, model, updated_at, sort_order, agent_json, last_event_sequence)
       VALUES (?, ?, 'model', NULL, 0, ?, 1)`,
    ).run(agent, thread, JSON.stringify({ id: agent, provider }));
  }
  const insert = db.prepare(
    `INSERT INTO projection_thread_messages
       (thread_id, message_id, turn_id, author, status, item_type, created_at, ordinal, message_json, last_event_sequence)
     VALUES (?, ?, ?, ?, 'completed', ?, ?, ?, ?, 2)`,
  );
  const importEvent = db.prepare(
    `INSERT INTO orchestration_events (event_id, command_id, aggregate_type, aggregate_id, event_type, occurred_at, payload_json)
     VALUES (?, ?, 'thread', ?, 'provider-history.message-imported', ?, ?)`,
  );
  for (const [ordinal, row] of MESSAGES.entries()) {
    const thread = row.thread ?? THREAD;
    const message = {
      id: row.id,
      turnId: row.turn,
      author: row.author,
      text: row.text,
      createdAt: time(row.at),
      status: "completed",
      ...(row.itemType ? { itemType: row.itemType } : {}),
    };
    insert.run(
      thread,
      row.id,
      row.turn,
      row.author,
      row.itemType ?? null,
      time(row.at),
      ordinal,
      JSON.stringify(message),
    );
    if (row.imported)
      importEvent.run(
        `event-${row.id}`,
        `command-${row.id}`,
        thread,
        time(row.at),
        JSON.stringify({ detail: { provider: row.imported }, importedMessage: message }),
      );
  }
  for (const thread of [THREAD, CODEX_THREAD]) refreshThreadOrder(db, thread);
  db.prepare(
    `INSERT INTO projection_thread_reads (thread_id, member_id, through_message_id, updated_at)
     VALUES (?, 'member', 'copy-answer', '2026-11-16T10:30:00.000Z')`,
  ).run(THREAD);
  db.prepare(
    `INSERT INTO projection_attachments (attachment_id, owner_kind, owner_id, name, path, metadata_json, created_at, last_event_sequence)
     VALUES ('file', 'thread-message', ?, 'notes.md', '', '{}', '2026-11-16T10:00:03.000Z', 2)`,
  ).run(`${THREAD}:copy-answer`);
}

function messageIds(db: DatabaseSync, thread = THREAD): string[] {
  return db
    .prepare(`${ORDERED_THREAD_MESSAGES} SELECT message_id FROM ordered ORDER BY ${ORDER_KEY_COLUMNS}`)
    .all(thread)
    .map((row) => String(row.message_id));
}

function orderKeys(db: DatabaseSync): unknown[] {
  return db
    .prepare(
      "SELECT thread_id, message_id, group_start, group_first, group_id, turn_rank FROM projection_thread_messages ORDER BY 1, 2",
    )
    .all();
}

describe("imported copies migration 49", () => {
  it("removes the imported copies of live messages and the synthetic replies, and nothing else", () => {
    const db = databaseAt(48);
    seed(db);
    const before = messageIds(db);

    migrateOpenBotDatabase(db);

    expect(db.prepare("SELECT MAX(version) AS version FROM schema_migrations").get()).toEqual({ version: 53 });
    expect(messageIds(db)).toEqual(before.filter((id) => !REMOVED.includes(id)));
    expect(messageIds(db, CODEX_THREAD)).toEqual(["codex-answer"]);
    // The reader had read through the removed answer: the cursor stays on the last row shown before it
    // that stays.
    const shownBeforeCopy = before.slice(0, before.indexOf("copy-answer")).findLast((id) => !REMOVED.includes(id));
    expect(db.prepare("SELECT through_message_id FROM projection_thread_reads").get()).toEqual({
      through_message_id: shownBeforeCopy,
    });
    expect(db.prepare("SELECT COUNT(*) AS count FROM projection_attachments").get()).toEqual({ count: 0 });
    // One event for each thread removes the rows on a replay too, after the events that added them.
    const removal = db
      .prepare(
        `SELECT aggregate_id, payload_json FROM orchestration_events
         WHERE event_type = 'conversation.imported-copies-removed' ORDER BY sequence`,
      )
      .all();
    expect(removal.map((row) => [row.aggregate_id, JSON.parse(String(row.payload_json)).removedMessageIds])).toEqual([
      [CODEX_THREAD, ["codex-synthetic"]],
      [THREAD, [...REMOVED].sort()],
    ]);
    const lastSequence = db.prepare("SELECT MAX(sequence) AS sequence FROM orchestration_events").get();
    expect(
      db.prepare("SELECT last_event_sequence AS sequence FROM projection_threads WHERE thread_id = ?").get(THREAD),
    ).toEqual(lastSequence);
    // The keys of the turns that lost a row are the keys that a later write computes.
    const keys = orderKeys(db);
    for (const thread of [THREAD, CODEX_THREAD]) refreshThreadOrder(db, thread);
    expect(orderKeys(db)).toEqual(keys);
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });

  it("rolls back after a late failure, then removes the copies once", () => {
    const db = databaseAt(48);
    seed(db);
    const before = messageIds(db);
    db.exec(`CREATE TEMP TRIGGER fail_marker BEFORE INSERT ON schema_migrations WHEN new.version = 49
      BEGIN SELECT RAISE(ABORT, 'late failure'); END;`);
    expect(() => migrateOpenBotDatabase(db)).toThrow("migration to version 49 failed");
    expect(messageIds(db)).toEqual(before);
    expect(
      db.prepare("SELECT COUNT(*) AS count FROM orchestration_events WHERE event_type LIKE 'conversation.%'").get(),
    ).toEqual({ count: 0 });
    db.exec("DROP TRIGGER fail_marker");
    migrateOpenBotDatabase(db);
    expect(messageIds(db)).toEqual(before.filter((id) => !REMOVED.includes(id)));
    expect(
      db.prepare("SELECT COUNT(*) AS count FROM orchestration_events WHERE event_type LIKE 'conversation.%'").get(),
    ).toEqual({ count: 2 });
  });
});
