# Private app connections

This fork supports browser sign-in on a private hosted OpenBot. OAuth tokens and app settings
stay on the host. The app provider still receives its own requests. The callback passes a short
authorization code through the private website; it never receives a refresh token.

Set these variables in the host container:

```text
OPENBOT_MCP_REMOTE_CALLBACK_URL=https://YOUR-PRIVATE-HOST/mcp-auth
OPENBOT_MCP_CHAT_PERMISSIONS=true
```

Deploy this fork's account website at that same hostname. Protect the whole hostname, including
`/mcp-auth`, with your own account access rules. Do not exempt the callback from authentication.
The host accepts only its configured callback. A sign-in belongs to the initiating administrator
and session, uses PKCE, expires after five minutes and consumes its return once.

Open Marketplace, select an app and select **Add account**. Give each account a different name,
such as **Slack — Job A**. Repeat for other accounts. Tokens go in the connection form, not chat.
Disconnecting one new account removes only its credentials. Older connections retain their
original shared credential scope for compatibility.

Open **Apps for this chat** in a direct or group conversation. For each account, select:

- **Off**: the chat receives no tools from that account.
- **Read only**: the host lists and accepts only tools declared read-only, with no destructive hint.
- **Allow changes**: the chat can use that account's offered tools, including sending tools.

New chats start with all app accounts off. Scheduled work uses its chat's choices. A group has
one shared selection for its members. Changes affect subsequent calls and cancel running proxy
calls; they cannot undo an action the app already accepted.

The pinned Slack community server uses a reviewed list of reading tools. Its account caches stay
separate, and posting tools are available only when the chat permits changes. Slack requires a
user OAuth token; this does not use Slack session cookies. The official Slack MCP currently needs
a separately registered client, so the catalog labels the community connection.

These settings govern MCP calls. They do not isolate terminal access, browser access, files,
credentials in other processes, or work delegated into another chat. Coding agents run with the
host's existing access. Use separate hosts or operating-system isolation for untrusted agents.
Read-only metadata also depends on the selected app server describing its tools correctly.

App headers and environment variables remain in the local configuration database. Do not assume
every credential type has encryption at rest. Keep host backups private and use limited tokens.
No app is connected or granted access merely because it appears in the catalog.

## Proxy tokens

An agent does not get the credential of an app. It gets a loopback URL and a token for one chat and
one account. The token is random and only in the memory of OpenBot. It is made when a chat first
gets the account, and it is gone when OpenBot stops. A restart gives a new token to each chat, and a
provider session that was started before it gets the new URL the next time its thread is configured.
That replaces the Codex session of an agent that has an account in **Apps for this chat** once
after each restart, with the same conversation. An earlier release signed the token with a key in
`chat-app-permissions-v1.json`. That key let any agent that could read the file make a token for a
chat that allows changes. The file now holds a random value that nothing uses. It stays so that an
earlier release can still read the file.

The token keeps an agent that is limited to **Read only** or **Off** from reaching an account that
another chat allows changes for, by accident or by a mistake in a prompt. It is not a boundary
against an agent that has full access to the computer.
