### Changed

- New agent, new channel, new message, new space, add members and the channel topic and description
  edits now use one dialog: the same header, fields, error line and Cancel and Create buttons. On a
  phone each one fills the screen, with its buttons above the home indicator.

- Workspace views (Activity, Threads, Fleet, Space agents, Secrets, Between agents) show placeholder
  rows while they load, a reason with Retry when they cannot load, and a different message for "no
  matches" than for "nothing yet". The New agent and Add secret buttons are the same in each header.
- Activity opens the exact message, scrolled to and marked. Its badge no longer counts reactions, and
  Mark all as read marks only the conversations in the list, not every channel.

### Fixed

- In the web client, a new agent now opens its chat when it is made, as in the desktop app.
- In the web client, Create agent no longer looks active but does nothing after a failure whose
  result is not known. It is off, and the message says to check the server first.
- Secrets: a failed save or delete shows its reason in place, and the dialog stays open. Before, a
  failed load said "No secrets yet".
- Between agents no longer shows the talks of agents in other spaces after an agent works.
- Storage: a failed read during a scan no longer leaves the progress bar and a disabled Scan again on
  screen.
- Fleet: the Assign button, which did the same as Message, is gone.
