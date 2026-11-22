### Fixed

- Secrets on an iPhone: Copy on a key now copies it. Before, Safari refused the copy because the
  key was read from the host first, and nothing said so. A copy that fails anywhere in Secrets,
  Connections or Mailboxes now says so, so a token that shows once never looks copied when it is not.
- Today, Artifacts and Tasks: a file that does not open or download now says so. Before, the tap
  did nothing.
- Copy text and Copy link in a message's or a channel's menu now say when the copy fails, and fall
  back to the browser's copy command when the clipboard refuses. Before, nothing was copied and
  nothing was said.
- Insights: while the host does not answer, a failed refresh shows one toast. Before, a new one
  stacked every two minutes and each time the page showed again.
- Mailboxes: when the host refuses to remove an address, the question stays open with the reason.
  Before, it stayed open with no word, and the address still got mail.
- A malformed answer from the host in Learning, playbooks, reviews, memories, routine history,
  mark unread and file downloads now reads "The host returned invalid data." in your language.
  Before, it showed a fixed English sentence such as "Invalid answer.".
- Web app: a host failure that repeats, such as a read that fails each time the page shows again,
  now replaces its toast instead of stacking a new one each time.
- Money: when the costs do not load, the view says so with Retry. Before, it said "No cost in this
  period", as if the agents had cost nothing.
- Mark all read in Unreads, Activity, a sidebar row's menu and the Mark all read shortcut now says
  when the host refuses. Before, nothing was said, Unreads emptied as if everything was read, and
  the shortcut's dialog closed as if it worked.
- Quiet hours, focus and the "When you're back" answers no longer say they worked while the host is
  away. Before, Save closed the dialog and an answer said "answered" although nothing reached the
  host; now they say the change failed, and you can try again.
- Connections and Mailboxes: revoking an access link, changing a sender, or changing, removing or
  adding a mailbox while the host is away now says it failed. Before, the dialog closed and
  "revoked" or "saved" showed, although the host never got the change and the link still worked.
- Connections: after you revoke an access link, the toast says "Link revoked" instead of "Revoke".
