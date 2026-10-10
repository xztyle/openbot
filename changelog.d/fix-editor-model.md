### Changed

- Save an event check and its private variables with one **Save**. The Save and Reset buttons show
  only when you have unsaved changes, and "Saved" confirms the result. Before, each private value had
  its own "Save value" button and you could not type a value while other settings were unsaved.
- Mark a private value for removal and apply it with **Save**. **Reset** takes it back. The editor
  says before you save that a new or removed value pauses the check and resets its baseline.
- Press **Done** in the install dialog to save the private values that you typed for each new check.
  Before, closing the dialog dropped them.

### Fixed

- Ask before you lose unsaved changes. The event check editor, the install dialog and the custom
  provider form now show "Discard changes?" when you press Back, Close, Cancel or Escape, click
  outside, or move to another agent. The web client also asks before you close the tab. Before, what
  you typed was lost with no warning.
- Show the unit of the check interval next to the number, and mark the required fields (name,
  program and instruction) with `*`. A switch no longer shows "Optional", and a setting no longer says
  "Optional" twice.
- Move focus to the first field with an error when Install finds one.
