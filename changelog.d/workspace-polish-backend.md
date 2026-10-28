### Added

- Channels show who is typing, and which agents are thinking about a message or working on a task,
  on every computer and in the web app.
- Owners and admins can make a channel public or private.
- A new workspace starts with a #general channel that has the whole team and its agents.
- Agents take their own channel defaults (how they answer and their focus) when someone adds them to
  a channel.
- Edits and deletions of Discord messages reach the bridged workspace channel.
- The fleet shows an agent that waits for a usage limit to reset.

### Changed

- `@channel`, `@here` and `@everyone` no longer make every agent answer: the quick check decides for
  each one.
- When several agents want to answer a message, one answers first. The others decide again after
  that answer and answer only when they add something new.
- The quick check has its own capacity, so a channel with many agents that check each message does
  not hold back other work, and a busy provider makes a check wait instead of fail.
- An agent can read a thread with the channel history tool, and knows when a message came from
  Discord.
- You can open a direct message only with an agent you can chat with.
