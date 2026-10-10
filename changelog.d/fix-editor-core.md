### Fixed

- Keep the list of conversations in an event check after you choose one or save. Before, the list
  went away and you had to load it again for each choice.
- Show the conversations that you chose under "Chosen" before the list loads. Before, they showed as
  raw IDs under "not in the list".
- Show a true-or-false setting of an event check as a switch in the editor, as the install dialog
  does. Before, it was a text box.
- Keep the values that you typed in the other private variable fields when you save one value. Before,
  saving one value cleared all of them and closed the open history.
- Show the name that the template gives a private variable, and say "Save your other changes first"
  when its fields are off.
- Say that the event check list is loading, and offer Retry when it cannot load. Before, it showed
  "No event checks yet." in both cases.
- Show why a check keeps failing, and why Save, Check now and Test are off, as text in the editor.
  Each failed action now says what failed.
- Keep your edits in the event check editor when the connection to the host changes.
- Move focus to Cancel when you press Delete on an event check, and keep Save off when the interval is
  empty or shorter than 30 seconds.
