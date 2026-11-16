### Fixed

- The server no longer stops for about 100 ms each time a client reads the unread counts of the chat list. A connected client reads them after each change in a chat that it does not show, so the server felt slow while agents worked.
