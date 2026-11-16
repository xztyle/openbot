### Fixed

- When the server reaches its limit of processes and threads, such as the `pids_limit` of a Docker container, a Claude turn that fails because of it says so and tells you to raise the limit. Before, it said only "Claude Code process terminated by signal SIGABRT". The resource log now records the number of processes and threads, the limit, and how many were refused.
- After you save the edit of a queued message, the text and files that you wrote in the composer before you chose Edit come back, as after Cancel. Before, Save deleted them.
- In the web app, a queued message that you steer just as the agent's turn ends goes to the next turn with no error. Before, the web app said "The active turn changed before this message could be steered." The desktop app now also ignores this refusal when it comes before the end of the turn shows.
- A message that waits behind a message that failed to send says "Waiting. Retry or dismiss the message above." Before, it showed no status and looked sent.
- In the web app, a change to another server keeps the text that you wrote to each agent. Only the files go, because they were uploaded to the server that you left. Before, all draft text was deleted. A reconnect to the same server no longer hides the composer errors.
- In the web app, the files of a queued message that you edit, and of the draft that the edit put aside, stay when you change to another server and come back. Before, the change deleted them, and Save or Cancel then failed or lost the files.
