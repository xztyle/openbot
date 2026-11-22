### Added

- The icon of the installed app (an iPhone Home Screen app, a desktop PWA) shows the same count as
  the browser tab: mentions, DM messages and agents that wait for you. It clears when they are read.

### Fixed

- A push that waited (the hourly digest of an agent's updates, or the notice that counts a burst of
  messages) no longer reaches a browser that was set to Nothing, muted or had push turned off in
  the meantime.
- An admin who has the app open no longer counts as the owner coming back: the owner's held
  requests stay in the "When you're back" bundle and the summary of their quiet hours still comes.
- The "While you were away" note names only what waited, in the right number: "1 held request,
  3 notifications" instead of "1 held requests, 3 notifications" or "0 held requests".
