// @vitest-environment node
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { migrateOpenBotDatabase } from "./openbot-database-schema";

const LOOP_TABLES = {
  loops: [],
  loop_items: [],
  loop_events: [],
  loop_experiments: [],
  loop_decisions: [],
  agent_usage_turn_notes: [],
};

// Failure modes: the upgrade changes or loses a row of any table; a failed upgrade leaves the table,
// its indexes or the marker; a retry fails on what the failed run left; a newer or incomplete history
// is accepted; a saved row names a channel that does not exist, a state that is not one, or a message
// twice for one person; the pins query does not use the pinned index.
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

/** A channel with a message, from schema 18 on. */
function seedChannel(db: DatabaseSync): void {
  db.prepare(`INSERT INTO projection_channels (channel_id, channel_json)
    VALUES ('launch', '{"id":"launch","name":"launch","members":[]}')`).run();
  db.prepare("INSERT INTO projection_channel_messages VALUES ('launch', 'first', 1, ?)").run(
    JSON.stringify({ id: "first", channelId: "launch", sequence: 1, message: { text: "Hello" } }),
  );
}

function contents(db: DatabaseSync): Record<string, unknown[]> {
  const tables = db
    .prepare(
      `SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'
       AND name <> 'schema_migrations' AND name NOT LIKE 'agent_memory_search%'
       AND name NOT LIKE 'channel_message_search%' ORDER BY name`,
    )
    .all()
    .map((row) => String(row.name));
  return Object.fromEntries(tables.map((table) => [table, db.prepare(`SELECT * FROM "${table}"`).all()]));
}

function savedObjects(db: DatabaseSync) {
  return db
    .prepare(
      "SELECT name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' AND (name LIKE '%channel_saved%' OR name = 'channel_messages_pinned') ORDER BY name",
    )
    .all();
}

function expectHealthy(db: DatabaseSync): void {
  expect(db.prepare("SELECT MAX(version) AS version FROM schema_migrations").get()).toEqual({ version: 56 });
  expect(db.prepare("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 });
  expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  expect(db.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
}

describe("channel saved items migration", () => {
  it.each(Array.from({ length: 46 }, (_, index) => index + 8))(
    "preserves every row from released schema %i and starts with no saved item",
    (version) => {
      const db = databaseAt(version);
      if (version < 18) migrateUpTo(db, 18);
      seedChannel(db);
      if (version < 53) migrateUpTo(db, 53);
      const before = contents(db);
      migrateOpenBotDatabase(db);
      expect(contents(db)).toEqual({ ...before, projection_channel_saved: [], ...LOOP_TABLES });
      expectHealthy(db);
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
    migrateUpTo(db, 53);
    seedChannel(db);
    const before = contents(db);
    migrateOpenBotDatabase(db);
    expect(contents(db)).toEqual({ ...before, projection_channel_saved: [], ...LOOP_TABLES });
    expectHealthy(db);
  });

  it("rolls back the table, its indexes and the marker after a late failure, then retries", () => {
    const db = databaseAt(53);
    seedChannel(db);
    const before = contents(db);
    db.exec(`CREATE TEMP TRIGGER fail_marker BEFORE INSERT ON schema_migrations WHEN new.version=54
      BEGIN SELECT RAISE(ABORT, 'late failure'); END;`);
    expect(() => migrateOpenBotDatabase(db)).toThrow("migration to version 54 failed");
    expect(contents(db)).toEqual(before);
    expect(savedObjects(db)).toEqual([]);
    expect(db.prepare("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 });
    db.exec("DROP TRIGGER fail_marker");
    migrateOpenBotDatabase(db);
    expect(contents(db)).toEqual({ ...before, projection_channel_saved: [], ...LOOP_TABLES });
    expect(savedObjects(db)).toHaveLength(4);
    expectHealthy(db);
  });

  it("rejects newer and incomplete migration histories before it creates the table", () => {
    const db = databaseAt(53);
    seedChannel(db);
    const before = contents(db);
    db.exec("INSERT INTO schema_migrations VALUES(57,'now')");
    expect(() => migrateOpenBotDatabase(db)).toThrow("newer than this application supports");
    db.exec("DELETE FROM schema_migrations WHERE version=57; DELETE FROM schema_migrations WHERE version=20");
    expect(() => migrateOpenBotDatabase(db)).toThrow("missing version 20");
    expect(contents(db)).toEqual(before);
    expect(savedObjects(db)).toEqual([]);
  });

  it("refuses a saved row of a missing channel, an unknown state and a repeat; the pins query uses its index", () => {
    const db = databaseAt(53);
    seedChannel(db);
    migrateOpenBotDatabase(db);
    const save = db.prepare("INSERT INTO projection_channel_saved VALUES (?, ?, ?, ?, ?)");
    save.run("alex", "launch", "first", "saved", "2026-01-01T00:00:00.000Z");
    expect(() => save.run("alex", "missing", "first", "saved", "2026-01-01")).toThrow("FOREIGN KEY constraint failed");
    expect(() => save.run("sam", "launch", "first", "later", "2026-01-01")).toThrow("CHECK constraint failed");
    expect(() => save.run("alex", "launch", "first", "done", "2026-01-01")).toThrow("UNIQUE constraint failed");
    const plan = db
      .prepare(
        `EXPLAIN QUERY PLAN SELECT message_json FROM projection_channel_messages
          WHERE channel_id = ? AND json_extract(message_json, '$.pinned') IS NOT NULL
          ORDER BY json_extract(message_json, '$.pinned.at') DESC`,
      )
      .all("launch")
      .map((row) => String(row.detail));
    expect(plan.join("\n")).toContain("channel_messages_pinned");
    expectHealthy(db);
  });
});
