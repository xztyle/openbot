# Approvals

The owner's goal is the lowest possible rate of human intervention. Only money and critical or
irreversible things reach the owner. Everything else is approved automatically, or by the asking
agent's manager in the org chart.

The shared rules are in `packages/contracts/src/agent-approvals.ts`. The manager tier is
`src/backend/approvals/approval-router.ts`.

## Tier 0: automatic, nobody is asked

Reversible internal work runs at once:

- creating, editing and commenting on Motion tickets;
- messages between agents;
- memory changes (they apply by themselves; the owner can revert them in the inbox);
- drafts, branches, review-branch pushes and local files;
- reading the web;
- runs in the agent's own jail;
- scheduled routines that already exist.

The trust policy's default rules allow publish, email and create-agent actions. Every action is still
recorded in the trust audit trail.

## Tier 1: the manager agent decides

The approver is the asking agent's parent in the org chart (`agentManagers` in
`@openbot/contracts/agent-org`). An agent with no manager goes to the space's top agent: the top-level
agent with the most agents under it. When no agent qualifies, the request goes to the owner
(`approverCandidates`).

Tier 1 covers:

- a Motion ticket handed over for an OK or a decision (`asks` = `approval` or `other`), and a `blocked`
  ticket that does not need a credential, money or a sign-in;
- a review that the grader escalated after its 3 rounds (`asks` = `review-escalated`): the manager
  accepts it as is or sends it back with a note;
- plan approvals and other `request_decision` calls that are not in a tier-2 class;
- creating or changing an agent within the space's limits (when the trust policy asks);
- free, reversible external sign-ups, such as an affiliate program with no fee;
- publishing to production once both QA agents said OK (a go-live of `request_decision`, or a publish
  that the trust policy asks for);
- an agent's first mail to a stranger, within the existing rate caps;
- lessons for an agent's instructions, a role playbook or a skill (the decision queue).

How it works:

1. The manager gets the request as a normal wake: the request id, the ticket, the reason and the
   asker's evidence.
2. It answers with `openbot.answer_approval`: `approve`, `decline` with a note, or `escalate` with a
   reason. The answer goes to the trust audit trail as answered by the manager
   (`answeredByKind: "agent"`). A ticket gets the answer as the manager's comment, and the asker is
   woken with it.
3. No agent answers its own request or one that it raised in the same chain: an agent that a request
   woke carries that request's chain into the requests it raises meanwhile.
4. With no answer within 2 hours (`APPROVAL_CLIMB_MS`) the request goes up one level. After the top
   agent it goes to the owner.
5. A manager escalates to the owner only for a tier-2 class, or with a stated reason. The owner's card
   says who escalated it and why.

The trust policy has an approver per action (`approvers`): `owner` or `manager`. Publish, email and
create-agent default to `manager`. Pay, ad launches and deletions are always `owner`
(`OWNER_ONLY_TRUST_ACTIONS`).

## Tier 2: the owner only

- Money: any spend, payment, ad budget or price change, subscriptions and budget caps. The money
  approvals of the trust gate stay exactly as they were: owner-only cards that full access does not
  answer, with their expiry and budgets.
- Deletions and irreversible actions: deleting data, agents, spaces, files outside the agent's own
  work, databases or pages in production; a force-push or history rewrite on main or production
  branches; revoking access. The default trust rule for `delete` asks the owner.
- Credentials, secrets and sign-in codes for accounts.
- Legal or identity commitments in the owner's name: contracts, terms with fees, KYC and ID checks.
- Security blocks: injection blocks and "Allow once".
- Anything a manager escalates with a reason.

`request_decision` takes `concerns` for these classes. Without it, an amount or the words of the
decision (`ownerOnlyClassOf`) put it in a class; the manager can still escalate what slips through.
The judge that reads a waiting Motion ticket answers `owner_only` the same way.

## What the owner sees

- **Needs you / Today**: only tier-2 items and escalations. A ticket for a manager never shows there and
  sends no push.
- **Inbox, "Decided by agents"**: what managers decided, as an FYI, with Reopen where the request can be
  taken back (a ticket goes back to Needs you).
- **Trust page**: "Your interventions": how many approvals and decisions the owner and the agents
  answered this week and the week before, and the share the agents took.

## Plain language

Everything that reaches the owner is in plain, non-technical words, in the owner's language
(`OPENBOT_OWNER_LANGUAGE`, or the host's language). The host asks the cheap judge model for a summary
of each ticket and each agent decision (`ownerSummaryPrompt`): what is asked, why it matters for the
business, and what a yes and a no do. `plainText` takes out ids, codes, long numbers, flags, paths and
technical words that the model leaves in. The raw text stays behind a collapsed "technical details",
which only the owner opens.
