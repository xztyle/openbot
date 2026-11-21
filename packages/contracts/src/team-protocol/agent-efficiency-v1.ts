// Optional agent-efficiency-v1 contract of this fork, under `fork-host-v1`.
//
// What it adds, recorded here because freezing it makes it permanent:
//
// - On an agent summary, beside the frozen agent projection exactly as `faceStyle` rides (see
//   `agent-face-v1.ts`): `modelPolicy` (`auto`; absent is a fixed model), `role` (1 to 80 characters,
//   no line break) and `sleepingSince` (an ISO 8601 time, at most 40 characters). The agent update
//   request can set `modelPolicy` (`fixed` or `auto`) and `role` (or clear it with `null`). An older
//   client or host drops the keys; a value that this build does not read is dropped from a summary.
// - `POST /v1/workspace/agents/sleep` `{ target: { kind: "agent" | "team" | "space", id }, sleeping }`
//   puts the agent, the agent and every agent under it in the org chart, or every agent of the space
//   to sleep, or wakes them, and answers `{ changedAgentIds, sleepingAgentIds }` (at most 1000 each).
//   Owners and admins only.
// - `POST /v1/workspace/model-savings` `{}` answers `{ days, turns, autoTurns, smallTurns, costUsd,
//   fixedCostUsd, warmSwitches }`: the turns of the last days, what the automatic model policy saved,
//   and how many turns changed the model of a session with a warm cache since the host started.
// - `POST /v1/workspace/reviews` `{ agentId?, pendingOnly?, enabled? }` answers `{ reviews, enabled? }`
//   (at most 500 reviews), newest first: one agent's weekly reviews, or the newest of each agent.
//   `enabled` turns the weekly reviews on or off first, and the answer says which it is. `/reviews/run` `{ agentId }`
//   reviews the agent's last seven days now and answers `{ review }` (null with nothing to review).
//   `/reviews/decide` `{ reviewId, decision: "approve" | "dismiss", text? (1200) }` approves the
//   proposed instruction, which the host adds to the agent's instructions, or dismisses it, and
//   answers `{ review }`. A review is `{ id, agentId, periodStart, periodEnd, grade: "great" | "good" |
//   "watch" | "poor", scorecard: { turns, failedTurns, ticketsDone, ticketsReopened, praise,
//   complaints, costUsd, smallModelShare (null or 0 to 1) }, summary (600), proposal: null | { text
//   (1200), state: "pending" | "approved" | "dismissed", decidedAt? }, reviewCostUsd (null or a
//   number), createdAt }`.
// - `POST /v1/workspace/playbooks` `{}` answers `{ playbooks, proposals }`. A playbook is `{ id, slug,
//   roles (1 to 20 role names), content (64000), version, updatedAt, agentIds }` and a proposal `{ id,
//   playbookId, agentId, content (64000), note (600), state, createdAt }`. `/playbooks/save` `{ id?,
//   slug, roles, content }`, `/playbooks/import` `{ agentId, slug, roles }` (the skill of that name in
//   the agent's workspace), `/playbooks/remove` `{ id }` and `/playbooks/decide` `{ proposalId,
//   decision }` answer the same snapshot. `candidates` (at most 100) are skills that two or more
//   agents have and no playbook owns: `{ slug, agentIds, suggestedRole (null or 80) }`. Owners and
//   admins only.
//
// A fork host built before these routes answers 404, and refuses an update that sets only these
// fields, so a client fails closed. The bounds are written out: this file must not move with an IPC limit.
import { isAgentModelPolicy, isAgentRole, isSleepingSince } from "../agent-efficiency";
import { isDynamicRecord, isString } from "../runtime-values";
import {
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
import { AGENT_KEYS, AGENT_LIST_KEYS, agentsIn } from "./agent-background-v1";
import { FORK_HOST_CAPABILITY } from "./fork-host-v1";
import type { TeamProtocolV2Json } from "./v2";
import type { TeamProtocolV6BaseJsonObject, TeamProtocolV6BaseJsonValue } from "./v6-base";

export const AGENT_EFFICIENCY_CAPABILITY = FORK_HOST_CAPABILITY;

/** The fields of an agent update request that this contract adds. */
export const AGENT_EFFICIENCY_UPDATE_KEYS = ["modelPolicy", "role"] as const;

/** The `modelPolicy` and `role` fields of an agent update request: a known value, or `null` to clear the role. */
export function decodeAgentEfficiencyRequest(value: unknown): TeamProtocolV6BaseJsonObject {
  if (!isDynamicRecord(value)) return {};
  const result: TeamProtocolV6BaseJsonObject = {};
  if (value.modelPolicy !== undefined) {
    if (!isAgentModelPolicy(value.modelPolicy)) throw new Error("Invalid model policy.");
    result.modelPolicy = value.modelPolicy;
  }
  if (value.role !== undefined) {
    if (value.role !== null && !isAgentRole(value.role)) throw new Error("Invalid agent role.");
    result.role = value.role;
  }
  return result;
}

/** Puts the model policy, the role and the sleep of each agent in `source` on the same agent in `projected`. */
export function withAgentEfficiency(
  projected: TeamProtocolV6BaseJsonValue,
  source: unknown,
): TeamProtocolV6BaseJsonValue {
  const marks = new Map<string, TeamProtocolV6BaseJsonObject>();
  for (const agent of agentsIn(source)) {
    if (!isDynamicRecord(agent) || !isString(agent.id)) continue;
    const mark: TeamProtocolV6BaseJsonObject = {};
    if (agent.modelPolicy === "auto") mark.modelPolicy = "auto";
    if (isAgentRole(agent.role)) mark.role = agent.role;
    if (isSleepingSince(agent.sleepingSince)) mark.sleepingSince = agent.sleepingSince;
    if (Object.keys(mark).length > 0) marks.set(agent.id, mark);
  }
  if (marks.size === 0) return projected;
  const apply = (agent: TeamProtocolV6BaseJsonValue): TeamProtocolV6BaseJsonValue => {
    if (!isDynamicRecord(agent) || !isString(agent.id)) return agent;
    const mark = marks.get(agent.id);
    return mark === undefined ? agent : { ...agent, ...mark };
  };
  if (Array.isArray(projected)) return projected.map(apply);
  if (!isDynamicRecord(projected)) return projected;
  if (isString(projected.id)) return apply(projected);
  const result: TeamProtocolV6BaseJsonObject = { ...projected };
  for (const key of AGENT_KEYS) if (isDynamicRecord(result[key])) result[key] = apply(result[key]);
  for (const key of AGENT_LIST_KEYS) {
    const items = result[key];
    if (Array.isArray(items)) result[key] = items.map(apply);
  }
  return result;
}

export const AGENT_EFFICIENCY_ROUTES = {
  sleep: "/v1/workspace/agents/sleep",
  modelSavings: "/v1/workspace/model-savings",
  reviews: "/v1/workspace/reviews",
  runReview: "/v1/workspace/reviews/run",
  decideReview: "/v1/workspace/reviews/decide",
  playbooks: "/v1/workspace/playbooks",
  savePlaybook: "/v1/workspace/playbooks/save",
  importPlaybook: "/v1/workspace/playbooks/import",
  removePlaybook: "/v1/workspace/playbooks/remove",
  decidePlaybook: "/v1/workspace/playbooks/decide",
} as const;

const money = (value: unknown): TeamProtocolV2Json => {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw new Error("Invalid cost.");
  return value;
};
const share = (value: unknown): TeamProtocolV2Json => {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) throw new Error("Invalid share.");
  return value;
};
const role = string(80);
const roles = (value: unknown): TeamProtocolV2Json => {
  const decoded = list(role, 20)(value);
  if (!Array.isArray(decoded) || decoded.length === 0) throw new Error("Invalid roles.");
  return decoded;
};
const decision = oneOf("approve", "dismiss");
const proposalState = oneOf("pending", "approved", "dismissed");

const review = fields({
  id: identifier,
  agentId: identifier,
  periodStart: string(80),
  periodEnd: string(80),
  grade: oneOf("great", "good", "watch", "poor"),
  scorecard: fields({
    turns: count,
    failedTurns: count,
    ticketsDone: count,
    ticketsReopened: count,
    praise: count,
    complaints: count,
    costUsd: money,
    smallModelShare: nullable(share),
  }),
  summary: string(600),
  proposal: nullable(fields({ text: string(1_200), state: proposalState }, { decidedAt: string(80) })),
  reviewCostUsd: nullable(money),
  createdAt: string(80),
});
const playbooks = fields({
  playbooks: list(
    fields({
      id: identifier,
      slug: string(64),
      roles,
      content: string(64_000),
      version: count,
      updatedAt: string(80),
      agentIds: list(identifier, 1_000),
    }),
    200,
  ),
  proposals: list(
    fields({
      id: identifier,
      playbookId: identifier,
      agentId: identifier,
      content: string(64_000),
      note: string(600),
      state: proposalState,
      createdAt: string(80),
    }),
    500,
  ),
  candidates: list(
    fields({ slug: string(64), agentIds: list(identifier, 1_000), suggestedRole: nullable(string(80)) }),
    100,
  ),
});

export const AGENT_EFFICIENCY_CODECS: ReadonlyMap<string, OptionalRouteCodec> = new Map([
  [
    AGENT_EFFICIENCY_ROUTES.sleep,
    adminRoute(
      fields({ target: fields({ kind: oneOf("agent", "team", "space"), id: identifier }), sleeping: boolean }),
      fields({ changedAgentIds: list(identifier, 1_000), sleepingAgentIds: list(identifier, 1_000) }),
    ),
  ],
  [
    AGENT_EFFICIENCY_ROUTES.modelSavings,
    adminRoute(
      empty,
      fields({
        days: count,
        turns: count,
        autoTurns: count,
        smallTurns: count,
        costUsd: money,
        fixedCostUsd: money,
        warmSwitches: count,
      }),
    ),
  ],
  [
    AGENT_EFFICIENCY_ROUTES.reviews,
    adminRoute(
      fields({}, { agentId: identifier, pendingOnly: boolean, enabled: boolean }),
      fields({ reviews: list(review, 500) }, { enabled: boolean }),
    ),
  ],
  [
    AGENT_EFFICIENCY_ROUTES.runReview,
    adminRoute(fields({ agentId: identifier }), fields({ review: nullable(review) })),
  ],
  [
    AGENT_EFFICIENCY_ROUTES.decideReview,
    adminRoute(fields({ reviewId: identifier, decision }, { text: string(1_200) }), fields({ review })),
  ],
  [AGENT_EFFICIENCY_ROUTES.playbooks, adminRoute(empty, playbooks)],
  [
    AGENT_EFFICIENCY_ROUTES.savePlaybook,
    adminRoute(fields({ slug: string(64), roles, content: string(64_000) }, { id: identifier }), playbooks),
  ],
  [
    AGENT_EFFICIENCY_ROUTES.importPlaybook,
    adminRoute(fields({ agentId: identifier, slug: string(64), roles }), playbooks),
  ],
  [AGENT_EFFICIENCY_ROUTES.removePlaybook, adminRoute(fields({ id: identifier }), playbooks)],
  [AGENT_EFFICIENCY_ROUTES.decidePlaybook, adminRoute(fields({ proposalId: identifier, decision }), playbooks)],
]);
