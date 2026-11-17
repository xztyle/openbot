### Fixed

- The app finds a server connection that stops delivering while it still looks connected. A connection that received nothing for 30 seconds sends a small check, and so does a read that got no answer; a check that gets no answer connects again at once.
