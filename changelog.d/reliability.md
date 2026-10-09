### Added

- `openbot backup <file>` on a self-hosted server or Docker container writes a verified copy of the database while OpenBot runs. It never replaces a file and it never runs by itself. `docs/docker.md` has the backup, upgrade rehearsal and restore steps.
- `openbot health` and a Docker health check. `openbot status` now also shows agent start state, database version, whether a restart is safe, provider state and retries, memory level, uptime, the last shutdown (clean or not), and the longest running and silent turns. `openbot status --raw` prints the `key=value` lines.
- `openbot diagnostics` prints the sanitized diagnostics report.
- A warning in the log when an agent turn gets no output from its provider for 30 minutes (`OPENBOT_SILENT_TURN_MINUTES`). OpenBot does not stop the turn.
- `OPENBOT_ANALYTICS=off` and `openbot analytics off` turn product analytics off on a server with no window.
- The Docker Compose file limits the size of the Docker log.

### Changed

- A self-hosted server and a Docker container now hold new turns when memory is low, limit the number of parallel turns by memory size, and prefer to stop agent tools before OpenBot when memory runs out. Before, only hosted servers did this.
- A provider that stops again and again is now started again in the background, every 30 seconds up to every 10 minutes. Before, it stayed down until you restarted OpenBot.
- A server that fails to start now logs the reason and exits with an error code, instead of waiting for a dialog that nobody can see.

### Fixed

- A VACUUM after a database migration is skipped, with a warning, when the disk has too little free space. Before, it could fill the disk.
- The memory guard keeps working in a container whose cgroup has no readable memory limit file.
