// @vitest-environment node

// Failure modes: an upgrade can lose existing rows, leave partial DDL or a false marker,
// erase checks during a roster save, or leave another agent's records after deletion.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { AgentSummary } from "@openbot/contracts/ipc";
import { afterEach, describe, expect, it } from "vitest";
import { runCauseEffect } from "./effect-boundary";
import { OpenBotDatabase } from "./openbot-database";
import { migrateOpenBotDatabase } from "./openbot-database-schema";

const appliedAt = "2026-10-08T12:00:00.000Z";
const stopMessage = "event-check fixture stops at its source version";
const roots: string[] = [];
const connections: DatabaseSync[] = [];
const databases: OpenBotDatabase[] = [];

afterEach(async () => {
  for (const database of databases.splice(0)) database.close();
  for (const connection of connections.splice(0)) connection.close();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Event check migration 32", () => {
  it.each(Array.from({ length: 23 }, (_, index) => index + 8))(
    "preserves saved data when upgrading schema version %i",
    (source) => {
      const database = sourceDatabase(source);
      seedExistingData(database, source);
      const before = captureRows(database);
      migrateOpenBotDatabase(database, { appliedAt });
      expectCapturedRows(database, before);
      expect(database.prepare("SELECT MAX(version) AS version FROM schema_migrations").get()).toEqual({ version: 32 });
      expectHealthy(database);
      expect(database.prepare("PRAGMA foreign_key_list(projection_event_checks)").all()).toEqual([]);
    },
  );

  it.each(["ddl", "marker"] as const)("rolls back a failed %s write and succeeds on retry", (failure) => {
    const database = sourceDatabase(30);
    seedExistingData(database, 30);
    const before = captureRows(database);
    addMigrationFailure(database, failure);
    expect(() => migrateOpenBotDatabase(database, { appliedAt })).toThrow("migration to version 32 failed");
    expectCapturedRows(database, before);
    expect(database.prepare("SELECT version FROM schema_migrations WHERE version = 32").get()).toBeUndefined();
    expect(database.prepare("SELECT name FROM sqlite_master WHERE name LIKE 'projection_event_check%'").all()).toEqual(
      [],
    );
    expectHealthy(database);
    removeMigrationFailure(database, failure);
    migrateOpenBotDatabase(database, { appliedAt });
    expectCapturedRows(database, before);
    seedCheck(database, "after-retry", "retained-agent");
    expectHealthy(database);
  });

  it("rejects newer and incomplete migration histories without changing user rows", () => {
    for (const invalid of ["newer", "missing"] as const) {
      const database = sourceDatabase(30);
      seedExistingData(database, 30);
      if (invalid === "newer") database.prepare("INSERT INTO schema_migrations VALUES (33, ?)").run(appliedAt);
      else database.exec("DELETE FROM schema_migrations WHERE version = 29");
      const before = captureRows(database);
      expect(() => migrateOpenBotDatabase(database, { appliedAt })).toThrow(
        invalid === "newer" ? "newer than this application supports" : "migration history is missing version 29",
      );
      expectCapturedRows(database, before);
      expect(
        database.prepare("SELECT name FROM sqlite_master WHERE name = 'projection_event_checks'").get(),
      ).toBeUndefined();
    }
  });

  it("rejects invalid check child references and preserves records on repeated startup", () => {
    const database = sourceDatabase(30);
    migrateOpenBotDatabase(database, { appliedAt });
    seedCheck(database, "persisted-check", "retained-agent");
    const before = captureRows(database);
    expect(() => insertExecution(database, "orphan-check")).toThrow("FOREIGN KEY constraint failed");
    migrateOpenBotDatabase(database, { appliedAt });
    expectCapturedRows(database, before);
    expectHealthy(database);
  });

  it("keeps checks on roster saves and deletes only the removed agent's checks and child records", async () => {
    const database = await openApplicationDatabase();
    const first = agent("first");
    const second = agent("second");
    database.replaceAgents("event-check-roster-seed", [first, second], "agents.imported");
    seedCheck(database.connection, "first-check", first.id);
    seedCheck(database.connection, "second-check", second.id);
    const saved = captureCheckRows(database.connection);
    database.replaceAgents("event-check-roster-save", [{ ...first, name: "Updated" }, second], "agents.updated");
    expect(captureCheckRows(database.connection)).toEqual(saved);
    database.hardDeleteAgent("event-check-agent-delete", first.id, first.threadId, [second]);
    expect(database.listAgents()).toEqual([second]);
    expect(captureCheckRows(database.connection)).toEqual(
      saved.map(({ rows, ...fields }) => ({ ...fields, rows: rows.filter((row) => row.check_id === "second-check") })),
    );
    expectHealthy(database.connection);
  });
});

function sourceDatabase(version: number): DatabaseSync {
  const database = new DatabaseSync(":memory:");
  connections.push(database);
  database.exec(
    "PRAGMA foreign_keys = ON; CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)",
  );
  database.exec(`
    CREATE TEMP TRIGGER stop_at_source BEFORE INSERT ON schema_migrations
    WHEN NEW.version > ${version} BEGIN SELECT RAISE(ABORT, '${stopMessage}'); END;
  `);
  expect(() => migrateOpenBotDatabase(database, { appliedAt })).toThrow(`migration to version ${version + 1} failed`);
  database.exec("DROP TRIGGER temp.stop_at_source");
  return database;
}

function seedExistingData(database: DatabaseSync, version: number): void {
  seedConversation(database);
  seedRoutine(database);
  if (version >= 20) seedMcpAccount(database);
  if (version === 30) seedWebhook(database);
}

function seedConversation(database: DatabaseSync): void {
  database
    .prepare(`
    INSERT INTO projection_agents (agent_id, thread_id, model, updated_at, sort_order, agent_json, last_event_sequence)
    VALUES ('retained-agent', 'retained-thread', 'model', ?, 0, '{"name":"Retained"}', 0)
  `)
    .run(appliedAt);
  database
    .prepare(`
    INSERT INTO projection_threads (thread_id, agent_id, title, active_turn_id, created_at, updated_at, last_event_sequence)
    VALUES ('retained-thread', 'retained-agent', 'Retained conversation', NULL, ?, ?, 0)
  `)
    .run(appliedAt, appliedAt);
  database
    .prepare(`
    INSERT INTO projection_thread_messages (thread_id, message_id, turn_id, author, status, item_type, created_at,
      ordinal, message_json, last_event_sequence)
    VALUES ('retained-thread', 'retained-message', NULL, 'user', 'completed', NULL, ?, 0,
      '{"text":"Keep this conversation"}', 0)
  `)
    .run(appliedAt);
}

function seedRoutine(database: DatabaseSync): void {
  database
    .prepare(`
    INSERT INTO projection_agent_routines (routine_id, agent_id, name, instruction, active, timezone,
      created_at, updated_at, last_event_sequence)
    VALUES ('retained-routine', 'retained-agent', 'Retained routine', 'Keep doing this task', 1, 'UTC', ?, ?, 0)
  `)
    .run(appliedAt, appliedAt);
  database
    .prepare(`
    INSERT INTO projection_routine_triggers (trigger_id, routine_id, schedule_json, next_run_at, created_at,
      updated_at, last_event_sequence)
    VALUES ('retained-trigger', 'retained-routine', '{"kind":"hourly","minute":5}', ?, ?, ?, 0)
  `)
    .run(appliedAt, appliedAt, appliedAt);
  database
    .prepare(`
    INSERT INTO projection_routine_runs (run_id, routine_id, agent_id, trigger_id, run_kind, scheduled_for,
      routine_name, instruction, delivery_id, status, error, created_at, updated_at, last_event_sequence)
    VALUES ('retained-run', 'retained-routine', 'retained-agent', NULL, 'manual', ?, 'Retained routine',
      'Retained run input', NULL, 'queued', NULL, ?, ?, 0)
  `)
    .run(appliedAt, appliedAt, appliedAt);
}

function seedMcpAccount(database: DatabaseSync): void {
  database
    .prepare(`
    INSERT INTO projection_mcp_servers (mcp_server_id, name, transport, enabled, command, args_json, env_json,
      env_passthrough_json, working_directory, url, headers_json, position, created_at, updated_at)
    VALUES ('retained-account', 'retained-workspace', 'http', 1, '', '[]', '[]', '[]', '',
      'https://example.test/mcp', '[{"key":"Authorization","value":"test-stored-credential"}]', 0, ?, ?)
  `)
    .run(appliedAt, appliedAt);
}

function seedWebhook(database: DatabaseSync): void {
  database
    .prepare(`
    INSERT INTO projection_routine_webhooks (routine_id, route_id, event_type, filters_json, secret_ciphertext,
      url, created_at, updated_at, last_event_sequence)
    VALUES ('retained-routine', 'retained-route', NULL, '[]', 'test-ciphertext', NULL, ?, ?, 0)
  `)
    .run(appliedAt, appliedAt);
  database
    .prepare(`
    INSERT INTO projection_webhook_receipts (receipt_id, owner_kind, routine_id, delivery_id, event_type,
      status, reason, run_id, received_at)
    VALUES ('retained-receipt', 'agent', 'retained-routine', 'retained-delivery', 'test.event',
      'started', NULL, 'retained-run', ?)
  `)
    .run(appliedAt);
}

function seedCheck(database: DatabaseSync, id: string, agentId: string): void {
  database
    .prepare(`
    INSERT INTO projection_event_checks (check_id, agent_id, definition_json, active, next_check_at,
      baseline_json, last_success_at, revision)
    VALUES (?, ?, '{"name":"Saved check"}', 1, ?, '{"ids":["existing-event"]}', ?, 'revision-1')
  `)
    .run(id, agentId, appliedAt, appliedAt);
  insertExecution(database, id);
  database
    .prepare(`
    INSERT INTO projection_event_check_outbox (event_id, check_id, revision, payload_json, created_at, delivery_id)
    VALUES (?, ?, 'revision-1', '{"ids":["new-event"]}', ?, NULL)
  `)
    .run(`${id}-event`, id, appliedAt);
}

function insertExecution(database: DatabaseSync, checkId: string): void {
  database
    .prepare(`
    INSERT INTO projection_event_check_executions (execution_id, check_id, started_at, result_json)
    VALUES (?, ?, ?, '{"status":"empty"}')
  `)
    .run(`${checkId}-execution`, checkId, appliedAt);
}

function addMigrationFailure(database: DatabaseSync, failure: "ddl" | "marker"): void {
  if (failure === "ddl") database.exec("CREATE TABLE event_check_outbox_pending (conflict TEXT)");
  else
    database.exec(`
    CREATE TEMP TRIGGER reject_event_check_marker BEFORE INSERT ON schema_migrations
    WHEN NEW.version = 32 BEGIN SELECT RAISE(ABORT, 'reject event check migration'); END;
  `);
}

function removeMigrationFailure(database: DatabaseSync, failure: "ddl" | "marker"): void {
  database.exec(
    failure === "ddl" ? "DROP TABLE event_check_outbox_pending" : "DROP TRIGGER temp.reject_event_check_marker",
  );
}

interface CapturedTable {
  table: string;
  columns: string[];
  rows: ReturnType<ReturnType<DatabaseSync["prepare"]>["all"]>;
}

function captureRows(database: DatabaseSync): CapturedTable[] {
  return database
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name != 'schema_migrations'",
    )
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
      return { table: name, columns, rows: database.prepare(`SELECT * FROM ${quote(name)}`).all() };
    });
}

function expectCapturedRows(database: DatabaseSync, before: CapturedTable[]): void {
  for (const { table, columns, rows } of before) {
    // Released migration 12 renames an empty reaction column. Its empty rows still stay empty.
    if (rows.length === 0) {
      expect(database.prepare(`SELECT COUNT(*) AS count FROM ${quote(table)}`).get(), table).toEqual({ count: 0 });
      continue;
    }
    expect(database.prepare(`SELECT ${columns.map(quote).join(", ")} FROM ${quote(table)}`).all(), table).toEqual(rows);
  }
}

function captureCheckRows(database: DatabaseSync) {
  return captureRows(database).filter(({ table }) => table.startsWith("projection_event_check"));
}

function expectHealthy(database: DatabaseSync): void {
  expect(database.prepare("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 });
  expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  expect(database.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
}

function quote(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

async function openApplicationDatabase(): Promise<OpenBotDatabase> {
  const root = await mkdtemp(join(tmpdir(), "openbot-event-check-migration-"));
  roots.push(root);
  const database = new OpenBotDatabase(root);
  databases.push(database);
  await runCauseEffect(database.initialize());
  return database;
}

function agent(id: string): AgentSummary {
  return {
    id,
    provider: "codex",
    name: id,
    title: "",
    description: "",
    notifications: true,
    model: "model",
    reasoningEffort: "medium",
    threadId: `thread-${id}`,
    workspacePath: `/tmp/${id}`,
    preview: "",
    updatedAt: appliedAt,
    avatarSeed: id,
    avatarHue: null,
    avatarUrl: null,
  };
}
