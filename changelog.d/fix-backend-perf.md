### Fixed

- Show the real reason when an event check is refused on a host that you open from the web or the
  iPhone app. Before, a refused install, update, save, remove or check now showed a general
  failure text.
- Keep the roster history of the database from growing with each message. Before, every message
  added a full copy of the agent list that nothing read again.
- Use less processor time on a host that runs for a long time: fewer reads of the agent list while
  an answer streams, one read of the status for all connected clients when a turn ends, and fewer
  checks of process files and event check programs.
