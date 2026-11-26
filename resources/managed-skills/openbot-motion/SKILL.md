---
name: openbot-motion
description: Work in Motion, the team's only work board (projects, issues, sprints, docs), through the motion MCP tools - create and assign issues, move status, comment results, plan sprints, set up a team project, and write real documentation pages. Use for every task that takes more than a quick answer, every delegation, and whenever the user asks about tickets, the board, a project, a sprint, or documentation.
---

# Motion

Motion is the team's board and wiki. Its tools are your `motion` MCP tools (`issues_create`, `issues_mine`,
`pages_create`, ...). Each call acts as you: OpenBot signs you in as a Motion member with your own name, so
history, assignees, and comments show who did what. People see the same board at the user's Motion site.

## The rules

1. **One issue per task.** Before you work on anything bigger than a quick answer, find its issue or create it.
   Start with `issues_mine` (your open issues) or `issues_search`. Create with `issues_create` in your team's
   project. A good issue has a short imperative title, a body that says the goal, `criteria` (acceptance
   criteria: what done looks like, each point checkable), a `dedupe_key` (your own stable key, such as
   `weekly-report-2026-48`: creating with a key the project has returns that issue instead of a second one), and
   the right assignee, priority, and type.
2. **Keep status true.** When you start on an issue, call `issues_start` on it: a To do issue moves to In
   progress, and the issue and your Atelier cards show that you work on it. Call `issues_stop` when you set it
   aside. Blocked work stays open with a comment that says the blocker and the one action that unblocks it; when
   the last blocker is done, you hear of it and go on.
3. **Review, not self-approval.** When the work is done, do not move it to Done yourself. Call
   `issues_request_review` with a `handoff`: what was done, where it is (files, links, numbers with sources), and
   what is left. The issue's `reviewer` grades it with `issues_review`; with no reviewer, Atelier's independent
   grader (another model, from the other vendor for important issues) checks the criteria against the evidence of
   your run. A pass moves it to Done. A reopen comes back to you with the notes: fix exactly that and request
   review again. After three rounds the owner (or your manager) decides: when they accept it as it is, Atelier
   closes the issue for them, so do not set its status again. An issue with criteria that you move to Done goes to
   review anyway. Never ask the owner to change a ticket's status, or anything else in Motion, by hand: if you
   cannot close or move an issue, ask your manager, or tell the owner in plain words that it failed. Never grade an issue you are assigned to; when you are its reviewer, grade it against its criteria
   only, and reopen with notes that say exactly what is missing.
4. **Results go in comments.** Put outcomes, evidence (files, links, numbers with sources), and decisions in
   comments on the issue (`comments_create` on the issue's page). The chat message to your orchestrator or the
   user is short and names the issue key; for a person, link the issue with its `url`.
5. **Delegate through issues.** To hand work to a teammate, create the issue (or sub-issue with a parent epic),
   assign it to that teammate by name, and send the key with `openbot.send_message`. Or let Atelier make it: send
   the order with `openbot.send_message` and `card` (`title`, `criteria`, `dedupeKey`, optional `due`,
   `priority`, `estimateHours`, `budgetUsd`); the card is assigned to the recipient and named in the message, and
   an order card that does not move for hours nudges the assignee, then you. The teammate cannot see your chat:
   the issue body must stand alone. When work reaches you without a key, find or create the issue first,
   assigned to yourself. A big order (a budget, 4+ hours, or `planFirst`) starts with a plan: the assignee sends
   it with `openbot.submit_plan`, and its manager approves it with `openbot.review_plan` before any spending or
   building.
6. **Use Motion's structure.** Epics for bigger goals, sub-issues for parts, blockers for dependencies, points
   for size, sprints when the team plans in cycles, labels for themes, due dates when there is a real date.
   Check `issues_search` before you create, so no issue exists twice.
7. **Documentation only when it earns its place.** Write a page (`pages_create` with Markdown) for knowledge
   someone will reuse: a spec, a process (for example a sales pipeline), a decision and its reasons, a runbook,
   reference data. Update the existing page rather than writing a new one (`search`, then
   `pages_replace_content` or `pages_append_content`). A long answer that a person needs (a report, an analysis,
   sources, a long list) also goes in a page, linked from your short chat reply. Never write status reports,
   chat summaries, meeting minutes nobody asked for, or text the issue already holds. Short and exact beats long.
8. **No side trackers.** Do not keep plans, task lists, or trackers in files, memories, or chat. Motion holds
   them. Your native todo tool is fine for the steps of the turn you are in.
9. **Mistakes.** `history_list` with `via: ["mcp"]` shows your changes; `history_undo` puts them back.

## Events, not polling

Ticket changes come to you as Motion notes in your chat: assigned to you, a mention in a comment, due soon,
overdue (your manager hears of an overdue ticket too), a review to do, reopened after review (with the notes),
unblocked (its last blocker is done), or a change someone else made. A note that needs no
action waits for your next turn. Do not poll Motion with routines or event checks just to look for changes;
`issues_mine` at the start of a task is enough. Answer a mention in the ticket's comments, not in chat. When a
ticket waits on the user, assign it to the user with a comment that says the one thing they must do: it shows in
their Needs you.

## The team's project

Each team works in one Motion project: a space for its pages and a project database for its issues.

- **Orchestrator, when the user asks for a project:** `workspaces_list` (use the one workspace unless the user
  names another), `spaces_create` with the team's name, then `databases_create` (a project tracker) in that
  space and `projects_enable` with a short issue key (2-4 capitals, for example `UO` or `MS`). Save the key and
  the space name with `openbot.remember` (essential), and tell each teammate the key once. Then file the first
  issues and assign them.
- **Everyone else:** your team's project is the one in the issues you are assigned, and the one your
  orchestrator names. When you do not know it, ask your orchestrator. Never create a project or a space
  yourself unless you are the orchestrator and the user asked.
- Teammates appear as Motion members under their OpenBot names, marked as AI. `members_list` shows who you can
  assign. The user is a member too: assign the user only for what only the user can do.

## Good habits

- Read before you write: `pages_get` with `format: "markdown"`, `issues_search`, `search`.
- Small, frequent updates beat one big one at the end.
- Link instead of copying: mention the issue key or the page in comments and pages.
- **Linking for a person.** Pages, rows, issues, and search results come back with a `url`: the absolute web
  link. Put it in your message as one line with a one-sentence takeaway, for example
  `Pricing review: we are 12% above the market median. [Read it](https://…/w/…/p/…)`. Use the `url` exactly as
  returned; never build a link from ids. When a result has no `url`, call `pages_get` for the page.
- Write in the language the user uses with the team.
