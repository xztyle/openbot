### Changed

- On a server, every agent runs in the Atelier agent jail, whatever its provider: Claude, Codex,
  OpenCode, Antigravity, Cursor, Cline, Pi, Grok, Muse and custom agents. Before, only Claude agents
  were jailed. In the jail the provider's own sandbox is off, so an agent no longer asks you to approve
  a command such as reading its own files. An agent that the server cannot jail does not start, and
  you get a plain message.
- An agent can attach files to a message to you, also a file that a teammate sent it. When it tells
  you about an image or a document, the file is in the message.

### Fixed

- A message between agents no longer fails with "The idempotency key is too long." when a Codex id is
  long, and a failed tool call of an agent no longer shows as an error banner in your chat: the agent
  gets the error and tries another way.
