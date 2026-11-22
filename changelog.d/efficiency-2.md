### Changed

- Claude agents compact their chats at 250,000 tokens by default, instead of Claude Code's own size
  of the whole model window. Long-lived agents re-read less on every step, so turns are faster and
  use less of the plan. Choose another size, or Claude Code default, in Server settings → Providers
  → Claude → Context.
- A Claude agent that was idle for more than an hour, with a chat above 120,000 tokens, starts a
  new session from its chat history before it reads the message that wakes it. Its prompt cache had
  expired, so the old session would have been written to the cache again in full.

### Fixed

- The desktop app sets the Dock or taskbar badge only when its count changes. Before, it set it
  about 100 times a second while agents worked, and the trace log filled up every few minutes.
- `send_message` accepts `message` for `text` and `to` for `recipientAgentIds`, the names agents
  guessed most often, and its errors show a complete call. About one call in seven failed before.
