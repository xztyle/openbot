### Changed

- An agent browser tab that sleeps now stops its page process. Before, it kept a blank page process. Its next use loads the page again with its history, scroll position and form values. After a restart, a tab starts its page process only on its first use, not at startup.
- Each agent keeps at most 4 browser tabs with a page process, and all agents together at most 24. Above these limits, the tabs that nobody used for 2 minutes sleep, the oldest first.
