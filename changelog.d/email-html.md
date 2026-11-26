### Added

- Agents can send formatted mail. `email_send` and `email_reply` take Markdown, and the mail looks
  like a Motion page in its dark theme: headings, tables, lists, checklists, callouts, and a button for a link alone on
  its line. Each mail also has a plain-text copy. Reports to people put the Motion link at the top and
  the decision first.

### Changed

- The mail Worker's `wrangler.toml` no longer holds placeholder vars, so `bun run deploy` keeps the
  live inbox address and sender domains.
