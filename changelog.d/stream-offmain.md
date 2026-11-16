### Fixed

- The server stays more responsive while many agents work and several apps are connected. A chat
  page, the unread counts of the chat list and the message and file search now read the database on
  their own threads, so the server goes on with other work while they read. In a load test with 12
  streaming agents, the server's main thread was busy about 10% less with one connected app and
  about 16% less with three, and with one app it paused for 150 ms or more about half as often. A
  search through a long history no longer stops the server for 100 to 260 ms.
