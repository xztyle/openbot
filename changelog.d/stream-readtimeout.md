### Fixed

- The web client no longer shows "needs your attention" and "The server did not answer in time." over a chat that shows its messages when one read of the chat is late, such as during a turn on a connection through a relay. The read deadline now starts when the read leaves and waits while the answer still arrives, a read without an answer is sent once more, and a failed read after a server event shows no error.
- The server log names a Team API answer that waited one second or more to leave over a device connection, with the data that waited before it.
