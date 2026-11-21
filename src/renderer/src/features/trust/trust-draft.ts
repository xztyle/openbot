import { agentManagers } from "@openbot/contracts/agent-org";
import {
  resolveTrustRule,
  TRUST_ACTIONS,
  type TrustAction,
  type TrustAgentPlacement,
  type TrustBudget,
  type TrustOverrides,
  type TrustPolicy,
  type TrustRule,
  type TrustRuleSource,
} from "@openbot/contracts/trust-control";
import type { AppTextKey } from "@openbot/i18n";

export const TRUST_ACTION_LABEL = {
  pay: "trust.action.pay",
  launch_ads: "trust.action.launchAds",
  publish: "trust.action.publish",
  email: "trust.action.email",
  create_agent: "trust.action.createAgent",
  delete: "trust.action.delete",
} as const satisfies Record<TrustAction, AppTextKey>;

export const TRUST_RULE_LABEL = {
  allow: "trust.rule.allow",
  ask: "trust.rule.ask",
  deny: "trust.rule.deny",
} as const satisfies Record<TrustRule, AppTextKey>;

export const TRUST_SOURCE_LABEL = {
  agent: "trust.source.agent",
  team: "trust.source.team",
  space: "trust.source.space",
  role: "trust.source.role",
} as const satisfies Record<TrustRuleSource, AppTextKey>;

/** The three levels a person can override, keyed as the policy keys them. */
export type TrustOverrideLevel = "agents" | "teams" | "spaces";

export interface TrustDirectoryAgent {
  id: string;
  name: string;
  reportsToAgentId?: string | null | undefined;
  createdBy?: { agentId: string } | undefined;
}

/** Where an agent stands for the policy, from the org chart of its space. */
export function trustPlacement(
  agents: readonly TrustDirectoryAgent[],
  spaceOf: (agentId: string) => string,
  agentId: string,
): TrustAgentPlacement {
  const spaceId = spaceOf(agentId);
  const managers = agentManagers(agents.filter((agent) => spaceOf(agent.id) === spaceId));
  const chain: string[] = [];
  let current = managers.get(agentId) ?? null;
  while (current && !chain.includes(current) && chain.length < 32) {
    chain.push(current);
    current = managers.get(current) ?? null;
  }
  const leads = chain.length === 0 || [...managers.values()].includes(agentId);
  return { agentId, spaceId, role: leads ? "lead" : "member", managers: chain };
}

export function effectiveTrustRules(
  policy: TrustPolicy,
  placement: TrustAgentPlacement,
): Record<TrustAction, { rule: TrustRule; source: TrustRuleSource }> {
  return {
    pay: resolveTrustRule(policy, placement, "pay"),
    launch_ads: resolveTrustRule(policy, placement, "launch_ads"),
    publish: resolveTrustRule(policy, placement, "publish"),
    email: resolveTrustRule(policy, placement, "email"),
    create_agent: resolveTrustRule(policy, placement, "create_agent"),
    delete: resolveTrustRule(policy, placement, "delete"),
  };
}

/** The policy with one override set, or cleared when `rule` is null. An empty override goes away. */
export function withOverride(
  policy: TrustPolicy,
  level: TrustOverrideLevel,
  id: string,
  action: TrustAction,
  rule: TrustRule | null,
): TrustPolicy {
  const current: TrustOverrides = { ...(policy[level][id] ?? {}) };
  if (rule) current[action] = rule;
  else delete current[action];
  const map = { ...policy[level] };
  if (TRUST_ACTIONS.some((key) => current[key])) map[id] = current;
  else delete map[id];
  return { ...policy, [level]: map };
}

export function withoutOverride(policy: TrustPolicy, level: TrustOverrideLevel, id: string): TrustPolicy {
  const map = { ...policy[level] };
  delete map[id];
  return { ...policy, [level]: map };
}

export function newBudget(): TrustBudget {
  return { id: crypto.randomUUID(), scope: "all", platform: "meta", perDay: 10, currency: "USD" };
}

export function samePolicy(left: TrustPolicy | null, right: TrustPolicy | null): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

/** Downloads text as a file in the browser. */
export function downloadText(name: string, text: string, type: string): void {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1_000);
}
