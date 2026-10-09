### Added

- Open the model's reasoning in the chat. While an agent works, click the activity line to read
  what it thinks. After the turn, a "Thinking" row above the answer opens the same text. The text
  is redacted and cut at 40,000 characters. A provider that shares only a summary of its reasoning,
  or none, shows that summary or says so.
- Read the full text of a message between agents. A marker shows one redacted line of the message.
  Click the marker, or press Enter on the line, to read the whole message and its reply.
- Keep Stop next to Send while you type a message to a working agent. The queue has a new "Stop and
  clear queue" action. It cancels the queued messages first, then stops the turn, so none of them
  starts. Cancelled messages stay in the chat marked as cancelled.
- Undo or edit a message that you send to a working agent. The message waits four seconds before it
  reaches the agent, with Undo and Edit under it.
- Saved replies above the message box, such as "Continue" and "Approve plan". One tap sends a reply.
  Edit the list with the pencil. The list is kept in this browser or desktop profile.
- Mark an agent's chat unread from its menu in the desktop and web sidebar. The whole chat becomes
  unread. The host cannot mark only the last message.
- Attach more text files: diff, patch, TSV, HAR, GraphQL, Protobuf, Terraform, Lua, SVG, dotfiles
  such as `.gitignore`, and others. A host that is older than this version refuses them, and the
  client does not offer them there.
- Show the question or the approval reason in an agent notification. This is off by default, because
  a lock screen can show it. Turn it on in Settings > Notifications, or in Account settings in the
  web client.

### Changed

- A notification that says an agent finished now comes after the turn that leaves the agent idle.
  Before, every turn of a chain of agents sent one. A failure still notifies at once.
- A tool step that fails now shows the tool and the reason on the agent's activity line, and the
  host log names the tool, agent and turn. Before, the line said only that a step failed. A Claude
  tool error was not marked as failed at all.
- A cancelled message of yours no longer disappears from the chat. It stays, marked as cancelled.

### Fixed

- Log a tool call that the provider cancelled before it answered, with the reason. These calls were
  silent, and the agent told the user that its tools had disconnected.
