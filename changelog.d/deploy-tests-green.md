### Fixed

- On a phone, leaving, archiving or closing the open conversation shows the Today tab with its tab bar, not a Today page with no way back.
- The server memory guard no longer stops a small idle process, such as a routine's `sleep`, while the process that fills the memory is too young to stop.
- An agent chat with no workspace around it, as in Storybook, no longer stops with "Context has no provider": the secret check of the composer reads the workspace only where one is mounted.
- A reply that streams in a chat no longer pulls the chat back by a line on each new line while the reader follows the end.
