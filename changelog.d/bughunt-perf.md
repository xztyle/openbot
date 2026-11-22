### Fixed

- A reply that streams in a channel no longer makes every open workspace read the whole channel
  list about ten times a second, and the open channel's 100 messages with it. The list is read at
  most once a second while a channel changes, and the open channel is read again only when its own
  live messages missed a change. On a phone's link this was about two reads of the open channel a
  second for as long as an agent wrote anywhere in the workspace.
