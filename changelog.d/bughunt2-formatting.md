### Fixed

- An approval that is not spend no longer shows a dollar amount on Today and in Money. Before, a
  command with "$1" or a peso amount such as "$50.000" read as dollars.
- A goal that is behind counts the days to its deadline from your own day. Before, in the evening in
  the Americas a goal due tomorrow said 0 days were left.
- Money shows the revenue and the ad spend in each currency, such as pesos, next to the dollar
  totals. Before, an entry in another currency was left out with only a note. Insights writes an
  amount with its currency's sign in your format, such as "$ 50.000" for pesos in Colombia.
- "Focus until tomorrow" ends when quiet hours end in their own time zone. Before, it used the
  browser's zone, five hours off in Colombia for a server in UTC. The quiet hours settings start on
  your own time zone when none is set, and the focus time shows in your language's format.
- The Guardrails tab of Trust renders when the host sends a time that does not parse. Its times read
  "Mon 3:05 PM" as in Money. An amount in the audit trail shows its currency's sign, and the audit
  export is named after your own day, not the UTC day.
- The Money alert rule says "for 1 day" in the singular when it is set to one day.
