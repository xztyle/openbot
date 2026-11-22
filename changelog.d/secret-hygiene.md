### Added

- Keep keys and passwords out of chat. When you paste a token, an API key, a private key or a
  "password: …" line into a workspace message, Atelier sends the message with a short marker in its
  place, so the secret is never stored or read by an agent. A notice offers to save it in Secrets as
  a shared key, and reminds you to rotate it if it was shared anywhere else.
