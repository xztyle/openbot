### Added

- Event checks keep the readable name of each conversation you pick. A chosen channel, direct
  message or group shows its name after a reload, without loading the list again. A rename in the
  app is picked up the next time the list loads. The saved value stays the same `ID:mode` text.
- The check editor names saved choices with one small request when the private value is saved, and
  loads the conversation list by itself when it opens. OpenBot keeps the list in memory for ten
  minutes, so adding a second conversation does not load the list again. The editor shows how old
  the list is, a Refresh button, and a note when the app could not be reached and an older list is
  shown. The install dialog still loads the list only when you press the button.
- Slack activity 1.4.0 reads the names of direct message partners from the member list, a page of
  200 at a time, instead of one request for each person. It can also name only the conversations
  that you already chose, and says which account the token belongs to.

### Changed

- A change of a conversation name never resets a check's baseline.
