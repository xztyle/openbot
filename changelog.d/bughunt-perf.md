### Fixed

- A reply that streams in a channel no longer makes every open workspace read the whole channel
  list about ten times a second, and the open channel's 100 messages with it. The list is read at
  most once a second while a channel changes, and the open channel is read again only when its own
  live messages missed a change. On a phone's link this was about two reads of the open channel a
  second for as long as an agent wrote anywhere in the workspace.
- While an agent writes in the open channel, its steps are read every 2 seconds as intended, not
  on each streamed word. An agent's picture that fails to load is no longer loaded again at every
  change of the agent, and the short success face after finished work is no longer cut off by an
  unrelated change.
- The web app loads about 300 KB (64 KB compressed) less script before the workspace shows: Money,
  Org chart, Storage, Loops, Secrets, Reviews, Portfolio, Insights and Trust load when you open
  them.
- The web tab no longer draws its icon again for each message when the unread count stays the
  same, and a reconnect or a server update no longer reads the selected agent's settings, the
  connectors, the routines' time zones and the loop decisions again when nothing they depend on
  changed.
