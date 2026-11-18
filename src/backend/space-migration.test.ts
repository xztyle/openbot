// @vitest-environment node
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { migrateOpenBotDatabase } from "./openbot-database-schema";

// Failure modes: the upgrade changes or loses a row of any table; it puts an existing agent or channel
// in a space other than `general`; a failed upgrade leaves the tables or the marker; a retry fails on
// what the failed run left; a newer or incomplete history is accepted; an assignment names a space that
// does not exist, a kind that is not an agent or a channel, or a name that another space has.
const databases: DatabaseSync[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});

const GENERAL = { space_id: "general", name: "General", slug: "general", icon: null, hue: null, position: 0 };
const NEW_TABLES = {
  spaces: [GENERAL],
  space_assignments: [],
  projection_channel_thread_follows: [],
  projection_channel_thread_reads: [],
  projection_channel_saved: [],
};

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

/** An agent and its thread, which every released schema has. */
function seedAgent(db: DatabaseSync): void {
  db.prepare(`INSERT INTO projection_agents (agent_id, thread_id, model, updated_at, sort_order, agent_json,
    last_event_sequence) VALUES ('chief', 'openbot-thread-chief', 'gpt-5', '2026-01-01', 0,
    '{"id":"chief","name":"Chief 界"}', 1)`).run();
}

/** A channel, from schema 18 on. */
function seedChannel(db: DatabaseSync): void {
  db.prepare(`INSERT INTO projection_channels (channel_id, channel_json)
    VALUES ('channel-1', '{"id":"channel-1","name":"launch","members":[{"agentId":"chief"}]}')`).run();
}

function seed(db: DatabaseSync, version: number): void {
  seedAgent(db);
  if (version >= 18) seedChannel(db);
}

function releasedDatabase(tag: string, marker: number): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  databases.push(db);
  db.exec(readFileSync(new URL(`./released-schemas/${tag}.sql`, import.meta.url), "utf8"));
  db.prepare("INSERT INTO schema_migrations(version, applied_at) VALUES (?, '2026-01-01')").run(marker);
  seedAgent(db);
  return db;
}

/** Every row of every table, by table name. */
function contents(db: DatabaseSync): Record<string, unknown[]> {
  const tables = db
    .prepare(
      `SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'
       AND name <> 'schema_migrations' AND name NOT LIKE 'agent_memory_search%' AND name NOT LIKE 'channel_message_search%' ORDER BY name`,
    )
    .all()
    .map((row) => String(row.name));
  return Object.fromEntries(tables.map((table) => [table, db.prepare(`SELECT * FROM "${table}"`).all()]));
}

function spaceTables(db: DatabaseSync) {
  return db.prepare("SELECT name FROM sqlite_master WHERE name LIKE 'space%' ORDER BY name").all();
}

function expectHealthy(db: DatabaseSync): void {
  expect(db.prepare("SELECT MAX(version) AS version FROM schema_migrations").get()).toEqual({ version: 54 });
  expect(db.prepare("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 });
  expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  expect(db.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
}

describe("space migration", () => {
  it.each(Array.from({ length: 42 }, (_, index) => index + 8))(
    "preserves every row from released schema %i and keeps every item in general",
    (version) => {
      const db = databaseAt(version);
      seed(db, version);
      // The earlier migrations run first; the rows after them are what v50 must keep.
      if (version < 49) migrateUpTo(db, 49);
      if (version < 18) seedChannel(db);
      const before = contents(db);
      migrateOpenBotDatabase(db);
      expect(contents(db)).toEqual({ ...before, ...NEW_TABLES });
      expectHealthy(db);
    },
  );

  it.each([
    ["v0.1.12", 3],
    ["v0.1.15", 4],
    ["v0.1.18", 4],
    ["v0.2.1", 6],
  ] as const)("preserves every row from the %s snapshot", (tag, marker) => {
    const db = releasedDatabase(tag, marker);
    migrateUpTo(db, 49);
    const before = contents(db);
    migrateOpenBotDatabase(db);
    expect(contents(db)).toEqual({ ...before, ...NEW_TABLES });
    expectHealthy(db);
  });

  it("gives a new database the general space", () => {
    const db = new DatabaseSync(":memory:");
    databases.push(db);
    migrateOpenBotDatabase(db);
    expect(db.prepare("SELECT * FROM spaces").all()).toEqual([GENERAL]);
    expectHealthy(db);
  });

  it("rolls back the tables, the general space and the marker after a late failure, then retries", () => {
    const db = databaseAt(49);
    seed(db, 49);
    const before = contents(db);
    db.exec(`CREATE TEMP TRIGGER fail_marker BEFORE INSERT ON schema_migrations WHEN new.version=50
      BEGIN SELECT RAISE(ABORT, 'late failure'); END;`);
    expect(() => migrateOpenBotDatabase(db)).toThrow("migration to version 50 failed");
    expect(contents(db)).toEqual(before);
    expect(spaceTables(db)).toEqual([]);
    expect(db.prepare("SELECT version FROM schema_migrations WHERE version=50").all()).toEqual([]);
    expect(db.prepare("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 });
    db.exec("DROP TRIGGER fail_marker");
    migrateOpenBotDatabase(db);
    expect(contents(db)).toEqual({ ...before, ...NEW_TABLES });
    expectHealthy(db);
  });

  it("rejects newer and incomplete migration histories before it creates the tables", () => {
    const db = databaseAt(49);
    seed(db, 49);
    const before = contents(db);
    db.exec("INSERT INTO schema_migrations VALUES(55,'now')");
    expect(() => migrateOpenBotDatabase(db)).toThrow("newer than this application supports");
    db.exec("DELETE FROM schema_migrations WHERE version=55; DELETE FROM schema_migrations WHERE version=20");
    expect(() => migrateOpenBotDatabase(db)).toThrow("missing version 20");
    expect(contents(db)).toEqual(before);
    expect(spaceTables(db)).toEqual([]);
  });

  it("refuses an assignment to a missing space, an unknown kind, a repeated item and a repeated name", () => {
    const db = databaseAt(49);
    migrateOpenBotDatabase(db);
    const space = db.prepare(
      "INSERT INTO spaces (space_id, name, slug, icon, hue, position) VALUES (?, ?, ?, ?, ?, ?)",
    );
    const assign = db.prepare("INSERT INTO space_assignments (kind, item_id, space_id) VALUES (?, ?, ?)");
    space.run("trading", "Trading", "trading", "📈", 215, 1);
    expect(() => space.run("trading-2", "TRADING", "trading-2", null, null, 2)).toThrow("UNIQUE constraint failed");
    expect(() => space.run("trading-3", "Other", "trading", null, null, 3)).toThrow("UNIQUE constraint failed");
    expect(() => space.run("odd", "Odd", "odd", null, 10, 4)).toThrow("CHECK constraint failed");
    expect(() => space.run("empty", "", "empty", null, null, 5)).toThrow("CHECK constraint failed");
    expect(() => assign.run("agent", "chief", "missing")).toThrow("FOREIGN KEY constraint failed");
    expect(() => assign.run("routine", "chief", "trading")).toThrow("CHECK constraint failed");
    assign.run("agent", "chief", "trading");
    expect(() => assign.run("agent", "chief", "general")).toThrow("UNIQUE constraint failed");
    assign.run("channel", "chief", "general");
    expect(() => db.prepare("DELETE FROM spaces WHERE space_id = 'trading'").run()).toThrow(
      "FOREIGN KEY constraint failed",
    );
    expectHealthy(db);
  });
});
