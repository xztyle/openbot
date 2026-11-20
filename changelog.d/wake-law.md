### Changed

- A new message from one agent to another that asks for no answer no longer starts a turn. It waits
  in the queue, marked "Waits for the next turn", and the agent reads it with the next message that
  starts its turn. Status updates between agents now use fewer tokens.
- Agents message only the teammates that must act or decide, and send no acknowledgements or
  copies "so they know".
