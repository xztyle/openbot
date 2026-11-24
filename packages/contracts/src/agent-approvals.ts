/**
 * Who approves what an agent asks (`docs/approvals.md`). The owner's goal is the lowest rate of human
 * intervention: only money and critical or irreversible things reach the owner.
 *
 * - Tier 0: reversible internal work runs at once and nobody is asked.
 * - Tier 1: the asking agent's manager in the org chart decides (`approverCandidates`). With no
 *   manager, the space's top agent decides; with no agent that qualifies, the owner does.
 * - Tier 2: only the owner decides: money, deletions and other irreversible actions, credentials and
 *   sign-in codes, legal or identity commitments, security blocks, and what a manager escalates.
 *
 * A request that waits on a manager climbs one level after `APPROVAL_CLIMB_MS` with no answer, and
 * goes to the owner after the top agent. No agent approves its own request or one that it raised in
 * the same chain.
 */

import { type AgentReportingFields, agentManagers } from "./agent-org";
import { isBoundedString, isIdentifier } from "./ipc-bounded-values";
import { isDynamicRecord, isOneOf } from "./runtime-values";

/** Who answers a request: the owner, or the asking agent's manager (an agent). */
export const APPROVERS = ["owner", "manager"] as const;
export type Approver = (typeof APPROVERS)[number];

/** The kinds of tier-2 request: only the owner decides them. */
export const OWNER_ONLY_CLASSES = ["money", "deletion", "credentials", "legal", "security"] as const;
export type OwnerOnlyClass = (typeof OWNER_ONLY_CLASSES)[number];

/** With no answer for this long, a request goes up one level. */
export const APPROVAL_CLIMB_MS = 2 * 60 * 60_000;

/** A manager's answer: yes, no with a note, or up to the owner with a reason. */
export const APPROVAL_VERDICTS = ["approve", "decline", "escalate"] as const;
export type ApprovalVerdict = (typeof APPROVAL_VERDICTS)[number];

/**
 * Where a request comes from:
 * - `ticket`: a Motion ticket that waits on a person (an OK, a decision, an escalated review);
 * - `decision`: `request_decision`;
 * - `gate`: an action that the trust policy asks for (publish, email, create an agent), or the first
 *   mail of an agent to an address;
 * - `lesson`: a proposed change of an agent's instructions, a playbook or a skill.
 */
export const APPROVAL_SOURCES = ["ticket", "decision", "gate", "lesson"] as const;
export type ApprovalSource = (typeof APPROVAL_SOURCES)[number];

/** Why a Motion ticket waits on a person, as `TicketAsks` of `ipc-attention-items.ts`. */
type TicketAsksValue = "approval" | "review-escalated" | "blocked" | "other";

/**
 * Who answers a Motion ticket that waits on a person. A ticket that needs a credential, money or a
 * sign-in, or that the judge put in a tier-2 class, stays with the owner. Everything else goes to the
 * manager: an OK, a decision, an escalated review, and a block that the team can clear.
 */
export function ticketApprover(_asks: TicketAsksValue, ownerOnly: OwnerOnlyClass | null): Approver {
  return ownerOnly ? "owner" : "manager";
}

/**
 * The agents that may answer a request of `askerId`, in the order a request climbs: its managers
 * nearest first, then the space's top agent. `agents` are the agents of the asker's space. An agent in
 * `exclude` (the request's chain) is never a candidate, and neither is the asker. An empty list means
 * that the owner answers.
 */
export function approverCandidates(
  agents: readonly AgentReportingFields[],
  askerId: string,
  exclude: readonly string[] = [],
): string[] {
  const managers = agentManagers(agents);
  const skip = new Set([askerId, ...exclude]);
  const candidates: string[] = [];
  for (let current = managers.get(askerId) ?? null; current && candidates.length < 32; ) {
    if (candidates.includes(current)) break;
    candidates.push(current);
    current = managers.get(current) ?? null;
  }
  const top = spaceTopAgent(agents, managers, askerId);
  if (top && !candidates.includes(top)) candidates.push(top);
  return candidates.filter((id) => !skip.has(id));
}

/**
 * The top agent of a space: of the agents at the top level, the one with the most agents under it;
 * the first one in `agents` on a tie. The asker never is its own top agent.
 */
function spaceTopAgent(
  agents: readonly AgentReportingFields[],
  managers: ReadonlyMap<string, string | null>,
  askerId: string,
): string | null {
  const under = new Map<string, number>();
  for (const agent of agents) {
    const seen = new Set<string>();
    for (let current = managers.get(agent.id) ?? null; current && !seen.has(current); ) {
      seen.add(current);
      under.set(current, (under.get(current) ?? 0) + 1);
      current = managers.get(current) ?? null;
    }
  }
  let best: string | null = null;
  let bestCount = -1;
  for (const agent of agents) {
    if (agent.id === askerId || managers.get(agent.id)) continue;
    const count = under.get(agent.id) ?? 0;
    if (count > bestCount) {
      best = agent.id;
      bestCount = count;
    }
  }
  return best;
}

/**
 * Words that put a request in a tier-2 class, in English and Spanish. A request with one of them goes
 * to the owner. A word that is not here leaves the request with the manager, who can still escalate.
 */
const OWNER_ONLY_WORDS: Record<OwnerOnlyClass, RegExp> = {
  // The action itself spends or commits money. A mention of ads, Meta, a price or a budget is not.
  money:
    /\b(pay|paying|payment|spend|purchase|buy|charge|refund|subscribe|(?:raise|increase|set|change|approve)\s+(?:the\s+)?(?:ad\s+|daily\s+)?(?:budget|price)|pagar|pago|gastar|comprar|cobrar|reembolsar|suscribir\w*|(?:subir|aumentar|fijar|cambiar|aprobar)\s+(?:el\s+)?(?:presupuesto|precio))\b/iu,
  deletion:
    /\b(delete|deletion|remove (?:the )?(?:agent|space|database|site|page)|drop (?:the )?(?:table|database)|destroy|wipe|purge|force[- ]push|rewrite (?:the )?history|revoke|borrar|eliminar|suprimir|destruir|revocar)\b/iu,
  credentials:
    /\b(password|passcode|credential|secret|api key|token|2fa|otp|sign[- ]?in code|verification code|login|contraseña|credencial|clave|código de (?:verificación|acceso|inicio)|iniciar sesión)\b/iu,
  legal:
    /\b(contract|terms of service|sign (?:the )?(?:agreement|contract)|kyc|identity|id document|passport|legal|contrato|términos|firmar|identidad|pasaporte|documento de identidad)\b/iu,
  security: /\b(injection|security block|untrusted|inyección|bloqueo de seguridad)\b/iu,
};

/** The tier-2 class that text names, or null. Money comes first, then the other classes. */
export function ownerOnlyClassOf(text: string): OwnerOnlyClass | null {
  for (const kind of OWNER_ONLY_CLASSES) if (OWNER_ONLY_WORDS[kind].test(text)) return kind;
  return null;
}

/**
 * An item explained for the owner, who has no technical background: what is asked, why it matters,
 * and what a yes and a no do. No ids, codes or technical words; the raw text stays behind the card's
 * opt-in technical details.
 */
export interface OwnerSummary {
  asks: string;
  why: string;
  ifYes: string;
  ifNo: string;
}

export const OWNER_SUMMARY_LIMIT = 240;

export function isOwnerSummary(value: unknown): value is OwnerSummary {
  return (
    isDynamicRecord(value) &&
    isBoundedString(value.asks, OWNER_SUMMARY_LIMIT) &&
    isBoundedString(value.why, OWNER_SUMMARY_LIMIT) &&
    isBoundedString(value.ifYes, OWNER_SUMMARY_LIMIT) &&
    isBoundedString(value.ifNo, OWNER_SUMMARY_LIMIT)
  );
}

// ---------------------------------------------------------------------------------------------------
// The owner's view: what waits on the agents and what they decided.

export const AGENT_APPROVAL_TEXT_LIMITS = { title: 200, reason: 500, note: 1_000, name: 120 } as const;
export const AGENT_APPROVALS_LIMIT = 200;

/**
 * One request that a manager answers, as the owner reads it: in the inbox's "Decided by agents" list
 * when it is decided, never in Needs you.
 */
export interface AgentApproval {
  id: string;
  source: ApprovalSource;
  askerId: string;
  title: string;
  reason: string;
  /** The agent that answers it now, or answered it. */
  approverId?: string;
  /** Absent while it waits. */
  verdict?: ApprovalVerdict;
  note?: string;
  ticketKey?: string;
  url?: string;
  createdAt: string;
  decidedAt?: string;
  /** The owner can take it back: Reopen puts it in Needs you. */
  reopenable?: boolean;
  /** The item explained for the owner; `title` and `reason` are its technical details. */
  plain?: OwnerSummary;
}

/** How many decisions the owner and the agents took in one week. */
export interface ApprovalWeek {
  /** ISO start of the week (seven days before its end). */
  since: string;
  owner: number;
  agents: number;
}

export interface AgentApprovalsView {
  pending: AgentApproval[];
  decided: AgentApproval[];
  /** The last seven days, and the seven before. */
  week: ApprovalWeek;
  previousWeek: ApprovalWeek;
}

function isApprovalWeek(value: unknown): value is ApprovalWeek {
  return (
    isDynamicRecord(value) &&
    isBoundedString(value.since, 64) &&
    Number.isInteger(value.owner) &&
    Number.isInteger(value.agents)
  );
}

export function isAgentApproval(value: unknown): value is AgentApproval {
  if (!isDynamicRecord(value)) return false;
  const optional = (key: string, limit: number) => value[key] === undefined || isBoundedString(value[key], limit);
  return (
    isBoundedString(value.id, 256) &&
    isOneOf(APPROVAL_SOURCES, value.source) &&
    isIdentifier(value.askerId) &&
    isBoundedString(value.title, AGENT_APPROVAL_TEXT_LIMITS.title) &&
    isBoundedString(value.reason, AGENT_APPROVAL_TEXT_LIMITS.reason) &&
    (value.approverId === undefined || isIdentifier(value.approverId)) &&
    (value.verdict === undefined || isOneOf(APPROVAL_VERDICTS, value.verdict)) &&
    optional("note", AGENT_APPROVAL_TEXT_LIMITS.note) &&
    optional("ticketKey", 64) &&
    (value.url === undefined || (isBoundedString(value.url, 2_000) && /^https?:\/\//u.test(value.url))) &&
    isBoundedString(value.createdAt, 64) &&
    optional("decidedAt", 64) &&
    (value.reopenable === undefined || typeof value.reopenable === "boolean") &&
    (value.plain === undefined || isOwnerSummary(value.plain))
  );
}

export function decodeAgentApprovalsView(value: unknown): AgentApprovalsView {
  if (
    !isDynamicRecord(value) ||
    !Array.isArray(value.pending) ||
    !Array.isArray(value.decided) ||
    value.pending.length > AGENT_APPROVALS_LIMIT ||
    value.decided.length > AGENT_APPROVALS_LIMIT ||
    !value.pending.every(isAgentApproval) ||
    !value.decided.every(isAgentApproval) ||
    !isApprovalWeek(value.week) ||
    !isApprovalWeek(value.previousWeek)
  )
    throw new Error("Invalid agent approvals.");
  return { pending: value.pending, decided: value.decided, week: value.week, previousWeek: value.previousWeek };
}
