### Added

- Today: the owner's home on a phone and a computer. It lists everything that waits on you from
  every space (agent questions and approvals, browser steps, loop decisions, insight alerts), with
  Approve, Decline and Answer on the card, then the agents that work now with Stop, then the
  briefing as cards: spend, goals with what they still need, and what the agents made. A new
  workspace gets a short guide to goals, #general, the morning briefing, loops and costs.
- Money: one page for what the agents cost today, this week and this month, revenue and ad spend,
  the spending that waits for your OK, each agent's cost, the plan's limits and the spend alert.
  With guardrails on the server it also shows what is paused (with Resume), each subscription's use
  and when it runs out, today's top spenders and the agents moved to another model.
- Today also lists what the agents learned and wait to apply (memories, playbook changes, review
  instructions) with Apply and Dismiss, an agent or a space that a guardrail paused with Resume, and
  a blocked prompt injection. A money approval shows its effect line: the target, the amount and the
  budget after.
- Ctrl+K (⌘K) runs actions: "ask Research compare the prices" sends the line to Research,
  "approve" lists what waits with Approve and Decline, "stop" stops an agent at work, "goal" opens a
  new goal. A sentence that names no one goes to the lead agent as a task. The phone's Jump to has
  the same actions.
- The phone has new tabs: Today, Chat, Agents and Inbox, with a "+" in the middle to ask an agent
  or start a message, a channel, a loop or a goal. Only Today has a count, in amber.

### Changed

- A run of short progress messages of one agent ("Checked the plan table of rival 1 … 30") folds
  into one row with "28 more updates", in channels and threads. Activity shows one agent's replies
  in a thread as one row ("Research: 31 replies"), and its badge counts that row once.
- "Needs you" counts every space, not only the one that shows, and the top bar, the sidebar's Today
  row and the phone's Today tab show the same number. Before, a loop decision or a request in
  another space did not reach you.
- A loop decision opens Loops on that loop, in its own space, with the card in view.
- The owner and the admins can change loops and decide gates; "New loop" says when no template
  loaded and offers to describe the loop to the lead agent.
- A computer has one search field, the top bar's, and Ctrl+K: the sidebar's "Jump to" button and
  "Filter conversations" field are gone there.
- The briefing form starts from your time zone (a list, not a text box) and, for a briefing that
  never went out, from English unless the app is in Spanish. The spend alert reads "Tell me when an
  agent spends money and nothing sells: more than (US$) … for this many days".
- "Behind" on a goal says what it still needs ("needs 21 more, 12 d left"), and a goal with fewer
  than three points has no sparkline.
- The fleet's cost line opens Money. A switch that is on is the accent colour; off has a muted
  thumb.
- The welcome of a new workspace points to Today's guide to goals, loops, the briefing and costs.

### Fixed

- Unread counts, times and the AI badge are readable in the light themes (4.5:1 contrast or more),
  and the keyboard focus ring is a clear 2 px ring.
- On a phone, Stop, "Why is this slow?", "Jump to latest", reactions, thread links and the Activity
  filters are 44 px targets. The jump pills no longer cover the middle of the text.
- The fleet says "2 messages waiting" for an agent with queued messages, not "Working on 2 messages
  wait".
- Insights › Costs no longer shows the same "Last 7 days" figure twice.
