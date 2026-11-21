### Added

- Trust and control. A trust policy says, for each agent, whether it may pay, launch or fund ads,
  publish, email customers, create agents and delete: Allow, Ask me or Deny. By default only money
  (payments and ad spend) asks; everything else is allowed and recorded. Defaults come by role
  (lead or member) and can be changed per space, per team (a manager and everyone under it) and per
  agent. Budgets cap spend per platform, per day and in total, such as Meta 7 USD a day.
- The host checks the policy at the tool layer, not in the prompt: card fills, actions on Meta,
  Google and TikTok Ads Manager and on checkout pages, `create_agent`, and for Claude agents the
  Bash commands and MCP tools that spend, publish, email or delete (the meta-ads, hotmart,
  render-sites and appctl helpers, pushes to the landings repository, email and payment APIs). An
  Ask shows an approval card that only the owner can answer; Full access does not answer it. One
  approval on an ads or checkout page covers the next actions there for 30 minutes (configurable).
- Sandbox first, off by default and switched on per kind (landings, ads that go live, emails): the public change is
  refused until the agent stages a preview and the owner approves it with a decision card.
- `openbot.request_decision`: agents ask for a decision with options and their consequences, an
  amount, a preview link and an optional default after a timeout. The card shows in the chat and in
  Needs you, with a push, and the agent's work waits for the answer.
- An append-only audit trail of spend, publishing, sends, deletes, new agents, policy changes,
  approvals, decisions, secret fills and sign-ins, with who, what, when, the amount and a link to
  the chat. Workspace > More > Trust & audit (web and phone, owner and admins) edits the policy and
  budgets, shows today's spend, and lists the audit log with filters and a CSV export. The org
  chart panel has a Permissions button for each agent.
