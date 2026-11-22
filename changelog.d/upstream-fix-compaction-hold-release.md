### Fixed

- An agent's messages no longer wait with "compaction" until a restart when the end of a turn failed
  after it reserved a compaction. Now the reservation ends with the failed turn end, and the next
  message starts.
