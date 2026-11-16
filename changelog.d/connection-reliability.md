### Fixed

- The web client shows the server's own reason when the server refuses a request, such as a name that is too long, instead of "The server could not complete this request. Refresh before trying again."
- A short connection loss, such as a server restart, no longer fails requests in the web client. A request that did not reach the server, and any read, waits for the reconnect and is sent again. When the connection does not come back, the message says that the connection dropped.
