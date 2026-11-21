/**
 * Trust and control: what each agent may do with money and with the outside world, and the
 * append-only record of what agents did.
 *
 * A trust policy names, for each consequential action, whether an agent may do it at once
 * (`allow`), only after the owner's approval (`ask`), or not at all (`deny`). The rule of an agent
 * comes from the first level that sets it: the agent, its team (the manager it reports to, up the
 * chain), its space, then the default of its role. Budgets cap money per platform, per day and in
 * total, for one agent, a team, a space or every agent. Sandbox first makes a landing, an ad or an
 * email that goes public wait for an approved preview.
 *
 * The host enforces the policy at the tool layer; the prompt only explains it.
 */

import { isBoundedString, isIdentifier } from "./ipc-bounded-values";
import { isDynamicRecord, isOneOf } from "./runtime-values";

export const TRUST_ACTIONS = ["pay", "launch_ads", "publish", "email", "create_agent", "delete"] as const;
export type TrustAction = (typeof TRUST_ACTIONS)[number];

export const TRUST_RULES = ["allow", "ask", "deny"] as const;
export type TrustRule = (typeof TRUST_RULES)[number];

/**
 * `lead`: an agent at the top of its space's org chart, or one that others report to. `member`:
 * every other agent.
 */
export const TRUST_ROLES = ["lead", "member"] as const;
export type TrustRole = (typeof TRUST_ROLES)[number];

export type TrustRules = Record<TrustAction, TrustRule>;
export type TrustOverrides = Partial<TrustRules>;

export const TRUST_BUDGET_SCOPES = ["all", "space", "team", "agent"] as const;
export type TrustBudgetScope = (typeof TRUST_BUDGET_SCOPES)[number];

export interface TrustBudget {
  id: string;
  scope: TrustBudgetScope;
  /** The space, the manager of the team, or the agent. Absent for `all`. */
  scopeId?: string;
  /** Lower case, such as `meta`, `google`, `tiktok`, `hotmart` or `stripe`. `*` counts every platform. */
  platform: string;
  perDay?: number;
  total?: number;
  /** Such as USD. Amounts are compared as they are; the host does not convert currencies. */
  currency: string;
}

export interface TrustSandbox {
  landings: boolean;
  ads: boolean;
  emails: boolean;
}

export interface TrustPolicy {
  version: 1;
  /** Off: every action is allowed and still recorded in the audit log. */
  enabled: boolean;
  roles: Record<TrustRole, TrustRules>;
  spaces: Record<string, TrustOverrides>;
  /** Keyed by the manager's agent id; applies to every agent under that manager. */
  teams: Record<string, TrustOverrides>;
  agents: Record<string, TrustOverrides>;
  budgets: TrustBudget[];
  sandbox: TrustSandbox;
  /** How long one approval of a surface or a go-live lasts for the same agent and action. */
  approvalPassMinutes: number;
}

export const TRUST_LIMITS = {
  budgets: 100,
  overrides: 500,
  platform: 32,
  currency: 8,
  amount: 1_000_000_000,
  passMinutesMax: 24 * 60,
} as const;

export const DEFAULT_TRUST_POLICY: TrustPolicy = {
  version: 1,
  enabled: true,
  roles: {
    // The owner's choice: only money waits for an approval. Every other action is allowed and kept in the audit trail.
    lead: { pay: "ask", launch_ads: "ask", publish: "allow", email: "allow", create_agent: "allow", delete: "allow" },
    member: { pay: "ask", launch_ads: "ask", publish: "allow", email: "allow", create_agent: "allow", delete: "allow" },
  },
  spaces: {},
  teams: {},
  agents: {},
  budgets: [],
  sandbox: { landings: false, ads: false, emails: false },
  approvalPassMinutes: 30,
};

function readRules(value: unknown, fallback: TrustRules): TrustRules {
  const record = isDynamicRecord(value) ? value : {};
  const rule = (action: TrustAction): TrustRule => {
    const candidate = record[action];
    return isOneOf(TRUST_RULES, candidate) ? candidate : fallback[action];
  };
  return {
    pay: rule("pay"),
    launch_ads: rule("launch_ads"),
    publish: rule("publish"),
    email: rule("email"),
    create_agent: rule("create_agent"),
    delete: rule("delete"),
  };
}

function readOverrides(value: unknown): TrustOverrides | null {
  if (!isDynamicRecord(value)) return null;
  const overrides: TrustOverrides = {};
  for (const action of TRUST_ACTIONS) {
    const rule = value[action];
    if (isOneOf(TRUST_RULES, rule)) overrides[action] = rule;
  }
  return Object.keys(overrides).length ? overrides : null;
}

function readOverrideMap(value: unknown): Record<string, TrustOverrides> {
  if (!isDynamicRecord(value)) return {};
  const map: Record<string, TrustOverrides> = {};
  for (const [id, entry] of Object.entries(value).slice(0, TRUST_LIMITS.overrides)) {
    const overrides = isIdentifier(id) ? readOverrides(entry) : null;
    if (overrides) map[id] = overrides;
  }
  return map;
}

function readAmount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= TRUST_LIMITS.amount
    ? value
    : undefined;
}

export function normalizeTrustPlatform(value: string): string {
  return value.trim().toLowerCase().slice(0, TRUST_LIMITS.platform);
}

function readBudget(value: unknown): TrustBudget | null {
  if (!isDynamicRecord(value) || !isIdentifier(value.id) || !isOneOf(TRUST_BUDGET_SCOPES, value.scope)) return null;
  if (!isBoundedString(value.platform, TRUST_LIMITS.platform) || !value.platform.trim()) return null;
  const perDay = readAmount(value.perDay);
  const total = readAmount(value.total);
  if (perDay === undefined && total === undefined) return null;
  if (value.scope !== "all" && !isIdentifier(value.scopeId)) return null;
  const currency =
    isBoundedString(value.currency, TRUST_LIMITS.currency) && value.currency.trim()
      ? value.currency.trim().toUpperCase()
      : "USD";
  return {
    id: value.id,
    scope: value.scope,
    ...(value.scope !== "all" && isIdentifier(value.scopeId) ? { scopeId: value.scopeId } : {}),
    platform: normalizeTrustPlatform(value.platform),
    ...(perDay === undefined ? {} : { perDay }),
    ...(total === undefined ? {} : { total }),
    currency,
  };
}

/**
 * Reads a stored or sent policy. A missing part takes its default and a malformed entry is left
 * out, so an older file still loads. Null when the value is not a policy at all.
 */
export function normalizeTrustPolicy(value: unknown): TrustPolicy | null {
  if (!isDynamicRecord(value)) return null;
  const roles = isDynamicRecord(value.roles) ? value.roles : {};
  const sandbox = isDynamicRecord(value.sandbox) ? value.sandbox : {};
  const minutes =
    typeof value.approvalPassMinutes === "number" && Number.isInteger(value.approvalPassMinutes)
      ? Math.min(Math.max(value.approvalPassMinutes, 0), TRUST_LIMITS.passMinutesMax)
      : DEFAULT_TRUST_POLICY.approvalPassMinutes;
  return {
    version: 1,
    enabled: typeof value.enabled === "boolean" ? value.enabled : DEFAULT_TRUST_POLICY.enabled,
    roles: {
      lead: readRules(roles.lead, DEFAULT_TRUST_POLICY.roles.lead),
      member: readRules(roles.member, DEFAULT_TRUST_POLICY.roles.member),
    },
    spaces: readOverrideMap(value.spaces),
    teams: readOverrideMap(value.teams),
    agents: readOverrideMap(value.agents),
    budgets: Array.isArray(value.budgets)
      ? value.budgets
          .slice(0, TRUST_LIMITS.budgets)
          .map(readBudget)
          .filter((budget): budget is TrustBudget => budget !== null)
      : [],
    sandbox: {
      landings: typeof sandbox.landings === "boolean" ? sandbox.landings : DEFAULT_TRUST_POLICY.sandbox.landings,
      ads: typeof sandbox.ads === "boolean" ? sandbox.ads : DEFAULT_TRUST_POLICY.sandbox.ads,
      emails: typeof sandbox.emails === "boolean" ? sandbox.emails : DEFAULT_TRUST_POLICY.sandbox.emails,
    },
    approvalPassMinutes: minutes,
  };
}

/** Where the rule of an agent came from, for the settings page. */
export type TrustRuleSource = "agent" | "team" | "space" | "role";

export interface TrustAgentPlacement {
  agentId: string;
  spaceId: string;
  role: TrustRole;
  /** The managers above the agent, nearest first. */
  managers: readonly string[];
}

/** The rule of one action for one agent, and the level that set it. */
export function resolveTrustRule(
  policy: TrustPolicy,
  placement: TrustAgentPlacement,
  action: TrustAction,
): { rule: TrustRule; source: TrustRuleSource } {
  const own = policy.agents[placement.agentId]?.[action];
  if (own) return { rule: own, source: "agent" };
  for (const manager of placement.managers) {
    const team = policy.teams[manager]?.[action];
    if (team) return { rule: team, source: "team" };
  }
  const space = policy.spaces[placement.spaceId]?.[action];
  if (space) return { rule: space, source: "space" };
  return { rule: policy.roles[placement.role][action], source: "role" };
}

/** The budgets that cover a spend of this agent on this platform. */
export function trustBudgetsFor(policy: TrustPolicy, placement: TrustAgentPlacement, platform: string): TrustBudget[] {
  const target = normalizeTrustPlatform(platform);
  return policy.budgets.filter((budget) => {
    if (budget.platform !== "*" && budget.platform !== target) return false;
    switch (budget.scope) {
      case "all":
        return true;
      case "space":
        return budget.scopeId === placement.spaceId;
      case "team":
        return budget.scopeId !== undefined && placement.managers.includes(budget.scopeId);
      case "agent":
        return budget.scopeId === placement.agentId;
      default:
        return false;
    }
  });
}

// ---------------------------------------------------------------------------------------------------
// Audit

export const TRUST_AUDIT_CATEGORIES = [
  "spend",
  "publish",
  "send",
  "delete",
  "create_agent",
  "policy",
  "approval",
  "decision",
  "secret",
  "sign_in",
] as const;
export type TrustAuditCategory = (typeof TRUST_AUDIT_CATEGORIES)[number];

/**
 * - `allowed`: the policy let it run at once.
 * - `approved` / `declined`: the owner answered an approval card.
 * - `refused`: the policy refused it (deny, sandbox, budget with no approval possible).
 * - `answered`: a decision card got an answer; `timed_out`: it took its default.
 * - `changed`: a person changed the policy.
 */
export const TRUST_AUDIT_OUTCOMES = [
  "allowed",
  "approved",
  "declined",
  "refused",
  "answered",
  "timed_out",
  "changed",
] as const;
export type TrustAuditOutcome = (typeof TRUST_AUDIT_OUTCOMES)[number];

export const TRUST_AUDIT_ACTOR_KINDS = ["agent", "person", "system"] as const;

export interface TrustAuditEntry {
  id: string;
  /** ISO time. */
  at: string;
  actor: { kind: (typeof TRUST_AUDIT_ACTOR_KINDS)[number]; id?: string; name?: string };
  category: TrustAuditCategory;
  /** What ran, such as `meta-ads set-budget` or `openbot_browser.fill_card`. */
  action: string;
  /** One line, with secrets redacted. */
  summary: string;
  outcome: TrustAuditOutcome;
  amount?: number;
  currency?: string;
  platform?: string;
  agentId?: string;
  threadId?: string;
  turnId?: string;
  channelId?: string;
  spaceId?: string;
  /** A Motion ticket the agent named, such as `UO-123`. */
  ticket?: string;
  /** Who answered an approval or a decision. */
  answeredBy?: string;
}

export const TRUST_AUDIT_TEXT_LIMITS = { action: 120, summary: 500, name: 120, ticket: 64 } as const;
export const TRUST_AUDIT_QUERY_MAX = 2_000;

export function isTrustAuditEntry(value: unknown): value is TrustAuditEntry {
  if (!isDynamicRecord(value) || !isDynamicRecord(value.actor)) return false;
  const optionalId = (key: string) => value[key] === undefined || isIdentifier(value[key]);
  return (
    isIdentifier(value.id) &&
    isBoundedString(value.at, 64) &&
    isOneOf(TRUST_AUDIT_ACTOR_KINDS, value.actor.kind) &&
    (value.actor.id === undefined || isIdentifier(value.actor.id)) &&
    (value.actor.name === undefined || isBoundedString(value.actor.name, TRUST_AUDIT_TEXT_LIMITS.name)) &&
    isOneOf(TRUST_AUDIT_CATEGORIES, value.category) &&
    isBoundedString(value.action, TRUST_AUDIT_TEXT_LIMITS.action) &&
    isBoundedString(value.summary, TRUST_AUDIT_TEXT_LIMITS.summary) &&
    isOneOf(TRUST_AUDIT_OUTCOMES, value.outcome) &&
    (value.amount === undefined || readAmount(value.amount) !== undefined) &&
    (value.currency === undefined || isBoundedString(value.currency, TRUST_LIMITS.currency)) &&
    (value.platform === undefined || isBoundedString(value.platform, TRUST_LIMITS.platform)) &&
    ["agentId", "threadId", "turnId", "channelId", "spaceId"].every(optionalId) &&
    (value.ticket === undefined || isBoundedString(value.ticket, TRUST_AUDIT_TEXT_LIMITS.ticket)) &&
    (value.answeredBy === undefined || isBoundedString(value.answeredBy, TRUST_AUDIT_TEXT_LIMITS.name))
  );
}

export interface TrustAuditQuery {
  limit?: number;
  /** Only entries before this ISO time, for the next page. */
  before?: string;
  since?: string;
  until?: string;
  category?: TrustAuditCategory;
  outcome?: TrustAuditOutcome;
  agentId?: string;
  /** Matches the action, the summary, the platform, the ticket or the actor name. */
  text?: string;
}

export function normalizeTrustAuditQuery(value: unknown): TrustAuditQuery {
  const record = isDynamicRecord(value) ? value : {};
  const time = (key: string) => (isBoundedString(record[key], 64) && record[key] ? { [key]: record[key] } : {});
  const limit =
    typeof record.limit === "number" && Number.isInteger(record.limit)
      ? Math.min(Math.max(record.limit, 1), TRUST_AUDIT_QUERY_MAX)
      : 200;
  return {
    limit,
    ...time("before"),
    ...time("since"),
    ...time("until"),
    ...(isOneOf(TRUST_AUDIT_CATEGORIES, record.category) ? { category: record.category } : {}),
    ...(isOneOf(TRUST_AUDIT_OUTCOMES, record.outcome) ? { outcome: record.outcome } : {}),
    ...(isIdentifier(record.agentId) ? { agentId: record.agentId } : {}),
    ...(isBoundedString(record.text, 200) && record.text.trim() ? { text: record.text.trim() } : {}),
  };
}

/** Whether an entry passes the filters of a query, all but its paging. */
export function trustAuditMatches(entry: TrustAuditEntry, query: TrustAuditQuery): boolean {
  if (query.before && entry.at >= query.before) return false;
  if (query.since && entry.at < query.since) return false;
  if (query.until && entry.at > query.until) return false;
  if (query.category && entry.category !== query.category) return false;
  if (query.outcome && entry.outcome !== query.outcome) return false;
  if (query.agentId && entry.agentId !== query.agentId && entry.actor.id !== query.agentId) return false;
  if (query.text) {
    const needle = query.text.toLowerCase();
    const haystack = [entry.action, entry.summary, entry.platform, entry.ticket, entry.actor.name, entry.answeredBy]
      .filter((part): part is string => typeof part === "string")
      .join("\n")
      .toLowerCase();
    if (!haystack.includes(needle)) return false;
  }
  return true;
}

const CSV_COLUMNS = [
  "at",
  "actor_kind",
  "actor_id",
  "actor_name",
  "category",
  "action",
  "outcome",
  "amount",
  "currency",
  "platform",
  "summary",
  "agent_id",
  "thread_id",
  "turn_id",
  "channel_id",
  "space_id",
  "ticket",
  "answered_by",
] as const;

function csvCell(value: string | number | undefined): string {
  if (value === undefined) return "";
  const text = String(value);
  // A leading = + - @ makes a spreadsheet run the cell as a formula.
  const safe = /^[=+\-@\t\r]/u.test(text) && typeof value !== "number" ? `'${text}` : text;
  return /[",\n\r]/u.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe;
}

/** The entries as CSV with a header row, in the order given. */
export function trustAuditCsv(entries: readonly TrustAuditEntry[]): string {
  const rows = entries.map((entry) =>
    [
      entry.at,
      entry.actor.kind,
      entry.actor.id,
      entry.actor.name,
      entry.category,
      entry.action,
      entry.outcome,
      entry.amount,
      entry.currency,
      entry.platform,
      entry.summary,
      entry.agentId,
      entry.threadId,
      entry.turnId,
      entry.channelId,
      entry.spaceId,
      entry.ticket,
      entry.answeredBy,
    ]
      .map(csvCell)
      .join(","),
  );
  return `${[CSV_COLUMNS.join(","), ...rows].join("\r\n")}\r\n`;
}

/** What the host spent per platform today and in total, for the settings page. */
export interface TrustSpendRow {
  platform: string;
  currency: string;
  /** Agent id, or absent for the sum over every agent. */
  agentId?: string;
  today: number;
  total: number;
}

export interface TrustPolicyView {
  policy: TrustPolicy;
  spend: TrustSpendRow[];
}

export function isTrustSpendRow(value: unknown): value is TrustSpendRow {
  return (
    isDynamicRecord(value) &&
    isBoundedString(value.platform, TRUST_LIMITS.platform) &&
    isBoundedString(value.currency, TRUST_LIMITS.currency) &&
    (value.agentId === undefined || isIdentifier(value.agentId)) &&
    readAmount(value.today) !== undefined &&
    readAmount(value.total) !== undefined
  );
}
