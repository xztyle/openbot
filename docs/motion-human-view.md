# Human view of Motion content

The owner reads Motion in **Vista para personas**: a full rewrite of the agent text in plain words, with
every section, table, number, decision, risk and next step. It is not a summary. The agent text stays
as it is in **Vista para agentes**. Agents read and write only the agent text, through the API and
MCP. Motion stores one human version per object (a page, a ticket or row with its fields, a comment,
a list's description), with the revision of the agent text it was written from, and shows the switch.

Atelier writes the versions (`src/main/motion-events/motion-human-views.ts`):

- **Which objects.** Pages and tickets that an agent linked to the owner (an owner-started answer,
  `message_owner`, a held request, an alert, a preview, an approval or a Needs you item), objects in
  Reportes, Decisiones, Manual del CSO, Inicio, Equipo and dossiers, objects an agent or the owner asked
  for (`human_view` in Motion, `mode: "generate"`), and objects that have a generated version already.
  A comment goes with its page and needs a version only when it is long or reads technical.
- **Freshness.** Every three minutes Atelier reads `human.queue` from its cursor. A small edit only
  stamps the version with the new revision; a material change (a key fact, more than 3 % of the
  length, or the words) writes it again. A version an agent wrote (`mode: "set"`) stays until someone
  asks again. At most eight objects a pass, one at a time.
- **Generation.** The cheap owner-summary model path (`generateReviewText`), with a strict prompt:
  every section, the same structure, digits for every number, money spelled out, no ids, codes, keys
  or jargon, and no summary of its own. `missingFacts` then checks the numbers, amounts, percentages,
  dates and decisions of the original. One more try names what is missing; a version that still misses
  something is saved, and the log names the facts.
- **Calls.** Atelier calls `human.queue`, `human.source`, `human.get` and `human.save` on Motion's HTTP
  API with the `motion` row's gateway token and no agent headers, so it acts as the owner. Motion
  refuses these operations to agents.
- **Chat previews.** `share_preview` with a Motion page link draws the page's human version (written
  then, when it has none) in place of the page, which the preview window cannot reach.
- **Backfill.** `POST /v1/motion/human-backfill` on the control socket (operator only) with
  `workspaceName` and `days` (default 7) writes the versions of Reportes of those days, Decisiones, the
  Manual, Inicio, Equipo, and the dossiers linked to the owner in those days, in the background. `GET`
  on the same route answers the progress and the report file under the user data folder.
