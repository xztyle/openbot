### Added

- Let an agent stay quiet when an event check finds nothing that needs you. Every event check message
  now asks the agent to answer exactly `[[no-update]]` in that case. The turn then leaves no message,
  no unread count and no notification. Any other answer stays visible.
- Let a routine that a webhook or a local script starts stay quiet in the same way. Write
  `[[no-update]]` in the routine task as the answer for "nothing needs me". Only the routine task
  counts, and the event data cannot turn it on.
- Back off failing event checks. A check that fails waits twice as long for each error in a row, up
  to 15 minutes, and goes back to its normal timing after a success.
- Show why a check failed. A program can name the reason with one fixed code (`auth`, `rate_limited`,
  `config` or `upstream`). **Last 10 checks** then shows a clear message. OpenBot never shows the
  program's own text. The list of checks marks a failing check with **Failing**.
- Tell you once, when an event check fails five times in a row, when an event was found but could not
  reach the agent, when an event check turn stops with an error, and when a scheduled routine run
  fails. Desktop and browser notifications show these at the levels **All activity** and
  **Only when it needs me**.
- Combine the events of an event check into one message. Choose a time of 1, 5, 15 or 60 minutes in
  **Delivery**. An item that changed twice appears once.
- Keep items out of an event check delivery with item filters, for example `/state=open`. A skipped
  item still counts as seen, so it does not come back as new later.
- Limit the work that events start. An event check sends at most 12 messages an hour to its agent, and
  a routine starts at most 20 runs an hour from webhooks and local scripts. Later events wait and go
  out as one message or run. Nothing is dropped.
- Update the Linear event check template to version 1.1.0. It can watch only some workflow states or
  labels, issues that are delegated to an agent user, and comments. It has no account name built in
  and reports errors with the new codes. A check that runs version 1.0.0 can still be linked to the
  template and then updated.
- Add a guide for a forwarder that checks GitHub and Linear webhook signatures and starts a routine on
  the same computer, with no polling.

### Changed

- Update the other eight event check templates to version 1.0.1. They report the reason for a failure
  with the new error codes. Use **Update** to move a check to the new version.
