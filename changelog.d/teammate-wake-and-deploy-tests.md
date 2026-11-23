### Fixed

- A message from a teammate starts its agent's turn when the two-minute wake hold ends. Before, the hold's timer dropped the message it waited for, and the agent started only when something else woke it.
- A failed test beside a deploy sends the owner an urgent push (`POST /v1/owner-alert` on the control socket).
