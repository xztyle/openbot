### Added

- Check connected apps on a saved schedule without calling an AI model. Empty checks stay quiet.
  New or changed data wakes the selected agent and adds an event marker to its chat.
- View and edit Event checks and Routines beside Skills and Tables in agent settings, including
  the private web app. Each event check keeps its last ten executions and errors in its own history.

- Default event checks to 30 seconds and skip the connected account’s own changes. The managed
  setup skill checks account identity, change authors and pagination. Tests can explicitly include
  self-events.
