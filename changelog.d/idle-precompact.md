### Changed

- A Claude agent with a large chat compacts it once after 55 minutes idle, while its prompt cache
  is still warm, and keeps its latest exchanges word for word. Its next wake reads a small context
  instead of writing the whole chat to the cache again. Set `OPENBOT_IDLE_PRECOMPACT=off` to turn
  it off.
