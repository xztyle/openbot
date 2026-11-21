// Insight: knowing what goes on without asking an agent. Goals per space, the money that goes out (ad
// spend) and comes in (sales and commissions) per day, the cost of each agent, the daily briefing,
// and where the time of one request went ("Why is this slow?"). The host computes all of it from what
// it stores; nothing here wakes an agent. Only the owner and the admins read and change it, except
// the timeline of a request, which any member who sees the agent may read.

import { isBoundedString, isFiniteNumber, isIdentifier, isNullableBoundedString } from "./ipc-bounded-values";
import { type DynamicRecord, isDynamicRecord, isOneOf } from "./runtime-values";

export const INSIGHT_GOAL_LIMIT = 100;
export const INSIGHT_GOAL_TITLE_LIMIT = 120;
export const INSIGHT_GOAL_METRIC_LIMIT = 40;
export const INSIGHT_PRODUCT_LIMIT = 60;
export const INSIGHT_NOTE_LIMIT = 200;
/** The progress points one goal keeps: one a day, about four months. */
export const INSIGHT_GOAL_HISTORY_LIMIT = 120;
/** The agents of a goal's team. None: every agent of its space. */
export const INSIGHT_GOAL_TEAM_LIMIT = 50;
/** The money rows one report holds. A day of a space has at most a few. */
export const INSIGHT_MONEY_ENTRY_LIMIT = 5_000;
export const INSIGHT_AGENT_LIMIT = 2_000;
export const INSIGHT_ALERT_LIMIT = 100;
export const INSIGHT_ALERT_TEXT_LIMIT = 300;
export const INSIGHT_BRIEFING_TEXT_LIMIT = 4_000;
export const INSIGHT_ROUTINE_LIMIT = 200;
export const INSIGHT_DAYS_LIMIT = 92;
export const INSIGHT_SPACE_LIMIT = 100;
export const INSIGHT_SLOW_SEGMENT_LIMIT = 40;

/**
 * Where the progress of a goal comes from. `manual`: a person or an agent sets it. The others are
 * read by the host each day: the approved Hotmart sales (count) or commissions (amount) of the
 * goal's space in the goal's period, its Meta ad spend, or the Motion issues closed.
 */
export const INSIGHT_GOAL_SOURCES = [
  "manual",
  "hotmart-sales",
  "hotmart-revenue",
  "meta-spend",
  "motion-closed",
] as const;
export type InsightGoalSource = (typeof INSIGHT_GOAL_SOURCES)[number];

export interface InsightGoalPoint {
  /** A calendar day, `YYYY-MM-DD`. */
  date: string;
  value: number;
}

export interface InsightGoal {
  id: string;
  spaceId: string;
  title: string;
  /** The unit, as people say it: "sales", "USD", "tickets". */
  metric: string;
  target: number;
  current: number;
  /** A calendar day, `YYYY-MM-DD`, or none. */
  deadline: string | null;
  source: InsightGoalSource;
  /** The product or campaign it is about, as a label. */
  product: string | null;
  /** The team whose cost counts for the goal. Empty: every agent of the space. */
  agentIds: string[];
  /** The last note of whoever moved the progress. */
  note: string | null;
  createdAt: string;
  updatedAt: string;
  history: InsightGoalPoint[];
  /** What the team cost in the report's period, in US dollars at API list prices. */
  costUsd?: number;
}

/** The fields a person or an agent sends to create or change a goal. */
export interface InsightGoalDraft {
  /** Absent: a new goal. */
  id?: string;
  spaceId: string;
  title: string;
  metric: string;
  target: number;
  current?: number;
  deadline: string | null;
  source: InsightGoalSource;
  product?: string | null;
  agentIds?: string[];
}

/**
 * How a goal is doing: `done` at the target, `behind` when the share of the target reached is more
 * than 15 points under the share of the time that passed, `ahead` 15 points over it. A goal with no
 * deadline or no start has no pace.
 */
export type InsightGoalPace = "done" | "ahead" | "on-track" | "behind" | "unknown";

export function insightGoalPace(
  goal: Pick<InsightGoal, "target" | "current" | "deadline" | "createdAt">,
  now: number,
): InsightGoalPace {
  if (goal.target !== 0 && goal.current >= goal.target) return "done";
  if (!goal.deadline || goal.target === 0) return "unknown";
  const start = Date.parse(goal.createdAt);
  const end = Date.parse(`${goal.deadline}T23:59:59Z`);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return "unknown";
  const time = Math.min(1, Math.max(0, (now - start) / (end - start)));
  const done = goal.current / goal.target;
  if (done - time > 0.15) return "ahead";
  if (time - done > 0.15) return "behind";
  return "on-track";
}

/** Spend and income. A Meta sync writes `spend`, a Hotmart sync `revenue` (the commissions). */
export const INSIGHT_MONEY_KINDS = ["spend", "revenue"] as const;
export type InsightMoneyKind = (typeof INSIGHT_MONEY_KINDS)[number];
export const INSIGHT_MONEY_SOURCES = ["manual", "meta", "hotmart"] as const;
export type InsightMoneySource = (typeof INSIGHT_MONEY_SOURCES)[number];

export interface InsightMoneyEntry {
  id: string;
  spaceId: string;
  /** A calendar day, `YYYY-MM-DD`, in the zone of the account that reported it. */
  date: string;
  kind: InsightMoneyKind;
  amount: number;
  /** An ISO currency code, such as USD or COP. */
  currency: string;
  /** The number of sales of a `revenue` row. */
  sales: number | null;
  product: string | null;
  source: InsightMoneySource;
  note: string | null;
  updatedAt: string;
}

export interface InsightMoneyDraft {
  spaceId: string;
  date: string;
  kind: InsightMoneyKind;
  amount: number;
  currency: string;
  sales?: number | null;
  product?: string | null;
  note?: string | null;
}

/** Whether the host can read a data source of a space, and when it last did. */
export interface InsightDataSource {
  spaceId: string;
  kind: "meta" | "hotmart" | "motion";
  state: "ready" | "missing" | "error";
  /** What is missing or what failed, in the host's words. Never a secret. */
  detail: string | null;
  syncedAt: string | null;
}

export const INSIGHT_ALERT_KINDS = ["spend-no-sales", "goal-behind", "sync-failed"] as const;
export type InsightAlertKind = (typeof INSIGHT_ALERT_KINDS)[number];

/** Something the owner should look at. It shows in Needs you until it is dismissed or no longer true. */
export interface InsightAlert {
  id: string;
  spaceId: string;
  kind: InsightAlertKind;
  text: string;
  createdAt: string;
}

/** One agent's cost in the report's period. Money is US dollars at API list prices, not plan charges. */
export interface InsightAgentCost {
  agentId: string;
  spaceId: string;
  costUsd: number;
  tokens: number;
  turns: number;
  /** Turns that cost something and left no message: no answer, no report. */
  idleTurns: number;
  idleCostUsd: number;
  /** The cost of the side calls: the channel gate, the reply condenser and memory reviews. */
  sideCostUsd: number;
  /** The cost of routine runs. */
  routineCostUsd: number;
  /** The cost of each day of the report, oldest first. */
  daily: number[];
}

export interface InsightCosts {
  /** The days of the report, `YYYY-MM-DD` in the reader's zone, oldest first. */
  days: string[];
  totalUsd: number;
  sideUsd: number;
  idleUsd: number;
  /** The last 7 days and the 7 before, for the weekly line of the briefing. */
  weekUsd: number;
  previousWeekUsd: number;
  agents: InsightAgentCost[];
}

export interface InsightBriefingSettings {
  enabled: boolean;
  /** The local time of the morning message, `HH:MM`. */
  time: string;
  /** The owner's zone. Empty: the zone the first reader of the view sent. */
  timeZone: string;
  language: "es" | "en";
  /** One briefing of every space. */
  allSpaces: boolean;
  /** A briefing of its own for each of these spaces. */
  spaceIds: string[];
  /** The routine reports that the briefing replaces: they are paused while it is on, never deleted. */
  replaceRoutineIds: string[];
  /** Spend with no sale for this many days raises an alert. */
  alertDays: number;
  /** Spend under this amount in those days raises none. */
  alertMinSpend: number;
}

export const DEFAULT_INSIGHT_BRIEFING: InsightBriefingSettings = {
  enabled: true,
  time: "08:00",
  timeZone: "",
  language: "es",
  allSpaces: true,
  spaceIds: [],
  replaceRoutineIds: [],
  alertDays: 3,
  alertMinSpend: 20,
};

/** A routine that looks like a report, which the briefing can replace. */
export interface InsightRoutineReport {
  routineId: string;
  agentId: string;
  name: string;
  active: boolean;
}

export interface InsightBriefingState {
  settings: InsightBriefingSettings;
  /** The channel the briefings go to, once there was one. */
  channelId: string | null;
  lastSentAt: string | null;
  lastText: string | null;
  routines: InsightRoutineReport[];
}

export interface WorkspaceInsightInput {
  /** The days the report covers, ending today: 1 to 92. Default 7. */
  days?: number;
  /** The reader's zone, for the days of the report, and the briefing's zone while none is saved. */
  timeZone?: string;
  /** The reader's language, the briefing's language while none is saved. */
  language?: string;
}

export interface WorkspaceInsight {
  at: number;
  days: number;
  timeZone: string;
  goals: InsightGoal[];
  costs: InsightCosts;
  money: InsightMoneyEntry[];
  sources: InsightDataSource[];
  alerts: InsightAlert[];
  briefing: InsightBriefingState;
}

export type WorkspaceInsightAction =
  | { kind: "goal-save"; goal: InsightGoalDraft }
  | { kind: "goal-remove"; goalId: string }
  | { kind: "goal-progress"; goalId: string; value: number; note?: string }
  | { kind: "money-add"; entry: InsightMoneyDraft }
  | { kind: "money-remove"; entryId: string }
  /** Reads Meta and Hotmart again now, for one space or all. */
  | { kind: "money-sync"; spaceId?: string }
  | { kind: "alert-dismiss"; alertId: string }
  | { kind: "briefing-save"; settings: InsightBriefingSettings }
  /** Sends the briefing now: every space, or one. */
  | { kind: "briefing-send"; spaceId?: string };

/** Where the time of one request went. Times are epoch milliseconds; an open segment has no end. */
export const INSIGHT_SLOW_KINDS = ["queued", "running", "teammate", "owner", "blocked", "failed"] as const;
export type InsightSlowKind = (typeof INSIGHT_SLOW_KINDS)[number];

export interface InsightSlowSegment {
  kind: InsightSlowKind;
  startAt: number;
  endAt: number | null;
  /** Who or what it waited for, such as a teammate's name or a question. */
  detail: string | null;
}

export interface WorkspaceWhySlowInput {
  agentId: string;
  /** The request: a message of a channel. Absent: the agent's latest work. */
  channelId?: string;
  messageId?: string;
}

export interface WorkspaceWhySlow {
  agentId: string;
  /** When the request reached the agent, or null when the host finds none. */
  startedAt: number | null;
  /** When the work ended, or null while it goes on. */
  endedAt: number | null;
  /** The other requests that wait before this one now. */
  queueAhead: number;
  segments: InsightSlowSegment[];
}

const DATE = /^\d{4}-\d{2}-\d{2}$/u;
const TIME = /^(?:[01]\d|2[0-3]):[0-5]\d$/u;
const CURRENCY = /^[A-Z]{3,8}$/u;

function isDay(value: unknown): value is string {
  return typeof value === "string" && DATE.test(value) && Number.isFinite(Date.parse(`${value}T00:00:00Z`));
}
function isTime(value: unknown): value is string {
  return isBoundedString(value, 64) && Number.isFinite(Date.parse(value));
}
function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
function isMoney(value: unknown): value is number {
  return isFiniteNumber(value) && value >= 0 && value < 1e12;
}
function isValue(value: unknown): value is number {
  return isFiniteNumber(value) && Math.abs(value) < 1e12;
}
function text(value: unknown, limit: number, error: string): string {
  if (!isBoundedString(value, limit) || value.trim() === "") throw new Error(error);
  return value.trim();
}
function nullableText(value: unknown, limit: number, error: string): string | null {
  if (value === undefined || value === null) return null;
  if (!isBoundedString(value, limit)) throw new Error(error);
  return value.trim() === "" ? null : value.trim();
}
function ids(value: unknown, limit: number, error: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > limit || !value.every(isIdentifier)) throw new Error(error);
  return [...new Set(value)];
}
function list<T>(value: unknown, limit: number, decode: (item: unknown) => T, error: string): T[] {
  if (!Array.isArray(value) || value.length > limit) throw new Error(error);
  return value.map(decode);
}
function record(value: unknown, error: string): DynamicRecord {
  if (!isDynamicRecord(value)) throw new Error(error);
  return value;
}

export function decodeInsightGoal(value: unknown): InsightGoal {
  const error = "Invalid goal.";
  const goal = record(value, error);
  if (
    !isIdentifier(goal.id) ||
    !isIdentifier(goal.spaceId) ||
    !isValue(goal.target) ||
    !isValue(goal.current) ||
    !(goal.deadline === null || isDay(goal.deadline)) ||
    !isOneOf(INSIGHT_GOAL_SOURCES, goal.source) ||
    !isTime(goal.createdAt) ||
    !isTime(goal.updatedAt) ||
    !(goal.costUsd === undefined || isMoney(goal.costUsd))
  )
    throw new Error(error);
  return {
    id: goal.id,
    spaceId: goal.spaceId,
    title: text(goal.title, INSIGHT_GOAL_TITLE_LIMIT, error),
    metric: text(goal.metric, INSIGHT_GOAL_METRIC_LIMIT, error),
    target: goal.target,
    current: goal.current,
    deadline: goal.deadline,
    source: goal.source,
    product: nullableText(goal.product, INSIGHT_PRODUCT_LIMIT, error),
    agentIds: ids(goal.agentIds, INSIGHT_GOAL_TEAM_LIMIT, error),
    note: nullableText(goal.note, INSIGHT_NOTE_LIMIT, error),
    createdAt: goal.createdAt,
    updatedAt: goal.updatedAt,
    history: list(
      goal.history,
      INSIGHT_GOAL_HISTORY_LIMIT,
      (item) => {
        const point = record(item, error);
        if (!isDay(point.date) || !isValue(point.value)) throw new Error(error);
        return { date: point.date, value: point.value };
      },
      error,
    ),
    ...(goal.costUsd === undefined ? {} : { costUsd: goal.costUsd }),
  };
}

export function decodeInsightMoneyEntry(value: unknown): InsightMoneyEntry {
  const error = "Invalid money entry.";
  const entry = record(value, error);
  if (
    !isIdentifier(entry.id) ||
    !isIdentifier(entry.spaceId) ||
    !isDay(entry.date) ||
    !isOneOf(INSIGHT_MONEY_KINDS, entry.kind) ||
    !isMoney(entry.amount) ||
    typeof entry.currency !== "string" ||
    !CURRENCY.test(entry.currency) ||
    !(entry.sales === null || isCount(entry.sales)) ||
    !isOneOf(INSIGHT_MONEY_SOURCES, entry.source) ||
    !isTime(entry.updatedAt)
  )
    throw new Error(error);
  return {
    id: entry.id,
    spaceId: entry.spaceId,
    date: entry.date,
    kind: entry.kind,
    amount: entry.amount,
    currency: entry.currency,
    sales: entry.sales,
    product: nullableText(entry.product, INSIGHT_PRODUCT_LIMIT, error),
    source: entry.source,
    note: nullableText(entry.note, INSIGHT_NOTE_LIMIT, error),
    updatedAt: entry.updatedAt,
  };
}

export function decodeInsightDataSource(value: unknown): InsightDataSource {
  const error = "Invalid data source.";
  const source = record(value, error);
  if (
    !isIdentifier(source.spaceId) ||
    !isOneOf(["meta", "hotmart", "motion"] as const, source.kind) ||
    !isOneOf(["ready", "missing", "error"] as const, source.state) ||
    !isNullableBoundedString(source.detail, INSIGHT_NOTE_LIMIT) ||
    !(source.syncedAt === null || isTime(source.syncedAt))
  )
    throw new Error(error);
  return {
    spaceId: source.spaceId,
    kind: source.kind,
    state: source.state,
    detail: source.detail,
    syncedAt: source.syncedAt,
  };
}

function decodeAlert(value: unknown): InsightAlert {
  const error = "Invalid alert.";
  const alert = record(value, error);
  if (
    !isIdentifier(alert.id) ||
    !isIdentifier(alert.spaceId) ||
    !isOneOf(INSIGHT_ALERT_KINDS, alert.kind) ||
    !isTime(alert.createdAt)
  )
    throw new Error(error);
  return {
    id: alert.id,
    spaceId: alert.spaceId,
    kind: alert.kind,
    text: text(alert.text, INSIGHT_ALERT_TEXT_LIMIT, error),
    createdAt: alert.createdAt,
  };
}

function decodeAgentCost(value: unknown, days: number): InsightAgentCost {
  const error = "Invalid agent cost.";
  const cost = record(value, error);
  if (
    !isIdentifier(cost.agentId) ||
    !isIdentifier(cost.spaceId) ||
    !isMoney(cost.costUsd) ||
    !isCount(cost.tokens) ||
    !isCount(cost.turns) ||
    !isCount(cost.idleTurns) ||
    !isMoney(cost.idleCostUsd) ||
    !isMoney(cost.sideCostUsd) ||
    !isMoney(cost.routineCostUsd)
  )
    throw new Error(error);
  const daily = list(
    cost.daily,
    days,
    (item) => {
      if (!isMoney(item)) throw new Error(error);
      return item;
    },
    error,
  );
  return {
    agentId: cost.agentId,
    spaceId: cost.spaceId,
    costUsd: cost.costUsd,
    tokens: cost.tokens,
    turns: cost.turns,
    idleTurns: cost.idleTurns,
    idleCostUsd: cost.idleCostUsd,
    sideCostUsd: cost.sideCostUsd,
    routineCostUsd: cost.routineCostUsd,
    daily,
  };
}

function decodeCosts(value: unknown): InsightCosts {
  const error = "Invalid costs.";
  const costs = record(value, error);
  const days = list(
    costs.days,
    INSIGHT_DAYS_LIMIT,
    (item) => {
      if (!isDay(item)) throw new Error(error);
      return item;
    },
    error,
  );
  if (
    !isMoney(costs.totalUsd) ||
    !isMoney(costs.sideUsd) ||
    !isMoney(costs.idleUsd) ||
    !isMoney(costs.weekUsd) ||
    !isMoney(costs.previousWeekUsd)
  )
    throw new Error(error);
  return {
    days,
    totalUsd: costs.totalUsd,
    sideUsd: costs.sideUsd,
    idleUsd: costs.idleUsd,
    weekUsd: costs.weekUsd,
    previousWeekUsd: costs.previousWeekUsd,
    agents: list(costs.agents, INSIGHT_AGENT_LIMIT, (item) => decodeAgentCost(item, days.length), error),
  };
}

/** Briefing settings from an untrusted sender. Out-of-range numbers are refused, not clamped. */
export function parseInsightBriefingSettings(value: unknown): InsightBriefingSettings {
  const error = "Invalid briefing settings.";
  const settings = record(value, error);
  if (
    typeof settings.enabled !== "boolean" ||
    typeof settings.time !== "string" ||
    !TIME.test(settings.time) ||
    !isBoundedString(settings.timeZone, 64) ||
    !isOneOf(["es", "en"] as const, settings.language) ||
    typeof settings.allSpaces !== "boolean" ||
    !isCount(settings.alertDays) ||
    settings.alertDays < 1 ||
    settings.alertDays > 14 ||
    !isMoney(settings.alertMinSpend)
  )
    throw new Error(error);
  return {
    enabled: settings.enabled,
    time: settings.time,
    timeZone: settings.timeZone,
    language: settings.language,
    allSpaces: settings.allSpaces,
    spaceIds: ids(settings.spaceIds, INSIGHT_SPACE_LIMIT, error),
    replaceRoutineIds: ids(settings.replaceRoutineIds, INSIGHT_ROUTINE_LIMIT, error),
    alertDays: settings.alertDays,
    alertMinSpend: settings.alertMinSpend,
  };
}

function decodeBriefing(value: unknown): InsightBriefingState {
  const error = "Invalid briefing.";
  const briefing = record(value, error);
  if (
    !(briefing.channelId === null || isIdentifier(briefing.channelId)) ||
    !(briefing.lastSentAt === null || isTime(briefing.lastSentAt)) ||
    !isNullableBoundedString(briefing.lastText, INSIGHT_BRIEFING_TEXT_LIMIT)
  )
    throw new Error(error);
  return {
    settings: parseInsightBriefingSettings(briefing.settings),
    channelId: briefing.channelId,
    lastSentAt: briefing.lastSentAt,
    lastText: briefing.lastText,
    routines: list(
      briefing.routines,
      INSIGHT_ROUTINE_LIMIT,
      (item) => {
        const routine = record(item, error);
        if (!isIdentifier(routine.routineId) || !isIdentifier(routine.agentId) || typeof routine.active !== "boolean")
          throw new Error(error);
        return {
          routineId: routine.routineId,
          agentId: routine.agentId,
          name: text(routine.name, 200, error),
          active: routine.active,
        };
      },
      error,
    ),
  };
}

export function decodeWorkspaceInsight(value: unknown): WorkspaceInsight {
  const error = "Invalid insight report.";
  const report = record(value, error);
  if (
    !isCount(report.at) ||
    !isCount(report.days) ||
    report.days < 1 ||
    report.days > INSIGHT_DAYS_LIMIT ||
    !isBoundedString(report.timeZone, 64)
  )
    throw new Error(error);
  return {
    at: report.at,
    days: report.days,
    timeZone: report.timeZone,
    goals: list(report.goals, INSIGHT_GOAL_LIMIT, decodeInsightGoal, error),
    costs: decodeCosts(report.costs),
    money: list(report.money, INSIGHT_MONEY_ENTRY_LIMIT, decodeInsightMoneyEntry, error),
    sources: list(report.sources, INSIGHT_SPACE_LIMIT * 3, decodeInsightDataSource, error),
    alerts: list(report.alerts, INSIGHT_ALERT_LIMIT, decodeAlert, error),
    briefing: decodeBriefing(report.briefing),
  };
}

export function parseWorkspaceInsightInput(value: unknown): WorkspaceInsightInput {
  const error = "Invalid insight request.";
  const input = record(value, error);
  if (
    (input.days !== undefined && (!isCount(input.days) || input.days < 1 || input.days > INSIGHT_DAYS_LIMIT)) ||
    (input.timeZone !== undefined && !isBoundedString(input.timeZone, 64)) ||
    (input.language !== undefined && !isBoundedString(input.language, 16))
  )
    throw new Error(error);
  return {
    ...(input.days === undefined ? {} : { days: input.days }),
    ...(input.timeZone === undefined ? {} : { timeZone: input.timeZone }),
    ...(input.language === undefined ? {} : { language: input.language }),
  };
}

/** A goal from a person or an agent. It throws on any value outside the limits. */
export function parseInsightGoalDraft(value: unknown): InsightGoalDraft {
  const error = "Invalid goal.";
  const goal = record(value, error);
  if (
    (goal.id !== undefined && !isIdentifier(goal.id)) ||
    !isIdentifier(goal.spaceId) ||
    !isValue(goal.target) ||
    (goal.current !== undefined && !isValue(goal.current)) ||
    !(goal.deadline === null || isDay(goal.deadline)) ||
    !isOneOf(INSIGHT_GOAL_SOURCES, goal.source)
  )
    throw new Error(error);
  return {
    ...(goal.id === undefined ? {} : { id: goal.id }),
    spaceId: goal.spaceId,
    title: text(goal.title, INSIGHT_GOAL_TITLE_LIMIT, error),
    metric: text(goal.metric, INSIGHT_GOAL_METRIC_LIMIT, error),
    target: goal.target,
    ...(goal.current === undefined ? {} : { current: goal.current }),
    deadline: goal.deadline,
    source: goal.source,
    product: nullableText(goal.product, INSIGHT_PRODUCT_LIMIT, error),
    agentIds: ids(goal.agentIds, INSIGHT_GOAL_TEAM_LIMIT, error),
  };
}

function parseMoneyDraft(value: unknown): InsightMoneyDraft {
  const error = "Invalid money entry.";
  const entry = record(value, error);
  if (
    !isIdentifier(entry.spaceId) ||
    !isDay(entry.date) ||
    !isOneOf(INSIGHT_MONEY_KINDS, entry.kind) ||
    !isMoney(entry.amount) ||
    typeof entry.currency !== "string" ||
    !CURRENCY.test(entry.currency.trim().toUpperCase()) ||
    !(entry.sales === undefined || entry.sales === null || isCount(entry.sales))
  )
    throw new Error(error);
  return {
    spaceId: entry.spaceId,
    date: entry.date,
    kind: entry.kind,
    amount: entry.amount,
    currency: entry.currency.trim().toUpperCase(),
    sales: entry.sales ?? null,
    product: nullableText(entry.product, INSIGHT_PRODUCT_LIMIT, error),
    note: nullableText(entry.note, INSIGHT_NOTE_LIMIT, error),
  };
}

/** An insight action from an untrusted sender. It throws on any value outside the limits. */
export function parseWorkspaceInsightAction(value: unknown): WorkspaceInsightAction {
  const error = "Invalid insight action.";
  const action = record(value, error);
  switch (action.kind) {
    case "goal-save":
      return { kind: "goal-save", goal: parseInsightGoalDraft(action.goal) };
    case "goal-remove":
      if (!isIdentifier(action.goalId)) throw new Error(error);
      return { kind: "goal-remove", goalId: action.goalId };
    case "goal-progress": {
      if (!isIdentifier(action.goalId) || !isValue(action.value)) throw new Error(error);
      const note = nullableText(action.note, INSIGHT_NOTE_LIMIT, error);
      return { kind: "goal-progress", goalId: action.goalId, value: action.value, ...(note ? { note } : {}) };
    }
    case "money-add":
      return { kind: "money-add", entry: parseMoneyDraft(action.entry) };
    case "money-remove":
      if (!isIdentifier(action.entryId)) throw new Error(error);
      return { kind: "money-remove", entryId: action.entryId };
    case "money-sync":
      if (action.spaceId !== undefined && !isIdentifier(action.spaceId)) throw new Error(error);
      return action.spaceId === undefined ? { kind: "money-sync" } : { kind: "money-sync", spaceId: action.spaceId };
    case "alert-dismiss":
      if (!isIdentifier(action.alertId)) throw new Error(error);
      return { kind: "alert-dismiss", alertId: action.alertId };
    case "briefing-save":
      return { kind: "briefing-save", settings: parseInsightBriefingSettings(action.settings) };
    case "briefing-send":
      if (action.spaceId !== undefined && !isIdentifier(action.spaceId)) throw new Error(error);
      return action.spaceId === undefined
        ? { kind: "briefing-send" }
        : { kind: "briefing-send", spaceId: action.spaceId };
    default:
      throw new Error(error);
  }
}

export function parseWorkspaceWhySlowInput(value: unknown): WorkspaceWhySlowInput {
  const error = "Invalid request.";
  const input = record(value, error);
  if (
    !isIdentifier(input.agentId) ||
    (input.channelId !== undefined && !isIdentifier(input.channelId)) ||
    (input.messageId !== undefined && !isIdentifier(input.messageId))
  )
    throw new Error(error);
  return {
    agentId: input.agentId,
    ...(input.channelId === undefined ? {} : { channelId: input.channelId }),
    ...(input.messageId === undefined ? {} : { messageId: input.messageId }),
  };
}

export function decodeWorkspaceWhySlow(value: unknown): WorkspaceWhySlow {
  const error = "Invalid timeline.";
  const slow = record(value, error);
  if (
    !isIdentifier(slow.agentId) ||
    !(slow.startedAt === null || isCount(slow.startedAt)) ||
    !(slow.endedAt === null || isCount(slow.endedAt)) ||
    !isCount(slow.queueAhead)
  )
    throw new Error(error);
  return {
    agentId: slow.agentId,
    startedAt: slow.startedAt,
    endedAt: slow.endedAt,
    queueAhead: slow.queueAhead,
    segments: list(
      slow.segments,
      INSIGHT_SLOW_SEGMENT_LIMIT,
      (item) => {
        const segment = record(item, error);
        if (
          !isOneOf(INSIGHT_SLOW_KINDS, segment.kind) ||
          !isCount(segment.startAt) ||
          !(segment.endAt === null || isCount(segment.endAt)) ||
          !isNullableBoundedString(segment.detail, INSIGHT_NOTE_LIMIT)
        )
          throw new Error(error);
        return { kind: segment.kind, startAt: segment.startAt, endAt: segment.endAt, detail: segment.detail };
      },
      error,
    ),
  };
}
