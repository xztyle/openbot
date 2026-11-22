### Fixed

- Secrets on an iPhone: Copy on a key now copies it. Before, Safari refused the copy because the
  key was read from the host first, and nothing said so. A copy that fails anywhere in Secrets,
  Connections or Mailboxes now says so, so a token that shows once never looks copied when it is not.
