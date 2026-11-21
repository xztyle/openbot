### Fixed

- On the web, a secure code or password card no longer stays hidden when the host's event stream
  stops while reads still work. When a running turn is silent and the requested runtime snapshot
  does not come, the web client replaces the connection, and the card and "Needs you" show.
- An answer that the reply condenser shortened no longer shows twice after a restart. The restart's
  history import read the agent's own text again and stored it beside the condensed answer. It now
  matches the answer by its kept original, and the next restart turns an already stored copy into
  a step, so the chat shows one answer.
