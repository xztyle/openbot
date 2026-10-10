### Added

- Global search finds every server settings section that your server shows, the Usage report, and the
  Event checks, Routines, Skills, Memories and Files pages of each agent. A search for "cost" or
  "api key" finds the page that holds it. The "Keyboard shortcuts" result lists the shortcuts, and the
  sidebar search field shows the shortcut that opens search.
- The chat header has a button that searches the conversation. A phone has no Cmd+F.
- The open chat has an ellipsis button on a touch screen. It opens the same menu as a right click on
  the chat.

### Changed

- The web client opens the chat that you used last on each server after a reload or a server switch.
  Before, it opened the first chat.
- "Mark all as read" and "Deleted channels" are in the New menu of the sidebar. Before, only a right
  click on an empty part of the list showed them.
- The agent settings put Memories, Skills, Files, Routines and Event checks above the instructions
  field, so a phone shows them without a long scroll.
- A server settings link that names a section that your server does not have opens General.
- The event check settings say "event check program" in place of "watcher program".

### Fixed

- The message search finds a word that starts with a capital letter that is not ASCII. Before, "état"
  did not find "État". The search still treats "e" and "é" as different letters.
