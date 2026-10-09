// @vitest-environment node

// Failure modes: either released v31 shape can lose saved rows, miss the other tables, or differ
// from a new install. A failed DDL, marker, or foreign-key check can leave partial tables or a false
// marker. A downgrade, missing history, or corrupt saved constraint must stop startup safely.
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { migrateOpenBotDatabase } from "./openbot-database-schema";
import fork31 from "./openbot-database-schema-fork31.fixture.json";
import schemaHistory from "./openbot-database-schema-history.json";

const sourceAt = "2026-10-08T10:00:00.000Z";
const appliedAt = "2026-10-09T10:00:00.000Z";
const connections: DatabaseSync[] = [];
const sourceVariants = ["main", "fork"] as const;
type SourceVariant = (typeof sourceVariants)[number];
type Rows = ReturnType<ReturnType<DatabaseSync["prepare"]>["all"]>;

afterEach(() => {
  for (const connection of connections.splice(0)) connection.close();
});

describe.each(sourceVariants)("OpenBot schema 32 from released %s version 31", (variant) => {
  it("keeps every saved row and old marker, and reaches the new-install schema", () => {
    const database = releasedDatabase(variant);
    const before = captureRows(database);
    const markers = readMarkers(database);
    const fresh = openDatabase();
    migrateOpenBotDatabase(fresh, { appliedAt });

    migrateOpenBotDatabase(database, { appliedAt });

    expectCapturedRows(database, before);
    expect(readMarkers(database)).toEqual([...markers, { version: 32, applied_at: appliedAt }]);
    expect(readDeclarations(database)).toEqual(readDeclarations(fresh));
    expectHealthy(database);
    const after = captureRows(database);
    migrateOpenBotDatabase(database, { appliedAt: "2026-10-10T10:00:00.000Z" });
    expectCapturedRows(database, after);
    expect(readMarkers(database)).toEqual([...markers, { version: 32, applied_at: appliedAt }]);
  });

  it.each(["ddl", "marker"] as const)("rolls back a failed %s write and preserves data on retry", (failure) => {
    const database = releasedDatabase(variant);
    addFailure(database, variant, failure);
    const before = captureRows(database);
    const declarations = readDeclarations(database);
    const markers = readMarkers(database);

    expect(() => migrateOpenBotDatabase(database, { appliedAt })).toThrow("migration to version 32 failed");

    expectCapturedRows(database, before);
    expect(readDeclarations(database)).toEqual(declarations);
    expect(readMarkers(database)).toEqual(markers);
    expect(database.isTransaction).toBe(false);
    expectHealthy(database);
    removeFailure(database, variant, failure);
    migrateOpenBotDatabase(database, { appliedAt });
    expectCapturedRows(
      database,
      before.filter(({ table }) => table !== conflictingIndex(variant)),
    );
    expect(readMarkers(database)).toEqual([...markers, { version: 32, applied_at: appliedAt }]);
    expectHealthy(database);
  });

  it.each(["newer", "missing"] as const)("rejects %s history without changing saved rows or schema", (invalid) => {
    const database = releasedDatabase(variant);
    if (invalid === "newer") database.prepare("INSERT INTO schema_migrations VALUES (33, ?)").run(sourceAt);
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
    const database = releasedDatabase(variant);
    database.exec("PRAGMA foreign_keys = OFF");
    insertOrphan(database, variant);
    database.exec("PRAGMA foreign_keys = ON");
    const before = captureRows(database);
    const declarations = readDeclarations(database);
    const markers = readMarkers(database);

    expect(() => migrateOpenBotDatabase(database, { appliedAt })).toThrow("migration to version 32 failed");

    expectCapturedRows(database, before);
    expect(readDeclarations(database)).toEqual(declarations);
    expect(readMarkers(database)).toEqual(markers);
    expect(database.prepare("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 });
    removeOrphan(database, variant);
    const repaired = captureRows(database);
    migrateOpenBotDatabase(database, { appliedAt });
    expectCapturedRows(database, repaired);
    expectHealthy(database);
  });

  it("stops startup on corrupt saved constraints and keeps the rows for repair", () => {
    const database = releasedDatabase(variant);
    database.exec("PRAGMA ignore_check_constraints = ON");
    setConstraintValue(database, variant, false);
    database.exec("PRAGMA ignore_check_constraints = OFF");
    const before = captureRows(database);

    expect(() => migrateOpenBotDatabase(database, { appliedAt })).toThrow("failed its integrity check");

    expectCapturedRows(database, before);
    expect(database.isTransaction).toBe(false);
    expect(database.prepare("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 });
    setConstraintValue(database, variant, true);
    const repaired = captureRows(database);
    migrateOpenBotDatabase(database, { appliedAt });
    expectCapturedRows(database, repaired);
    expectHealthy(database);
  });

  it("enforces foreign keys for both table groups after the upgrade", () => {
    const database = releasedDatabase(variant);
    migrateOpenBotDatabase(database, { appliedAt });
    for (const shape of sourceVariants) {
      expect(() => insertOrphan(database, shape)).toThrow("FOREIGN KEY constraint failed");
    }
    expectHealthy(database);
  });
});

function openDatabase(): DatabaseSync {
  const database = new DatabaseSync(":memory:");
  connections.push(database);
  database.exec("PRAGMA foreign_keys = ON");
  return database;
}

function releasedDatabase(variant: SourceVariant): DatabaseSync {
  const database = openDatabase();
  database.exec(`
    CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
    CREATE TEMP TRIGGER stop_at_v30 BEFORE INSERT ON schema_migrations
    WHEN NEW.version > 30 BEGIN SELECT RAISE(ABORT, 'fixture stops at version 30'); END;
  `);
  expect(() => migrateOpenBotDatabase(database, { appliedAt: sourceAt })).toThrow("migration to version 31 failed");
  database.exec("DROP TRIGGER temp.stop_at_v30");
  // These are frozen released declarations, not the current schema constants under test.
  const declarations = variant === "main" ? schemaHistory["31"] : fork31.declarations;
  for (const kind of ["table", "index"]) {
    for (const [key, sql] of Object.entries(declarations)) {
      if (key.startsWith(`${kind} `)) database.exec(sql);
    }
  }
  database.prepare("INSERT INTO schema_migrations VALUES (31, ?)").run(sourceAt);
  seedCommonRows(database);
  if (variant === "main") seedRoutineFlowRows(database);
  else seedEventCheckRows(database);
  expectHealthy(database);
  return database;
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

function conflictingIndex(variant: SourceVariant) {
  return variant === "main" ? "event_check_outbox_pending" : "routine_flow_steps_agent";
}

function addFailure(database: DatabaseSync, variant: SourceVariant, failure: "ddl" | "marker"): void {
  if (failure === "ddl") database.exec(`CREATE TABLE ${quote(conflictingIndex(variant))} (saved TEXT)`);
  else
    database.exec(`
      CREATE TEMP TRIGGER reject_v32 BEFORE INSERT ON schema_migrations
      WHEN NEW.version = 32 BEGIN SELECT RAISE(ABORT, 'reject compatibility migration'); END;
    `);
}

function removeFailure(database: DatabaseSync, variant: SourceVariant, failure: "ddl" | "marker"): void {
  database.exec(failure === "ddl" ? `DROP TABLE ${quote(conflictingIndex(variant))}` : "DROP TRIGGER temp.reject_v32");
}

function insertOrphan(database: DatabaseSync, variant: SourceVariant): void {
  if (variant === "main")
    database.exec(`INSERT INTO routine_flow_steps (step_id, run_id, agent_id, input, status, created_at, updated_at)
      VALUES ('orphan-step', 'missing-run', 'saved-agent', 'Saved input', 'running', '${sourceAt}', '${sourceAt}')`);
  else
    database.exec(`INSERT INTO projection_event_check_executions (execution_id, check_id, started_at, result_json)
      VALUES ('orphan-execution', 'missing-check', '${sourceAt}', '{"status":"empty"}')`);
}

function removeOrphan(database: DatabaseSync, variant: SourceVariant): void {
  database.exec(
    variant === "main"
      ? "DELETE FROM routine_flow_steps WHERE step_id = 'orphan-step'"
      : "DELETE FROM projection_event_check_executions WHERE execution_id = 'orphan-execution'",
  );
}

function setConstraintValue(database: DatabaseSync, variant: SourceVariant, valid: boolean): void {
  database.exec(
    variant === "main"
      ? `UPDATE routine_flow_steps SET status = '${valid ? "succeeded" : "invalid"}' WHERE step_id = 'saved-step'`
      : `UPDATE projection_event_checks SET active = ${valid ? 1 : 2} WHERE check_id = 'saved-check'`,
  );
}

function captureRows(database: DatabaseSync): { table: string; rows: Rows }[] {
  return database
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all()
    .filter(({ name }) => name !== "schema_migrations")
    .map(({ name }) => {
      if (typeof name !== "string") throw new Error("Invalid fixture table name.");
      return { table: name, rows: database.prepare(`SELECT * FROM ${quote(name)} ORDER BY rowid`).all() };
    });
}

function expectCapturedRows(database: DatabaseSync, before: ReturnType<typeof captureRows>): void {
  for (const { table, rows } of before) {
    expect(database.prepare(`SELECT * FROM ${quote(table)} ORDER BY rowid`).all(), table).toEqual(rows);
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
          sql.replace(/\bIF NOT EXISTS\b/gi, "").match(/'(?:''|[^'])*'|"(?:""|[^"])*"|\w+|<>|[^\s]/g) ?? [];
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

function quote(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}
