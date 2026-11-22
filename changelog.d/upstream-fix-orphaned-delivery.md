### Fixed

- An agent no longer stays "working" after a restart when a message that no turn runs is still
  marked as running. Before, new messages stayed queued, the chat had no Stop button, and another
  agent could not stop it. Now Atelier settles that message again, and the queued messages start.
