### Fixed

- After the server restarts or loses its network, phones and browsers connect again as soon as it is
  back. Signal used to keep the server's dead connection for up to two minutes and send every device
  to it; it now ends a server connection that answers nothing for 30 seconds, and devices wait for
  the server instead.
