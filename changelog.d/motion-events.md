### Added

- Motion tickets come to agents as events instead of the agents polling the board. When a ticket is
  assigned to an agent, a comment mentions it, it is due soon (24 h and 2 h before, by default) or
  overdue, Motion sends a signed event and the agent wakes with the ticket key, title, link, status
  and due date. An overdue ticket also tells the agent's manager from the org chart. A change by you
  that needs no action, such as a status move, waits for the agent's next turn. A second event about
  the same ticket within 15 minutes waits too, and quiet hours hold events until they end.
- When an agent hands a ticket to you, or marks it blocked, it shows in Needs you with a push, and
  opens the ticket. It goes when you act on the ticket.
- The ticket an agent works on shows on its fleet card, its org chart card and in its DM header.
  When an agent starts on a ticket, the ticket moves to In progress and Motion shows "Agent is
  working on this" with a link to the chat.
- Server settings > Workspace > Integrations · Motion events turns events off and sets the warning
  windows, who hears of an overdue ticket, the Needs you item, quiet hours and the burst window.
