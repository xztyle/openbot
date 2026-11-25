### Changed

- The subscription failover now moves an agent only when its Claude subscription is used up: a turn
  fails with Claude's usage limit, or the meter shows a window at 100%. The turn that failed runs
  again on Codex, and the agent goes back to Claude when Claude's window resets.
- Opus agents also fail over, to the strongest Codex model that Codex lists. Sonnet agents still
  take Codex's default model.
- The order is the Claude subscription, then the Codex subscription, then the Codex credits. A Codex
  plan that is used up still counts as usable while the account has credits, because Codex spends
  them by itself. When nothing is left, the agent waits for a reset and the owner gets one notice.
- The Trust page shows the order and the step each agent is on.
