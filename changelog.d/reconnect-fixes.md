### Fixed

- After the server restarts or loses its network, phones and browsers connect again as soon as it is
  back. Signal used to keep the server's dead connection for up to two minutes and send every device
  to it; it now ends a server connection that answers nothing for 30 seconds, and devices wait for
  the server instead.
- The web app tries again after 30 seconds, not two minutes, when its first attempts to reach the
  server fail. After a 40-second restart it was back about 27 seconds after the server, not about
  two minutes.
- When a deploy restarts the server, it tells phones and browsers first, and they ask again every
  few seconds: back about 2 to 3 seconds after the server.
