### Fixed

- The owner's chat no longer shows the agent's own activity as the owner's message. When Claude Code joined the Motion notes, a teammate's message and Atelier's notes that waited during a turn into one prompt, the history import stored it as a message from the owner. Such a prompt is now stored as the note it is, and Atelier repairs the rows stored that way at start (with a new event; nothing is deleted).
- A Motion note, a note from Atelier or a teammate's own message in a turn that the owner's message started now folds into "Agent activity"; the owner's message and the answer stay the conversation.
- The queue above the message box lists only the owner's own queued messages, with edit, delete and steer. Queued Motion notes, notes and teammates' messages show as one muted line with no actions, and the host refuses to edit, delete or steer them for a person (web, phone and desktop).
