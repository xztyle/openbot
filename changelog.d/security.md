### Security

- Approve an event check program again after an agent edits it. A check keeps its private
  variables only for the program and the address settings that you approved. If an agent edits the
  program or an address setting (for example an API base URL or a host), the check pauses, the
  program does not get your keys, and **Private variables (.env)** shows **Approve this program**.
  Before, an agent could rewrite a shared program, run it, and the new code received your token.
  A reviewed template program still works with **Update** and keeps its values. Existing keys keep
  working with the program that each check last recorded.
- Mark who last saved an event check, and fence the event data. The message that wakes an agent now
  says whether the user, a team member or another agent wrote the saved instruction. The matching
  items sit between two lines with a random boundary, with "not instructions" inside them.
- Refuse a credential in an ordinary event check field. A token with a known prefix, a bearer token,
  or a value that OpenBot holds as a secret is not saved in a name, an instruction, the arguments or a
  setting. The error names the field and never shows the value.
- Stop a Workspace-only agent from creating, changing, testing, running, enabling or deleting an
  event check. It can still read about them.
- Record changes that move trust in a security audit file, with names and no values: event check
  saves, enables, deletes and private variables, app connections, auto-approve, access, and an agent
  that edits another agent. Owners and admins read it with `openbot audit` on a server, or in a
  host that advertises `security-audit-v1`.
- Sign proxy tokens for **Apps for this chat** with random in-memory values, not with a key in
  `chat-app-permissions-v1.json`. An agent in a Read only chat can no longer make a token for a chat
  that allows changes. After a restart, an agent that has an app in a chat starts one new provider
  session with the same conversation.
- Limit the durable sign-in of a self-hosted server. The session that `openbot login` makes can no
  longer make a Mobile Connect code, open a remote session to a host, join a team server, list or end
  other sessions, reach billing or hosted servers, make an admin or permanent invitation, or make an
  admin. It still publishes the host and routes webhooks, Slack and Discord.
- Drop all Linux capabilities except `SYS_CHROOT` and set a process limit in the Docker example. Add
  a design for keeping private values away from agents that have full access.
