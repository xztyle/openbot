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
- Change a program only with a new `version`. An installed check keeps its old file until the
  user chooses Update, which gives it a fresh baseline.

`watcher.json` fields: `slug`, `name`, `tagline`, `description`, `version`, `creatorName`,
`iconUrl`, `websiteUrl`, `app` (the Apps listing it reads from, or `null`), `program` (file name in
the template directory), `accountLabelHint`, `variables` (`name`, `label`, `hint`, `docsUrl`),
`configuration` (`name`, `label`, `description`, `value`, `required`), `arguments` (the object the
program receives besides the configuration), `cursorArgument`, `nextCursorPointer`, `selection`
(`itemsPointer`, `idPointer`, `revisionPointer`), `actorPointer`, `intervalSeconds`, `instruction`.

## Byte-exact programs

A program is pinned by its SHA-256 digest, and a check can be linked to a template only when its
program matches that digest. Biome therefore skips `resources/watcher-catalog/` (generated) and
`watchers/linear-assigned-intake/program.mjs`, which is the exact file that was already running on a
host when the catalog began. Other programs follow the repository's Biome format. Do not reformat
the Linear program; a change to it needs a new `version`.
