### Added

- Owners and admins can turn on Coordinator routing for a channel in its Settings, and pick the
  lead agent. The lead then gives each message to one member, and the answer mode of each agent
  does not apply. An agent that you mention still answers your message.
- A link to a workspace message (`openbot://workspace/...`) now opens the app from a browser or
  another app. OpenBot comes to the front, switches to the server, and opens the channel and the
  thread.

### Fixed

- When a moderator deletes many Discord messages at once, the messages that the bridge brought into
  the workspace channel are now deleted too. Before, only single deletions reached the channel. The
  Discord bot needs a Signal update.
