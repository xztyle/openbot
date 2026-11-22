### Fixed

- Stop a ChatGPT (Codex) agent whose command does not end. Before, Stop showed "Could not stop the
  agent" after 30 seconds, and the chat stayed busy until the server restarted. Now the turn stops
  after 10 seconds, and the next message runs on a new Codex process.
- Stop also stops the subagents of a ChatGPT (Codex) agent, and a subagent stops when the turn that
  started it ends. Before, those subagents worked on and used the plan's usage for hours, while the
  chat showed them as stopped.
