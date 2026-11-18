### Changed

- The note that tells an agent to continue after a restart is now a small marker in its chat, "OpenBot restarted · <agent> resumed its work". Before, it showed as a message from you. It does not make the chat unread. The server control socket can send an operator message as such a note with `system: true`; without it, the message is still yours.

### Fixed

- The steps of an agent, the labels of its tool steps and its trace show email addresses again. Before, an address that the agent wrote, such as one it made for itself, showed as `[redacted-email]`. Logs, reports and event check results still hide email addresses, and keys and tokens are still removed everywhere.
