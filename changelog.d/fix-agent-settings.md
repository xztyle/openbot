### Changed

- Memories: you can undo a delete from the toast for a few seconds. A change that you did not save
  stays when you open another memory, and OpenBot asks before it throws the change away or closes
  the list. The text for a full list says what to do.
- Agent settings now show a save error under the setting that failed, and the error names the
  setting. A field with a limit shows its character count near the limit, and says when a paste was
  cut.
  An empty agent name shows an error. Before, it was saved as "New agent".
- The routine editor marks the name and the instruction as required, says why Save is off, and shows
  the next run and the time zone under the schedule. Delete now comes after Save and says what it
  removes. A routine list row says when the last run failed.
- A routine run shows its result in words, and a failed run shows its error. Before, only an icon
  showed the result.
- The model picker and "Start new chat" say why they are off while the agent works.
- Usage names a deleted agent "Deleted agent" and shows the daily dates in your language. The cost
  says that it is an estimate, not a bill.
- "Unpublish" for a shared agent asks first and says that the link stops working. The publish
  window shows what is published and who can open the link.

### Fixed

- The Notifications switch, the avatar color and the generated avatar face kept a new value when the
  save failed. They now go back to the saved value.
- The skill list read "Enable" in English for each skill switch in every language. The question
  about a skill now returns focus to the menu button of the skill that you chose.
