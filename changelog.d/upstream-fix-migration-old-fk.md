### Fixed

- Atelier starts after an upgrade when its database has broken links between rows from an earlier
  version. Before, the upgrade stopped at each start with "OpenBot database migration to version 47
  failed", and the app did not open. Atelier keeps these rows as they are, and an upgrade step stops
  only when it breaks a link itself.
