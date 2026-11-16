### Added

- The server control socket can send a message to an agent (`POST /v1/agents/<agentId>/message` with `text`), as the owner types it in the app, and can tell each agent whose work a restart cut off to continue (`POST /v1/resume-interrupted`). The resume is idempotent and takes the delivery IDs that a deploy recorded.
