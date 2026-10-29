### Added

- A Storage view in the workspace, for owners and admins: the disk use of the server, what each
  shared project and agent workspace holds (work, regenerable build output and caches, stale
  copies, evidence media), the largest folders, and a cleanup plan with a checkbox for each rule
  and project. A cleanup checks each item again first and keeps anything in use or changed in the
  last minutes. An audit file records every deletion.
- Cleanup rules in Server settings > Storage: remove regenerable caches when the disk is fuller
  than a limit, convert old screenshots to WebP, and delete old evidence media. All are off by
  default.
- Agents get guidance to keep the shared disk small: one shared Rust target folder, no copies of
  repositories or builds in notes, WebP screenshots, and removal of merged worktrees. Agent
  sessions start again once to read it.
