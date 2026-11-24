import { readFileSync } from "node:fs";
import type { AgentApprovalsView, ApprovalWeek, Approver } from "@openbot/contracts/agent-approvals";
import { agentManagers } from "@openbot/contracts/agent-org";
import {
  DEFAULT_TRUST_POLICY,
  normalizeTrustPlatform,
  normalizeTrustPolicy,
  OWNER_ONLY_TRUST_ACTIONS,
  resolveTrustRule,
  TRUST_ACTIONS,
  TRUST_AUDIT_QUERY_MAX,
  type TrustAgentPlacement,
  type TrustAuditEntry,
  type TrustBudget,
  type TrustPolicy,
  type TrustPolicyView,
  type TrustSandbox,
  type TrustSpendRow,
  trustBudgetsFor,
} from "@openbot/contracts/trust-control";
import { sourceText } from "@openbot/i18n/source";
import { createOpenBotLogger, toLogValue } from "@openbot/logging";
import { Effect } from "effect";
import type { ApprovalRouter } from "../approvals/approval-router";
import { writeJsonFileAtomically } from "../atomic-json-file";
import type { TrustAuditInput, TrustAuditLog } from "./trust-audit-log";
import { type TrustClassification, trustCategory } from "./trust-classifier";

const logger = createOpenBotLogger("trust-service");

/** The agent fields the service reads: identity, org line and space. */
export interface TrustDirectoryAgent {
  id: string;
  name: string;
  reportsToAgentId?: string | null | undefined;
  createdBy?: { agentId: string } | undefined;
}

export interface TrustDirectory {
  agents(): readonly TrustDirectoryAgent[];
  spaceOf(agentId: string): string;
}

/** Who asks, and where the work is, for the approval card and the audit row. */
export interface TrustSubject {
  agentId: string;
  threadId?: string | undefined;
  turnId?: string | undefined;
  channelId?: string | undefined;
}

export type TrustVerdict =
  | { kind: "allow"; covered?: "pass" | "go-live" }
  | { kind: "ask"; reason: string }
  | { kind: "refuse"; message: string };

export type TrustApprovalAnswer = "accept" | "decline" | "cancel";

/** An answer with who gave it: the owner on the card, or the agent's manager (`ApprovalRouter`). */
export type TrustApprovalResult =
  | TrustApprovalAnswer
  | { answer: TrustApprovalAnswer; byName: string; byKind: "owner" | "agent"; note?: string | undefined };

function answerOf(result: TrustApprovalResult): {
  answer: TrustApprovalAnswer;
  byName: string;
  byKind: "owner" | "agent";
  note?: string | undefined;
} {
  return typeof result === "string" ? { answer: result, byName: "owner", byKind: "owner" } : result;
}

const WEEK_MS = 7 * 86_400_000;

export type TrustGateResult = { allowed: true } | { allowed: false; message: string };

const ACTION_WORDS: Record<TrustClassification["action"], string> = {
  pay: "pay",
  launch_ads: "launch or fund ads",
  publish: "publish",
  email: "email people",
  create_agent: "create agents",
  delete: "delete",
};

const ASK_KEYS = {
  pay: "status.agent.trustAsk.pay",
  launch_ads: "status.agent.trustAsk.launchAds",
  publish: "status.agent.trustAsk.publish",
  email: "status.agent.trustAsk.email",
  create_agent: "status.agent.trustAsk.createAgent",
  delete: "status.agent.trustAsk.delete",
} as const;

const SANDBOX_WORDS: Record<keyof TrustSandbox, string> = {
  landings: "a landing or site going public",
  ads: "an ad going live",
  emails: "an email to customers",
};

function money(amount: number, currency: string): string {
  return `${Number.isInteger(amount) ? amount : amount.toFixed(2)} ${currency}`;
}

/**
 * Owns the trust policy file and the decision of the trust gate: whether an agent's consequential
 * action runs at once, waits for the owner's approval, or is refused, from the policy, the budgets
 * and the spend that the audit trail records. It also holds the short-lived passes that one approval
 * gives: a browser surface (Ads Manager) or a sandboxed go-live (an approved preview).
 *
 * It never shows a card itself: the caller hands it the approval to wait for, so the same gate
 * serves the tool router, the Claude hook and any later path.
 */
export class TrustService {
  readonly #file: string;
  readonly #audit: TrustAuditLog;
  readonly #directory: TrustDirectory;
  readonly #now: () => number;
  #policy: TrustPolicy;
  /** Tier 1 of `docs/approvals.md`, for the owner's view of what agents decided. */
  #approvals: ApprovalRouter | null = null;
  /** `agentId\nkey` → expiry in epoch milliseconds. Keys are surfaces and `go-live:<sandbox>`. */
  readonly #passes = new Map<string, number>();

  constructor(options: { file: string; audit: TrustAuditLog; directory: TrustDirectory; now?: () => number }) {
    this.#file = options.file;
    this.#audit = options.audit;
    this.#directory = options.directory;
    this.#now = options.now ?? Date.now;
    this.#policy = this.#load();
  }

  get audit(): TrustAuditLog {
    return this.#audit;
  }

  #load(): TrustPolicy {
    try {
      return normalizeTrustPolicy(JSON.parse(readFileSync(this.#file, "utf8"))) ?? DEFAULT_TRUST_POLICY;
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT"))
        logger.warn("The trust policy file could not be read; the defaults apply", { error: toLogValue(error) });
      return DEFAULT_TRUST_POLICY;
    }
  }

  policy(): TrustPolicy {
    return this.#policy;
  }

  view(): TrustPolicyView {
    return { policy: this.#policy, spend: this.#spendRows() };
  }

  /** Saves a new policy from the settings page and records who changed what. */
  readonly savePolicy = Effect.fn("TrustService.savePolicy")(function* (
    this: TrustService,
    value: TrustPolicy,
    actor: { id?: string; name?: string },
  ) {
    const before = this.#policy;
    yield* writeJsonFileAtomically(this.#file, value, { createDirectory: true });
    this.#policy = value;
    this.#audit.record({
      actor: { kind: "person", ...actor },
      category: "policy",
      action: "trust.policy",
      summary: policyChanges(before, value),
      outcome: "changed",
    });
    return this.view();
  });

  placement(agentId: string): TrustAgentPlacement {
    const agents = this.#directory.agents();
    const spaceId = this.#directory.spaceOf(agentId);
    const sameSpace = agents.filter((agent) => this.#directory.spaceOf(agent.id) === spaceId);
    const managers = agentManagers(sameSpace);
    const chain: string[] = [];
    let current = managers.get(agentId) ?? null;
    while (current && !chain.includes(current) && chain.length < 32) {
      chain.push(current);
      current = managers.get(current) ?? null;
    }
    const leads = chain.length === 0 || [...managers.values()].includes(agentId);
    return { agentId, spaceId, role: leads ? "lead" : "member", managers: chain };
  }

  agentName(agentId: string): string | undefined {
    return this.#directory.agents().find((agent) => agent.id === agentId)?.name;
  }

  attachApprovals(approvals: ApprovalRouter): void {
    this.#approvals = approvals;
  }

  /** What waits on managers, what they decided, and the owner's interventions by week. */
  approvalsView(): AgentApprovalsView {
    const view = this.#approvals?.view() ?? { pending: [], decided: [] };
    return { ...view, ...this.approvalWeeks() };
  }

  /** The owner takes back a request that a manager decided: it goes to their Needs you. */
  reopenApproval(id: string): Promise<boolean> {
    return this.#approvals?.reopen(id) ?? Promise.resolve(false);
  }

  /** Who answers when the policy asks for this action: always the owner for money and deletions. */
  approverFor(action: TrustClassification["action"]): Approver {
    return OWNER_ONLY_TRUST_ACTIONS.includes(action) ? "owner" : (this.#policy.approvers[action] ?? "owner");
  }

  /**
   * How many approvals and decisions the owner and the agents answered in the last seven days and
   * the seven before, from the audit trail: the owner's interventions and the share the agents took.
   * An escalation is no decision; a timed-out default is nobody's.
   */
  approvalWeeks(): { week: ApprovalWeek; previousWeek: ApprovalWeek } {
    const now = this.#now();
    const since = new Date(now - 2 * WEEK_MS).toISOString();
    const rows = (["approval", "decision"] as const).flatMap((category) =>
      this.#audit.query({ since, category, limit: TRUST_AUDIT_QUERY_MAX }),
    );
    const week = { since: new Date(now - WEEK_MS).toISOString(), owner: 0, agents: 0 };
    const previousWeek = { since, owner: 0, agents: 0 };
    for (const row of rows) {
      if (row.escalated || !["approved", "declined", "answered"].includes(row.outcome)) continue;
      const kind = row.answeredByKind ?? (row.answeredBy && row.answeredBy !== "timeout" ? "owner" : null);
      if (!kind) continue;
      const bucket = row.at >= week.since ? week : previousWeek;
      if (kind === "owner") bucket.owner += 1;
      else bucket.agents += 1;
    }
    return { week, previousWeek };
  }

  #passKey(agentId: string, key: string): string {
    return `${agentId}\n${key}`;
  }

  #hasPass(agentId: string, key: string): boolean {
    const until = this.#passes.get(this.#passKey(agentId, key));
    if (until === undefined) return false;
    if (until > this.#now()) return true;
    this.#passes.delete(this.#passKey(agentId, key));
    return false;
  }

  #grant(agentId: string, key: string): void {
    const minutes = this.#policy.approvalPassMinutes;
    if (minutes > 0) this.#passes.set(this.#passKey(agentId, key), this.#now() + minutes * 60_000);
  }

  /** An approved preview: the agent's next go-live of this kind runs within the pass time. */
  grantGoLive(agentId: string, sandbox: keyof TrustSandbox): void {
    const minutes = Math.max(this.#policy.approvalPassMinutes, 10);
    this.#passes.set(this.#passKey(agentId, `go-live:${sandbox}`), this.#now() + minutes * 60_000);
  }

  #covers(budget: TrustBudget): (entry: TrustAuditEntry) => boolean {
    return (entry) => {
      if (budget.platform !== "*" && entry.platform !== budget.platform) return false;
      if (entry.currency && entry.currency !== budget.currency) return false;
      switch (budget.scope) {
        case "all":
          return true;
        case "space":
          return entry.spaceId === budget.scopeId;
        case "agent":
          return entry.agentId === budget.scopeId;
        case "team":
          return (
            entry.agentId !== undefined &&
            budget.scopeId !== undefined &&
            this.placement(entry.agentId).managers.includes(budget.scopeId)
          );
      }
    };
  }

  /** The policy's answer for one action, before any card. */
  evaluate(subject: TrustSubject, action: TrustClassification): TrustVerdict {
    const policy = this.#policy;
    if (!policy.enabled) return { kind: "allow" };
    // Tier 0 (docs/approvals.md): the agents' own Motion board is internal work, a deletion there too.
    if (action.action === "delete" && normalizeTrustPlatform(action.platform ?? "") === "motion")
      return { kind: "allow" };
    const placement = this.placement(subject.agentId);
    const { rule, source } = resolveTrustRule(policy, placement, action.action);
    const what = `${action.label}: ${action.summary}`;
    if (rule === "deny")
      return {
        kind: "refuse",
        message: `Refused by the trust policy: you may not ${ACTION_WORDS[action.action]} (${source} rule). Action: ${what}. Do not try it another way. If it is really needed, ask the owner with openbot.request_decision; only the owner can change the policy (Server settings > Trust & budgets).`,
      };
    let goLive = false;
    if (action.sandbox && policy.sandbox[action.sandbox]) {
      goLive = this.#hasPass(subject.agentId, `go-live:${action.sandbox}`);
      if (!goLive)
        return {
          kind: "refuse",
          message: `Sandbox first: ${SANDBOX_WORDS[action.sandbox]} needs an approved preview. Stage it first (a render-sites site named <name>-preview, appctl deploy --private, a draft, or the text of the email), then call openbot.request_decision with previewUrl (or preview) and goLive "${action.sandbox}". After the owner approves, run this command again within ${Math.max(policy.approvalPassMinutes, 10)} minutes. Action held: ${what}.`,
        };
    }
    if (action.surface && this.#hasPass(subject.agentId, action.surface)) return { kind: "allow", covered: "pass" };
    const agent = this.agentName(subject.agentId) ?? subject.agentId;
    if (action.action === "pay" || action.action === "launch_ads") {
      const platform = normalizeTrustPlatform(action.platform ?? "unknown");
      for (const budget of trustBudgetsFor(policy, placement, platform)) {
        if (action.currency && action.currency !== budget.currency) continue;
        const spent = this.#audit.spent(this.#covers(budget));
        if (action.amount === undefined)
          return {
            kind: "ask",
            reason:
              action.action === "pay" && action.browser
                ? sourceText("status.agent.trustAskCheckout", {
                    agent,
                    site: action.browser.site,
                    what: action.browser.what,
                  })
                : sourceText("status.agent.trustAskUnknown", { agent, platform }),
          };
        const amount = money(action.amount, budget.currency);
        if (budget.perDay !== undefined && spent.today + action.amount > budget.perDay)
          return {
            kind: "ask",
            reason: sourceText("status.agent.trustAskDaily", {
              agent,
              platform,
              amount,
              spent: money(spent.today, budget.currency),
              limit: money(budget.perDay, budget.currency),
            }),
          };
        if (budget.total !== undefined && spent.total + action.amount > budget.total)
          return {
            kind: "ask",
            reason: sourceText("status.agent.trustAskTotal", {
              agent,
              platform,
              amount,
              spent: money(spent.total, budget.currency),
              limit: money(budget.total, budget.currency),
            }),
          };
      }
    }
    if (goLive) return { kind: "allow", covered: "go-live" };
    if (rule === "ask")
      return {
        kind: "ask",
        reason:
          action.action === "pay" && action.browser
            ? action.surface
              ? sourceText("status.agent.trustAskCheckoutSurface", {
                  agent,
                  site: action.browser.site,
                  what: action.browser.what,
                  minutes: String(policy.approvalPassMinutes),
                })
              : sourceText("status.agent.trustAskCheckout", {
                  agent,
                  site: action.browser.site,
                  what: action.browser.what,
                })
            : action.surface
              ? sourceText("status.agent.trustAskSurface", {
                  agent,
                  site: action.platform ?? action.surface,
                  minutes: String(policy.approvalPassMinutes),
                })
              : sourceText(ASK_KEYS[action.action], { agent }),
      };
    return { kind: "allow" };
  }

  /**
   * Checks one action and records it. `approve` shows the approval card and waits for the owner; it
   * runs only when the policy asks. A pass that covers the action records nothing more.
   */
  readonly gate = Effect.fn("TrustService.gate")(function* <E, R>(
    this: TrustService,
    subject: TrustSubject,
    action: TrustClassification,
    approve: (reason: string) => Effect.Effect<TrustApprovalResult, E, R>,
  ): Effect.fn.Return<TrustGateResult, E, R> {
    const verdict = this.evaluate(subject, action);
    if (verdict.kind === "allow" && verdict.covered === "pass") return { allowed: true };
    const base = this.#row(subject, action);
    if (verdict.kind === "refuse") {
      this.#audit.record({ ...base, outcome: "refused" });
      return { allowed: false, message: verdict.message };
    }
    if (verdict.kind === "allow") {
      this.#audit.record({ ...base, outcome: "allowed" });
      if (action.surface) this.#grant(subject.agentId, action.surface);
      return { allowed: true };
    }
    const { answer, byName, byKind, note } = answerOf(yield* approve(verdict.reason));
    const by = { answeredBy: byName, answeredByKind: byKind };
    if (answer === "accept") {
      this.#audit.record({ ...base, outcome: "approved", ...by });
      if (action.surface) this.#grant(subject.agentId, action.surface);
      return { allowed: true };
    }
    this.#audit.record({ ...base, outcome: "declined", ...(answer === "decline" ? by : {}) });
    const who = byKind === "agent" ? `${byName} (your manager)` : "The owner";
    return {
      allowed: false,
      message:
        answer === "decline"
          ? `${who} declined: ${action.label}.${note ? ` Their note: ${note}` : ""} Do not retry it or try it another way. Continue without it, or ask what to change with openbot.request_decision.`
          : `Nobody answered the approval for ${action.label}, so it did not run. Do not retry now; continue with other work or end your turn.`,
    };
  });

  #row(subject: TrustSubject, action: TrustClassification): Omit<TrustAuditInput, "outcome"> {
    return {
      actor: {
        kind: "agent",
        id: subject.agentId,
        ...(this.agentName(subject.agentId) ? { name: this.agentName(subject.agentId) } : {}),
      },
      category: trustCategory(action.action),
      action: action.label,
      summary: action.summary,
      ...(action.amount === undefined ? {} : { amount: action.amount, currency: action.currency ?? "USD" }),
      ...(action.platform ? { platform: normalizeTrustPlatform(action.platform) } : {}),
      agentId: subject.agentId,
      spaceId: this.#directory.spaceOf(subject.agentId),
      ...(subject.threadId ? { threadId: subject.threadId } : {}),
      ...(subject.turnId ? { turnId: subject.turnId } : {}),
      ...(subject.channelId ? { channelId: subject.channelId } : {}),
    };
  }

  /** Records an action that is not gated but belongs in the trail: a secret fill, a sign-in, a decision. */
  record(entry: TrustAuditInput): TrustAuditEntry {
    return this.#audit.record(entry);
  }

  #spendRows(): TrustSpendRow[] {
    const dayStart = this.#audit.todayStart;
    const rows = new Map<string, TrustSpendRow>();
    for (const entry of this.#audit.spendLines()) {
      const platform = entry.platform ?? "unknown";
      const currency = entry.currency ?? "USD";
      for (const agentId of [undefined, entry.agentId]) {
        const key = `${platform}\n${currency}\n${agentId ?? ""}`;
        const row = rows.get(key) ?? { platform, currency, ...(agentId ? { agentId } : {}), today: 0, total: 0 };
        row.total += entry.amount ?? 0;
        if (entry.at >= dayStart) row.today += entry.amount ?? 0;
        rows.set(key, row);
      }
    }
    return [...rows.values()].slice(0, 500);
  }
}

/** One line that says what a person changed in the policy, for the audit trail. */
function policyChanges(before: TrustPolicy, after: TrustPolicy): string {
  const parts: string[] = [];
  if (before.enabled !== after.enabled) parts.push(after.enabled ? "turned the policy on" : "turned the policy off");
  for (const role of ["lead", "member"] as const)
    for (const action of TRUST_ACTIONS)
      if (before.roles[role][action] !== after.roles[role][action])
        parts.push(`${role} ${action}=${after.roles[role][action]}`);
  for (const level of ["agents", "teams", "spaces"] as const) {
    const ids = new Set([...Object.keys(before[level]), ...Object.keys(after[level])]);
    for (const id of ids)
      if (JSON.stringify(before[level][id] ?? {}) !== JSON.stringify(after[level][id] ?? {}))
        parts.push(`${level.slice(0, -1)} ${id}: ${JSON.stringify(after[level][id] ?? {})}`);
  }
  if (JSON.stringify(before.budgets) !== JSON.stringify(after.budgets))
    parts.push(
      `budgets: ${after.budgets.map((budget) => `${budget.platform}/${budget.scope}${budget.perDay === undefined ? "" : ` ${budget.perDay}/day`}${budget.total === undefined ? "" : ` ${budget.total} total`} ${budget.currency}`).join("; ") || "none"}`,
    );
  for (const key of ["landings", "ads", "emails"] as const)
    if (before.sandbox[key] !== after.sandbox[key]) parts.push(`sandbox ${key} ${after.sandbox[key] ? "on" : "off"}`);
  if (before.approvalPassMinutes !== after.approvalPassMinutes) parts.push(`pass ${after.approvalPassMinutes} min`);
  for (const action of TRUST_ACTIONS)
    if (before.approvers[action] !== after.approvers[action])
      parts.push(`${action} approver=${after.approvers[action]}`);
  return parts.join(", ") || "saved with no change";
}
