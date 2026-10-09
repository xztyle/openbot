### Added

- Reuse shared API watcher programs across agents and workspaces. Each check has separate masked
  private variables and ordinary configuration fields that the agent defines and the user can edit.
- Test paused API checks without starting AI or adding messages to chat.

### Changed

- Require direct API checks in the watcher creation skill. Existing MCP checks remain supported.
