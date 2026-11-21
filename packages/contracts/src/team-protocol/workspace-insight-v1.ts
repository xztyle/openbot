// Optional insight wire contract of this fork, under `fork-host-v1`.
//
// What it adds, recorded here because freezing it makes it permanent:
//
// - `POST /v1/workspace/insight` `{ days? (1 to 92), timeZone? (64), language? (16) }` answers the
//   report `{ at, days, timeZone, goals, costs, money, sources, alerts, briefing }` for the owner and
//   the admins (403 for any other member). A goal is `{ id, spaceId, title (120), metric (40), target,
//   current, deadline (YYYY-MM-DD or null), source: "manual" | "hotmart-sales" | "hotmart-revenue" |
//   "meta-spend" | "motion-closed", product (60 or null), agentIds (50), note (200 or null),
//   createdAt, updatedAt, history (120 of { date, value }), costUsd? }`, at most 100. `costs` is `{
//   days (92 dates), totalUsd, sideUsd, idleUsd, weekUsd, previousWeekUsd, agents }`, each agent `{
//   agentId, spaceId, costUsd, tokens, turns, idleTurns, idleCostUsd, sideCostUsd, routineCostUsd,
//   daily (one amount a day) }`, at most 2000. `money` (5000) is `{ id, spaceId, date, kind: "spend"
//   | "revenue", amount, currency (3 to 8 capitals), sales (count or null), product, source: "manual"
//   | "meta" | "hotmart", note, updatedAt }`. `sources` (300) is `{ spaceId, kind: "meta" | "hotmart"
//   | "motion", state: "ready" | "missing" | "error", detail (200 or null), syncedAt }`. `alerts`
//   (100) is `{ id, spaceId, kind: "spend-no-sales" | "goal-behind" | "sync-failed", text (300),
//   createdAt }`. `briefing` is `{ settings, channelId, lastSentAt, lastText (4000), routines (200 of
//   { routineId, agentId, name (200), active }) }`, the settings `{ enabled, time (HH:MM), timeZone
//   (64), language: "es" | "en", allSpaces, spaceIds (100), replaceRoutineIds (200), alertDays (1 to
//   14), alertMinSpend }`. Amounts are finite numbers; money is never negative.
// - `POST /v1/workspace/insight/action` with an action answers the report. An action is `{ kind:
//   "goal-save", goal }` (a goal without the stored fields, `id` to change one), `{ kind:
//   "goal-remove", goalId }`, `{ kind: "goal-progress", goalId, value, note? }`, `{ kind:
//   "money-add", entry }`, `{ kind: "money-remove", entryId }`, `{ kind: "money-sync", spaceId? }`,
//   `{ kind: "alert-dismiss", alertId }`, `{ kind: "briefing-save", settings }` or `{ kind:
//   "briefing-send", spaceId? }`. Owner and admins only; a refused action answers 409 with the reason.
// - `POST /v1/workspace/why-slow` `{ agentId, channelId?, messageId? }` answers `{ agentId,
//   startedAt, endedAt, queueAhead, segments }`, at most 40 segments `{ kind: "queued" | "running" |
//   "teammate" | "owner" | "blocked" | "failed", startAt, endAt (or null), detail (200 or null) }`.
//   Times are epoch milliseconds. Any member who sees the agent may read it; another agent answers 404.
//
// A fork host built before these routes answers 404, so a client shows no insight view. A present
// malformed value fails closed. The bounds are written out: this file must not move with an IPC limit.
import { isDynamicRecord } from "../runtime-values";
import {
  type AdminDecoder,
  adminRoute,
  boolean,
  count,
  fields,
  identifier,
  list,
  nullable,
  type OptionalRouteCodec,
  oneOf,
  string,
} from "./admin-wire";
import { FORK_HOST_CAPABILITY } from "./fork-host-v1";

export const WORKSPACE_INSIGHT_CAPABILITY = FORK_HOST_CAPABILITY;

export const WORKSPACE_INSIGHT_ROUTES = {
  read: "/v1/workspace/insight",
  action: "/v1/workspace/insight/action",
  whySlow: "/v1/workspace/why-slow",
} as const;

const finite: AdminDecoder = (value) => {
  if (typeof value !== "number" || !Number.isFinite(value) || Math.abs(value) >= 1e12)
    throw new Error("Invalid insight number.");
  return value;
};
const money: AdminDecoder = (value) => {
  const result = finite(value);
  if (typeof result !== "number" || result < 0) throw new Error("Invalid insight amount.");
  return result;
};
const day: AdminDecoder = (value) => {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/u.test(value)) throw new Error("Invalid insight day.");
  return value;
};
const time = string(64);
const ids = (maximum: number) => list(identifier, maximum);
const goalSource = oneOf("manual", "hotmart-sales", "hotmart-revenue", "meta-spend", "motion-closed");

const goal = fields(
  {
    id: identifier,
    spaceId: identifier,
    title: string(120),
    metric: string(40),
    target: finite,
    current: finite,
    deadline: nullable(day),
    source: goalSource,
    product: nullable(string(60)),
    agentIds: ids(50),
    note: nullable(string(200)),
    createdAt: time,
    updatedAt: time,
    history: list(fields({ date: day, value: finite }), 120),
  },
  { costUsd: money },
);
const agentCost = fields({
  agentId: identifier,
  spaceId: identifier,
  costUsd: money,
  tokens: count,
  turns: count,
  idleTurns: count,
  idleCostUsd: money,
  sideCostUsd: money,
  routineCostUsd: money,
  daily: list(money, 92),
});
const costs = fields({
  days: list(day, 92),
  totalUsd: money,
  sideUsd: money,
  idleUsd: money,
  weekUsd: money,
  previousWeekUsd: money,
  agents: list(agentCost, 2_000),
});
const moneyEntry = fields({
  id: identifier,
  spaceId: identifier,
  date: day,
  kind: oneOf("spend", "revenue"),
  amount: money,
  currency: string(8),
  sales: nullable(count),
  product: nullable(string(60)),
  source: oneOf("manual", "meta", "hotmart"),
  note: nullable(string(200)),
  updatedAt: time,
});
const source = fields({
  spaceId: identifier,
  kind: oneOf("meta", "hotmart", "motion"),
  state: oneOf("ready", "missing", "error"),
  detail: nullable(string(200)),
  syncedAt: nullable(time),
});
const alert = fields({
  id: identifier,
  spaceId: identifier,
  kind: oneOf("spend-no-sales", "goal-behind", "sync-failed"),
  text: string(300),
  createdAt: time,
});
const settings = fields({
  enabled: boolean,
  time: string(5),
  timeZone: string(64),
  language: oneOf("es", "en"),
  allSpaces: boolean,
  spaceIds: ids(100),
  replaceRoutineIds: ids(200),
  alertDays: count,
  alertMinSpend: money,
});
const briefing = fields({
  settings,
  channelId: nullable(identifier),
  lastSentAt: nullable(time),
  lastText: nullable(string(4_000)),
  routines: list(fields({ routineId: identifier, agentId: identifier, name: string(200), active: boolean }), 200),
});
const report = fields({
  at: count,
  days: count,
  timeZone: string(64),
  goals: list(goal, 100),
  costs,
  money: list(moneyEntry, 5_000),
  sources: list(source, 300),
  alerts: list(alert, 100),
  briefing,
});

const goalDraft = fields(
  {
    spaceId: identifier,
    title: string(120),
    metric: string(40),
    target: finite,
    deadline: nullable(day),
    source: goalSource,
  },
  { id: identifier, current: finite, product: nullable(string(60)), agentIds: ids(50) },
);
const moneyDraft = fields(
  { spaceId: identifier, date: day, kind: oneOf("spend", "revenue"), amount: money, currency: string(8) },
  { sales: nullable(count), product: nullable(string(60)), note: nullable(string(200)) },
);

/** The actions, by `kind`. `variant` is keyed by `kind` too, so it is written out here. */
const ACTIONS: Record<string, AdminDecoder> = {
  "goal-save": fields({ kind: oneOf("goal-save"), goal: goalDraft }),
  "goal-remove": fields({ kind: oneOf("goal-remove"), goalId: identifier }),
  "goal-progress": fields({ kind: oneOf("goal-progress"), goalId: identifier, value: finite }, { note: string(200) }),
  "money-add": fields({ kind: oneOf("money-add"), entry: moneyDraft }),
  "money-remove": fields({ kind: oneOf("money-remove"), entryId: identifier }),
  "money-sync": fields({ kind: oneOf("money-sync") }, { spaceId: identifier }),
  "alert-dismiss": fields({ kind: oneOf("alert-dismiss"), alertId: identifier }),
  "briefing-save": fields({ kind: oneOf("briefing-save"), settings }),
  "briefing-send": fields({ kind: oneOf("briefing-send") }, { spaceId: identifier }),
};
const action: AdminDecoder = (value) => {
  const decode = isDynamicRecord(value) && typeof value.kind === "string" ? ACTIONS[value.kind] : undefined;
  if (!decode) throw new Error("Invalid insight action.");
  return decode(value);
};

const segment = fields({
  kind: oneOf("queued", "running", "teammate", "owner", "blocked", "failed"),
  startAt: count,
  endAt: nullable(count),
  detail: nullable(string(200)),
});

export const WORKSPACE_INSIGHT_CODECS: ReadonlyMap<string, OptionalRouteCodec> = new Map([
  [
    WORKSPACE_INSIGHT_ROUTES.read,
    adminRoute(fields({}, { days: count, timeZone: string(64), language: string(16) }), report),
  ],
  [WORKSPACE_INSIGHT_ROUTES.action, adminRoute(action, report)],
  [
    WORKSPACE_INSIGHT_ROUTES.whySlow,
    adminRoute(
      fields({ agentId: identifier }, { channelId: identifier, messageId: identifier }),
      fields({
        agentId: identifier,
        startedAt: nullable(count),
        endedAt: nullable(count),
        queueAhead: count,
        segments: list(segment, 40),
      }),
    ),
  ],
]);
