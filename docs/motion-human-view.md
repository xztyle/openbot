# Human view of Motion content

The owner reads Motion in **Vista para personas**: a rewrite of the agent text in plain words that keeps
every number, decision, risk and next step, and is short and easy to scan (rules below). The agent text stays
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
  asks again. At most sixteen objects a pass, four at a time.
- **Generation.** The cheap owner-summary model path (`generateReviewText`) reads the whole agent text in
  one call, with a strict prompt. The rules, approved by the owner on 2026-11-26:
  1. **Current state only.** Add-ons and corrections fold into the section they change; what a later
     decision replaced is left out. The model names those replaced facts on a last `SUPERSEDED:` line,
     which is not saved; the facts check does not count them as missing.
  2. **Decision box on top** (long texts, from 600 words): a callout with the verdict and what the owner
     must do, the key numbers as a small table, and a "Falta antes de …" checklist with owners.
  3. **Evidence collapsed** in `<details><summary>Ver evidencia: …</summary>` blocks, which Motion
     stores as toggle blocks (closed by default).
  4. **Tables, checklists and simple charts over prose.** A Mermaid chart may be a simple `pie` or
     `flowchart LR`; any other chart becomes a table of its values (`safeCharts`), so the page never
     shows a drawing error.
  5. **Visible-length budget** (`wordBudget`): half the original's words, at least 80 and at most 900,
     counting only the text outside collapsed blocks and charts.
  6. **Second pass.** `reviewHumanView` checks the length and the layout (budget, decision box,
     collapsed evidence, no add-on sections). A draft with a problem goes back once to be tightened,
     with the owner's self-check: "¿Estoy siendo lo más conciso posible sin caer en lenguaje no humano?
     Si ya soy conciso y la página sigue larga, ¿estoy presentando la información en tablas o imágenes
     fáciles de seguir que la hagan más fácil de entender y más corta?"

  Then `missingFacts` checks the numbers, amounts, percentages, dates and decisions of the original,
  visible or collapsed. One more round names what is missing; the better version is kept (fewer
  missing facts, then fewer visible words). A version that still misses something is saved, and the
  log names the facts. Motion's agent conventions (MCP instructions, the `human_view` tool) and
  Atelier's agent instructions carry the same rules for versions that agents write with `mode: "set"`.
- **Calls.** Atelier calls `human.queue`, `human.source`, `human.get` and `human.save` on Motion's HTTP
  API with the `motion` row's gateway token and no agent headers, so it acts as the owner. Motion
  refuses these operations to agents.
- **Chat previews.** `share_preview` with a Motion page link draws the page's human version (written
  then, when it has none) in place of the page, which the preview window cannot reach.
- **Backfill.** `POST /v1/motion/human-backfill` on the control socket (operator only) with
  `workspaceName` and `days` (default 7) writes the versions of Reportes of those days, Decisiones, the
  Manual, Inicio, Equipo, and the dossiers linked to the owner in those days, in the background. `GET`
  on the same route answers the progress and the report file under the user data folder. With
  `regenerate: true` it writes every version the host generated before again under the current rules
  (`workspaceName: "*"` takes every workspace); versions an agent wrote stay. Each outcome in the report
  has the visible words and the budget.
