---
name: openbot-event-checks
description: Create reusable, silent API watchers with editable configurations and private variables. Each check is a normal program, with no inference during polling.
---

# API watchers

Use the app's **direct API, not MCP**, for every new watcher. A watcher is a normal program.
AI writes its program once and handles matching events. The repeated checks do not use inference.
OpenBot supplies timing, private variables, baselines, event delivery and the last ten execution logs.
Existing MCP checks remain supported. Replace one only when the user asks.

## Defaults

- Check every 30 seconds unless the user specifies another interval or calendar schedule.
- Create paused. First enabled success saves a silent baseline.
- Empty, unchanged and self-only checks stay out of chat and notifications. A failing check shows
  **Failing** in the list, waits longer between runs, and tells the user once at the fifth error in a row.
- Skip events made by the connected account unless the user explicitly permits them, such as a test.
- Preserve the user's event scope, response instruction and notification preferences.

## Templates first

Reviewed templates ship with the host (Linear, GitHub, any git server, Slack, Discord, Gmail, Proton Mail,
Render, PostHog). Call `openbot.list_event_check_templates` first. When one fits the request:

1. Call `openbot.install_event_check_template` with the slug, one `accountLabel` per account, and every
   required setting from `configuration`. Ask the user for IDs and names you do not know; never guess.
   The check is saved **paused** and linked to its template. Install again for another account or agent.
2. Call `openbot.event_check_environment`. Tell the user which private variable names to add in agent
   settings → Event checks → this check → Private variables (.env). **Never ask for the value in chat,
   and never put it in any tool field or file.** Only the user fills the masked fields.
3. When the user says they added them, call `openbot.test_event_check` and read
   `openbot.event_check_history`. Fix setting mistakes with `openbot.save_event_check`.
4. Enable with `openbot.set_event_check_active` only when the user asks. The first enabled read saves a
   quiet baseline.

Use `openbot.update_event_check_template` to move a check to a newer template version (it gets a fresh
baseline) and `openbot.link_event_check_template` to link an older check whose program is the template's
program. The user can do the same in Marketplace → **Event checks**. Write a new program only when no
template fits.

## Reuse programs, keep accounts separate

Programs live in `OpenBot/Shared/Watchers`, not in one agent's workspace. Before writing a new
program, look there for a suitable one. Reuse a program for several agents or app workspaces.
Each saved check is a separate instance with its own account label, configuration, private variables,
schedule, baseline and ten execution logs. Never copy tokens between instances automatically.
A shared program edit gives each instance a fresh baseline before delivering more events.

## Program contract

Use `.mjs`/`.js`, `.py` or `.sh`. The host launches the fixed interpreter without a command shell.
The working directory is `OpenBot/Shared/Watchers`. Read one JSON object from standard input.
It contains ordinary `configuration` values merged with `argumentsJson`; paging arguments take
precedence. Read private variables from the process environment. Do not read the private host file.
No provider or Cloudflare credentials are inherited. Do not depend on extra local environment values.

Emit exactly one complete JSON value to standard output, then exit zero. Default output:
`{"items":[{"id":"stable-id","revision":"selected-content-revision","actor":"actual-author-id"}],"hasNextPage":false}`.
For another page, use `hasNextPage: true` and a nonempty `cursor`. Read the next `cursor` from stdin.
The final page may omit `cursor`. Configure selection `/items`, `/id`, `/revision`, paging argument
`cursor` and result `/cursor`. For content-only changes, compare only requested fields, not status or
last-updated timestamps. Keep enough useful event content for the agent to act.

Read-only API requests only. Request read-only credentials where the app supports them. Use official
HTTPS API addresses, bounded request timeouts, complete pagination and no credential-bearing redirects.
Reject API errors and partial results (including HTTP 200 GraphQL `errors`). Read full requested data;
never silently use truncated descriptions. Do not run models, MCP clients, provider CLIs or AI SDKs.
Do not post messages or make other app changes during a check. No persistent child/background process.
Checks have a 40-second program deadline, 20-page/2,000-item limits and bounded output. Honor rate limits.
Use the host's baseline comparison rather than saving your own cursor before a read fully succeeds.
On failure, exit non-zero and print a fixed message of your own on standard error. When you know why,
print one more line, `openbot-error: <code>`, with exactly one code: `auth` (the app refused the
credentials), `rate_limited`, `config` (the check's settings are wrong) or `upstream` (the app is down or
sent an error). The host shows its own text for the code and never repeats program output. Never print
text from the app, a token or a header.
Exact argument strings `$lastSuccessAt` and `$now` expand to host timestamps; the former has a five-minute
safety overlap. Local state, if needed, must be separate for each instance and contain no credentials.

## Creation procedure

1. Resolve the target agent ID. List `openbot.list_event_checks` and update a matching instance.
2. Select one intended account. Ask which if ambiguous. Find or write a shared API program.
   Verify the API query, full result fields, rate limits, pagination and actual user/account identity.
3. Declare ordinary UI fields in `source.configuration`. Each field has `name`, `label`,
   `description`, and string `value`. For example:
   `{"name":"assigneeId","label":"Assigned user","description":"Linear user ID whose tickets to check","value":"VERIFIED_ID"}`.
   The user can edit these values in the watcher settings. Parse numbers/booleans inside the program.
   Tokens, passwords and credentials never belong in configuration, arguments, instructions or chat.
4. Declare needed private names in `source.variables`, for example `["LINEAR_API_TOKEN"]`.
   Set `source.kind: api`, `toolName` to the relative shared program path, `connectionId` to a stable
   label for this one account, and `argumentsJson` to ordinary JSON arguments (often `{}`).
   Save using `openbot.save_event_check` with `active: false`. Omit schedule for 30 seconds.
5. Call `openbot.event_check_environment`. It returns names and Set/Missing status only.
   For each missing name ask: **“Please add LINEAR_API_TOKEN in this watcher's Private variables
   (.env) settings so we can test it.”** Substitute the declared name. Direct the user to agent
   settings → Event checks → this instance → Private variables (.env).
   Never ask for the value in chat, read a saved secret, extract it from an MCP connection, or
   put it in an agent/shared file. Only the user fills masked settings fields.
6. When configured, use `openbot.test_event_check`. It performs one program read and records only
   its own execution log. It does not enable the instance or wake an agent. An edited program resets the old baseline before testing.
   Read `openbot.event_check_history`. Fix errors before enabling.
7. Verify self-event filtering. Use the connected account's verified IDs and **actual change-author**
   path. Creator, assignee and owner do not identify who updated an item. If the API cannot expose
   the author for the requested changes, keep paused and explain the limit. Never silently choose
   `include`. Include self-events only when the user explicitly permits this scope or a test.
8. Enable after credentials, successful test and self-event policy are ready. First enabled read
   establishes the baseline silently. Only matching changes start AI work.

A matching change reaches you as a message. When nothing in it needs the user, answer exactly
`[[no-update]]` and nothing else: the turn then leaves no message or notification. Answer anything else
when there is a result to report.

Replacing/removing a private value pauses the instance, resets baseline and cancels pending events.
Test and enable again. Account/query/configuration/selection/self-event changes reset baseline.
Timing or response-instruction edits preserve it. If replacing an AI polling routine is authorized,
keep it paused after the watcher is verified. Never create both for the same purpose.
