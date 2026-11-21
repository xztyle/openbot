// Shared by migration v55 and the new-database schema, so every statement is IF NOT EXISTS.
//
// A loop is a pipeline that the owner or an orchestrator defines for one space: its stages, fields and
// Motion project live in `definition_json`, which `parseLoopDefinition` reads. Items move through it,
// each with its field values and done checklist entries as JSON. Every change of an item appends a row
// to `loop_events`, which is the item's history and is never rewritten. Experiments belong to an item.
// A decision waits for the owner: a gate of a stage, the budget of an experiment or an escalated
// question. Deleting a loop deletes its rows (ON DELETE CASCADE); nothing else deletes them.
export const LOOP_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS loops (
    loop_id TEXT NOT NULL PRIMARY KEY,
    space_id TEXT NOT NULL,
    template_id TEXT,
    definition_json TEXT NOT NULL CHECK(json_valid(definition_json)),
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS loops_space ON loops(space_id);
  CREATE TABLE IF NOT EXISTS loop_items (
    item_id TEXT NOT NULL PRIMARY KEY,
    loop_id TEXT NOT NULL REFERENCES loops(loop_id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    stage_id TEXT NOT NULL,
    owner_agent_id TEXT,
    values_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(values_json)),
    checks_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(checks_json)),
    external_id TEXT,
    pending_decision_id TEXT,
    entered_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS loop_items_loop ON loop_items(loop_id);
  CREATE UNIQUE INDEX IF NOT EXISTS loop_items_external ON loop_items(loop_id, external_id) WHERE external_id IS NOT NULL;
  CREATE TABLE IF NOT EXISTS loop_events (
    event_id TEXT NOT NULL PRIMARY KEY,
    loop_id TEXT NOT NULL REFERENCES loops(loop_id) ON DELETE CASCADE,
    item_id TEXT NOT NULL,
    at INTEGER NOT NULL,
    kind TEXT NOT NULL,
    actor_kind TEXT NOT NULL,
    actor_id TEXT,
    from_stage TEXT,
    to_stage TEXT,
    text TEXT
  );
  CREATE INDEX IF NOT EXISTS loop_events_loop ON loop_events(loop_id, at);
  CREATE INDEX IF NOT EXISTS loop_events_item ON loop_events(item_id, at);
  CREATE TABLE IF NOT EXISTS loop_experiments (
    experiment_id TEXT NOT NULL PRIMARY KEY,
    loop_id TEXT NOT NULL REFERENCES loops(loop_id) ON DELETE CASCADE,
    item_id TEXT NOT NULL,
    experiment_json TEXT NOT NULL CHECK(json_valid(experiment_json)),
    status TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS loop_experiments_loop ON loop_experiments(loop_id);
  CREATE TABLE IF NOT EXISTS loop_decisions (
    decision_id TEXT NOT NULL PRIMARY KEY,
    loop_id TEXT NOT NULL REFERENCES loops(loop_id) ON DELETE CASCADE,
    space_id TEXT NOT NULL,
    item_id TEXT NOT NULL,
    decision_json TEXT NOT NULL CHECK(json_valid(decision_json)),
    status TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS loop_decisions_space ON loop_decisions(space_id, status);
`;
