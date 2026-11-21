### Fixed

- On the web, a secure code or password card no longer stays hidden when the host's event stream
  stops while reads still work. When a running turn is silent and the requested runtime snapshot
  does not come, the web client replaces the connection, and the card and "Needs you" show.
