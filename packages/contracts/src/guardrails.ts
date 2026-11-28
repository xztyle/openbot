/**
 * Guardrails: the hard stops on how much work agents do, and the watch on how they do it.
 *
 * - Budgets: limits per agent and per space on turns, tokens and estimated cost per local day, and on
 *   the share of a subscription's usage window. A warning tells the owner at `warnPercent`; at 100% the
 *   agent or space pauses until the day or the window resets, or until the owner resumes it.
 * - Run breakers: the most steps, tokens and minutes of one turn, and of one routine run.
 * - The stuck watch: repeated identical tool calls, and two agents that message each other with no
 *   other work. It nudges the agent first, then stops the turn and tells the owner.
 * - Injection defence: after a turn read content from the web, a browser, an email or a webhook, a
 *   cheap monitor model checks each high-impact action against the task before it runs.
 * - The subscription meter: the usage windows of each provider account, a forecast of when each runs
 *   out, and the automatic move of Claude agents to Codex when their subscription is out: the order is
 *   the Claude subscription, then the Codex subscription, then the Codex credits.
 *
 * The host enforces all of it; the owner reads and changes it on the Trust page.
 */

import { isBoundedString, isIdentifier } from "./ipc-bounded-values";
import { isDynamicRecord, isOneOf } from "./runtime-values";

export const GUARDRAIL_LIMIT_KEYS = ["turnsPerDay", "tokensPerDay", "costUsdPerDay", "windowSharePercent"] as const;
export type GuardrailLimitKey = (typeof GUARDRAIL_LIMIT_KEYS)[number];

/** A limit per key. `null` is no limit; an absent key in an override keeps the default. */
export type GuardrailLimits = Partial<Record<GuardrailLimitKey, number | null>>;
export type GuardrailFullLimits = Record<GuardrailLimitKey, number | null>;

export const GUARDRAIL_RUN_KEYS = ["maxSteps", "maxTokens", "maxMinutes"] as const;
export type GuardrailRunKey = (typeof GUARDRAIL_RUN_KEYS)[number];
/** The circuit breaker of one turn or one routine run. `null` is no limit. */
export type GuardrailRunLimits = Record<GuardrailRunKey, number | null>;

export const GUARDRAIL_MODEL_TIERS = ["small", "medium", "large"] as const;
export type GuardrailModelTier = (typeof GUARDRAIL_MODEL_TIERS)[number];

export interface GuardrailFailover {
  /**
   * Moves agents off a subscription that is out: a turn failed with the provider's usage limit, or the
   * meter shows a window at `thresholdPercent`. Off: only the agent's own backup models move it.
   */
  enabled: boolean;
  /** A window used to this percent, in every account of the pool, counts as out. 100 by default. */
  thresholdPercent: number;
  /** The model tiers that move: Sonnet-class (`medium`) and Opus-class (`large`) by default. */
  tiers: GuardrailModelTier[];
  /** Agents pinned to their model: they never move. */
  pinnedAgentIds: string[];
  /** Also move to the Claude API key, which costs money per token. Off by default. */
  allowApiKey: boolean;
  /** The order of models an agent moves to. Unset: Codex's default model, then the newest. */
  chains?: GuardrailFailoverChains;
}

/** One model of a fallback order. */
export interface GuardrailChainChoice {
  provider: GuardrailProvider;
  model: string;
  effort?: string;
}

export interface GuardrailFailoverChains {
  /** The order for a model with none of its own. */
  default?: GuardrailChainChoice[];
  /** The order of one main model, by its id. */
  byModel?: Record<string, GuardrailChainChoice[]>;
}

export const GUARDRAIL_CHAIN_LIMIT = 8;

export const GUARDRAIL_PROVIDERS = ["claude", "codex"] as const;
export type GuardrailProvider = (typeof GUARDRAIL_PROVIDERS)[number];

/** A provider that the owner turned off for a while: the whole workspace, or one space. */
export interface GuardrailDisabledProvider {
  provider: GuardrailProvider;
  /** Absent: the whole workspace. */
  spaceId?: string;
  /** ISO time at which it comes back. Absent: until the owner turns it on again. */
  until?: string;
}

export interface GuardrailPolicy {
  version: 1;
  /** Off: nothing pauses, breaks or blocks; usage still shows. */
  enabled: boolean;
  /** The percent of a limit at which the owner gets a warning, once a day per limit. */
  warnPercent: number;
  agentDefaults: GuardrailFullLimits;
  spaceDefaults: GuardrailFullLimits;
  agents: Record<string, GuardrailLimits>;
  spaces: Record<string, GuardrailLimits>;
  turn: GuardrailRunLimits;
  routine: GuardrailRunLimits;
  stuck: {
    enabled: boolean;
    /** Identical calls with the same result before a nudge. The turn stops at twice this. */
    repeats: number;
    /** Messages between two agents, with no other work, before a nudge. Both pause at twice this. */
    pingPong: number;
  };
  injection: { enabled: boolean };
  /** A money approval that nobody answered expires after these hours. */
  moneyApprovalHours: number;
  failover: GuardrailFailover;
  /** Providers that the owner turned off. Absent: none. */
  disabledProviders?: GuardrailDisabledProvider[];
}

/**
 * The defaults, set above the busiest real work seen on the live host in the 14 days to 2026-11-21:
 * at most 130 turns, about 700M tokens and $115 (list price) for one agent in one day; 691 turns,
 * 1.53B tokens and $426 for one space in one day; 360 model steps, 239M tokens and 153 minutes for one
 * turn (94 minutes for a routine run); about 58% of a busy five-hour window for one agent; and 13
 * messages both ways between two agents in 30 minutes. No
 * warning would have fired on those days.
 */
export const DEFAULT_GUARDRAIL_POLICY: GuardrailPolicy = {
  version: 1,
  enabled: true,
  warnPercent: 80,
  agentDefaults: { turnsPerDay: 200, tokensPerDay: 1_000_000_000, costUsdPerDay: 150, windowSharePercent: 75 },
  spaceDefaults: { turnsPerDay: 1_000, tokensPerDay: 2_500_000_000, costUsdPerDay: 600, windowSharePercent: null },
  agents: {},
  spaces: {},
  turn: { maxSteps: 500, maxTokens: 400_000_000, maxMinutes: 240 },
  routine: { maxSteps: 400, maxTokens: 300_000_000, maxMinutes: 150 },
  stuck: { enabled: true, repeats: 5, pingPong: 16 },
  injection: { enabled: true },
  moneyApprovalHours: 24,
  failover: {
    enabled: true,
    thresholdPercent: 100,
    tiers: ["medium", "large"],
    pinnedAgentIds: [],
    allowApiKey: false,
  },
};

export const GUARDRAIL_BOUNDS = {
  turnsPerDay: 100_000,
  tokensPerDay: 1e13,
  costUsdPerDay: 1e6,
  windowSharePercent: 100,
  maxSteps: 100_000,
  maxTokens: 1e12,
  maxMinutes: 7 * 24 * 60,
  overrides: 500,
  pinned: 500,
} as const;

export const GUARDRAIL_PAUSE_REASONS = ["turns", "tokens", "cost", "window", "loop"] as const;
export type GuardrailPauseReason = (typeof GUARDRAIL_PAUSE_REASONS)[number];

export const GUARDRAIL_PAUSE_REASON_LIMIT: Record<GuardrailPauseReason, GuardrailLimitKey | null> = {
  turns: "turnsPerDay",
  tokens: "tokensPerDay",
  cost: "costUsdPerDay",
  window: "windowSharePercent",
  loop: null,
};

/**
 * A paused agent or space. Its owner messages still run; agent, routine, Motion and event-check work
 * waits. `until` is when it resumes by itself (the next local day, a window reset, or the end of a loop
 * hold), as an ISO time; null waits for the owner.
 */
export interface GuardrailPause {
  scope: "agent" | "space";
  id: string;
  reason: GuardrailPauseReason;
  since: string;
  until: string | null;
  /** One line for the owner, such as "201 of 200 turns today". */
  detail: string;
}

export const GUARDRAIL_EVENT_KINDS = [
  "budget-warn",
  "budget-pause",
  "budget-resume",
  "breaker",
  "stuck-nudge",
  "stuck-stop",
  "loop-nudge",
  "loop-stop",
  "injection-blocked",
  "injection-checked",
  "money-expired",
  "failover",
  "failover-return",
  "blocked-allowed",
] as const;
export type GuardrailEventKind = (typeof GUARDRAIL_EVENT_KINDS)[number];

export const GUARDRAIL_TEXT_LIMIT = 300;
/** The longest reason or action of a blocked action's details. */
export const GUARDRAIL_DETAIL_LIMIT = 1_200;

/**
 * What the injection monitor blocked, in full: the action (its label and the command or call), the
 * sources of untrusted text that the turn read, and the monitor's whole reason. `allowedAt`: the
 * owner allowed it once, so the agent may run the same action again.
 */
export interface GuardrailBlockedAction {
  label: string;
  action: string;
  sources: string[];
  reason: string;
  allowedAt?: string;
}

/** One thing the guardrails did, newest first in a view. */
export interface GuardrailEvent {
  id: string;
  at: string;
  kind: GuardrailEventKind;
  agentId?: string;
  spaceId?: string;
  threadId?: string;
  turnId?: string;
  summary: string;
  /** An `injection-blocked` event of a host that keeps the details. */
  blocked?: GuardrailBlockedAction;
  /** A `blocked-allowed` event: the id of the `injection-blocked` event that the owner allowed. */
  ref?: string;
}

export function isGuardrailBlockedAction(value: unknown): value is GuardrailBlockedAction {
  return (
    isDynamicRecord(value) &&
    isBoundedString(value.label, GUARDRAIL_TEXT_LIMIT) &&
    isBoundedString(value.action, GUARDRAIL_DETAIL_LIMIT) &&
    Array.isArray(value.sources) &&
    value.sources.length <= 8 &&
    value.sources.every((source) => isBoundedString(source, 32)) &&
    isBoundedString(value.reason, GUARDRAIL_DETAIL_LIMIT) &&
    (value.allowedAt === undefined || isBoundedString(value.allowedAt, 64))
  );
}

/** Today's work of one agent or space against its limits. */
export interface GuardrailUsageRow {
  scope: "agent" | "space";
  id: string;
  turns: number;
  tokens: number;
  costUsd: number;
  /** The share of the agent's subscription window it used, when a reading exists. */
  windowSharePercent: number | null;
  limits: GuardrailFullLimits;
  state: "ok" | "warn" | "paused";
}

/** One usage window of an account, with the forecast of when it runs out. Times are epoch seconds. */
export interface SubscriptionWindowMeter {
  /** `short` is a window of a day or less, such as five hours; `long` is longer, such as a week. */
  kind: "short" | "long" | "other";
  usedPercent: number;
  windowDurationMins: number | null;
  resetsAt: number | null;
  /** When it reaches 100% at the pace since it started, if that is before its reset. */
  exhaustsAt: number | null;
}

export interface SubscriptionPoolMeter {
  provider: string;
  accountId: string;
  label?: string;
  pooled: boolean;
  /** The account that the pool, or the agents, use now. */
  inUse: boolean;
  windows: SubscriptionWindowMeter[];
  /** A window is at the failover threshold and no paid credits carry the account: it runs no turns. */
  nearlyExhausted: boolean;
  /**
   * Codex: the plan's windows are used up, and the account runs on its paid credits. Absent from an
   * older host.
   */
  onCredits?: boolean;
  /** Codex: whether paid credits remain. Absent when the provider did not say. */
  creditsLeft?: boolean;
  /** Codex: the paid credits left, rounded. Absent when unknown or unlimited. */
  creditBalance?: number;
  /** Codex: the unused usage resets of the account. Atelier never spends one by itself. */
  resetCredits?: number;
  /** Agents on this account now. */
  agents: number;
}

/**
 * The steps of the failover, in order: the Claude subscription, the Codex subscription, the Codex
 * credits. `none`: no step has room left, and the agent waits for a window to reset.
 */
export const FAILOVER_STEPS = ["claude", "codex-plan", "codex-credits", "none"] as const;
export type FailoverStep = (typeof FAILOVER_STEPS)[number];

/** The step that one agent runs on now. Only the agents of a provider in the order have one. */
export interface GuardrailFailoverStepRow {
  agentId: string;
  step: FailoverStep;
}

/** An agent that the failover moved, and where it goes back to. */
export interface GuardrailFailoverRow {
  agentId: string;
  from: { provider: string; model: string };
  to: { provider: string; model: string };
  since: string;
}

export interface GuardrailsView {
  policy: GuardrailPolicy;
  /** The local day of the usage, as YYYY-MM-DD. */
  day: string;
  usage: GuardrailUsageRow[];
  pauses: GuardrailPause[];
  meter: SubscriptionPoolMeter[];
  failovers: GuardrailFailoverRow[];
  /** The models the owner can put in a fallback order. Absent from an older host. */
  models?: { id: string; name: string; provider: GuardrailProvider }[];
  /** The failover step of each Claude and Codex agent. Absent from an older host. */
  steps?: GuardrailFailoverStepRow[];
  /** The newest events, at most 100. */
  events: GuardrailEvent[];
  /** The events of the last seven days by kind: caught injections, stuck stops, pauses. */
  kpis: Partial<Record<GuardrailEventKind, number>>;
}

export const GUARDRAIL_VIEW_LIMITS = {
  usage: 1_000,
  pauses: 1_000,
  meter: 64,
  failovers: 500,
  steps: 1_000,
  events: 100,
} as const;

function finite(value: unknown, max: number): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= max ? value : null;
}

function readLimit(value: unknown, key: GuardrailLimitKey | GuardrailRunKey): number | null | undefined {
  if (value === null) return null;
  const number = finite(value, GUARDRAIL_BOUNDS[key]);
  return number === null ? undefined : number;
}

function readFullLimits(value: unknown, fallback: GuardrailFullLimits): GuardrailFullLimits {
  const record = isDynamicRecord(value) ? value : {};
  const limits = { ...fallback };
  for (const key of GUARDRAIL_LIMIT_KEYS) {
    const read = readLimit(record[key], key);
    if (read !== undefined) limits[key] = read;
  }
  return limits;
}

function readOverrides(value: unknown): Record<string, GuardrailLimits> {
  if (!isDynamicRecord(value)) return {};
  const result: Record<string, GuardrailLimits> = {};
  for (const [id, entry] of Object.entries(value).slice(0, GUARDRAIL_BOUNDS.overrides)) {
    if (!isIdentifier(id) || !isDynamicRecord(entry)) continue;
    const limits: GuardrailLimits = {};
    for (const key of GUARDRAIL_LIMIT_KEYS) {
      const read = readLimit(entry[key], key);
      if (read !== undefined) limits[key] = read;
    }
    if (Object.keys(limits).length > 0) result[id] = limits;
  }
  return result;
}

function readRun(value: unknown, fallback: GuardrailRunLimits): GuardrailRunLimits {
  const record = isDynamicRecord(value) ? value : {};
  const limits = { ...fallback };
  for (const key of GUARDRAIL_RUN_KEYS) {
    const read = readLimit(record[key], key);
    if (read !== undefined) limits[key] = read;
  }
  return limits;
}

function integer(value: unknown, min: number, max: number, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max ? value : fallback;
}

function flag(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

/** A policy from a file or the wire, with each missing or invalid value at its default. Null: not an object. */
export function normalizeGuardrailPolicy(value: unknown): GuardrailPolicy | null {
  if (!isDynamicRecord(value)) return null;
  const base = DEFAULT_GUARDRAIL_POLICY;
  const stuck = isDynamicRecord(value.stuck) ? value.stuck : {};
  const injection = isDynamicRecord(value.injection) ? value.injection : {};
  const failover = isDynamicRecord(value.failover) ? value.failover : {};
  const tiers = Array.isArray(failover.tiers)
    ? [...new Set(failover.tiers.filter((tier) => isOneOf(GUARDRAIL_MODEL_TIERS, tier)))]
    : base.failover.tiers;
  const pinned = Array.isArray(failover.pinnedAgentIds)
    ? [...new Set(failover.pinnedAgentIds.filter(isIdentifier))].slice(0, GUARDRAIL_BOUNDS.pinned)
    : [];
  const readChain = (raw: unknown): GuardrailChainChoice[] | undefined => {
    if (!Array.isArray(raw)) return undefined;
    const chain: GuardrailChainChoice[] = [];
    for (const entry of raw.slice(0, GUARDRAIL_CHAIN_LIMIT)) {
      if (!isDynamicRecord(entry) || !isOneOf(GUARDRAIL_PROVIDERS, entry.provider)) continue;
      if (typeof entry.model !== "string" || !/^[\w.:/[\]-]{1,200}$/u.test(entry.model)) continue;
      const effort = typeof entry.effort === "string" && /^[\w-]{1,40}$/u.test(entry.effort) ? entry.effort : undefined;
      if (!chain.some((c) => c.provider === entry.provider && c.model === entry.model))
        chain.push({ provider: entry.provider, model: entry.model, ...(effort ? { effort } : {}) });
    }
    return chain;
  };
  const rawChains = isDynamicRecord(failover.chains) ? failover.chains : {};
  const defaultChain = readChain(rawChains.default);
  const byModel: Record<string, GuardrailChainChoice[]> = {};
  if (isDynamicRecord(rawChains.byModel))
    for (const [id, raw] of Object.entries(rawChains.byModel).slice(0, 64)) {
      const chain = readChain(raw);
      if (chain?.length && /^[\w.:/[\]-]{1,200}$/u.test(id)) byModel[id] = chain;
    }
  const chains: GuardrailFailoverChains = {
    ...(defaultChain?.length ? { default: defaultChain } : {}),
    ...(Object.keys(byModel).length ? { byModel } : {}),
  };
  const disabled: GuardrailDisabledProvider[] = [];
  if (Array.isArray(value.disabledProviders))
    for (const entry of value.disabledProviders.slice(0, 64)) {
      if (!isDynamicRecord(entry) || !isOneOf(GUARDRAIL_PROVIDERS, entry.provider)) continue;
      const until =
        typeof entry.until === "string" && entry.until.length <= 64 && Number.isFinite(Date.parse(entry.until))
          ? entry.until
          : undefined;
      if (entry.until !== undefined && until === undefined) continue;
      if (entry.spaceId !== undefined && !isIdentifier(entry.spaceId)) continue;
      disabled.push({
        provider: entry.provider,
        ...(typeof entry.spaceId === "string" ? { spaceId: entry.spaceId } : {}),
        ...(until === undefined ? {} : { until }),
      });
    }
  return {
    version: 1,
    enabled: flag(value.enabled, base.enabled),
    warnPercent: integer(value.warnPercent, 10, 99, base.warnPercent),
    agentDefaults: readFullLimits(value.agentDefaults, base.agentDefaults),
    spaceDefaults: readFullLimits(value.spaceDefaults, base.spaceDefaults),
    agents: readOverrides(value.agents),
    spaces: readOverrides(value.spaces),
    turn: readRun(value.turn, base.turn),
    routine: readRun(value.routine, base.routine),
    stuck: {
      enabled: flag(stuck.enabled, base.stuck.enabled),
      repeats: integer(stuck.repeats, 2, 100, base.stuck.repeats),
      pingPong: integer(stuck.pingPong, 4, 200, base.stuck.pingPong),
    },
    injection: { enabled: flag(injection.enabled, base.injection.enabled) },
    moneyApprovalHours: integer(value.moneyApprovalHours, 1, 24 * 14, base.moneyApprovalHours),
    failover: {
      enabled: flag(failover.enabled, base.failover.enabled),
      thresholdPercent: integer(failover.thresholdPercent, 50, 100, base.failover.thresholdPercent),
      tiers,
      pinnedAgentIds: pinned,
      allowApiKey: flag(failover.allowApiKey, base.failover.allowApiKey),
      ...(Object.keys(chains).length ? { chains } : {}),
    },
    ...(disabled.length === 0 ? {} : { disabledProviders: disabled }),
  };
}

/** The limits that apply to one agent or space: its override over the default. */
export function effectiveGuardrailLimits(
  policy: GuardrailPolicy,
  scope: "agent" | "space",
  id: string,
): GuardrailFullLimits {
  const base = scope === "agent" ? policy.agentDefaults : policy.spaceDefaults;
  const own = (scope === "agent" ? policy.agents : policy.spaces)[id] ?? {};
  const limits = { ...base };
  for (const key of GUARDRAIL_LIMIT_KEYS) if (own[key] !== undefined) limits[key] = own[key] ?? null;
  return limits;
}

function isLimitRecord(value: unknown): value is GuardrailFullLimits {
  return (
    isDynamicRecord(value) &&
    GUARDRAIL_LIMIT_KEYS.every((key) => value[key] === null || finite(value[key], GUARDRAIL_BOUNDS[key]) !== null)
  );
}

function optionalId(value: unknown): boolean {
  return value === undefined || isIdentifier(value);
}

export function isGuardrailEvent(value: unknown): value is GuardrailEvent {
  return (
    isDynamicRecord(value) &&
    isIdentifier(value.id) &&
    isBoundedString(value.at, 64) &&
    isOneOf(GUARDRAIL_EVENT_KINDS, value.kind) &&
    optionalId(value.agentId) &&
    optionalId(value.spaceId) &&
    optionalId(value.threadId) &&
    optionalId(value.turnId) &&
    isBoundedString(value.summary, GUARDRAIL_TEXT_LIMIT) &&
    (value.blocked === undefined || isGuardrailBlockedAction(value.blocked)) &&
    optionalId(value.ref)
  );
}

export function isGuardrailPause(value: unknown): value is GuardrailPause {
  return (
    isDynamicRecord(value) &&
    (value.scope === "agent" || value.scope === "space") &&
    isIdentifier(value.id) &&
    isOneOf(GUARDRAIL_PAUSE_REASONS, value.reason) &&
    isBoundedString(value.since, 64) &&
    (value.until === null || isBoundedString(value.until, 64)) &&
    isBoundedString(value.detail, GUARDRAIL_TEXT_LIMIT)
  );
}

function isUsageRow(value: unknown): value is GuardrailUsageRow {
  return (
    isDynamicRecord(value) &&
    (value.scope === "agent" || value.scope === "space") &&
    isIdentifier(value.id) &&
    finite(value.turns, GUARDRAIL_BOUNDS.turnsPerDay * 10) !== null &&
    finite(value.tokens, GUARDRAIL_BOUNDS.tokensPerDay * 10) !== null &&
    finite(value.costUsd, GUARDRAIL_BOUNDS.costUsdPerDay * 10) !== null &&
    (value.windowSharePercent === null || finite(value.windowSharePercent, 1_000) !== null) &&
    isLimitRecord(value.limits) &&
    (value.state === "ok" || value.state === "warn" || value.state === "paused")
  );
}

function isWindow(value: unknown): value is SubscriptionWindowMeter {
  return (
    isDynamicRecord(value) &&
    (value.kind === "short" || value.kind === "long" || value.kind === "other") &&
    finite(value.usedPercent, 100) !== null &&
    (value.windowDurationMins === null || finite(value.windowDurationMins, 1e7) !== null) &&
    (value.resetsAt === null || finite(value.resetsAt, 1e11) !== null) &&
    (value.exhaustsAt === null || finite(value.exhaustsAt, 1e11) !== null)
  );
}

function isMeter(value: unknown): value is SubscriptionPoolMeter {
  return (
    isDynamicRecord(value) &&
    isBoundedString(value.provider, 64) &&
    isBoundedString(value.accountId, 64) &&
    (value.label === undefined || isBoundedString(value.label, 200)) &&
    typeof value.pooled === "boolean" &&
    typeof value.inUse === "boolean" &&
    Array.isArray(value.windows) &&
    value.windows.length <= 8 &&
    value.windows.every(isWindow) &&
    typeof value.nearlyExhausted === "boolean" &&
    (value.onCredits === undefined || typeof value.onCredits === "boolean") &&
    (value.creditsLeft === undefined || typeof value.creditsLeft === "boolean") &&
    (value.creditBalance === undefined || finite(value.creditBalance, 1e12) !== null) &&
    (value.resetCredits === undefined || finite(value.resetCredits, 1_000) !== null) &&
    finite(value.agents, 100_000) !== null
  );
}

function isModelRef(value: unknown): boolean {
  return isDynamicRecord(value) && isBoundedString(value.provider, 64) && isBoundedString(value.model, 200);
}

function isFailoverRow(value: unknown): value is GuardrailFailoverRow {
  return (
    isDynamicRecord(value) &&
    isIdentifier(value.agentId) &&
    isModelRef(value.from) &&
    isModelRef(value.to) &&
    isBoundedString(value.since, 64)
  );
}

function isStepRow(value: unknown): value is GuardrailFailoverStepRow {
  return isDynamicRecord(value) && isIdentifier(value.agentId) && isOneOf(FAILOVER_STEPS, value.step);
}

function readKpis(value: unknown): Partial<Record<GuardrailEventKind, number>> | null {
  if (!isDynamicRecord(value)) return null;
  const kpis: Partial<Record<GuardrailEventKind, number>> = {};
  for (const [kind, count] of Object.entries(value)) {
    const number = finite(count, 1e9);
    if (!isOneOf(GUARDRAIL_EVENT_KINDS, kind) || number === null) return null;
    kpis[kind] = number;
  }
  return kpis;
}

function bounded<T>(value: unknown, limit: number, check: (entry: unknown) => entry is T): value is T[] {
  return Array.isArray(value) && value.length <= limit && value.every(check);
}

/** A view from the wire, checked. Null when any part is malformed: a client fails closed. */
export function decodeGuardrailsView(value: unknown): GuardrailsView | null {
  if (!isDynamicRecord(value)) return null;
  const policy = normalizeGuardrailPolicy(value.policy);
  const kpis = readKpis(value.kpis);
  let steps: GuardrailFailoverStepRow[] | undefined;
  if (value.steps !== undefined) {
    if (!bounded(value.steps, GUARDRAIL_VIEW_LIMITS.steps, isStepRow)) return null;
    steps = value.steps;
  }
  let models: { id: string; name: string; provider: GuardrailProvider }[] | undefined;
  if (Array.isArray(value.models)) {
    models = value.models
      .slice(0, 64)
      .filter(
        (m): m is { id: string; name: string; provider: GuardrailProvider } =>
          isDynamicRecord(m) &&
          isBoundedString(m.id, 200) &&
          isBoundedString(m.name, 200) &&
          isOneOf(GUARDRAIL_PROVIDERS, m.provider),
      )
      .map((m) => ({ id: m.id, name: m.name, provider: m.provider }));
  }
  if (
    !policy ||
    !kpis ||
    !isBoundedString(value.day, 16) ||
    !bounded(value.usage, GUARDRAIL_VIEW_LIMITS.usage, isUsageRow) ||
    !bounded(value.pauses, GUARDRAIL_VIEW_LIMITS.pauses, isGuardrailPause) ||
    !bounded(value.meter, GUARDRAIL_VIEW_LIMITS.meter, isMeter) ||
    !bounded(value.failovers, GUARDRAIL_VIEW_LIMITS.failovers, isFailoverRow) ||
    !bounded(value.events, GUARDRAIL_VIEW_LIMITS.events, isGuardrailEvent)
  )
    return null;
  return {
    policy,
    day: value.day,
    usage: value.usage,
    pauses: value.pauses,
    meter: value.meter,
    failovers: value.failovers,
    ...(steps === undefined ? {} : { steps }),
    ...(models === undefined ? {} : { models }),
    events: value.events,
    kpis,
  };
}
