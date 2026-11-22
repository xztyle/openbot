### Fixed

- Today: an insight alert, a learning proposal, a guardrail pause and the briefing cards show as soon
  as the host connects. Before, an alert waited up to ten minutes and the others up to two. Today
  also reads them again when the connection comes back and when you return to the app.
- Today and the phone's Today tab keep what waits while the connection comes back. Before, they said
  "Nothing waits on you" while a phone woke up or the host restarted.
- A money approval shows its amount ("$19.00") and sorts by it. Before, the amount of the host's
  effect line ("pay 19 USD", "10 USD → 50 USD") was not read.
- A blocked prompt injection that you dismiss leaves every count (Today, the top bar, the sidebar,
  the phone's tab) and stays dismissed when Today opens again.
- The top bar shows "Needs you" for a loop decision, an alert or a request of another space too.
- Money and Today no longer stop rendering when the host sends a time that does not parse.
- A loop decision stays in the queue when one read of its space fails.
