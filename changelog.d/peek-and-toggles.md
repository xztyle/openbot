### Added

- Peek at a message between agents. Click the "Messaged" row in the chat, or press Enter on it. A
  translucent layer opens over the chat. It shows who messaged whom, the whole message, the message
  it answers and the replies. "Open conversation" goes to the chat with the other agent. Escape, a
  click outside or the close button closes it, and focus returns to the row. On a phone it is a
  sheet at the bottom of the screen.
- Two switches, "Show agent reasoning" and "Show messages between agents", both on by default. Find
  them in Settings > General on the desktop, and in Account settings > Preferences in the web
  client. They apply at once and are kept for this browser or desktop profile only. With the first
  off, each Thinking row stays closed with no preview line. With the second off, messages between
  agents are one collapsed row for each run, and the peek still opens. Nothing is removed.

### Changed

- The row for a message between agents no longer shows a line of the message. The row is compact
  again, as before. The text is in the peek.

### Fixed

- A routine flow that sends to several agents at once now sends to them in the order the links were
  made, also when two links have the same time.
