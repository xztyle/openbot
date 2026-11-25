### Changed

- The subscription failover now moves an agent only when its Claude subscription is used up: a turn
  fails with Claude's usage limit, or the meter shows a window at 100%. The turn that failed runs
  again on Codex, and the agent goes back to Claude when Claude's window resets.
- Opus agents also fail over. Every tier moves to Codex's default model, or to the newest listed
  Codex model when the default is not listed.
- The order is the Claude subscription, then the Codex subscription, then the Codex credits. A Codex
  plan that is used up still counts as usable while the account has credits, because Codex spends
  them by itself. When nothing is left, the agent waits for a reset and the owner gets one notice.
- A Codex agent stays on Codex: its order is the Codex plan, then the Codex credits.
- The Trust page shows the order, the step each agent is on, the Codex credit balance, and unused
  Codex usage resets. Atelier never spends a usage reset by itself.
