### Added

- A server deploy can wait for the running agent turns to end before it restarts:
  `POST /v1/drain` on the control socket holds new turns and answers when none runs, or after a
  timeout. See [Docker](docs/docker.md#health-logs-and-diagnostics).

- A scheduled routine can have a cheap pre-check, a shell command that the agent sets. When it
  finds nothing to do, the run is skipped and costs no turn. Most runs of polling routines found
  nothing before.

### Changed

- Claude agents compact their chats at 250,000 tokens by default, instead of Claude Code's own size
  of the whole model window. Long-lived agents re-read less on every step, so turns are faster and
  use less of the plan. Choose another size, or Claude Code default, in Server settings → Providers
  → Claude → Context.
- A Claude agent that was idle for more than an hour, with a chat above 120,000 tokens, starts a
  new session from its chat history before it reads the message that wakes it. Its prompt cache had
  expired, so the old session would have been written to the cache again in full.- Agents can pause in the browser with `wait_for` and `delayMs`, alone or as a `run_steps` step,
  and run one `evaluate` script up to 50 times in one call with `repeat`, to collect a list across
  pages without a model step for each page.
- A message from a teammate waits up to two minutes before it wakes an agent, and the teammate
  messages that arrive meanwhile start the same turn. A message from you never waits, and `fyi`
  notes still wake nobody. A message that wakes its recipients goes to at most 10 teammates.
- A streaming reply in a channel sends only its message to the open clients. Before, each part of
  the text, ten times a second, also stored a copy in the channel's history and made every client
  read the whole channel list again. The copies that earlier versions stored are removed in the
  background.

### Fixed

- The desktop app sets the Dock or taskbar badge only when its count changes. Before, it set it
  about 100 times a second while agents worked, and the trace log filled up every few minutes.
- `send_message` accepts `message` for `text` and `to` for `recipientAgentIds`, the names agents
  guessed most often, and its errors show a complete call. About one call in seven failed before.
- A server with 10 to 40 GiB of memory runs at most 12 turns at the same time, not 16, and keeps
  at most 12 agent browser tabs loaded, not 24. A 24 GiB server ran out of memory with 13 turns.
- After a restart, each agent whose turn the restart cut off continues by itself once the server is
  ready. Before, an operator had to send the resume.
