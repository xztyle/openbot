# Agent learning

How agents learn by themselves while the owner stays in control. The host owns all of it; the
code is in `src/backend/agent-learning/`, the types in `packages/contracts/src/agent-learning.ts`,
and the routes in `packages/contracts/src/team-protocol/agent-learning-v1.ts` (under
`fork-host-v1`, owners and admins only).

## Storage

Small JSON files in the user data folder, written whole and atomically. No database table.

| File | Holds |
| --- | --- |
| `agent-learning-v1.json` | Review items, the two switches, the nightly cursors, the lesson counters, and the chat turns each memory review read |
| `agent-settings-history-v1.json` | The newest 30 settings checkpoints of each agent |
| `space-knowledge-v1.json` | The decision log (500 per space) and the customer, product and supplier memory (500 entities per space, 30 facts each) |

A missing or damaged file reads as empty.

## Nightly cleanup ("dreaming")

`AgentLearning` looks at the clock every 30 minutes. Between 02:00 and 06:00 in the host's time
zone, once per local date, it runs:

1. Each awake agent, most memories first, at most 25: one prompt on the provider's small model
   (`learning-prompts.ts` `dreamPrompt`) with the agent's memories and its own chat since the last
   cleanup. The answer lists merges, stale memories, rewrites and repeated mistakes.
   - A merge whose texts share at least 60% of their words applies by itself as one
     `auto-applied` item, which the owner can undo.
   - Anything else is a `pending` item. A repeated mistake becomes an `instructions-add`.
   - A memory that the owner wrote or chose (`manual`, `userControlled`) or that was redacted for
     the prompt is never changed.
2. Each space: entities that are one spelling of the same name merge, and repeated facts go.
3. One prompt over every space: a local skill of an agent in one space that would help an agent of
   another space becomes a `cross-space` item. Accepting it installs the skill on that agent.

`POST /v1/workspace/learning/dream { agentId }` runs step 1 for one agent now.

## Lessons from finished tasks

A Motion `issue.status_changed` to a done status (`motion-events-host.ts`) and a loop item that
reaches an end stage (`LoopService` `itemFinished`) call `taskFinished` for the agents that worked
on it. After 90 seconds, one prompt (`taskLessonPrompt`) reads the agent's chat, its role
playbooks and its local skills, and may propose one rule. It becomes a pending `playbook-add`,
`skill-add` or `instructions-add` item. At most one lesson per agent per hour and 20 per day.

Accepting a lesson adds it to the "Lessons" part of the playbook or skill, or to the end of the
instructions, through the host's normal update paths.

## Settings history

`AgentService.updateAgent` records a checkpoint of the fields that changed, with the author: the
owner (or an admin), the agent that asked (`initiatingAgentId`), or `improver` for a weekly review
instruction or a learning item that the owner accepted. A skill revision by a memory review and a
role playbook change are recorded too, for each agent of the role. `rollbackSettings` puts the
fields back to their values before the checkpoint and records the rollback as a new checkpoint.

## Space knowledge

The `space_memory` tool remembers, recalls and forgets entities and their facts, lists decisions,
and records an outcome. `log_decision` always adds to the space's decision log; in a hands-off
channel it also posts in the channel, as before.

## Forget one chat

`forgetConversation` lists the memories whose source turn is a turn of the chat, the memories made
by a background memory review that read one of those turns, and the space facts saved in those
turns. With `confirm` they go. Manual memories stay.

## The decision queue

`POST /v1/workspace/learning/queue {}` answers `{ entries }`: every proposal that waits for the
owner, newest first, in one shape (`DecisionQueueEntry`):

```ts
{
  id: "learning:<itemId>" | "playbook:<proposalId>" | "review:<reviewId>",
  source: "learning" | "playbook" | "review",
  kind: "memory" | "instructions" | "playbook" | "skill" | "cross-space",
  agentId: string | null,
  spaceId: string | null,
  title: string,      // at most 200 characters
  detail: string,     // plain text of what changes, at most 2000 characters
  risk: "low" | "review",
  createdAt: string,  // ISO 8601
}
```

`POST /v1/workspace/learning/queue/decide { id, decision: "approve" | "dismiss" }` decides any
entry by its `id` and answers `{ ok: true }`. A client that shows a decision queue needs only these
two routes; the richer per-source routes (`/learning/reviews`, `/playbooks`, `/reviews`) stay for
their own screens.
