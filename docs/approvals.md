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
- scheduled routines that already exist;
- deletions of anything that is not in tier 1 or tier 2 (see [Deletions](#deletions)).

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
  accepts it as is or sends it back with a note. Either verdict, the manager's or the owner's, replaces
  the grader's in Motion (`issues_review` with `override`, as that person's own Motion member): accept
  closes the ticket at once and starts no new review round, even when its agent marks it Done again;
  send back reopens it with the note. Nobody changes the ticket's status by hand;
- plan approvals and other `request_decision` calls that are not in a tier-2 class;
- creating or changing an agent within the space's limits (when the trust policy asks);
- free, reversible external sign-ups, such as an affiliate program with no fee;
- publishing to production once both QA agents said OK (a go-live of `request_decision`, or a publish
  that the trust policy asks for);
- an agent's first mail to a stranger, within the existing rate caps;
- lessons for an agent's instructions, a role playbook or a skill (the decision queue);
- deleting a routine, a skill or a shared table (see [Deletions](#deletions)).

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
(`OWNER_ONLY_TRUST_ACTIONS`), except the deletions of tier 0 and tier 1 below.

## Tier 2: the owner only

- Money: any spend, payment, ad budget or price change, subscriptions and budget caps. The money
  approvals of the trust gate stay exactly as they were: owner-only cards that full access does not
  answer, with their expiry and budgets.
- Deletions of crucial things (see [Deletions](#deletions)): an agent, a channel, a space, a live site,
  app or database, an account connection or its credentials; a force-push or a delete of main or a
  production branch. The default trust rule for `delete` asks the owner for these only.
- Credentials, secrets and sign-in codes for accounts.
- Legal or identity commitments in the owner's name: contracts, terms with fees, KYC and ID checks.
- Security blocks: injection blocks and "Allow once".
- Every mail from an agent mailbox set to **Ask me before every mail** (`ownerApprovesEverySend`),
  replies too: an owner-only card with the draft, one OK per mail.
- Anything a manager escalates with a reason.

`request_decision` takes `concerns` for these classes. Without it, an amount or the words of the
decision (`ownerOnlyClassOf`) put it in a class; the manager can still escalate what slips through.
The judge that reads a waiting Motion ticket answers `owner_only` the same way.

## Deletions

A deletion goes to a tier by what it deletes, not by the word "delete" (`deletionTier` and
`classifyOpenBotTool` in `src/backend/trust/trust-classifier.ts`):

| Tier | Who decides | What is deleted |
| --- | --- | --- |
| 2 | The owner | An agent; a channel (`openbot.delete_channel`); a whole space; a live production site, app or database: published hosted sites (`render-sites delete`), `appctl delete`, `appctl db delete` / `db drop`, and every deletion on a database or hosting MCP server, such as Supabase or Vercel; an owner account connection or its stored credentials (`openbot.remove_api_key`, a Vault login, an MCP tool that removes a connection, an account, a token or a key); a force-push or a delete of main or a production branch. |
| 1 | The asking agent's manager | A routine or a schedule (`openbot.delete_routine`); a skill (`openbot.uninstall_skill`); a shared table (`openbot.delete_table`, `DROP TABLE` in `openbot.execute_data`). |
| 0 | Nobody: it runs at once | Every other deletion: Motion tickets, pages and comments; messages; files and folders in agent or space workspaces (`rm`); git branches and repositories; drafts, staging copies (such as a site named `<name>-preview`) and memories; browser tabs and temporary data. |

A deletion whose target is not clear is tier 0, unless it names a tier-2 thing. Hotmart coupon and
subscription deletes stay with the owner: they change prices and money. Tier-2 deletions also count as
high-impact actions for the injection monitor. Every deletion is still recorded in the trust audit
trail.

## What the owner sees

- **Needs you / Today**: only tier-2 items and escalations. A ticket for a manager never shows there and
  sends no push.
- A waiting ticket that asks the owner nothing (the judge's `owner_action` is `none`, or its summary
  says "no se le pide nada", "no hace falta que decida" and similar, `nothingAsked`) never reaches the
  owner: its manager answers it (a review the manager accepts closes), or, with no manager, it leaves
  the list and its agent gets an FYI note (`routeWithoutOwner` in `motion-waiting-asks.ts`).
- A ticket whose real ask is a sign-in on the owner's account (`sign_in`) is a sign-in card: the button
  "Sign in to <site>" asks the agent to open the page in its browser and hand the tab over (a takeover),
  in place of Approve and Decline. It stays with the owner as `credentials`.
- **Inbox, "Decided by agents"**: what managers decided, as an FYI, with Reopen where the request can be
  taken back (a ticket goes back to Needs you).
- **Trust page**: "Your interventions": how many approvals and decisions the owner and the agents
  answered this week and the week before, and the share the agents took.

## Plain language

Everything that reaches the owner is in plain, non-technical words, in the owner's language
(`OPENBOT_OWNER_LANGUAGE`, or the host's language). The host asks the cheap judge model for a summary
of each ticket and each agent decision (`ownerSummaryPrompt`): what is asked, why it matters for the
business, and what a yes and a no do. A waiting ticket's summary also reads the agent's recent chat, where the
real blocker is often said, and its `asks` is the owner's concrete action as a question or an
imperative ("¿Cerramos este trabajo ya aprobado?"); `if_yes` and `if_no` say what the card's buttons do. `plainText` takes out ids, codes, long numbers, flags, paths and
technical words that the model leaves in. The raw text stays behind a collapsed "technical details",
which only the owner opens.
