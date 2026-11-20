### Added

- Long agent replies to people read like a chat message. When an agent's answer in its chat or in a
  channel is longer than 90 words, or is shaped like a report (bold labels, headings, status
  sections, a long list, hashes and code), the workspace check model rewrites it after the turn
  ends: the answer first, then only what you must do or decide, with every Motion link, file and
  mention kept. The reply shows "Condensed · Show original"; the agent's full text is kept on the
  message, and the agent itself still has it. Talk between agents, code, texts you asked for, and
  replies to "give me the detail" stay as they are. A rewrite that fails or takes too long leaves
  the original.
- Server settings > Workspace > Agent replies turns this off and sets the length it starts at (60
  to 200 words). Each rewrite counts toward the agent's usage.
