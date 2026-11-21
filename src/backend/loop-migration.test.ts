// @vitest-environment node
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { migrateOpenBotDatabase } from "./openbot-database-schema";

// Failure modes: the upgrade to 55 changes or loses a row of any table; a failed upgrade leaves a loop
// table, an index or the marker; a retry fails on what the failed run left; a newer history is accepted;
// a loop row with a broken definition or an item of no loop is accepted.
const databases: DatabaseSync[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});

const LOOP_TABLES = { loops: [], loop_items: [], loop_events: [], loop_experiments: [], loop_decisions: [] };

function databaseAt(version: number): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  databases.push(db);
  db.exec("CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)");
  db.exec(`CREATE TEMP TRIGGER stop_at_version BEFORE INSERT ON schema_migrations WHEN new.version > ${version}
    BEGIN SELECT RAISE(ABORT, 'fixture stop'); END;`);
  expect(() => migrateOpenBotDatabase(db)).toThrow(`migration to version ${version + 1} failed`);
  db.exec("DROP TRIGGER stop_at_version");
  return db;
}

function seed(db: DatabaseSync): void {
  db.prepare(`INSERT INTO projection_channels (channel_id, channel_json)
    VALUES ('launch', '{"id":"launch","name":"launch","members":[]}')`).run();
  db.prepare(
    "INSERT INTO spaces (space_id, name, slug, icon, hue, position) VALUES ('uo', 'UO', 'uo', NULL, NULL, 1)",
  ).run();
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

function loopObjects(db: DatabaseSync) {
  return db.prepare("SELECT name FROM sqlite_master WHERE name LIKE 'loop%' ORDER BY name").all();
}

describe("loop migration", () => {
  it("keeps every row of schema 54 and starts with empty loop tables", () => {
    const db = databaseAt(54);
    seed(db);
    const before = contents(db);
    migrateOpenBotDatabase(db);
    expect(contents(db)).toEqual({ ...before, ...LOOP_TABLES });
    expect(loopObjects(db)).toHaveLength(12);
    expect(db.prepare("SELECT MAX(version) AS version FROM schema_migrations").get()).toEqual({ version: 55 });
    expect(db.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
  });

  it("rolls back the tables and the marker after a late failure, then retries", () => {
    const db = databaseAt(54);
    seed(db);
    const before = contents(db);
    db.exec(`CREATE TEMP TRIGGER fail_marker BEFORE INSERT ON schema_migrations WHEN new.version=55
      BEGIN SELECT RAISE(ABORT, 'late failure'); END;`);
    expect(() => migrateOpenBotDatabase(db)).toThrow("migration to version 55 failed");
    expect(contents(db)).toEqual(before);
    expect(loopObjects(db)).toEqual([]);
    db.exec("DROP TRIGGER fail_marker");
    migrateOpenBotDatabase(db);
    expect(contents(db)).toEqual({ ...before, ...LOOP_TABLES });
  });

  it("rejects a newer history before it creates a table", () => {
    const db = databaseAt(54);
    db.exec("INSERT INTO schema_migrations VALUES(56,'now')");
    expect(() => migrateOpenBotDatabase(db)).toThrow("newer than this application supports");
    expect(loopObjects(db)).toEqual([]);
  });

  it("refuses a definition that is not JSON and an item of no loop", () => {
    const db = databaseAt(54);
    migrateOpenBotDatabase(db);
    expect(() => db.prepare("INSERT INTO loops VALUES ('a', 'uo', NULL, 'not json', 1, 1)").run()).toThrow(
      "CHECK constraint failed",
    );
    expect(() =>
      db
        .prepare(
          "INSERT INTO loop_items (item_id, loop_id, title, stage_id, entered_at, created_at, updated_at) VALUES ('i', 'missing', 't', 's', 1, 1, 1)",
        )
        .run(),
    ).toThrow("FOREIGN KEY constraint failed");
  });
});
