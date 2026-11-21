// @vitest-environment node
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { migrateOpenBotDatabase } from "./openbot-database-schema";

// Failure modes: the upgrade changes or loses a row of any table; a thread that a person started,
// replied to or was mentioned in is not followed after it; a thread reads as unread although its
// channel was read, or as read although it was not; a bridged author, an agent or a routing note
// follows a thread; the event that a rebuild replays is missing; a failed upgrade leaves the tables,
// the rows, the event or the marker; a retry fails on what the failed run left; a newer or incomplete
// history is accepted; the thread query does not use the new index.
const databases: DatabaseSync[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});

function databaseAt(version: number): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  databases.push(db);
  db.exec("CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)");
  migrateUpTo(db, version);
  return db;
}

function migrateUpTo(db: DatabaseSync, version: number): void {
  db.exec(`CREATE TEMP TRIGGER stop_at_version BEFORE INSERT ON schema_migrations WHEN new.version > ${version}
    BEGIN SELECT RAISE(ABORT, 'fixture stop'); END;`);
  expect(() => migrateOpenBotDatabase(db)).toThrow(`migration to version ${version + 1} failed`);
  db.exec("DROP TRIGGER stop_at_version");
}

/** The stored fields of a seeded message that differ from a plain top-level message by Alex. */
interface MessageFields {
  threadRootId?: string;
  author?: { kind: string; id: string; name: string };
  mentions?: { kind: string; id?: string }[];
  externalAuthor?: { kind: string; platform: string; id: string; name: string };
  message?: { id: string; text: string; createdAt: string; itemType: string };
}

function message(id: string, sequence: number, fields: MessageFields): [string, string, number, string] {
  const value = {
    id,
    channelId: "launch",
    sequence,
    author: { kind: "member", id: "alex", name: "Alex" },
    message: { id, text: id, createdAt: `2026-01-01T00:00:0${sequence}.000Z`, status: "complete" },
    ...fields,
  };
  return ["launch", id, sequence, JSON.stringify(value)];
}

/**
 * A channel with one thread: Alex wrote the root; an agent replied and mentioned Sam; Kim replied;
 * a bridged Discord author, a routing note and a plan replied too. Alex read the channel through
 * the agent's reply; Sam read nothing. A second channel has a root with no replies.
 */
function seedChannels(db: DatabaseSync): void {
  db.prepare(`INSERT INTO projection_channels (channel_id, channel_json) VALUES
    ('launch', '{"id":"launch","name":"launch","members":[{"agentId":"chief"}]}'),
    ('quiet', '{"id":"quiet","name":"quiet","members":[]}')`).run();
  const insert = db.prepare("INSERT INTO projection_channel_messages VALUES (?, ?, ?, ?)");
  insert.run(...message("root", 1, {}));
  insert.run(
    ...message("agent-reply", 2, {
      threadRootId: "root",
      author: { kind: "agent", id: "chief", name: "Chief 界" },
      mentions: [{ kind: "member", id: "sam" }, { kind: "here" }],
    }),
  );
  insert.run(...message("kim-reply", 3, { threadRootId: "root", author: { kind: "member", id: "kim", name: "Kim" } }));
  insert.run(
    ...message("bridged-reply", 4, {
      threadRootId: "root",
      author: { kind: "member", id: "discord-1", name: "Lee" },
      externalAuthor: { kind: "external", platform: "discord", id: "discord-1", name: "Lee" },
    }),
  );
  insert.run(
    ...message("routing-note", 5, {
      threadRootId: "root",
      author: { kind: "member", id: "router", name: "Router" },
      message: {
        id: "routing-note",
        text: "",
        createdAt: "2026-01-01T00:00:05.000Z",
        itemType: "channel-routing-event:x",
      },
    }),
  );
  insert.run(
    ...message("plan", 6, {
      threadRootId: "root",
      author: { kind: "member", id: "planner", name: "Planner" },
      message: { id: "plan", text: "", createdAt: "2026-01-01T00:00:06.000Z", itemType: "plan" },
    }),
  );
  db.prepare("INSERT INTO projection_channel_messages VALUES (?, ?, ?, ?)").run(
    "quiet",
    "lonely",
    1,
    JSON.stringify({ id: "lonely", channelId: "quiet", sequence: 1, author: { kind: "member", id: "alex" } }),
  );
  db.prepare(`INSERT INTO projection_channel_reads (channel_id, member_id, through_sequence) VALUES
    ('launch', 'alex', 2), ('quiet', 'alex', 1)`).run();
}

const FOLLOWS = [
  { channel_id: "launch", root_id: "root", member_id: "alex", followed: 1, explicit: 0 },
  { channel_id: "launch", root_id: "root", member_id: "kim", followed: 1, explicit: 0 },
  { channel_id: "launch", root_id: "root", member_id: "sam", followed: 1, explicit: 0 },
];
const READS = [
  { channel_id: "launch", root_id: "root", member_id: "alex", through_sequence: 2 },
  { channel_id: "launch", root_id: "root", member_id: "kim", through_sequence: 3 },
];

/** Every row of every table but the event log, by table name. */
function contents(db: DatabaseSync): Record<string, unknown[]> {
  const tables = db
    .prepare(
      `SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'
       AND name <> 'schema_migrations' AND name <> 'orchestration_events' AND name NOT LIKE 'agent_memory_search%' AND name NOT LIKE 'channel_message_search%'
       ORDER BY name`,
    )
    .all()
    .map((row) => String(row.name));
  // The new tables are compared in key order; every other table in the order of its rows.
  const order = (table: string) =>
    table.startsWith("projection_channel_thread_") ? " ORDER BY channel_id, root_id, member_id" : "";
  return Object.fromEntries(
    tables.map((table) => [table, db.prepare(`SELECT * FROM "${table}"${order(table)}`).all()]),
  );
}

function events(db: DatabaseSync): unknown[] {
  return db.prepare("SELECT * FROM orchestration_events ORDER BY sequence").all();
}

function threadState(db: DatabaseSync) {
  return {
    follows: db
      .prepare("SELECT * FROM projection_channel_thread_follows ORDER BY channel_id, root_id, member_id")
      .all(),
    reads: db.prepare("SELECT * FROM projection_channel_thread_reads ORDER BY channel_id, root_id, member_id").all(),
  };
}

function importedEvents(db: DatabaseSync) {
  return db
    .prepare(
      `SELECT aggregate_type, aggregate_id, event_type, command_id, payload_json FROM orchestration_events
        WHERE event_type = 'channel.thread-state-imported' ORDER BY sequence`,
    )
    .all()
    .map((row) => {
      const payload = JSON.parse(String(row.payload_json));
      const byKey = (left: { memberId: string }, right: { memberId: string }) =>
        left.memberId.localeCompare(right.memberId);
      return { ...row, payload_json: { reads: payload.reads.sort(byKey), follows: payload.follows.sort(byKey) } };
    });
}

function threadTables(db: DatabaseSync) {
  return db
    .prepare(
      `SELECT name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'
        AND (name LIKE '%channel_thread%' OR name = 'channel_messages_thread') ORDER BY name`,
    )
    .all();
}

function expectHealthy(db: DatabaseSync): void {
  expect(db.prepare("SELECT MAX(version) AS version FROM schema_migrations").get()).toEqual({ version: 55 });
  expect(db.prepare("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 });
  expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  expect(db.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
}

function expectMigrated(db: DatabaseSync, before: Record<string, unknown[]>, eventsBefore: unknown[]): void {
  expect(contents(db)).toEqual({
    ...before,
    projection_channel_thread_follows: FOLLOWS,
    projection_channel_thread_reads: READS,
    projection_channel_saved: [],
    loops: [],
    loop_items: [],
    loop_events: [],
    loop_experiments: [],
    loop_decisions: [],
  });
  // The event log keeps every event and gains one for the channel with a thread.
  expect(events(db).slice(0, eventsBefore.length)).toEqual(eventsBefore);
  expect(importedEvents(db)).toEqual([
    {
      aggregate_type: "channel",
      aggregate_id: "launch",
      event_type: "channel.thread-state-imported",
      command_id: "migration:52:launch",
      payload_json: {
        reads: READS.map((row) => ({
          rootId: row.root_id,
          memberId: row.member_id,
          throughSequence: row.through_sequence,
        })),
        follows: FOLLOWS.map((row) => ({ rootId: row.root_id, memberId: row.member_id })),
      },
    },
  ]);
  expect(events(db)).toHaveLength(eventsBefore.length + 1);
  expectHealthy(db);
}

describe("channel thread state migration", () => {
  // Channels exist from schema 18 on; an older database reaches 18 before the seed.
  it.each(Array.from({ length: 44 }, (_, index) => index + 8))(
    "preserves every row from released schema %i and derives the follows and read positions",
    (version) => {
      const db = databaseAt(version);
      if (version < 18) migrateUpTo(db, 18);
      seedChannels(db);
      if (version < 51) migrateUpTo(db, 51);
      const before = contents(db);
      const eventsBefore = events(db);
      migrateOpenBotDatabase(db);
      expectMigrated(db, before, eventsBefore);
    },
  );

  it.each([
    ["v0.1.12", 3],
    ["v0.1.15", 4],
    ["v0.1.18", 4],
    ["v0.2.1", 6],
  ] as const)("preserves every row from the %s snapshot", (tag, marker) => {
    const db = new DatabaseSync(":memory:");
    databases.push(db);
    db.exec(readFileSync(new URL(`./released-schemas/${tag}.sql`, import.meta.url), "utf8"));
    db.prepare("INSERT INTO schema_migrations(version, applied_at) VALUES (?, '2026-01-01')").run(marker);
    migrateUpTo(db, 51);
    seedChannels(db);
    const before = contents(db);
    const eventsBefore = events(db);
    migrateOpenBotDatabase(db);
    expectMigrated(db, before, eventsBefore);
  });

  it("gives a new database the tables and the index, and the thread query uses the index", () => {
    const db = new DatabaseSync(":memory:");
    databases.push(db);
    migrateOpenBotDatabase(db);
    expect(threadTables(db)).toHaveLength(5);
    const plan = db
      .prepare(
        `EXPLAIN QUERY PLAN SELECT message_json FROM projection_channel_messages
          WHERE channel_id = ? AND json_extract(message_json, '$.threadRootId') = ? AND sequence > ?`,
      )
      .all("launch", "root", 0)
      .map((row) => String(row.detail));
    expect(plan.join("\n")).toContain("channel_messages_thread");
    expectHealthy(db);
  });

  it("adds nothing for a database whose channels have no thread", () => {
    const db = databaseAt(51);
    db.prepare(`INSERT INTO projection_channels (channel_id, channel_json) VALUES ('quiet', '{"id":"quiet"}')`).run();
    db.prepare(`INSERT INTO projection_channel_reads VALUES ('quiet', 'alex', 0)`).run();
    const before = contents(db);
    const eventsBefore = events(db);
    migrateOpenBotDatabase(db);
    expect(contents(db)).toEqual({
      ...before,
      projection_channel_thread_follows: [],
      projection_channel_thread_reads: [],
      projection_channel_saved: [],
      loops: [],
      loop_items: [],
      loop_events: [],
      loop_experiments: [],
      loop_decisions: [],
    });
    expect(events(db)).toEqual(eventsBefore);
    expectHealthy(db);
  });

  it("rolls back the tables, the rows, the event and the marker after a late failure, then retries", () => {
    const db = databaseAt(51);
    seedChannels(db);
    const before = contents(db);
    const eventsBefore = events(db);
    db.exec(`CREATE TEMP TRIGGER fail_marker BEFORE INSERT ON schema_migrations WHEN new.version=52
      BEGIN SELECT RAISE(ABORT, 'late failure'); END;`);
    expect(() => migrateOpenBotDatabase(db)).toThrow("migration to version 52 failed");
    expect(contents(db)).toEqual(before);
    expect(events(db)).toEqual(eventsBefore);
    expect(threadTables(db)).toEqual([]);
    expect(db.prepare("SELECT version FROM schema_migrations WHERE version=52").all()).toEqual([]);
    expect(db.prepare("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 });
    db.exec("DROP TRIGGER fail_marker");
    migrateOpenBotDatabase(db);
    expectMigrated(db, before, eventsBefore);
    expect(threadState(db)).toEqual({ follows: FOLLOWS, reads: READS });
  });

  it("rejects newer and incomplete migration histories before it creates the tables", () => {
    const db = databaseAt(51);
    seedChannels(db);
    const before = contents(db);
    db.exec("INSERT INTO schema_migrations VALUES(56,'now')");
    expect(() => migrateOpenBotDatabase(db)).toThrow("newer than this application supports");
    db.exec("DELETE FROM schema_migrations WHERE version=56; DELETE FROM schema_migrations WHERE version=20");
    expect(() => migrateOpenBotDatabase(db)).toThrow("missing version 20");
    expect(contents(db)).toEqual(before);
    expect(threadTables(db)).toEqual([]);
  });

  it("refuses a row of a channel that does not exist and an invalid follow or position", () => {
    const db = databaseAt(51);
    seedChannels(db);
    migrateOpenBotDatabase(db);
    const follow = db.prepare("INSERT INTO projection_channel_thread_follows VALUES (?, ?, ?, ?, ?)");
    const read = db.prepare("INSERT INTO projection_channel_thread_reads VALUES (?, ?, ?, ?)");
    expect(() => follow.run("missing", "root", "alex", 1, 0)).toThrow("FOREIGN KEY constraint failed");
    expect(() => follow.run("launch", "root", "lee", 2, 0)).toThrow("CHECK constraint failed");
    expect(() => follow.run("launch", "root", "alex", 1, 0)).toThrow("UNIQUE constraint failed");
    expect(() => read.run("missing", "root", "alex", 1)).toThrow("FOREIGN KEY constraint failed");
    expect(() => read.run("launch", "root", "lee", -1)).toThrow("CHECK constraint failed");
    expectHealthy(db);
  });
});
