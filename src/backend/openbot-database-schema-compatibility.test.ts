// @vitest-environment node

// Failure modes: the fork and upstream shipped different migrations under the same version numbers. The
// fork shipped event checks at 31 and a compatibility migration at 32; upstream shipped routine flows at
// 31 and agent memory selection at 32. A fork 32 database can skip upstream's 32 because its version
// says it ran, lose its event checks or other saved rows, or differ from a new install. A failed DDL,
// marker, or foreign-key check can leave partial tables or a false marker. A downgrade, missing history,
// a version 32 that matches neither side, or a corrupt saved constraint must stop startup safely.
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { migrateOpenBotDatabase } from "./openbot-database-schema";
import fork31 from "./openbot-database-schema-fork31.fixture.json";
import fork32 from "./openbot-database-schema-fork32.fixture.json";
import schemaHistory from "./openbot-database-schema-history.json";

const sourceAt = "2026-10-08T10:00:00.000Z";
const appliedAt = "2026-10-09T10:00:00.000Z";
const latestVersion = 47;
const connections: DatabaseSync[] = [];
const sources = ["upstream 31", "fork 31", "fork 32", "upstream 32", "upstream 46"] as const;
type Source = (typeof sources)[number];
type Rows = ReturnType<ReturnType<DatabaseSync["prepare"]>["all"]>;

afterEach(() => {
  for (const connection of connections.splice(0)) connection.close();
});

describe.each(sources)("OpenBot schema %s", (source) => {
  it("keeps every saved row and old marker, and reaches the new-install schema", () => {
    const database = sourceDatabase(source);
    const before = captureRows(database);
    const markers = readMarkers(database);
    const fresh = openDatabase();
    migrateOpenBotDatabase(fresh, { appliedAt });

    migrateOpenBotDatabase(database, { appliedAt });

    expectCapturedRows(database, before);
    expect(readMarkers(database)).toEqual([...markers, ...newMarkers(source)]);
    expect(readDeclarations(database)).toEqual(readDeclarations(fresh));
    expectHealthy(database);
    const after = captureRows(database);
    migrateOpenBotDatabase(database, { appliedAt: "2026-10-10T10:00:00.000Z" });
    expectCapturedRows(database, after);
    expect(readMarkers(database)).toEqual([...markers, ...newMarkers(source)]);
  });

  it.runIf(ddlConflict(source))("rolls back a failed DDL write and preserves data on retry", () => {
    const conflict = ddlConflict(source) ?? "";
    const database = sourceDatabase(source);
    database.exec(`CREATE TABLE ${quote(conflict)} (saved TEXT)`);
    const before = captureRows(database);
    const declarations = readDeclarations(database);
    const markers = readMarkers(database);

    expect(() => migrateOpenBotDatabase(database, { appliedAt })).toThrow(
      `migration to version ${firstStep(source)} failed`,
    );

    expectCapturedRows(database, before);
    expect(readDeclarations(database)).toEqual(declarations);
    expect(readMarkers(database)).toEqual(markers);
    expect(database.isTransaction).toBe(false);
    expectHealthy(database);
    database.exec(`DROP TABLE ${quote(conflict)}`);
    migrateOpenBotDatabase(database, { appliedAt });
    expectCapturedRows(
      database,
      before.filter(({ table }) => table !== conflict),
    );
    expect(readMarkers(database)).toEqual([...markers, ...newMarkers(source)]);
    expectHealthy(database);
  });

  it("rolls back a failed marker write and preserves data on retry", () => {
    const database = sourceDatabase(source);
    const rejected = firstMarker(source);
    database.exec(`
      CREATE TEMP TRIGGER reject_marker BEFORE INSERT ON schema_migrations
      WHEN NEW.version = ${rejected} BEGIN SELECT RAISE(ABORT, 'reject the marker'); END;
    `);
    const before = captureRows(database);
    const declarations = readDeclarations(database);
    const markers = readMarkers(database);

    expect(() => migrateOpenBotDatabase(database, { appliedAt })).toThrow(`migration to version ${rejected} failed`);

    expectCapturedRows(database, before);
    expect(readMarkers(database)).toEqual(markers);
    expect(database.isTransaction).toBe(false);
    if (source === "fork 32") {
      // Upstream's 32 committed on its own; only the marker 33 transaction rolled back.
      const added = Object.keys(readDeclarations(database)).filter((key) => !Object.hasOwn(declarations, key));
      expect(added.sort()).toEqual(Object.keys(schemaHistory["32"]).sort());
    } else expect(readDeclarations(database)).toEqual(declarations);
    expectHealthy(database);
    database.exec("DROP TRIGGER temp.reject_marker");
    migrateOpenBotDatabase(database, { appliedAt });
    expectCapturedRows(database, before);
    expect(readMarkers(database)).toEqual([...markers, ...newMarkers(source)]);
    expectHealthy(database);
  });

  it.each(["newer", "missing"] as const)("rejects %s history without changing saved rows or schema", (invalid) => {
    const database = sourceDatabase(source);
    if (invalid === "newer")
      database.prepare("INSERT INTO schema_migrations VALUES (?, ?)").run(latestVersion + 1, sourceAt);
    else database.exec("DELETE FROM schema_migrations WHERE version = 29");
    const before = captureRows(database);
    const declarations = readDeclarations(database);
    const markers = readMarkers(database);

    expect(() => migrateOpenBotDatabase(database, { appliedAt })).toThrow(
      invalid === "newer" ? "newer than this application supports" : "migration history is missing version 29",
    );

    expectCapturedRows(database, before);
    expect(readDeclarations(database)).toEqual(declarations);
    expect(readMarkers(database)).toEqual(markers);
    expectHealthy(database);
  });

  it("rolls back on an existing foreign-key violation and succeeds after its repair", () => {
    const database = sourceDatabase(source);
    database.exec("PRAGMA foreign_keys = OFF");
    insertOrphan(database, orphanGroup(source));
    database.exec("PRAGMA foreign_keys = ON");
    const before = captureRows(database);
    const declarations = readDeclarations(database);
    const markers = readMarkers(database);

    expect(() => migrateOpenBotDatabase(database, { appliedAt })).toThrow(
      `migration to version ${firstStep(source)} failed`,
    );

    expectCapturedRows(database, before);
    expect(readDeclarations(database)).toEqual(declarations);
    expect(readMarkers(database)).toEqual(markers);
    expect(database.prepare("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 });
    removeOrphan(database, orphanGroup(source));
    const repaired = captureRows(database);
    migrateOpenBotDatabase(database, { appliedAt });
    expectCapturedRows(database, repaired);
    expect(readMarkers(database)).toEqual([...markers, ...newMarkers(source)]);
    expectHealthy(database);
  });

  it("stops startup on corrupt saved constraints and keeps the rows for repair", () => {
    const database = sourceDatabase(source);
    const group = orphanGroup(source);
    database.exec("PRAGMA ignore_check_constraints = ON");
    setConstraintValue(database, group, false);
    database.exec("PRAGMA ignore_check_constraints = OFF");
    const before = captureRows(database);

    expect(() => migrateOpenBotDatabase(database, { appliedAt })).toThrow("failed its integrity check");

    expectCapturedRows(database, before);
    expect(database.isTransaction).toBe(false);
    expect(database.prepare("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 });
    setConstraintValue(database, group, true);
    const repaired = captureRows(database);
    migrateOpenBotDatabase(database, { appliedAt });
    expectCapturedRows(database, repaired);
    expectHealthy(database);
  });

  it("enforces foreign keys for every table group after the upgrade", () => {
    const database = sourceDatabase(source);
    migrateOpenBotDatabase(database, { appliedAt });
    for (const group of ["routine flows", "event checks", "agent memory"] as const) {
      expect(() => insertOrphan(database, group)).toThrow("FOREIGN KEY constraint failed");
    }
    expectHealthy(database);
  });
});

describe("OpenBot schema fork 32", () => {
  it("indexes and selects the saved agent memories and keeps every event check row", () => {
    const database = sourceDatabase("fork 32");
    const checks = readEventCheckRows(database);
    expect(checks.map(({ rows }) => rows.length)).toEqual([1, 1, 1]);

    migrateOpenBotDatabase(database, { appliedAt });

    expect(readEventCheckRows(database)).toEqual(checks);
    expect(
      database
        .prepare("SELECT memory_id, inclusion, user_controlled FROM agent_memory_selections ORDER BY memory_id")
        .all(),
    ).toEqual([
      { memory_id: "saved-memory-1", inclusion: "essential", user_controlled: 0 },
      { memory_id: "saved-memory-2", inclusion: "essential", user_controlled: 0 },
    ]);
    expect(
      database
        .prepare(`SELECT memory.memory_id FROM agent_memory_search search
          JOIN projection_agent_memories memory ON memory.rowid = search.rowid
          WHERE agent_memory_search MATCH 'invoices'`)
        .all(),
    ).toEqual([{ memory_id: "saved-memory-2" }]);
    expectHealthy(database);
  });

  it.each([
    ["without an event check table", "DROP TABLE projection_event_check_outbox"],
    ["with only part of upstream's 32", "CREATE TABLE agent_memory_selections (memory_id TEXT PRIMARY KEY)"],
  ])("refuses a version 32 %s and changes nothing", (_, change) => {
    const database = sourceDatabase("fork 32");
    database.exec(change);
    const before = captureRows(database);
    const declarations = readDeclarations(database);
    const markers = readMarkers(database);

    expect(() => migrateOpenBotDatabase(database, { appliedAt })).toThrow(
      "has neither upstream's agent memory tables nor the fork's event check and routine flow tables",
    );

    expectCapturedRows(database, before);
    expect(readDeclarations(database)).toEqual(declarations);
    expect(readMarkers(database)).toEqual(markers);
    expectHealthy(database);
  });
});

describe("OpenBot schema new install", () => {
  it("creates the latest schema with the event check tables and every marker", () => {
    const database = openDatabase();
    migrateOpenBotDatabase(database, { appliedAt });

    expect(readMarkers(database)).toEqual(
      range(8, latestVersion).map((version) => ({ version, applied_at: appliedAt })),
    );
    for (const key of Object.keys(fork32.declarations)) expect(readDeclarations(database)).toHaveProperty([key]);
    seedEventCheckRows(database);
    expectHealthy(database);
  });
});

function openDatabase(): DatabaseSync {
  const database = new DatabaseSync(":memory:");
  connections.push(database);
  database.exec("PRAGMA foreign_keys = ON");
  return database;
}

/** A database the real migrations built up to `version`, as an install on that version has. */
function migratedTo(version: number): DatabaseSync {
  const database = openDatabase();
  database.exec(`
    CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
    CREATE TEMP TRIGGER stop_at_source BEFORE INSERT ON schema_migrations
    WHEN NEW.version > ${version} BEGIN SELECT RAISE(ABORT, 'fixture stops at its source version'); END;
  `);
  expect(() => migrateOpenBotDatabase(database, { appliedAt: sourceAt })).toThrow(
    `migration to version ${version + 1} failed`,
  );
  database.exec("DROP TRIGGER temp.stop_at_source");
  return database;
}

// The released 31 and 32 shapes are frozen declarations, not the current schema constants under test.
function sourceDatabase(source: Source): DatabaseSync {
  const database =
    source === "upstream 32" ? migratedTo(32) : source === "upstream 46" ? migratedTo(46) : migratedTo(30);
  if (source === "upstream 31" || source === "fork 32") applyDeclarations(database, schemaHistory["31"]);
  if (source === "fork 31") applyDeclarations(database, fork31.declarations);
  if (source === "fork 32") applyDeclarations(database, fork32.declarations);
  if (source === "upstream 31" || source === "fork 31" || source === "fork 32")
    database.prepare("INSERT INTO schema_migrations VALUES (31, ?)").run(sourceAt);
  if (source === "fork 32") database.prepare("INSERT INTO schema_migrations VALUES (32, ?)").run(sourceAt);
  seedCommonRows(database);
  if (source !== "fork 31") seedRoutineFlowRows(database);
  if (source.startsWith("fork")) seedEventCheckRows(database);
  expectHealthy(database);
  return database;
}

function applyDeclarations(database: DatabaseSync, declarations: Record<string, string>): void {
  for (const kind of ["table", "index"]) {
    for (const [key, sql] of Object.entries(declarations)) {
      if (key.startsWith(`${kind} `)) database.exec(sql);
    }
  }
}

/** The markers an upgrade from `source` adds: the fork's 32 already holds a marker 32. */
function newMarkers(source: Source): Rows {
  return range(firstMarker(source), latestVersion).map((version) => ({ version, applied_at: appliedAt }));
}

function firstMarker(source: Source): number {
  return { "upstream 31": 32, "fork 31": 32, "fork 32": 33, "upstream 32": 33, "upstream 46": 47 }[source];
}

/** The first step of an upgrade: for the fork's 32 that is upstream's 32, which it has no marker for. */
function firstStep(source: Source): number {
  return source === "fork 32" ? 32 : firstMarker(source);
}

/** A table whose name the first step creates without IF NOT EXISTS, so a table there fails it. */
function ddlConflict(source: Source): string | undefined {
  if (source === "upstream 32") return undefined;
  return source === "upstream 46" ? "event_check_outbox_pending" : "agent_memory_search_data";
}

type TableGroup = "routine flows" | "event checks" | "agent memory";

function orphanGroup(source: Source): TableGroup {
  return source.startsWith("fork") ? "event checks" : "routine flows";
}

function seedCommonRows(database: DatabaseSync): void {
  database.exec(`
    INSERT INTO orchestration_events (event_id, command_id, aggregate_type, aggregate_id, event_type,
      occurred_at, payload_json) VALUES ('saved-event', 'saved-command', 'agent', 'saved-agent',
      'agents.imported', '${sourceAt}', '{"saved":true}');
    INSERT INTO projection_agents (agent_id, thread_id, model, updated_at, sort_order, agent_json,
      last_event_sequence) VALUES ('saved-agent', 'saved-thread', 'saved-model', '${sourceAt}', 0,
      '{"name":"Saved agent"}', 1);
    INSERT INTO projection_threads (thread_id, agent_id, title, created_at, updated_at, last_event_sequence)
      VALUES ('saved-thread', 'saved-agent', 'Saved conversation', '${sourceAt}', '${sourceAt}', 1);
    INSERT INTO projection_thread_messages (thread_id, message_id, turn_id, author, status, item_type,
      created_at, ordinal, message_json, last_event_sequence) VALUES ('saved-thread', 'saved-message',
      NULL, 'user', 'completed', NULL, '${sourceAt}', 0, '{"text":"Keep my conversation"}', 1);
    INSERT INTO projection_agent_routines (routine_id, agent_id, name, instruction, active, timezone,
      created_at, updated_at, last_event_sequence) VALUES ('saved-routine', 'saved-agent', 'Saved routine',
      'Keep my work', 1, 'UTC', '${sourceAt}', '${sourceAt}', 1);
    INSERT INTO projection_routine_runs (run_id, routine_id, agent_id, trigger_id, run_kind, scheduled_for,
      routine_name, instruction, delivery_id, status, error, created_at, updated_at, last_event_sequence)
      VALUES ('saved-run', 'saved-routine', 'saved-agent', NULL, 'manual', '${sourceAt}', 'Saved routine',
      'Saved input', NULL, 'succeeded', NULL, '${sourceAt}', '${sourceAt}', 1);
    INSERT INTO projection_agent_memories (memory_id, agent_id, text, normalized_text, origin, source_turn_id,
      created_at, updated_at, last_event_sequence) VALUES
      ('saved-memory-1', 'saved-agent', 'Prefers short answers', 'prefers short answers', 'manual', NULL,
        '${sourceAt}', '${sourceAt}', 1),
      ('saved-memory-2', 'saved-agent', 'Sends invoices on Fridays', 'sends invoices on fridays', 'automatic',
        NULL, '${sourceAt}', '${sourceAt}', 1);
  `);
}

function seedRoutineFlowRows(database: DatabaseSync): void {
  database.exec(`
    INSERT INTO routine_flow_links (link_id, routine_id, from_agent_id, to_agent_id, instruction, created_at)
      VALUES ('saved-link', 'saved-routine', 'saved-agent', 'saved-recipient', 'Saved handoff', '${sourceAt}');
    INSERT INTO routine_flow_positions (canvas_agent_id, node_key, x, y, updated_at)
      VALUES ('saved-agent', 'agent:saved-recipient', 40.5, -90.25, '${sourceAt}');
    INSERT INTO routine_flow_steps (step_id, run_id, agent_id, delivery_id, input, output, status,
      error, created_at, updated_at) VALUES ('saved-step', 'saved-run', 'saved-recipient', 'saved-delivery',
      'Saved step input', 'Saved step answer', 'succeeded', NULL, '${sourceAt}', '${sourceAt}');
  `);
}

function seedEventCheckRows(database: DatabaseSync): void {
  database.exec(`
    INSERT INTO projection_event_checks (check_id, agent_id, definition_json, active, next_check_at,
      baseline_json, last_success_at, revision) VALUES ('saved-check', 'saved-agent',
      '{"name":"Saved check"}', 1, '${sourceAt}', '{"ids":["seen-event"]}', '${sourceAt}', 'saved-revision');
    INSERT INTO projection_event_check_executions (execution_id, check_id, started_at, result_json)
      VALUES ('saved-execution', 'saved-check', '${sourceAt}', '{"status":"changed"}');
    INSERT INTO projection_event_check_outbox (event_id, check_id, revision, payload_json, created_at, delivery_id)
      VALUES ('saved-outbox', 'saved-check', 'saved-revision', '{"ids":["new-event"]}', '${sourceAt}', NULL);
  `);
}

function readEventCheckRows(database: DatabaseSync): { table: string; rows: Rows }[] {
  return ["projection_event_checks", "projection_event_check_executions", "projection_event_check_outbox"].map(
    (table) => ({ table, rows: database.prepare(`SELECT * FROM ${quote(table)} ORDER BY rowid`).all() }),
  );
}

function insertOrphan(database: DatabaseSync, group: TableGroup): void {
  if (group === "routine flows")
    database.exec(`INSERT INTO routine_flow_steps (step_id, run_id, agent_id, input, status, created_at, updated_at)
      VALUES ('orphan-step', 'missing-run', 'saved-agent', 'Saved input', 'running', '${sourceAt}', '${sourceAt}')`);
  else if (group === "event checks")
    database.exec(`INSERT INTO projection_event_check_executions (execution_id, check_id, started_at, result_json)
      VALUES ('orphan-execution', 'missing-check', '${sourceAt}', '{"status":"empty"}')`);
  else database.exec("INSERT INTO agent_memory_selections (memory_id) VALUES ('missing-memory')");
}

function removeOrphan(database: DatabaseSync, group: TableGroup): void {
  database.exec(
    group === "routine flows"
      ? "DELETE FROM routine_flow_steps WHERE step_id = 'orphan-step'"
      : "DELETE FROM projection_event_check_executions WHERE execution_id = 'orphan-execution'",
  );
}

function setConstraintValue(database: DatabaseSync, group: TableGroup, valid: boolean): void {
  database.exec(
    group === "routine flows"
      ? `UPDATE routine_flow_steps SET status = '${valid ? "succeeded" : "invalid"}' WHERE step_id = 'saved-step'`
      : `UPDATE projection_event_checks SET active = ${valid ? 1 : 2} WHERE check_id = 'saved-check'`,
  );
}

interface CapturedTable {
  table: string;
  columns: string[];
  rows: Rows;
}

// Later migrations add columns, so only the columns a table had before are compared. The full-text index's
// own tables hold its encoded pages rather than saved rows.
function captureRows(database: DatabaseSync): CapturedTable[] {
  return database
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
      AND name != 'schema_migrations' AND name NOT LIKE 'agent_memory_search%' ORDER BY name`)
    .all()
    .map(({ name }) => {
      if (typeof name !== "string") throw new Error("Invalid fixture table name.");
      const columns = database
        .prepare(`PRAGMA table_info(${quote(name)})`)
        .all()
        .map(({ name: column }) => {
          if (typeof column !== "string") throw new Error("Invalid fixture column name.");
          return column;
        });
      const selected = columns.map(quote).join(", ");
      return {
        table: name,
        columns,
        rows: database.prepare(`SELECT ${selected} FROM ${quote(name)} ORDER BY rowid`).all(),
      };
    });
}

function expectCapturedRows(database: DatabaseSync, before: CapturedTable[]): void {
  for (const { table, columns, rows } of before) {
    const selected = columns.map(quote).join(", ");
    expect(database.prepare(`SELECT ${selected} FROM ${quote(table)} ORDER BY rowid`).all(), table).toEqual(rows);
  }
}

function readMarkers(database: DatabaseSync): Rows {
  return database.prepare("SELECT version, applied_at FROM schema_migrations ORDER BY version").all();
}

function readDeclarations(database: DatabaseSync): Record<string, readonly string[]> {
  return Object.fromEntries(
    database
      .prepare(`SELECT type, name, sql FROM sqlite_master WHERE sql IS NOT NULL
        AND name NOT LIKE 'sqlite_%' AND name != 'schema_migrations' ORDER BY type, name`)
      .all()
      .map(({ type, name, sql }) => {
        if (typeof name !== "string" || typeof sql !== "string") throw new Error("Invalid fixture declaration.");
        const tokens =
          sql.replace(/\bIF NOT EXISTS\b/gi, "").match(/'(?:''|[^'])*'|"(?:""|[^"])*"|\w+|<>|>=|[^\s]/g) ?? [];
        return [
          `${type} ${name.toLowerCase()}`,
          tokens.map((token) => (token.startsWith("'") ? token : token.replaceAll('"', "").toUpperCase())),
        ];
      }),
  );
}

function expectHealthy(database: DatabaseSync): void {
  expect(database.prepare("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 });
  expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  expect(database.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
}

function range(from: number, to: number): number[] {
  return Array.from({ length: to - from + 1 }, (_, index) => from + index);
}

function quote(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}
