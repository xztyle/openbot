# Plugin catalog source

One developer bundle per directory: `plugins/<slug>/plugin.json`.
`catalog.json` sets the order and the featured flags.
`scripts/build-plugin-catalog.ts` validates the source and writes three
generated outputs; never edit those by hand:

- `src/renderer/src/features/settings/marketplace-plugin-catalog.ts` (Apps tab)
- `apps/auth-api/src/lib/plugin-catalog.generated.ts` (Worker JSON routes)
- `resources/plugin-catalog/` (offline snapshot shipped with the app)

```sh
bun run marketplace:build:plugins
bun run marketplace:build:plugins -- --check
```

Rules for a new entry:

- One app per plugin. Skills stay `[]` until pinned skill versions exist.
- No secret values anywhere in this directory. Auth declares where a
  credential goes (`header` for http, `env` for stdio); the user types the
  value in the connect dialog.
- `http` servers take a `url`. `stdio` servers take a `command` and `args`.
  No `workingDirectory`: the provider drops such servers.
- A `command` can start with `~/` to name a program that a desktop app installs
  in the home folder, as the Paper listing does. OpenBot expands `~` on the
  computer that runs the server, before any provider starts it.
- Names must pass `mcpConfigErrors` and must not be reserved (`openbot`).
- OAuth-only vendors install as a plain `http` server with a `link` flow, the
  same shape the Canva listing uses. OpenBot signs in itself: the main process
  holds the MCP OAuth client, keeps the tokens in encrypted storage, and adds
  the `Authorization` header at hand-off. No bridge program is installed, and
  no listing may name one.

## Change the server of a listing

An installed row is the app's row while its command and words (or its address) are the listing's.
When a listing moves to a newer server, for example `slack-mcp-server@1.3.0` to a later version,
list the earlier signature in `supersedes` on the app's `server`, so those rows are not lost:

```json
"supersedes": [{ "command": "npx", "args": ["-y", "slack-mcp-server@1.3.0", "--transport", "stdio"] }]
```

An `http` server lists `{ "url": "https://..." }`. An entry must be a complete, valid signature, must
not equal the current one, and may have no other field. The app page then offers **Update** for such a
row, which tests the new version and rewrites the words in place. OpenBot also rewrites the row at
startup (`migrateCatalogSuccessors`). Only a row with the exact earlier words moves. Its id, name,
credentials, enabled state and chat access stay. A row with any other word is the user's own edit.

Slack read-only mode allows a reviewed list of tool names (`SLACK_READ_TOOLS` in
`src/backend/mcp-chat-policy.ts`) for one server. The build stops when the Slack listing names a
different server than `SLACK_MCP_ARGS`. Review the tool names of the new version, then change both.

## Paper

Paper Desktop installs its CLI at `~/.paper/bin/paper`. `paper mcp` is a stdio
relay to the file that is open in Paper Desktop. Paper also has an http address,
`http://127.0.0.1:29979/mcp`, but its documentation calls that address legacy,
and a listing must use https. The listing needs no key.

Troubleshooting:

- "Command not found: ~/.paper/bin/paper": install Paper Desktop from
  <https://paper.design/downloads> and open it once.
- The tools see no file, or the wrong file: open the file in Paper Desktop.
  The server works on the file that is open.
- A long session calls tools that do not exist: start a new thread. Paper
  gives this advice in <https://paper.design/docs/mcp>.
