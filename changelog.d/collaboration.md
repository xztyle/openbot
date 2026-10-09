### Added

- Tell an agent when a request that it sent ends with no result. When the other agent's turn fails,
  stops, wrote only a placeholder, or ended while OpenBot restarted, the requester gets one short note
  from OpenBot, so it does not wait for an answer that never comes. A requester that stopped the
  work itself gets no note.
- Show more in `list_agents` for an agent that delegates work: how many questions, approvals and
  browser takeovers wait for you, when a spent plan ends, whether the last turn failed, and whether
  channel work holds the queue. The commands of an approval stay out of the answer.
- Send the report of a routine flow to the agent that owns the routine. When every step has ended,
  the owner gets the status of each step and the last outputs, without an answer to give.
- Name the creator in the first message of an agent that another agent creates. The first task is
  now a request from the creator, so the new agent's result comes back to the creator.

### Changed

- Hold the result of an agent that waits for its own teammates. Before, an agent that asked a
  teammate for help sent its first short status to the requester as the result, and the real summary
  never arrived. Now the requester gets the summary after the teammates answer.
- Stop waiting for a silent teammate after 20 minutes. Answers from the other teammates start a
  turn then, and the prompt names the teammates that are still working.
- Stop a loop between agents: OpenBot does not send a message that repeats one that still waits, and
  refuses more than 20 messages from one agent to one other agent in 10 minutes. It limits the
  agents that other agents create to 20 in 24 hours.
