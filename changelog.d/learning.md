### Added

- Agents tidy their memories at night. In the quiet hours of the server's time zone, a short Haiku
  pass reads each agent's memories and its chat since the last pass. Near-identical memories merge
  by themselves, and you can undo the merge. An outdated memory, a rewrite, or a rule after a
  mistake that the agent made twice waits for you in Reviews → Learning. Each space's customer and
  product memory is tidied too, and Atelier suggests a skill of one space that could help an agent
  of another space.
- Agents learn from finished work. When a Motion card is done or a loop item reaches an end stage,
  the agent can propose one lesson for its role playbook, one of its skills, or its instructions.
  The lesson waits in Reviews → Learning until you apply it.
- Settings history: every change of an agent's name, title, instructions, model, provider, reasoning
  effort, model policy, role, access, Computer Use, backup models, of a skill that a review revised,
  and of a playbook of its role is kept with who made it (you, an agent, or a review you accepted).
  An agent's Cost and performance settings show each change with its diff and a Roll back button.
- Each space has a shared decision log and a memory of its customers, products and suppliers. Agents
  use `space_memory` to remember and recall them, and `log_decision` now records every decision in
  the space's log, also outside a hands-off channel.
- "Forget what it learned in this chat" in an agent's settings removes the memories and space facts
  that came from its current chat, after it shows them.

### Changed

- Memory search ranks a recent memory before an old one that matches about as well.
- A context compaction of an agent's own chat starts its memory review, so the detail that the
  summary drops is kept first.
