### Changed

- Claude agents compact their chats at 250,000 tokens by default, instead of Claude Code's own size
  of the whole model window. Long-lived agents re-read less on every step, so turns are faster and
  use less of the plan. Choose another size, or Claude Code default, in Server settings → Providers
  → Claude → Context.
