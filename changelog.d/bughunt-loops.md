### Fixed

- Loops: a value typed in one item's fields no longer shows in, or saves to, the next item you
  open. Each item keeps its own unsaved values until you save or cancel them.
- Loops: a money or number field now saves "1,200", "12,5" or "$49" as a number, and says when
  a value is not a number. Before, such values were saved as text, so a money gate showed no
  amount and exit metrics never passed.
