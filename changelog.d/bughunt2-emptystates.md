### Fixed

- On a phone, a host that does not answer on the first load shows the connection screen with Retry.
  Before, the phone showed an empty Today ("Nothing waits on you") and a first-run guide that asked
  you to make agents and channels that the host already had.
- The Today guide waits for the host's channels before it shows its steps, so a slow first load does
  not show done steps as undone.
- The Today guide of a host or a space with no agent starts with New agent.
- In a new space, the guide's channel step makes a channel in that space. Before, it opened #general
  of General and left the new space, and the step stayed undone.
- Portfolio > Templates shows the validation score of a new space when the host has it. Before, the
  import said "Validating" until you left the tab and opened it again.
