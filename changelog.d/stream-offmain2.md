### Fixed

- The server stays more responsive while agents stream answers and several apps are connected. It
  no longer copies and checks every message of a chat at each change, the page of an open chat leaves
  the database thread ready to send, apps that read the same page at the same moment share one read,
  and routines that come due at the same minute, or many agents that start at once, no longer hold
  the server in one long step. In a load test with 12 streaming agents and three connected apps, the
  server paused for 150 ms or more 7 times a minute instead of 12.
