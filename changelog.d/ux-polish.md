### Changed

- Translate the Backups, Trust and Efficiency screens into German, French, Italian, Japanese,
  Korean, Polish, Portuguese, Russian, Turkish and Chinese.
- The org chart names a model as the chat header does, such as "GPT-5.6 Luna", not by its id. The
  Usage page has the same back chevron as the other pages, and the Settings, Usage and phone More
  titles use the theme's display face like the other views.
- Settings are grouped by task. Server settings list their sections under Agents & models,
  Connections & secrets, and Server & backups, with links to Money & limits (the Trust view),
  Notifications & quiet hours, and Appearance. The account's Preferences split into Appearance and
  Notifications, and Notifications opens the quiet hours. An address can name a group, such as
  `?page=server-settings&section=connections`.

- The desktop app draws an agent's interactive cards (choices, approvals, forms and tables) in
  channels and in the agent's own chat, and the owner answers them with taps there, on this
  computer and on a joined server. The web client now draws a card in the agent's own chat too,
  where it showed the card's text and its `[card:…]` marker.
- More > Knowledge shows what a space's agents know together: the decision log (what was decided,
  why, what else was considered and what came of it) and the customer, product and supplier memory,
  with search, a filter by kind, and a remove button for a wrong decision, entity or fact. Owners
  and admins of a server with agent learning.
- The morning briefing also reads the space's decision log, so a decision an agent logged outside a
  hands-off channel reaches the briefing. A decision that a channel already showed is said once.

### Fixed

- An agent DM's header stays on one row on a computer. "Why is this slow?" sat on a row of its own
  above the model picker while a request waited, and a narrow window pushed the buttons over each
  other; the topic, the effort and then the model name now give way first.

- On a phone, every control a finger hits is at least 44 px: the channel header icons, the composer
  buttons, saved replies, attachment buttons and the model picker. Links inside text (an agent's
  name, "Show more", "Show original", reactions) get a 44 px hit area without moving the text.
- Avatar initials, the AI badge and the times of unread rows read at 4.5:1 or more in light mode.
  In Riso Press light, the phone's Today, Agents and Inbox tabs no longer put light text on light
  cards.

- A settings address keeps its section: `?page=settings&section=notifications` opens Notifications,
  survives a reload, and follows the tab the user picks. Old `section=preferences` links open
  Appearance, and `section=backups` opens Backups.
