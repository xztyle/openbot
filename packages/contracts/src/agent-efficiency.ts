/**
 * The agent efficiency features of this fork: the model policy (a fixed model, or a model that each
 * turn chooses), the sleep of agents, teams and spaces, the weekly performance reviews and the
 * playbooks that every agent of a role reads. The host keeps the policy, the role and the sleep on
 * the agent; the reviews and the playbooks have tables of their own.
 */
import { isBoundedString, isIdentifier } from "./ipc-bounded-values";
import { isBoolean, isDynamicRecord, isNumber, isOneOf, isString } from "./runtime-values";

/** `fixed`: every turn runs on the agent's model. `auto`: each turn takes the model its work needs. */
export const AGENT_MODEL_POLICIES = ["fixed", "auto"] as const;
export type AgentModelPolicy = (typeof AGENT_MODEL_POLICIES)[number];

export function isAgentModelPolicy(value: unknown): value is AgentModelPolicy {
  return isOneOf(AGENT_MODEL_POLICIES, value);
}

/** The model sizes that the automatic policy chooses from, smallest first. */
export const MODEL_TIERS = ["small", "medium", "large"] as const;
export type ModelTier = (typeof MODEL_TIERS)[number];

/**
 * Why the automatic policy chose its model for a turn: a routine run, a teammate's note, a short
 * status question from a person, an event check, the usual work, a planning turn of a lead, a turn
 * after a failed or stuck one, an agent that asked for a stronger model, or a large input.
 */
export const AUTO_MODEL_REASONS = [
  "routine",
  "note",
  "status",
  "event",
  "default",
  "plan",
  "retry",
  "escalated",
  "large",
] as const;
export type AutoModelReason = (typeof AUTO_MODEL_REASONS)[number];

export function isAutoModelReason(value: unknown): value is AutoModelReason {
  return isOneOf(AUTO_MODEL_REASONS, value);
}

/** The longest role name, such as "Creativo de Anuncios". */
export const AGENT_ROLE_LIMIT = 80;

/** A role name: 1 to 80 characters with no line break, not only spaces. */
export function isAgentRole(value: unknown): value is string {
  return isBoundedString(value, AGENT_ROLE_LIMIT) && value.trim().length > 0 && !/[\r\n]/u.test(value);
}

/** An ISO 8601 time at which an agent went to sleep. */
export function isSleepingSince(value: unknown): value is string {
  return isBoundedString(value, 40) && !Number.isNaN(Date.parse(value));
}

/** What a sleep or wake request puts to sleep: one agent, an agent and every agent under it, or a space. */
export const SLEEP_TARGET_KINDS = ["agent", "team", "space"] as const;
export type SleepTargetKind = (typeof SLEEP_TARGET_KINDS)[number];

export interface SleepTarget {
  kind: SleepTargetKind;
  /** The agent id, the id of the team's lead, or the space id. */
  id: string;
}

export interface SetAgentsSleepingInput {
  target: SleepTarget;
  sleeping: boolean;
}

/** The agents that changed, and every agent that sleeps now. */
export interface SetAgentsSleepingResult {
  changedAgentIds: string[];
  sleepingAgentIds: string[];
}

export function parseSetAgentsSleepingInput(value: unknown): SetAgentsSleepingInput {
  if (
    !isDynamicRecord(value) ||
    !isDynamicRecord(value.target) ||
    !isOneOf(SLEEP_TARGET_KINDS, value.target.kind) ||
    !isIdentifier(value.target.id) ||
    !isBoolean(value.sleeping)
  )
    throw new Error("Invalid sleep request.");
  return { target: { kind: value.target.kind, id: value.target.id }, sleeping: value.sleeping };
}

/**
 * The agent ids under a team lead in the org chart, the lead included, from the manager of each
 * agent. `managerOf` answers the manager that `agentManagers` resolves (null at the top level).
 */
export function teamAgentIds(
  leadId: string,
  agentIds: readonly string[],
  managerOf: (agentId: string) => string | null,
): string[] {
  const reports = new Map<string, string[]>();
  for (const id of agentIds) {
    const manager = managerOf(id);
    if (manager === null) continue;
    reports.set(manager, [...(reports.get(manager) ?? []), id]);
  }
  const team: string[] = [];
  const seen = new Set<string>();
  const queue = agentIds.includes(leadId) ? [leadId] : [];
  while (queue.length > 0) {
    const id = queue.shift();
    if (id === undefined || seen.has(id)) continue;
    seen.add(id);
    team.push(id);
    queue.push(...(reports.get(id) ?? []));
  }
  return team;
}

// Performance reviews.

/** The counts that one weekly review reads, all from the host's own records. */
export interface PerformanceScorecard {
  turns: number;
  failedTurns: number;
  /** The board tickets that the agent closed and that were opened again in the week, when the board says so. */
  ticketsDone: number;
  ticketsReopened: number;
  /** The messages of people that thank or approve, and the ones that complain or ask to redo work. */
  praise: number;
  complaints: number;
  costUsd: number;
  /** The share of turns that the automatic policy ran on the small model, 0 to 1, or null with a fixed model. */
  smallModelShare: number | null;
}

export const PERFORMANCE_GRADES = ["great", "good", "watch", "poor"] as const;
export type PerformanceGrade = (typeof PERFORMANCE_GRADES)[number];

export const REVIEW_PROPOSAL_STATES = ["pending", "approved", "dismissed"] as const;
export type ReviewProposalState = (typeof REVIEW_PROPOSAL_STATES)[number];

export const REVIEW_SUMMARY_LIMIT = 600;
export const REVIEW_PROPOSAL_LIMIT = 1_200;

export interface PerformanceReview {
  id: string;
  agentId: string;
  periodStart: string;
  periodEnd: string;
  grade: PerformanceGrade;
  scorecard: PerformanceScorecard;
  /** Two or three short sentences: what went well and what did not. */
  summary: string;
  /**
   * A sentence or two to add to the agent's instructions, when the week shows a pattern that one
   * instruction fixes. The owner approves it; the review never changes the instructions by itself.
   */
  proposal: { text: string; state: ReviewProposalState; decidedAt?: string } | null;
  /** What the review itself cost, in US dollars, or null when the provider did not say. */
  reviewCostUsd: number | null;
  createdAt: string;
}

/** What the automatic model policy did in the last days (`/v1/workspace/model-savings`). */
export interface ModelSavingsSnapshot {
  days: number;
  turns: number;
  autoTurns: number;
  smallTurns: number;
  costUsd: number;
  /** What the turns of the automatic agents would have cost on each agent's own model. */
  fixedCostUsd: number;
  /** Turns that changed the model of a session whose cache was warm, since the host started. */
  warmSwitches: number;
}

export interface PerformanceReviewsInput {
  /** One agent's reviews, newest first. Absent: the newest review of each agent. */
  agentId?: string;
  /** Only reviews with a pending proposal. */
  pendingOnly?: boolean;
  /** Turns the weekly reviews on or off before the list is read. */
  enabled?: boolean;
}

export interface PerformanceReviewsPage {
  reviews: PerformanceReview[];
  /** Off: no weekly review runs by itself. */
  enabled?: boolean;
}

export interface DecideReviewProposalInput {
  reviewId: string;
  decision: "approve" | "dismiss";
  /** The text to add, when the owner changed it before approving. */
  text?: string;
}

export function parsePerformanceReviewsInput(value: unknown): PerformanceReviewsInput {
  if (!isDynamicRecord(value)) throw new Error("Invalid reviews request.");
  if (value.agentId !== undefined && !isIdentifier(value.agentId)) throw new Error("Invalid reviews request.");
  if (value.pendingOnly !== undefined && !isBoolean(value.pendingOnly)) throw new Error("Invalid reviews request.");
  if (value.enabled !== undefined && !isBoolean(value.enabled)) throw new Error("Invalid reviews request.");
  return {
    ...(value.enabled === undefined ? {} : { enabled: value.enabled }),
    ...(value.agentId === undefined ? {} : { agentId: value.agentId }),
    ...(value.pendingOnly === true ? { pendingOnly: true } : {}),
  };
}

export function parseDecideReviewProposalInput(value: unknown): DecideReviewProposalInput {
  if (
    !isDynamicRecord(value) ||
    !isIdentifier(value.reviewId) ||
    !isOneOf(["approve", "dismiss"] as const, value.decision) ||
    (value.text !== undefined && (!isBoundedString(value.text, REVIEW_PROPOSAL_LIMIT) || !value.text.trim()))
  )
    throw new Error("Invalid review decision.");
  return {
    reviewId: value.reviewId,
    decision: value.decision,
    ...(isString(value.text) ? { text: value.text.trim() } : {}),
  };
}

export function parseRunReviewInput(value: unknown): { agentId: string } {
  if (!isDynamicRecord(value) || !isIdentifier(value.agentId)) throw new Error("Invalid review request.");
  return { agentId: value.agentId };
}

export function isPerformanceScorecard(value: unknown): value is PerformanceScorecard {
  const count = (field: unknown) => isNumber(field) && Number.isInteger(field) && field >= 0;
  return (
    isDynamicRecord(value) &&
    count(value.turns) &&
    count(value.failedTurns) &&
    count(value.ticketsDone) &&
    count(value.ticketsReopened) &&
    count(value.praise) &&
    count(value.complaints) &&
    isNumber(value.costUsd) &&
    value.costUsd >= 0 &&
    (value.smallModelShare === null ||
      (isNumber(value.smallModelShare) && value.smallModelShare >= 0 && value.smallModelShare <= 1))
  );
}

// Role playbooks.

/** The folder name of a playbook skill: lower case letters, digits and dashes. */
export const PLAYBOOK_SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/u;
/** The largest SKILL.md of a playbook. */
export const PLAYBOOK_CONTENT_LIMIT = 64_000;
export const PLAYBOOK_ROLES_LIMIT = 20;
export const PLAYBOOK_LIMIT = 200;
export const PLAYBOOK_NOTE_LIMIT = 600;

export interface RolePlaybook {
  id: string;
  /** The skill folder that each agent of the roles gets. */
  slug: string;
  /** The roles that inherit it. An agent matches by its role, or by its name or title without one. */
  roles: string[];
  /** The full SKILL.md, with its `name` and `description` front matter. */
  content: string;
  version: number;
  updatedAt: string;
  /** The agents that have it now. */
  agentIds: string[];
}

export interface PlaybookProposal {
  id: string;
  playbookId: string;
  agentId: string;
  /** The SKILL.md that the agent proposes. */
  content: string;
  /** Why, in the agent's words. */
  note: string;
  state: ReviewProposalState;
  createdAt: string;
}

/** A skill that several agents have in their workspaces and no playbook owns: a playbook to make. */
export interface PlaybookCandidate {
  slug: string;
  agentIds: string[];
  /** The role that most of those agents share, from their names, or null. */
  suggestedRole: string | null;
}

export interface RolePlaybooksSnapshot {
  playbooks: RolePlaybook[];
  proposals: PlaybookProposal[];
  candidates: PlaybookCandidate[];
}

export interface SaveRolePlaybookInput {
  /** Absent: a new playbook. */
  id?: string;
  slug: string;
  roles: string[];
  content: string;
}

export interface ImportRolePlaybookInput {
  /** The agent whose workspace holds the skill. */
  agentId: string;
  slug: string;
  roles: string[];
}

export interface DecidePlaybookProposalInput {
  proposalId: string;
  decision: "approve" | "dismiss";
}

function isRoles(value: unknown): value is string[] {
  return Array.isArray(value) && value.length > 0 && value.length <= PLAYBOOK_ROLES_LIMIT && value.every(isAgentRole);
}

function cleanRoles(roles: readonly string[]): string[] {
  return [...new Map(roles.map((role) => [role.trim().toLocaleLowerCase(), role.trim()] as const)).values()];
}

export function isPlaybookSlug(value: unknown): value is string {
  return isString(value) && PLAYBOOK_SLUG_PATTERN.test(value);
}

export function parseSaveRolePlaybookInput(value: unknown): SaveRolePlaybookInput {
  if (
    !isDynamicRecord(value) ||
    (value.id !== undefined && !isIdentifier(value.id)) ||
    !isPlaybookSlug(value.slug) ||
    !isRoles(value.roles) ||
    !isBoundedString(value.content, PLAYBOOK_CONTENT_LIMIT) ||
    !value.content.trim()
  )
    throw new Error("Invalid playbook.");
  return {
    ...(value.id === undefined ? {} : { id: value.id }),
    slug: value.slug,
    roles: cleanRoles(value.roles),
    content: value.content,
  };
}

export function parseImportRolePlaybookInput(value: unknown): ImportRolePlaybookInput {
  if (!isDynamicRecord(value) || !isIdentifier(value.agentId) || !isPlaybookSlug(value.slug) || !isRoles(value.roles))
    throw new Error("Invalid playbook import.");
  return { agentId: value.agentId, slug: value.slug, roles: cleanRoles(value.roles) };
}

export function parseDecidePlaybookProposalInput(value: unknown): DecidePlaybookProposalInput {
  if (
    !isDynamicRecord(value) ||
    !isIdentifier(value.proposalId) ||
    !isOneOf(["approve", "dismiss"] as const, value.decision)
  )
    throw new Error("Invalid playbook decision.");
  return { proposalId: value.proposalId, decision: value.decision };
}

export function parseRemoveRolePlaybookInput(value: unknown): { id: string } {
  if (!isDynamicRecord(value) || !isIdentifier(value.id)) throw new Error("Invalid playbook.");
  return { id: value.id };
}

/**
 * Whether an agent has a role of the playbook: its own role when it has one, else its name or title
 * holds the role's words. Case and accents do not count.
 */
export function agentHasPlaybookRole(
  agent: { name: string; title?: string | undefined; role?: string | undefined },
  roles: readonly string[],
): boolean {
  const fold = (text: string) =>
    text
      .normalize("NFD")
      .replace(/\p{Diacritic}/gu, "")
      .toLocaleLowerCase()
      .replace(/\s+/gu, " ")
      .trim();
  const wanted = roles.map(fold).filter(Boolean);
  if (agent.role !== undefined) return wanted.includes(fold(agent.role));
  const haystack = fold(`${agent.name} ${agent.title ?? ""}`);
  return wanted.some((role) => haystack.includes(role));
}
