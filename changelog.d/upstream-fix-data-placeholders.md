### Fixed

- An agent's shared data write with fewer values than `?` placeholders is now refused with a clear
  message. Before, it saved NULL in place of each missing value, with no error.
