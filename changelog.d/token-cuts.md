### Changed

- Claude agents send about 9,500 fewer tokens in each request (about 29% of the fixed part on our
  server). Claude no longer gets the `ListAgents`, `Workflow`, `ReportFindings`, `DesignSync` and
  `PushNotification` tools or the helper agents for the Claude Code app, Claude auto memory is off
  (OpenBot memory is the agent's memory), Claude Code skills that cannot work in OpenBot are off and the
  coding skills show by name only, and commits no longer get a Claude co-author line unless your own
  settings ask for one. Your own skills keep their listing.
- The agent instructions and teammate messages are shorter, with the same rules.
- Tool schemas that agents read are about a third smaller, and the tool list is grouped by namespace.
- A channel member gets the channel rules once per session, not with each turn.
- A Claude agent keeps its memories and section list after an MCP server or skill change, so the next
  turn does not send them again.
- A browser `evaluate` value over 16,000 characters and a GitHub tool text over 40,000 characters reach
  the agent cut, with a note on how to read the rest.
- Background calls without tools, such as titles, summaries and routing, no longer send Claude Code's
  coding instructions.
- No task sound plays for a turn of work between agents.

### Added

- Server settings > Providers > Claude > Context: "Use my Claude Code setup", off by default. Off,
  Claude agents do not load the CLAUDE.md, skills, agents, hooks, plugins and output style of
  `~/.claude`; your sign-in settings still apply. **Turn it on if your agents need your own Claude Code
  setup.**
- "Compact chats at" in the same place: the size at which Claude compacts a chat, from 100K to 1M
  tokens, or Claude Code's own size.
