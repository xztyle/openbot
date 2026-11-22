### Fixed

- Secrets on an iPhone: Copy on a key now copies it. Before, Safari refused the copy because the
  key was read from the host first, and nothing said so. A copy that fails anywhere in Secrets,
  Connections or Mailboxes now says so, so a token that shows once never looks copied when it is not.
- Today, Artifacts and Tasks: a file that does not open or download now says so. Before, the tap
  did nothing.
- Copy text and Copy link in a message's or a channel's menu now say when the copy fails, and fall
  back to the browser's copy command when the clipboard refuses. Before, nothing was copied and
  nothing was said.
