### Fixed

- Stop the Marketplace from adding a second account of an app that is already connected. Before, an
  app showed Connect until the list of apps arrived, and a press on it saved a new account. Now the
  app shows Checking, and a failed read shows Retry.
- Let the user cancel a browser sign-in for an app. Before, the window could not be closed for up to
  five minutes after the browser tab was closed.
- Show an app as needing attention when its browser sign-in is gone, with Sign in again as the main
  action. Before, the app showed Connected.
- Show the result of an action in the Marketplace window. Before, only a screen reader got it.
- Make the app page fit a phone screen. Before, the app name shrank to a few pixels beside the
  buttons.
- Say what removing one account takes, and name the server that holds the app when it is not this
  computer.
- Ask before the Marketplace removes a skill from several agents, or deletes skill files that the
  user changed.
- Keep the Bitwarden session key after a refused connect, ask before Disconnect, and say when the
  connection status could not be read.
- End a browser app sign-in when the user closes its window. Before, the sign-in waited until the
  attempt expired and then said that it was cancelled.
- Tell a member of a joined server that only an owner or admin can connect apps. Before, every app
  showed Not connected with no reason.
