### Fixed

- The web client shows the server's own reason when the server refuses a request, such as a name that is too long, instead of "The server could not complete this request. Refresh before trying again."
- A short connection loss, such as a server restart, no longer fails requests in the web client. A request that did not reach the server, and any read, waits for the reconnect and is sent again. When the connection does not come back, the message says that the connection dropped.
- The web client no longer drops its server connection after about ten returns to the browser tab. Each return restarted the connection path, and the server replaces a connection after ten restarts. The web client now checks the path first and renews it only when the check fails.
- A window focus no longer shows an error toast when the account service or the server connection fails for a moment during the background refresh. The connection status still shows a lost connection.
- The event checks panel no longer stays on "Loading event checks…" when the connection loses the answer. The list read has a 30-second limit, is read again after a reconnect, and otherwise shows Retry.
