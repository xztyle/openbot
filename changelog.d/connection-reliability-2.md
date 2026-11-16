### Fixed

- When the server says that the web client missed events, the web client reads the workspace again without a "connecting" state, and it now also asks for pending approvals and questions again.
- A web or phone connection that goes through the relay no longer drops after about seven and a half hours. Before the server's limit of ten connection-path restarts, the client replaces the connection quietly, after the writes in flight end.
