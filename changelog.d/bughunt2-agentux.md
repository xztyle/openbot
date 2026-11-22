### Fixed

- Agents' tool discovery accepts the forms models send: `tool_describe` with one `name`, `names` as
  one string or a JSON-encoded list, or a bare tool name such as `create_agent`; `tool_call` with
  JSON-encoded `arguments`, without `arguments`, or naming `tool_search` itself. A name that is not a
  tool gets an error that names it and lists similar tools, instead of one generic message.
- `send_message` accepts one agent id as a string and `"true"` or `"false"` for `expectsReply` and
  `fyi`, which Claude agents' calls were refused for before the tool saw them.
- When an agent calls a tool with arguments that do not fit its schema, it gets the fields to fix and
  the tool to describe, instead of raw validation output, and the owner no longer sees a server error
  for it.

### Changed

- An agent that another agent creates starts with Computer Use off, unless the creator sets
  `computerUse` and has it itself. The creator can also start it with workspace access. Full
  access stays the default, because workspace access stops Grok and OpenCode agents on Linux.
