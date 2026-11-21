### Added

- Set an agent's model policy to Automatic in its settings, under Cost and performance. Routine
  runs then use Haiku in their own session. Chats keep the agent's model, so no cache is rewritten.
  The agent moves to Opus for one turn after a failed turn, or when it asks with `escalate_model`.
  The working line shows the model, and debug mode shows why.
- Put an agent to sleep in its settings, a team from the org chart panel, or a space from the space
  menu. A sleeping agent runs no routines or checks and starts no turn. Messages to it wait until it
  wakes, and its face sleeps. Leads can do this for their own team with `set_team_sleep`.
- Read a short weekly review of each agent in the new Reviews view and in the agent settings. A
  review can propose an instruction. You edit it, add it, or dismiss it. A review never changes an
  agent by itself.
- Give the agents of a role a shared playbook skill in Reviews → Playbooks. Agents of the role get it
  now and later, and they can propose changes for you to apply. A skill that several agents share
  can become a playbook in one click.

### Changed

- Claude subagents use Sonnet by default, unless the server's provider variables set
  `CLAUDE_CODE_SUBAGENT_MODEL`.
