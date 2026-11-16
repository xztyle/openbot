### Fixed

- When one Claude agent's process crashes, only that agent's turn fails. Before, the crash stopped the turns of every Claude agent on the server, and their routine runs and messages ended as if OpenBot had restarted. The agent whose process crashed answers its next message as usual.
- The web app shows every approval and browser step that waits for you after a reload or a reconnect. Before, the server's status update held only four waiting requests for all agents, questions first, so with several questions open an agent showed as waiting with no card to answer. A browser step also stayed visible through a short loss of the connection.
- In agent settings, two quick changes of the channel defaults, such as the focus and the answer mode, are both saved. Before, the second save could write over the first.
- An event check variable that links to a key you deleted from Secrets can be removed, and its select shows the key it links. Before, the Remove button was off and the select showed nothing.
- A routine run that failed, needs attention or stopped shows why under its row in the chat, such as "Connect Claude to continue." The run history in the routine settings now also says why a run stopped.
- In the web app, a change of schedule on a routine card in the chat is saved. Before, it always failed, because the card used calls that only the desktop app has.
