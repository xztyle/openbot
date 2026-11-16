// Shared by migration v50 and the separate new-database schema. IF NOT EXISTS and INSERT OR IGNORE,
// because this text is both the migration and the tail of the latest schema.
//
// A space keeps the agents and channels of one project apart from the others. The `general` space is
// written here, so every database has it from its first start or from this migration on. An agent or a
// channel with no row in `space_assignments` is in `general`: every agent and channel that existed
// before this migration stays where the user sees it, and no row has to be written for them. A DM with
// one agent has no row of its own; it follows its agent. The slug names the space's folder under
// `OpenBot/Spaces` and does not change on a rename, so a rename moves no files. The hue is one of the
// agent avatar hues (`AVATAR_HUES`). Configuration, written directly.
export const SPACE_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS spaces (
    space_id TEXT NOT NULL PRIMARY KEY,
    name TEXT NOT NULL UNIQUE COLLATE NOCASE CHECK(length(name) BETWEEN 1 AND 60),
    slug TEXT NOT NULL UNIQUE,
    icon TEXT,
    hue INTEGER CHECK(hue IS NULL OR hue IN (0, 30, 55, 100, 150, 185, 215, 245, 280, 320)),
    position INTEGER NOT NULL
  );
  INSERT OR IGNORE INTO spaces (space_id, name, slug, icon, hue, position)
    VALUES ('general', 'General', 'general', NULL, NULL, 0);
  CREATE TABLE IF NOT EXISTS space_assignments (
    kind TEXT NOT NULL CHECK(kind IN ('agent', 'channel')),
    item_id TEXT NOT NULL,
    space_id TEXT NOT NULL REFERENCES spaces(space_id),
    PRIMARY KEY(kind, item_id)
  );
  CREATE INDEX IF NOT EXISTS space_assignments_space ON space_assignments(space_id);
`;
