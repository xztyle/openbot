---
name: openbot-event-checks
description: Create and manage silent deterministic app event checks, also called watchers. Use when the user asks to detect new tickets, messages, mentions, pull requests, or app changes without idle AI turns.
---

# App event checks

An event check is a normal host program. It calls a reading MCP tool and compares saved IDs and
revisions. AI sets it up and handles matching events. AI does not perform the repeated checks.

## Defaults

- Check every 30 seconds unless the user gives another interval or calendar schedule.
- Use one account already enabled in the target chat. Never add app permissions.
- Read tools only. Keep the user's response instruction and notification intent.
- Skip changes made by the connected account, including changes made through its MCP tools.
- First success saves a quiet baseline. Empty, unchanged, self-only, and failed checks stay out
  of chat and notifications. Last ten executions remain in the check's own history.

## Setup procedure

1. For another agent, obtain its stable ID with `openbot.list_agents`. List its existing checks
   with `openbot.list_event_checks`. Update a matching check instead of adding a duplicate.
2. Call `openbot.list_event_check_apps` and select the intended account. If several accounts
   could match the request, ask which one. Do not read all accounts to guess.
3. Call `openbot.list_event_check_tools`. Inspect a permitted reading tool's input schema and
   actual result through that same connected account. Never guess result paths or credentials.
4. Obtain the connected account's current user ID with its reading MCP tools. Identify the field
   that contains the **person who made each change**. An item's creator, assignee, and owner do
   not identify who updated it. Prefer an activity/event query with actor IDs and stable event IDs.
5. Configure the full query, pagination, list path, stable ID path, and revision path. For a list
   of immutable activity events, stable event IDs are enough. For mutable items, use their revision.
   Timestamp argument values `$lastSuccessAt` and `$now` must be complete JSON string values.
6. Save with `openbot.save_event_check`. Set `selfEvents.mode` to `exclude`, `selfEvents.connectionId` to the selected account ID, and `actorPointer` to the
   verified change-author ID path, and `accountActorIds` to the selected account's verified IDs.
   Omit schedule for the enforced 30-second default, or pass an interval using `unit: seconds`.
   Use the user's instruction for useful work after an event; do not add empty status messages.
7. Run `openbot.run_event_check` to establish the baseline, then read `openbot.event_check_history`.
   Report the selected account, timing, filtering, and any limit in ordinary words.

If the app cannot expose the change author, keep the check paused and explain that self-event
filtering cannot be verified. Do not substitute the creator/assignee, invent an identity, or silently
set `mode: include`. Missing or invalid author data fails quietly without advancing the baseline.

## Testing and changes

Self-events may be included **only when the user explicitly requests it**, such as testing.
Temporarily save `selfEvents.mode: include`, establish the new baseline, then make the authorized
test change and run the check. Inspect its history and restore `exclude` afterward. A manual read
can wake the agent for a real matching event. It does not grant permission to write to the app.

Changing the account, query, selection, or self-event policy resets the baseline and cancels old
pending batches. Changing timing or instructions preserves it. Pause or remove through native
tools. If the user authorizes replacing an AI polling routine, pause that routine after the check
is verified. Do not create both for the same purpose. Do not run a model from a polling script.
