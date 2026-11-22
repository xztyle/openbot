# Loops

A loop is the owner's own pipeline for one space: ordered stages with branches, and items that move
through them (a product, a lead, a video, a buyer question). Open it in the workspace: More, Loops.

## Parts

| Part | What it does |
|---|---|
| Stage | Name, owner agent or role, goal, deadline in days, end (`done`, `won`, `lost`, `killed`). |
| Exit criteria | A checklist and metric thresholds (`roas >= 1.5`). An item leaves the stage only when they hold; the owner can move it anyway, an agent only with a note. Moving back or to an end skips them. |
| Next stages | The branches. Empty: the next stage in order and every end. |
| Gate | `money`, `publish` or `decision`. The owner approves before an item enters the stage. An agent's move waits as a decision; an agent can never open, remove or change a gate. |
| On enter | Wake the owner agent with the item and its exit criteria; a Motion ticket in the loop's Motion project; a routine run. |
| Fields | The loop's values (`key | Label | type | card`). `card` fields show on the board. |
| Experiment | Hypothesis, variants, metric, budget, days, status, winner and result, for any item. A budget above 0 waits for the owner. |
| Decision | What waits for the owner: a gate, an experiment budget, or a question an agent escalated. It shows in the Loops view and in Needs you. The answer reaches the asking agent as a note. |

Every change is a row of the item's history (`loop_events`). Templates: affiliate course growth loop,
content pipeline, leads, customer inbox.

## Agent tools

`openbot.list_loops`, `save_loop`, `save_loop_item`, `move_loop_item`, `propose_experiment`,
`update_experiment`, `escalate_loop_item`. They are deferred: an agent finds them with `tool_search`,
so they cost no prompt tokens until used. An agent sees only the loops of its own space.

## The decision item

`LoopDecision` in `packages/contracts/src/ipc-workspace-loops.ts` is the standard "decision" attention
item of loops: `{ id, spaceId, loopId, itemId, kind: money | publish | decision, subject: move |
experiment | question, title, detail?, amountUsd?, requestedBy?, status, createdAt }`. An inbox lists the
pending ones with `LoopService.pendingDecisions()` (every space) or the `decisionsOnly` board read, and
answers one with the `decide` action (`{ decisionId, approve, note? }`).

## Motion tickets

A stage ticket goes through Motion's public API (`POST /api/v1/issues.create`) with the address and
headers of the enabled MCP server named `motion`, filled for the agent that moved the item (or the
stage owner): the gateway token from Secrets and the agent and space headers. Set the loop's Motion
project key (such as `PUO`) in the editor. Without that row or key, no ticket is made and the history
says so.

## Competitor watch

The `meta-ad-library` event check template (Marketplace, Event checks) searches the Meta Ad Library
API for the niche's keywords and countries, one request every 3.5 s, and wakes its agent for each new
competitor ad and again when an ad has run long enough to be proven. Use a small-model agent (Haiku)
for the summary. It needs `META_ACCESS_TOKEN`: a user access token of a Meta account that confirmed its
identity for the Ad Library API (facebook.com/ID). A Business system user token for the Marketing API
may not read `ads_archive`. Meta returns every ad type only for ads that reach the EU or the UK; for
Latin American countries the API returns only political and issue ads, so an agent reads the public
Ad Library page in its browser instead.

## Customer inbox

Create a loop from the customer inbox template and set the owner agent of New. The connectors are the
event check templates that wake that agent for each new message; the agent files each one with
`save_loop_item` (`externalId` = the thread id, so a reply updates the same item), answers it, and
escalates what only the owner can answer with `escalate_loop_item`.

| Channel | Connector | Credentials |
|---|---|---|
| Business address on Cloudflare | [Agent mailboxes](agent-mailboxes.md): each mail adds or updates a card by itself | None in the agent: Email Routing, the mail Worker and its secret. |
| Gmail | `gmail-inbox` template | The Gmail address and an app password (`GMAIL_APP_PASSWORD`). |
| Proton Mail | `protonmail-inbox` template | Proton Mail Bridge on the host and its password (`PROTONMAIL_BRIDGE_PASSWORD`). |
| Other mail (IMAP) | Write a check with the `openbot-event-checks` skill | IMAP host, user and app password. |
| Hotmart | `hotmart-sales` and `hotmart-subscriptions` templates | Hotmart developer credential. Hotmart's API has no buyer questions; these give sales, refunds and cancellations. |
| WhatsApp | None yet | A WhatsApp Business Cloud API number and token, and a webhook bridge. |
