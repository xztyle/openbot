### Fixed

- When one Claude agent's process crashes, only that agent's turn fails. Before, the crash stopped the turns of every Claude agent on the server, and their routine runs and messages ended as if OpenBot had restarted. The agent whose process crashed answers its next message as usual.
