// Optional agent-learning-v1 contract of this fork, under `fork-host-v1`. Owners and admins only.
//
// What it adds, recorded here because freezing it makes it permanent. Every route is POST and answers
// JSON; a refusal of the request itself (an item that no longer waits, a rollback that cannot apply)
// answers 409 with `{ error }`.
//
// Review items (`agent-learning.ts`, `LearningReviewItem`): what the nightly memory cleanup and the
// lessons of finished Motion cards and loop items propose.
// - `/v1/workspace/learning/reviews` `{ agentId?, spaceId?, pendingOnly?, settings?: { dreaming?,
//   taskLearning? } }` answers `{ items (at most 500, newest first), settings: { dreaming, taskLearning } }`.
//   `settings` turns the cleanup or the lessons on or off before the list is read.
// - `/learning/decide` `{ itemId, decision: "accept" | "dismiss" | "revert" }` answers `{ item }`. Accept
//   applies a pending item; revert undoes an applied or auto-applied memory item.
// - `/learning/dream` `{ agentId }` runs the cleanup of one agent now and answers `{ items }` (what it made).
//
// The decision queue, for any client that lists everything that waits for the owner in one place:
// - `/learning/queue` `{}` answers `{ entries }` (at most 500, newest first). An entry is `{ id, source:
//   "learning" | "playbook" | "review", kind, agentId (null), spaceId (null), title (200), detail (2000),
//   risk: "low" | "review", createdAt }`. It holds the pending learning items, the pending playbook
//   proposals of agents (agent-efficiency-v1) and the pending instruction of each weekly review.
// - `/learning/queue/decide` `{ id, decision: "approve" | "dismiss" }` decides one entry by its `id`,
//   whatever its source, and answers `{ ok: true }`.
//
// Settings history (`SettingsCheckpoint`): every change of an agent's name, title, instructions,
// provider, model, reasoning effort, model policy, role, access, Computer Use, backup models, of one of
// its local skills by a review, and of a playbook of its role, with who made it.
// - `/learning/history` `{ agentId }` answers `{ checkpoints }` (at most 30, newest first).
// - `/learning/rollback` `{ checkpointId }` puts each field of the checkpoint back to its value before it
//   and answers `{ checkpoint }`, the new checkpoint of the rollback.
//
// Space knowledge (`SpaceKnowledge`): the decision log and the customer, product and supplier memory
// that every agent of a space shares through its `space_memory` and `log_decision` tools.
// - `/learning/knowledge` `{ spaceId, query? }` answers `{ spaceId, decisions, entities }` (at most 500 each).
// - `/learning/knowledge/remove` `{ spaceId, kind: "decision" | "entity" | "fact", id, entityId? }` answers
//   the same.
//
// - `/learning/forget-conversation` `{ agentId, threadId?, confirm? }` answers `{ memories: [{ id, text }],
//   facts: [{ entityId, factId, text }], forgotten }`: the memories and space facts that the agent learned
//   from that chat (its own chat when `threadId` is absent). Without `confirm` nothing goes and
//   `forgotten` is 0.
//
// A fork host built before these routes answers 404, so a client hides what needs them.
import { isDynamicRecord, isString } from "../runtime-values";
import {
  type AdminDecoder,
  adminRoute,
  boolean,
  count,
  empty,
  fields,
  identifier,
  list,
  nullable,
  type OptionalRouteCodec,
  oneOf,
  string,
} from "./admin-wire";

export const AGENT_LEARNING_ROUTES = {
  reviews: "/v1/workspace/learning/reviews",
  decide: "/v1/workspace/learning/decide",
  dream: "/v1/workspace/learning/dream",
  queue: "/v1/workspace/learning/queue",
  decideQueue: "/v1/workspace/learning/queue/decide",
  history: "/v1/workspace/learning/history",
  rollback: "/v1/workspace/learning/rollback",
  knowledge: "/v1/workspace/learning/knowledge",
  removeKnowledge: "/v1/workspace/learning/knowledge/remove",
  forgetConversation: "/v1/workspace/learning/forget-conversation",
} as const;

const time = string(80);
const text = string(1_200);
const kind = oneOf("memory", "instructions", "playbook", "skill", "cross-space");
const risk = oneOf("low", "review");

const changeCases = new Map<string, AdminDecoder>([
  ["memory-update", fields({ type: string(40), memoryId: identifier, before: text, after: text })],
  ["memory-forget", fields({ type: string(40), memoryId: identifier, before: text })],
  ["instructions-add", fields({ type: string(40), text })],
  ["playbook-add", fields({ type: string(40), playbookId: identifier, slug: string(64), text })],
  ["skill-add", fields({ type: string(40), skillId: identifier, name: string(200), text })],
  ["skill-copy", fields({ type: string(40), fromAgentId: identifier, skillId: identifier, name: string(200) })],
]);

/** One change of an item, by its `type`. */
const change: AdminDecoder = (value) => {
  const decode = isDynamicRecord(value) && isString(value.type) ? changeCases.get(value.type) : undefined;
  if (!decode) throw new Error("Invalid admin variant.");
  return decode(value);
};

const item = fields(
  {
    id: identifier,
    kind,
    source: oneOf("dreaming", "task", "loop"),
    agentId: nullable(identifier),
    spaceId: nullable(identifier),
    title: string(200),
    note: string(600),
    ref: nullable(string(200)),
    changes: list(change, 20),
    risk,
    state: oneOf("pending", "applied", "auto-applied", "dismissed", "reverted", "stale"),
    createdAt: time,
  },
  { decidedAt: time },
);
const settings = fields({ dreaming: boolean, taskLearning: boolean });

const entry = fields({
  id: string(200),
  source: oneOf("learning", "playbook", "review"),
  kind,
  agentId: nullable(identifier),
  spaceId: nullable(identifier),
  title: string(200),
  detail: string(2_000),
  risk,
  createdAt: time,
});

const fieldChange = fields(
  {
    field: oneOf(
      "name",
      "title",
      "instructions",
      "provider",
      "model",
      "reasoningEffort",
      "modelPolicy",
      "playbookRole",
      "access",
      "computerUse",
      "backupModels",
      "skill",
      "playbook",
    ),
    before: nullable(string(70_000)),
    after: nullable(string(70_000)),
  },
  { ref: identifier, label: string(200) },
);
const checkpoint = fields(
  {
    id: identifier,
    agentId: identifier,
    at: time,
    author: fields({ kind: oneOf("owner", "agent", "improver") }, { agentId: identifier }),
    changes: list(fieldChange, 20),
  },
  { rollbackOf: identifier },
);

const knowledge = fields({
  spaceId: identifier,
  decisions: list(
    fields(
      {
        id: identifier,
        spaceId: identifier,
        agentId: nullable(identifier),
        decision: string(400),
        why: string(600),
        createdAt: time,
      },
      { alternatives: string(400), outcome: string(400), outcomeAt: time, channelId: identifier },
    ),
    500,
  ),
  entities: list(
    fields({
      id: identifier,
      spaceId: identifier,
      type: oneOf("customer", "product", "supplier", "other"),
      name: string(120),
      facts: list(
        fields(
          { id: identifier, text: string(400), agentId: nullable(identifier), at: time },
          { sourceTurnId: identifier },
        ),
        30,
      ),
      updatedAt: time,
    }),
    500,
  ),
});

export const AGENT_LEARNING_CODECS: ReadonlyMap<string, OptionalRouteCodec> = new Map([
  [
    AGENT_LEARNING_ROUTES.reviews,
    adminRoute(
      fields(
        {},
        {
          agentId: identifier,
          spaceId: identifier,
          pendingOnly: boolean,
          settings: fields({}, { dreaming: boolean, taskLearning: boolean }),
        },
      ),
      fields({ items: list(item, 500), settings }),
    ),
  ],
  [
    AGENT_LEARNING_ROUTES.decide,
    adminRoute(fields({ itemId: identifier, decision: oneOf("accept", "dismiss", "revert") }), fields({ item })),
  ],
  [AGENT_LEARNING_ROUTES.dream, adminRoute(fields({ agentId: identifier }), fields({ items: list(item, 500) }))],
  [AGENT_LEARNING_ROUTES.queue, adminRoute(empty, fields({ entries: list(entry, 500) }))],
  [
    AGENT_LEARNING_ROUTES.decideQueue,
    adminRoute(fields({ id: string(200), decision: oneOf("approve", "dismiss") }), fields({ ok: boolean })),
  ],
  [
    AGENT_LEARNING_ROUTES.history,
    adminRoute(fields({ agentId: identifier }), fields({ checkpoints: list(checkpoint, 30) })),
  ],
  [AGENT_LEARNING_ROUTES.rollback, adminRoute(fields({ checkpointId: identifier }), fields({ checkpoint }))],
  [AGENT_LEARNING_ROUTES.knowledge, adminRoute(fields({ spaceId: identifier }, { query: string(200) }), knowledge)],
  [
    AGENT_LEARNING_ROUTES.removeKnowledge,
    adminRoute(
      fields(
        { spaceId: identifier, kind: oneOf("decision", "entity", "fact"), id: identifier },
        { entityId: identifier },
      ),
      knowledge,
    ),
  ],
  [
    AGENT_LEARNING_ROUTES.forgetConversation,
    adminRoute(
      fields({ agentId: identifier }, { threadId: identifier, confirm: boolean }),
      fields({
        memories: list(fields({ id: identifier, text: string(1_200) }), 1_000),
        facts: list(fields({ entityId: identifier, factId: identifier, text: string(400) }), 1_000),
        forgotten: count,
      }),
    ),
  ],
]);
