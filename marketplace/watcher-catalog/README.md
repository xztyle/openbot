# Event check catalog source

One reviewed template per directory: `watchers/<slug>/watcher.json` and the program it names.
`catalog.json` sets the order. `scripts/build-watcher-catalog.ts` validates the source and writes
`resources/watcher-catalog/` (`catalog.json` and `programs/`), which ships with the host. Never edit
the generated files by hand.

```sh
bun run marketplace:build:watchers
bun run marketplace:build:watchers -- --check
```

A client names a template by slug. The host copies the bundled program into
`OpenBot/Shared/Watchers/<name>@<version>.<ext>` and creates a paused check. Nobody sends program
text over the wire, so a template is code that was reviewed in this repository.

Rules for a new template:

- The program follows the contract in `resources/managed-skills/openbot-event-checks/SKILL.md`:
  one JSON object on stdin, one JSON value on stdout, read-only requests, bounded pagination.
- No secret value anywhere in this directory. A credential is a private variable: the template
  names it, and the user types the value into a masked field after the install.
- Account-specific values (workspace, team, user IDs) are `configuration` fields, never constants
  in the program. One program serves every account.
- Do not name a configuration field like a secret (`token`, `password`, `secret`, `api_key`).
- On failure, exit with a code other than zero and print the reason as a fixed message of your own on
  standard error. If you know why, print one more line, `openbot-error: <code>`, with one code from
  `auth` (the app refused the credentials), `rate_limited`, `config` (the settings are wrong) or
  `upstream` (the app is down, slow or sent an error). OpenBot reads only that line, shows its own
  text for it, and backs off. Never print text from the app, a token or a header.
- Change a program only with a new `version`. An installed check keeps its old file until the
  user chooses Update, which gives it a fresh baseline.
- Keep the program of every version that a user can still run, so that a check that runs it can be
  linked and then updated. The newest program is `program`. List the earlier ones in
  `earlierPrograms` as `{ "version": "1.0.0", "program": "program.mjs" }`. The build ships each earlier
  program byte for byte as `programs/<slug>-<version>.<ext>` and lists its digest in the generated
  catalog. The build fails when an earlier program equals the current one.

`watcher.json` fields: `slug`, `name`, `tagline`, `description`, `version`, `creatorName`,
`iconUrl`, `websiteUrl`, `app` (the Apps listing it reads from, or `null`), `program` (file name in
the template directory), `earlierPrograms` (optional), `accountLabelHint`, `variables` (`name`, `label`, `hint`, `docsUrl`),
`configuration` (`name`, `label`, `description`, `value`, `required`), `arguments` (the object the
program receives besides the configuration), `cursorArgument`, `nextCursorPointer`, `selection`
(`itemsPointer`, `idPointer`, `revisionPointer`), `actorPointer`, `intervalSeconds`, `instruction`.

## Byte-exact programs

A program is pinned by its SHA-256 digest, and a check can be linked to a template only when its
program matches that digest. Biome therefore skips `resources/watcher-catalog/` (generated) and
`watchers/linear-assigned-intake/program.mjs`, which is the exact file (version 1.0.0) that was
already running on a host when the catalog began. The Linear template ships it as an earlier program
and `program-1.1.0.mjs` as the current one. Other programs follow the repository's Biome format.
Never edit or reformat `program.mjs` of the Linear template.
