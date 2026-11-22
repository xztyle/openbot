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
- With two tabs of the app open on the same server, and push notifications off, the computer shows
  one notification for an agent's event or a channel reply instead of one from each tab.
- In focus or quiet hours, the owner's open browser tab no longer pops its own notifications or
  plays cues for agent events and channel replies (with push notifications off); it waits, as push
  does. An admin's tab still tells.
- Coming back to the app while the connection is still coming back no longer delays the "When
  you're back" note by up to four minutes: a call that did not reach the server is made again.
- Settings > Notifications says what push notifications cover: mentions, messages to you and
  replies in threads you follow, as well as agents that finish or need you.
