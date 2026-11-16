### Added

- An MCP row can name the agent's space with `{{space.id}}`, `{{space.name}}` and `{{space.slug}}`, the same way as `{{agent.id}}` and `{{agent.name}}`. The General space is `general`. Motion uses it to keep the agents of each space in their own workspace.

### Changed

- Spaces, the space agents view and their messages are now in Spanish when OpenBot is in Spanish.

### Fixed

- On a phone, in the web client, a tap on a space in the space rail keeps the list of that space on the screen. Before, it opened Activity and hid the space rail.
