/** Additive tables only. The agent ID has no FK: roster saves replace the agent projection. */
export const EVENT_CHECK_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS projection_event_checks (
    check_id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL,
    definition_json TEXT NOT NULL CHECK(json_valid(definition_json)),
    active INTEGER NOT NULL CHECK(active IN (0, 1)),
    next_check_at TEXT NOT NULL,
    baseline_json TEXT CHECK(baseline_json IS NULL OR json_valid(baseline_json)),
    last_success_at TEXT,
    revision TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS event_checks_agent ON projection_event_checks(agent_id, check_id);
  CREATE INDEX IF NOT EXISTS event_checks_due ON projection_event_checks(active, next_check_at);
  CREATE TABLE IF NOT EXISTS projection_event_check_executions (
    execution_id TEXT PRIMARY KEY,
    check_id TEXT NOT NULL REFERENCES projection_event_checks(check_id) ON DELETE CASCADE,
    started_at TEXT NOT NULL,
    result_json TEXT NOT NULL CHECK(json_valid(result_json))
  );
  CREATE INDEX IF NOT EXISTS event_check_executions_recent
    ON projection_event_check_executions(check_id, started_at DESC, execution_id);
  CREATE TABLE IF NOT EXISTS projection_event_check_outbox (
    event_id TEXT PRIMARY KEY,
    check_id TEXT NOT NULL REFERENCES projection_event_checks(check_id) ON DELETE CASCADE,
    revision TEXT NOT NULL,
    payload_json TEXT NOT NULL CHECK(json_valid(payload_json)),
    created_at TEXT NOT NULL,
    delivery_id TEXT
  );
  CREATE INDEX IF NOT EXISTS event_check_outbox_pending
    ON projection_event_check_outbox(delivery_id, created_at, event_id);
`;
