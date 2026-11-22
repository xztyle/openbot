### Changed

- Claude agents compact their chats at 250,000 tokens by default, instead of Claude Code's own size
  of the whole model window. Long-lived agents re-read less on every step, so turns are faster and
  use less of the plan. Choose another size, or Claude Code default, in Server settings → Providers
  → Claude → Context.
- A Claude agent that was idle for more than an hour, with a chat above 120,000 tokens, starts a
  new session from its chat history before it reads the message that wakes it. Its prompt cache had
  expired, so the old session would have been written to the cache again in full.
