### Fixed

- Claude Code agents no longer show "UNIQUE constraint failed: entries.uuid" at each start. When a
  Claude Code chat history has the same message two times, Atelier now reads it one time and imports
  the turns.
