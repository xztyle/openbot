### Fixed

- Workspace: the fold of an agent's progress lines never hides a question, a chat card, a link, a
  mention, a pinned or condensed answer or a line that still streams, and an opened fold shows each
  line as plain text, without Markdown marks.
- Workspace: a link to an agent's progress line (from search, Activity or a copied link) scrolls to
  it and lights it, in a channel and in a thread, instead of finding nothing in a folded run.
- Workspace: "N new messages" while you read above, the "new messages since" banner and a thread's
  reply count count each folded progress line, so a run of new updates no longer shows as "Jump to
  latest" with no count.
