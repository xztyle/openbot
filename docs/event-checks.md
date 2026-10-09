# Event checks

An event check is an ordinary program on the OpenBot host. It calls a saved reading tool from
one connected app account. It does not call Codex, Claude, or another AI model to check for work.
App request limits still apply. A matching event can start an AI turn.

Open an agent's settings and select **Event checks**, beside **Skills**, **Tables**, and **Routines**.
Choose an account already enabled in **Apps for this chat**. Select its reading tool, query options,
result-list path, stable item ID path, and optional revision path. Give the agent an instruction for
matching changes. Choose an interval of at least one minute, or a calendar schedule and time zone.
A bot can also configure checks through OpenBot's native event-check tools.

The first successful read saves a baseline and stays quiet. Subsequent checks compare item IDs
and revisions. If the revision path is blank, the program compares the complete item. Query options
decide which data matters. Use a query for new mentions, assigned tickets, or relevant pull requests.
Pagination must cover the complete query; configure its cursor fields if the app returns pages.
An exact JSON string value `$lastSuccessAt` expands to the last successful read minus five minutes;
`$now` expands to the current time. The overlap lets the saved baseline remove repeated results.

Empty checks, unchanged checks, and errors do not add chat rows, unread counts, completion messages,
or notifications. **Last 10 checks** shows start time, duration, result count, event count, and safe
error information. **Check now** uses the saved definition; save edits first. You can pause a check
even if its app is disconnected.

New or changed items add one **Event check: NAME — triggered** marker and one durable agent delivery.
The agent receives the matching data as untrusted app content and the saved instruction. A pending
batch survives a restart. The mailbox's idempotency key prevents a retry from making a second turn.
Changing timing or instructions keeps the baseline and pending batch. Changing the account, query,
or result selection resets the baseline and cancels batches from the old query. Deleting a check
removes its settings, history, baseline, and pending batches, but does not erase prior chat messages.

## Permissions and storage

Checks use the same host-owned MCP credentials as the existing app connection. They never receive
credentials in their saved definition. Each check uses only its selected account and the target
chat's current permissions. Its app calls are always read-only, including in a chat that permits
changes. Fresh tool metadata is checked before each call. Permission revocation, agent deletion,
and host shutdown prevent an in-flight observation from queuing an event.

Settings, fingerprint records, ten-entry history, and pending event data stay in the host's SQLite
database. Poll history contains counts and safe errors, not app payloads or credentials. Pending
data is removed after delivery. A fingerprint baseline retains at most 10,000 recently seen IDs;
an item that returns after leaving that bounded history can be treated as new. A read is bounded to
45 seconds, 20 pages, 2,000 items and 512,000 bytes. Oversized or malformed results fail without
advancing the baseline. The existing full host access of coding agents is unchanged.

This extension negotiates the optional `event-checks-v1` capability. Older clients do not receive
its chat markers or controls. SQLite migration 31 adds separate tables and keeps released schemas
and existing agent data intact.
