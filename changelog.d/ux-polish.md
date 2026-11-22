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

### Fixed

- On a phone, every control a finger hits is at least 44 px: the channel header icons, the composer
  buttons, saved replies, attachment buttons and the model picker. Links inside text (an agent's
  name, "Show more", "Show original", reactions) get a 44 px hit area without moving the text.
- Avatar initials, the AI badge and the times of unread rows read at 4.5:1 or more in light mode.
  In Riso Press light, the phone's Today, Agents and Inbox tabs no longer put light text on light
  cards.

- A settings address keeps its section: `?page=settings&section=notifications` opens Notifications,
  survives a reload, and follows the tab the user picks. Old `section=preferences` links open
  Appearance, and `section=backups` opens Backups.
