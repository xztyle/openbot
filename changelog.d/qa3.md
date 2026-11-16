### Fixed

- When the server reaches its limit of processes and threads, such as the `pids_limit` of a Docker container, a Claude turn that fails because of it says so and tells you to raise the limit. Before, it said only "Claude Code process terminated by signal SIGABRT". The resource log now records the number of processes and threads, the limit, and how many were refused.
