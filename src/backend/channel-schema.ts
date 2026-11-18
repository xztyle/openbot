// Shared by migration v18 and the separate new-database schema. IF NOT EXISTS throughout, because
// this text is both the migration and the tail of the latest schema: a database built from the
// latest schema and then replayed forward - which is how a test fakes an older version - meets its
// own tables.
export const CHANNEL_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS projection_channels (
    channel_id TEXT PRIMARY KEY,
    channel_json TEXT NOT NULL CHECK(json_valid(channel_json))
  );
  CREATE TABLE IF NOT EXISTS projection_channel_messages (
    channel_id TEXT NOT NULL REFERENCES projection_channels(channel_id),
    message_id TEXT NOT NULL,
    sequence INTEGER NOT NULL,
    message_json TEXT NOT NULL CHECK(json_valid(message_json)),
    PRIMARY KEY(channel_id, message_id)
  );
  CREATE INDEX IF NOT EXISTS channel_messages_sequence ON projection_channel_messages(channel_id, sequence);
  CREATE TABLE IF NOT EXISTS projection_channel_tasks (
    task_id TEXT PRIMARY KEY,
    channel_id TEXT NOT NULL REFERENCES projection_channels(channel_id),
    task_json TEXT NOT NULL CHECK(json_valid(task_json))
  );
  CREATE INDEX IF NOT EXISTS channel_tasks_channel ON projection_channel_tasks(channel_id);
  CREATE TABLE IF NOT EXISTS projection_channel_assignments (
    assignment_id TEXT PRIMARY KEY,
    channel_id TEXT NOT NULL REFERENCES projection_channels(channel_id),
    task_id TEXT NOT NULL REFERENCES projection_channel_tasks(task_id),
    delivery_id TEXT UNIQUE,
    assignment_json TEXT NOT NULL CHECK(json_valid(assignment_json))
  );
  CREATE INDEX IF NOT EXISTS channel_assignments_channel ON projection_channel_assignments(channel_id);
  CREATE TABLE IF NOT EXISTS projection_channel_contexts (
    channel_id TEXT NOT NULL REFERENCES projection_channels(channel_id),
    agent_id TEXT NOT NULL,
    thread_id TEXT NOT NULL UNIQUE REFERENCES projection_threads(thread_id),
    session_id TEXT,
    through_sequence INTEGER NOT NULL DEFAULT 0,
    summary_version INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY(channel_id, agent_id)
  );
  CREATE TABLE IF NOT EXISTS projection_channel_summaries (
    channel_id TEXT PRIMARY KEY REFERENCES projection_channels(channel_id),
    version INTEGER NOT NULL,
    through_sequence INTEGER NOT NULL,
    text TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS projection_channel_reads (
    channel_id TEXT NOT NULL REFERENCES projection_channels(channel_id),
    member_id TEXT NOT NULL,
    through_sequence INTEGER NOT NULL,
    PRIMARY KEY(channel_id, member_id)
  );
`;

// Shared by migration v19 and the separate new-database schema. A separate constant, and a new
// version rather than an edit to CHANNEL_SCHEMA_SQL: a database that already ran 18 - every
// development profile on this branch - would otherwise never meet these tables.
//
// Every table mirrors its agent twin in the v8 baseline column for column, because one store
// implementation serves both owners. The two UNIQUE constraints on the run table are what make one
// fire produce one run; without them a missed re-arm degrades silently into duplicate work.
export const CHANNEL_SETTINGS_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS projection_channel_memories (
    memory_id TEXT PRIMARY KEY,
    channel_id TEXT NOT NULL REFERENCES projection_channels(channel_id) ON DELETE CASCADE,
    text TEXT NOT NULL,
    normalized_text TEXT NOT NULL,
    origin TEXT NOT NULL CHECK(origin IN ('automatic', 'manual')),
    source_turn_id TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    last_event_sequence INTEGER NOT NULL,
    UNIQUE(channel_id, normalized_text)
  );
  CREATE INDEX IF NOT EXISTS channel_memories_channel
    ON projection_channel_memories(channel_id, updated_at DESC, memory_id);
  CREATE TABLE IF NOT EXISTS projection_channel_routines (
    routine_id TEXT PRIMARY KEY,
    channel_id TEXT NOT NULL REFERENCES projection_channels(channel_id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    instruction TEXT NOT NULL,
    active INTEGER NOT NULL CHECK(active IN (0, 1)),
    timezone TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    last_event_sequence INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS channel_routines_channel
    ON projection_channel_routines(channel_id, updated_at DESC, routine_id);
  CREATE TABLE IF NOT EXISTS projection_channel_routine_triggers (
    trigger_id TEXT PRIMARY KEY,
    routine_id TEXT NOT NULL REFERENCES projection_channel_routines(routine_id) ON DELETE CASCADE,
    schedule_json TEXT NOT NULL CHECK(json_valid(schedule_json)),
    next_run_at TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    last_event_sequence INTEGER NOT NULL,
    UNIQUE(routine_id)
  );
  CREATE INDEX IF NOT EXISTS channel_routine_triggers_due
    ON projection_channel_routine_triggers(next_run_at, routine_id);
  CREATE TABLE IF NOT EXISTS projection_channel_routine_runs (
    run_id TEXT PRIMARY KEY,
    routine_id TEXT NOT NULL REFERENCES projection_channel_routines(routine_id) ON DELETE CASCADE,
    channel_id TEXT NOT NULL,
    trigger_id TEXT,
    run_kind TEXT NOT NULL CHECK(run_kind IN ('scheduled', 'manual')),
    scheduled_for TEXT NOT NULL,
    routine_name TEXT NOT NULL,
    instruction TEXT NOT NULL,
    request_message_id TEXT,
    status TEXT NOT NULL CHECK(status IN (
      'queued', 'running', 'needs-attention', 'succeeded', 'failed', 'cancelled'
    )),
    error TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    last_event_sequence INTEGER NOT NULL,
    UNIQUE(trigger_id, scheduled_for)
  );
  CREATE INDEX IF NOT EXISTS channel_routine_runs_routine
    ON projection_channel_routine_runs(routine_id, created_at DESC, run_id);
  CREATE UNIQUE INDEX IF NOT EXISTS channel_routine_runs_request
    ON projection_channel_routine_runs(request_message_id) WHERE request_message_id IS NOT NULL;
`;

// Shared by migration v52 and the separate new-database schema. The read position of each person in
// each thread, apart from the channel position, so reading a channel does not read its threads; and
// the threads that each person follows. `followed` is 0 for a thread that the person stopped
// following; `explicit` is 1 when the person chose it, which an automatic follow does not change.
// The partial index finds the replies of one thread without a scan of the channel.
export const CHANNEL_THREAD_STATE_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS projection_channel_thread_reads (
    channel_id TEXT NOT NULL REFERENCES projection_channels(channel_id),
    root_id TEXT NOT NULL,
    member_id TEXT NOT NULL,
    through_sequence INTEGER NOT NULL CHECK(through_sequence >= 0),
    PRIMARY KEY(channel_id, root_id, member_id)
  );
  CREATE INDEX IF NOT EXISTS channel_thread_reads_member ON projection_channel_thread_reads(member_id);
  CREATE TABLE IF NOT EXISTS projection_channel_thread_follows (
    channel_id TEXT NOT NULL REFERENCES projection_channels(channel_id),
    root_id TEXT NOT NULL,
    member_id TEXT NOT NULL,
    followed INTEGER NOT NULL CHECK(followed IN (0, 1)),
    explicit INTEGER NOT NULL DEFAULT 0 CHECK(explicit IN (0, 1)),
    PRIMARY KEY(channel_id, root_id, member_id)
  );
  CREATE INDEX IF NOT EXISTS channel_thread_follows_member
    ON projection_channel_thread_follows(member_id, followed);
  CREATE INDEX IF NOT EXISTS channel_messages_thread
    ON projection_channel_messages(channel_id, json_extract(message_json, '$.threadRootId'), sequence)
    WHERE json_extract(message_json, '$.threadRootId') IS NOT NULL;
`;

/** The SQL condition of a channel message row `row` that the message search finds. */
function searchable(row: string): string {
  return `json_extract(${row}.message_json, '$.deletedAt') IS NULL
      AND COALESCE(json_extract(${row}.message_json, '$.message.status'), '') != 'streaming'
      AND COALESCE(json_extract(${row}.message_json, '$.message.itemType'), '') NOT IN ('plan', 'subagents', 'channel-change', 'commentary')
      AND COALESCE(json_extract(${row}.message_json, '$.message.itemType'), '') NOT LIKE 'channel-routing-event:%'
      AND trim(COALESCE(json_extract(${row}.message_json, '$.message.text'), '')) != ''`;
}

const searchText = (row: string) => `json_extract(${row}.message_json, '$.message.text')`;

// Shared by migration v53 and the separate new-database schema. The full-text index of the channel
// messages that a person can find: complete, not deleted, and not a step, a note or a routing event.
// It keeps no copy of the text (`content=''`); a row is the message row's `rowid`. The triggers keep
// it in step with every write, also a rebuild and a deletion, and skip the frames of a streaming
// answer: the answer is indexed once, when it completes.
export const CHANNEL_SEARCH_SCHEMA_SQL = `
  CREATE VIRTUAL TABLE IF NOT EXISTS channel_message_search USING fts5(
    text, content='', contentless_delete=1, tokenize='unicode61 remove_diacritics 2'
  );
  CREATE TRIGGER IF NOT EXISTS channel_message_search_insert AFTER INSERT ON projection_channel_messages
  WHEN ${searchable("new")}
  BEGIN
    INSERT INTO channel_message_search(rowid, text) VALUES (new.rowid, ${searchText("new")});
  END;
  CREATE TRIGGER IF NOT EXISTS channel_message_search_update AFTER UPDATE OF message_json ON projection_channel_messages
  WHEN (${searchable("old")}) OR (${searchable("new")})
  BEGIN
    DELETE FROM channel_message_search WHERE rowid = old.rowid
      AND (${searchable("old")}) AND (NOT (${searchable("new")}) OR ${searchText("old")} IS NOT ${searchText("new")});
    INSERT INTO channel_message_search(rowid, text) SELECT new.rowid, ${searchText("new")}
      WHERE (${searchable("new")}) AND (NOT (${searchable("old")}) OR ${searchText("old")} IS NOT ${searchText("new")});
  END;
  CREATE TRIGGER IF NOT EXISTS channel_message_search_delete AFTER DELETE ON projection_channel_messages
  WHEN ${searchable("old")}
  BEGIN
    DELETE FROM channel_message_search WHERE rowid = old.rowid;
  END;
`;

/** Migration 53 fills the index from the stored messages, in rowid order. */
export const V53_CHANNEL_SEARCH_BACKFILL_SQL = `
  INSERT INTO channel_message_search(rowid, text)
  SELECT message.rowid, ${searchText("message")} FROM projection_channel_messages message
   WHERE ${searchable("message")} ORDER BY message.rowid;
`;
