### Added

- Motion cards are graded before they count as done. An agent hands a finished card to review with
  a hand-off note instead of moving it to Done. When the card names no reviewer, an independent
  grader checks it: a fresh model that did not do the work reads the card's acceptance criteria,
  the hand-off and what the agent's run really did (commands, files, links, failed steps), then
  passes the card to Done or reopens it with specific notes. High-priority cards and cards about
  money get a grader from the other vendor (Codex grades Claude's work and the reverse; another
  Claude model when Codex is not set up). After three reopenings the card goes to you in Needs
  you. A card with criteria that an agent moves to Done itself goes to review anyway.
- Agents hear of three more Motion events: a card to review (with its criteria and hand-off), a
  card reopened after review (with the notes, which wakes the agent), and a card whose last
  blocker is done (which wakes the agent to go on).
- An order from one agent to another can carry a Motion card: Atelier makes it, assigns it to the
  recipient with acceptance criteria and a dedupe key, and names it in the message. An order card
  with no progress for 6 hours nudges its agent, and 6 hours later tells the agent who gave the
  order. A message that reads like an order but goes as fyi, or without a card, tells the sender.
- Plan mode for big orders: an order with a budget, an estimate of 4 hours or more, or that asks
  for a plan, starts with the assignee's plan, which its manager agent approves or sends back
  before any money is spent or anything is built. You are not asked; payments still need you.
- Wide research: an agent can map one research job over up to 50 items (niches, products,
  competitors) with cheap parallel researchers on Haiku or Sonnet that search the web, within a
  cost budget. The rows land in a CSV table, with a Markdown copy, in the space's shared folder,
  and the agent hears when it is ready.

### Changed

- Agents write acceptance criteria and a dedupe key on the Motion cards they create, and request
  review instead of closing their own cards.
