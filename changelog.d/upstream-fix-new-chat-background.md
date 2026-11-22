### Fixed

- A Claude agent that starts a new chat by itself no longer stops its background subagents and
  commands and loses their result. The new chat now waits until that work ends and the agent has
  answered its result.
