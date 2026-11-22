### Fixed

- A ChatGPT (Codex) turn whose own compaction hangs, for example when the connection stops
  answering, now stops after 20 minutes with a plain message, and the next message runs. Before, the
  chat showed "Compacting context" for an hour.
