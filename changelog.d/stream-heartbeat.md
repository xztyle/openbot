### Fixed

- The web client finds a server connection that stops delivering while it still looks connected. A connection that received nothing for 30 seconds sends a small check, and so does a read that got no answer; a check that gets no answer connects again at once. Before, the chat could wait for a finished reply for minutes, with "has sent no update" under it.
- When a running reply of the open chat sends nothing for 45 seconds, the web client reads the chat once. When the server finished or changed it and no event came, the web client replaces the connection quietly and reads the workspace again.
- "Some workspace panels could not load" no longer stays after a short connection loss: the panels are read once more after 10 seconds.

### Added

- The server log shows why a device connected again after its connection failed, such as `heartbeat-timeout` or `event-stall`, with counts and the time offline. It also shows the path of each device connection (candidate types only, never an address), each path that the server lost, and each TURN allocation that the TURN server refused.
- `TURN_ALLOWED_PEER_IPS` for the TURN container: the private address of an OpenBot container on the same machine, so that devices reach it through one relay and not through a second allocation of the server.
