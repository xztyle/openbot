// @vitest-environment node
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { migrateOpenBotDatabase } from "./openbot-database-schema";

// Failure modes: the upgrade changes or loses a row of any table; the index misses a stored message or
// finds a deleted, streaming, empty or activity one; a later insert, edit, deletion or completion of a
// streaming answer leaves the index behind; a failed upgrade leaves the index, its triggers or the
// marker; a retry fails on what the failed run left; a newer or incomplete history is accepted.
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

interface Body {
  text: string;
  status?: string;
  itemType?: string;
  deletedAt?: string;
  threadRootId?: string;
}

function json(id: string, sequence: number, body: Body): string {
  return JSON.stringify({
    id,
    channelId: "launch",
    sequence,
    author: { kind: "member", id: "alex", name: "Alex" },
    ...(body.deletedAt ? { deletedAt: body.deletedAt } : {}),
    ...(body.threadRootId ? { threadRootId: body.threadRootId } : {}),
    message: {
      id,
      text: body.text,
      createdAt: "2026-01-01T00:00:00.000Z",
      status: body.status ?? "completed",
      ...(body.itemType ? { itemType: body.itemType } : {}),
    },
  });
}

const insert = (db: DatabaseSync, id: string, sequence: number, body: Body) =>
  db
    .prepare("INSERT INTO projection_channel_messages VALUES ('launch', ?, ?, ?)")
    .run(id, sequence, json(id, sequence, body));
const update = (db: DatabaseSync, id: string, sequence: number, body: Body) =>
  db
    .prepare("UPDATE projection_channel_messages SET message_json = ? WHERE channel_id = 'launch' AND message_id = ?")
    .run(json(id, sequence, body), id);

/** A channel with a message of each kind the index decides on. */
function seedChannel(db: DatabaseSync): void {
  db.prepare(`INSERT INTO projection_channels (channel_id, channel_json)
    VALUES ('launch', '{"id":"launch","name":"launch","members":[]}')`).run();
  insert(db, "plain", 1, { text: "The Café menu is ready" });
  insert(db, "reply", 2, { text: "Menu prices need review", threadRootId: "plain" });
  insert(db, "streaming", 3, { text: "Menu draft half", status: "streaming" });
  insert(db, "deleted", 4, { text: "Menu secret", deletedAt: "2026-01-02T00:00:00.000Z" });
  insert(db, "plan", 5, { text: "Menu plan step", itemType: "plan" });
  insert(db, "routing", 6, { text: "Menu routing", itemType: "channel-routing-event:x" });
  insert(db, "empty", 7, { text: "   " });
}

/** The message ids that a full-text query finds, in id order. */
function found(db: DatabaseSync, query: string): string[] {
  return db
    .prepare(
      `SELECT message.message_id FROM channel_message_search search
         JOIN projection_channel_messages message ON message.rowid = search.rowid
        WHERE channel_message_search MATCH ? ORDER BY message.message_id`,
    )
    .all(query)
    .map((row) => String(row.message_id));
}

/** Every row of every table but the index, by table name. */
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

function searchObjects(db: DatabaseSync) {
  return db
    .prepare("SELECT type, name FROM sqlite_master WHERE name LIKE 'channel_message_search%' ORDER BY name")
    .all();
}

function expectHealthy(db: DatabaseSync): void {
  expect(db.prepare("SELECT MAX(version) AS version FROM schema_migrations").get()).toEqual({ version: 53 });
  expect(db.prepare("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 });
  expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  expect(db.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
  expect(() =>
    db.exec("INSERT INTO channel_message_search(channel_message_search) VALUES ('integrity-check')"),
  ).not.toThrow();
}

describe("channel search migration", () => {
  // Channels exist from schema 18 on; an older database reaches 18 before the seed.
  it.each(Array.from({ length: 45 }, (_, index) => index + 8))(
    "preserves every row from released schema %i and indexes each stored message a person can find",
    (version) => {
      const db = databaseAt(version);
      if (version < 18) migrateUpTo(db, 18);
      seedChannel(db);
      if (version < 52) migrateUpTo(db, 52);
      const before = contents(db);
      migrateOpenBotDatabase(db);
      expect(contents(db)).toEqual(before);
      expect(found(db, "menu")).toEqual(["plain", "reply"]);
      // Diacritics fold: "cafe" finds "Café".
      expect(found(db, "cafe")).toEqual(["plain"]);
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
    migrateUpTo(db, 52);
    seedChannel(db);
    const before = contents(db);
    migrateOpenBotDatabase(db);
    expect(contents(db)).toEqual(before);
    expect(found(db, "menu")).toEqual(["plain", "reply"]);
    expectHealthy(db);
  });

  it("keeps the index in step with each later write", () => {
    const db = databaseAt(52);
    seedChannel(db);
    migrateOpenBotDatabase(db);
    insert(db, "later", 8, { text: "Launch checklist" });
    expect(found(db, "checklist")).toEqual(["later"]);
    update(db, "later", 8, { text: "Launch timeline" });
    expect(found(db, "checklist")).toEqual([]);
    expect(found(db, "timeline")).toEqual(["later"]);
    // A streaming answer is found once it completes, with its final text.
    update(db, "streaming", 3, { text: "Menu draft complete", status: "completed" });
    expect(found(db, "complete")).toEqual(["streaming"]);
    // A reaction or a summary changes the row but not its text: the index keeps it.
    update(db, "plain", 1, { text: "The Café menu is ready" });
    expect(found(db, "cafe")).toEqual(["plain"]);
    update(db, "plain", 1, { text: "The Café menu is ready", deletedAt: "2026-01-03T00:00:00.000Z" });
    expect(found(db, "cafe")).toEqual([]);
    db.prepare("DELETE FROM projection_channel_messages WHERE message_id = 'reply'").run();
    expect(found(db, "prices")).toEqual([]);
    expect(found(db, "menu")).toEqual(["streaming"]);
    expectHealthy(db);
  });

  it("gives a new database the index and its triggers", () => {
    const db = new DatabaseSync(":memory:");
    databases.push(db);
    migrateOpenBotDatabase(db);
    db.prepare(`INSERT INTO projection_channels (channel_id, channel_json) VALUES ('launch', '{"id":"launch"}')`).run();
    insert(db, "first", 1, { text: "Hello team" });
    expect(found(db, "hello")).toEqual(["first"]);
    expectHealthy(db);
  });

  it("rolls back the index, its triggers and the marker after a late failure, then retries", () => {
    const db = databaseAt(52);
    seedChannel(db);
    const before = contents(db);
    db.exec(`CREATE TEMP TRIGGER fail_marker BEFORE INSERT ON schema_migrations WHEN new.version=53
      BEGIN SELECT RAISE(ABORT, 'late failure'); END;`);
    expect(() => migrateOpenBotDatabase(db)).toThrow("migration to version 53 failed");
    expect(contents(db)).toEqual(before);
    expect(searchObjects(db)).toEqual([]);
    expect(db.prepare("SELECT version FROM schema_migrations WHERE version=53").all()).toEqual([]);
    expect(db.prepare("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 });
    db.exec("DROP TRIGGER fail_marker");
    migrateOpenBotDatabase(db);
    expect(contents(db)).toEqual(before);
    expect(found(db, "menu")).toEqual(["plain", "reply"]);
    expectHealthy(db);
  });

  it("rejects newer and incomplete migration histories before it creates the index", () => {
    const db = databaseAt(52);
    seedChannel(db);
    const before = contents(db);
    db.exec("INSERT INTO schema_migrations VALUES(54,'now')");
    expect(() => migrateOpenBotDatabase(db)).toThrow("newer than this application supports");
    db.exec("DELETE FROM schema_migrations WHERE version=54; DELETE FROM schema_migrations WHERE version=20");
    expect(() => migrateOpenBotDatabase(db)).toThrow("missing version 20");
    expect(contents(db)).toEqual(before);
    expect(searchObjects(db)).toEqual([]);
  });
});
