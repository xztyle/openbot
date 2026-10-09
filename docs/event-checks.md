# Event checks

An event check is an ordinary program on the OpenBot host. It calls a saved reading tool from
one connected app account. It does not call Codex, Claude, or another AI model to check for work.
App request limits still apply. A matching event can start an AI turn.

Open an agent's settings and select **Event checks**, beside **Skills**, **Tables**, and **Routines**.
Choose an account already enabled in **Apps for this chat**. Select its reading tool, query options,
result-list path, stable item ID path, and optional revision path. Give the agent an instruction for
matching changes. Choose an interval of at least 30 seconds (the default), or a calendar schedule and time zone.
An agent can configure checks with native tools and the installed **openbot-event-checks** skill.

The first successful read saves a baseline and stays quiet. Subsequent checks compare item IDs
and revisions. If the revision path is blank, the program compares the complete item. Query options
decide which data matters. Use a query for new mentions, assigned tickets, or relevant pull requests.
Pagination must cover the complete query; configure its cursor fields if the app returns pages.
An exact JSON string value `$lastSuccessAt` expands to the last successful read minus five minutes;
`$now` expands to the current time. The overlap lets the saved baseline remove repeated results.

Empty checks, unchanged checks, and single errors do not add chat rows, unread counts, completion
messages, or notifications. **Last 10 checks** shows start time, duration, result count, event count,
and safe error information. **Check now** uses the saved definition; save edits first. You can pause a
check even if its app is disconnected. See [Failures](#failures) for what happens when a check keeps
failing.

New or changed items add one **Event check: NAME — triggered** marker and one durable agent delivery.
The agent receives the matching data as untrusted app content and the saved instruction. A pending
batch survives a restart. The mailbox's idempotency key prevents a retry from making a second turn.
The agent can answer a check's message with exactly `[[no-update]]` when nothing needs the user. A turn
that has only event check messages and ends with that answer leaves no message, no unread count and
no notification. The marker row **Event check: NAME — triggered** stays. Any other answer, or a turn
that also holds a message from a person, stays visible. The prompt of every event asks for the marker.
Changing timing or instructions keeps the baseline and pending batch. Changing the account, query,
or result selection resets the baseline and cancels batches from the old query. Deleting a check
removes its settings, history, baseline, and pending batches, but does not erase prior chat messages.

## Failures

A check that fails waits longer before it runs again. The wait doubles for each error in a row (among
the last ten checks), up to 15 minutes or 16 intervals, whichever is shorter. A check whose interval
is already longer than that waits its normal interval. A success sets the wait back to normal.

A program can say why it failed. It prints one line on standard error, `openbot-error: auth`, and exits
with a code other than zero. The codes are `auth`, `rate_limited`, `config` and `upstream`. OpenBot
shows a fixed message for each code in **Last 10 checks**. It never shows the program's own text, which
could hold a secret. A program that prints no code, or another code, gets the general message.

| Code | Shown message means |
| --- | --- |
| `auth` | The app did not accept the saved credentials. |
| `rate_limited` | The app limited the requests. The check waits. |
| `config` | The app did not accept the check's settings. |
| `upstream` | The app could not be reached or sent an error. |

The list of checks marks a check with **Failing** when its last check ended in an error. At the fifth
error in a row, OpenBot tells the user once: an error notice for the agent, and a desktop or browser
notification at the levels **All activity** and **Only when it needs me**. The next failure streak,
after a success, tells again. OpenBot also tells the user once when an event was found but could not
be handed to the agent, and when an event check turn stops with an error. The same applies to a
scheduled routine run that fails. The server level **Nothing**, mute, and the agent's own switch turn
these notices off.

## Delivery

By default each check that finds changes starts its own message to the agent. Two optional settings
change this. Both are in the check's **Delivery** section.

- **Combine events** collects events for 1, 5, 15 or 60 minutes. They reach the agent as one message,
  and an item that changed twice appears once with its newest data. The message goes out at the first
  check after the time passes.
- **Only deliver items that match** keeps items out of the delivery. Write one filter on each line,
  a JSON Pointer and a value, such as `/state=open`. All filters must match. An item that does not match
  does not wake the agent, but the baseline still records it, so it cannot come back as new later.
  **Last 10 checks** counts these items.

Hosts that keep these settings advertise `event-check-delivery-v1`. It adds three optional fields to the
existing routes: `delivery` on a check, `health` on a listed check, and `filteredCount` on a check log
entry. Older clients ignore them. A client that does not send `delivery` when it saves a check leaves
the saved value as it is. Older hosts do not keep `delivery`, so a client hides the **Delivery**
section for them. The settings live in the saved definition. SQLite needs no migration.

A check also sends at most 12 messages an hour to its agent. The limit lives in memory, so a restart
starts a new hour. Over the limit, events wait in the outbox and go out as one combined message when
a place frees. No event is dropped.

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

## Self-events

Checks skip changes made by the connected account by default. Configure its verified user IDs
and the actual change-author ID path. The identity filter is bound to that exact app connection;
switching accounts clears it and requires setup again. Use activity records when a mutable item does not identify
its latest change author. Creator and assignee fields are not substitutes. Skipped changes still
advance the baseline, so they cannot reappear as new later; their count appears in the check log.
Missing author data fails quietly without advancing the baseline. A check without verified actor
configuration cannot be activated with exclusion enabled. It can be saved paused.

For an explicitly requested test, turn off **Skip my account’s changes**, establish the new quiet
baseline, then make the test change. Restore exclusion afterward. A filter edit resets the baseline
and cancels pending events from the previous filter. App rate limits still apply to 30-second reads.

## Templates

Marketplace has an **Event checks** tab. A template is a program that was reviewed in this
repository (`marketplace/watcher-catalog/`) and ships with the host in `resources/watcher-catalog/`.
It holds the program, the settings the program reads, the names of its private variables, the result
paths and a default instruction and interval. It holds no secret and no account data.

**Install** a template for one or more agents. Enter an account label, the settings, the schedule and
the connected account's verified user IDs. The host copies the program to
`OpenBot/Shared/Watchers/<name>@<version>.<ext>` and creates a **paused** check for each agent. Then
add the private variables in masked fields and test the check. Nothing is enabled for you. A client
names a template by slug and never sends program text. The host refuses a program in the shared folder
that does not match the reviewed digest, and it never overwrites one.

Install the same template again for another account or agent. Each install is its own check, with its
own account label, settings, private variables, schedule, baseline and ten-entry history.

A check from a template keeps a link (`source.template`: slug and version) in its saved definition.
The link is not part of what the check reads, so adding or removing it keeps the baseline.

- **Update** moves a check to the template's current version. The new program gets a new file. Your
  settings, schedule, instruction and name stay; new settings take their defaults; removed settings
  go. The check gets a fresh baseline, the same as for any program change. The old file stays.
- **Link** connects a check that you made before the catalog existed to its template. It works only
  when the check's program is byte for byte a program that the host ships for the template: the
  current one, or an earlier version that the template keeps. The link names that version, so
  **Update** can then move the check to the current version. The baseline stays.

Hosts that support this advertise `event-check-templates-v1`. Older clients do not show the tab and
ignore the link. Installing needs an owner or admin, as for every event check route.

### Templates that ship

| Template | Reads | Credential (private variable) |
| --- | --- | --- |
| `linear-assigned-intake` | Issues assigned to you (and optionally delegated to an agent user) and projects you lead, in one Linear team. Optional filters by state and label, and comments | `LINEAR_API_TOKEN` |
| `github-activity` | GitHub notifications, and pull requests, issues, commits, failed runs, releases and alerts of chosen repos | `GITHUB_TOKEN` |
| `git-remote-refs` | New and moved branches and tags on any git server over HTTPS | `GIT_ACCESS_TOKEN` |
| `slack-activity` | Mentions, keywords, direct messages and chosen channels | `SLACK_USER_TOKEN` |
| `discord-activity` | Messages in chosen channels, with an optional mentions-only filter, through a bot | `DISCORD_BOT_TOKEN` |
| `gmail-inbox` | New mail in a Gmail mailbox, through IMAP and an app password | `GMAIL_APP_PASSWORD` |
| `protonmail-inbox` | New mail through Proton Mail Bridge on the same machine | `PROTONMAIL_BRIDGE_PASSWORD` |
| `render-services` | Service and deploy status, and databases, on Render | `RENDER_API_KEY` |
| `posthog-health` | Big shifts in event volume, pageviews, users and exceptions | `POSTHOG_PERSONAL_API_KEY` |

The Linear template, version 1.1.0, reads issue state, labels and comments only when a setting asks for
it. With no optional setting it watches what version 1.0.0 watched: the title and description. Version
1.1.0 has no account constants, and it reports errors with the codes above. A check that runs the
1.0.0 program of this template can still be linked to it, and then updated.

Every template uses read-only requests. Each one was tested against recorded or simulated
responses only, so test a new install with **Check now** before you enable it.

### Add a template

See `marketplace/watcher-catalog/README.md`. Run `bun run marketplace:build:watchers`. The build
installs each template into a scratch folder and decodes the saved check, so a template that the host
would refuse fails the build. `-- --check` fails when the generated files are stale.
