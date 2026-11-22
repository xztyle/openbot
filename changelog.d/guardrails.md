### Added

- Budgets with hard stops. Each agent and each space has a limit on turns, tokens and estimated cost
  per day, and an agent on the share of its subscription window it may use. At 80% the owner gets a
  notice in Needs you; at 100% the agent or space pauses until the next day or the window reset, or
  until the owner resumes it. The owner's own messages still run while paused. The defaults sit above
  the busiest real day of the last two weeks.
- Circuit breakers: a turn stops after 500 tool steps, 400M estimated tokens or 4 hours, and a routine
  run after 400 steps, 300M tokens or 150 minutes.
- A stuck watch. An agent that runs the same tool call with the same result 5 times gets a nudge in
  its turn; at 10 the turn stops and the owner gets a notice. Two agents that send each other 16
  messages in 30 minutes with no other work get a nudge; at 32 both pause for an hour.
- Prompt-injection defence. A result from the web, a browser page, an email or a webhook is marked as
  untrusted data in the agent's context. After a turn read such content, a cheap monitor model checks
  each payment, ad budget, outbound message, deploy, secret change or agent change against the task
  before it runs, and blocks it and alerts the owner when it follows the outside content.
- Money approval cards show the effect, such as "Meta ads · daily budget 10 USD → 50 USD · ad set
  1203", and for a payment what to pay by hand and where. The approval covers only that exact call,
  and an unanswered money approval expires after 24 hours.
- A subscription meter with the 5-hour and weekly windows of each Claude and Codex account and a
  forecast of when each runs out. When every account of a pool is at 95%, Sonnet-class agents without
  backup models of their own move to Codex until the pool has room again.
- Trust > Guardrails shows today's use against the limits, the pauses with Resume, the meter, the
  agents that failed over and the guardrail events, and sets the limits.
