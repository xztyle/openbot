### Changed

- "Show agent reasoning" and "Show messages between agents" now collapse what they switch off. They
  no longer delete it. With reasoning off, each Thinking row stays closed with no preview line, and
  the activity line still opens the live reasoning. With messages between agents off, a run of
  messages is one collapsed row, also when a message carries files, and the peek still opens.
- A channel draws the reasoning of an agent as one closed Thinking row, as the agent chat does. The
  unread count and the sidebar preview of a channel leave reasoning out.
- A teammate in a channel is drawn as a member with their name, not as an agent. An answer that a
  task change replaced is muted and says "Earlier answer". An answer that stopped early or failed
  has a note.
- The approval card of a channel names the agent that asks. A request that belongs to the chat of a
  member is answered in that chat, not in the channel.
- The activity row of a channel says who works and who is queued. A member who left a channel is
  named by the name last used, or "Former member", not by an id.

### Fixed

- The unread divider of a channel stayed for no more than a moment, because the open channel was
  marked read at once. It now stays until you leave the channel, jump to the latest message or mark
  it read.
- A task you stopped in a channel disappeared. It now stays with "Stopped by you" and a Continue
  action, and every stopped-task card shows the owner and the first line of the request.
- The empty peek of a message between agents says that the message is not loaded.
