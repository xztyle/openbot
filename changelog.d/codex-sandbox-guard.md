### Fixed

- A Codex agent in the Atelier jail no longer starts with Codex's own sandbox as its default. Codex
  checked at each start that its sandbox could make a user namespace, which the jail does not allow,
  and the owner saw "Codex's Linux sandbox uses bubblewrap…" as a red toast. The jailed app-server
  now starts with `sandbox_mode="danger-full-access"`, so its helpers (`spawn_agent`), reviews and
  compactions run with the jail as their only sandbox too.
- If Codex still reports that its sandbox cannot start, Atelier logs it, and a turn that it failed
  runs once more in a new session. The owner reads one plain sentence, never Codex's English.
- A server error toast with a provider's own words now shows a plain sentence, and the provider's text
  stays behind a closed "Show technical details".
