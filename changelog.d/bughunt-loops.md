### Fixed

- Loops: a value typed in one item's fields no longer shows in, or saves to, the next item you
  open. Each item keeps its own unsaved values until you save or cancel them.
- Loops: a money or number field now saves "1,200", "12,5" or "$49" as a number, and says when
  a value is not a number. Before, such values were saved as text, so a money gate showed no
  amount and exit metrics never passed.
- Loop editor: the stage checklist takes new lines and spaces as you type them. Before, Enter and
  a space at the end of a line were removed, so a new checklist entry could not be typed.
- Loop editor: a stage metric that is not a rule, such as `sales >= one`, now stays in the box
  with the reason and blocks Save. Before, it was dropped without a word.
- Loop editor: Escape, a click outside and Cancel ask before they discard your changes. A new blank
  loop names its stages in your language.
