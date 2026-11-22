### Fixed

- A ChatGPT (Codex) agent no longer compacts its context again and again in one turn without
  progress. Before, when each compaction left the chat too full, Codex compacted after every step,
  and the agent showed "compacting" until a restart. Now Atelier stops the turn at the third such
  compaction and says what to change.
