import type {
  DecideReviewProposalInput,
  ImportRolePlaybookInput,
  ModelSavingsSnapshot,
  PerformanceReview,
  PerformanceReviewsInput,
  PerformanceReviewsPage,
  RolePlaybooksSnapshot,
  SaveRolePlaybookInput,
  SetAgentsSleepingResult,
  SleepTarget,
} from "@openbot/contracts/agent-efficiency";
import type {
  DecisionQueueEntry,
  ForgetConversationResult,
  LearningDecision,
  LearningReviewItem,
  LearningReviewsInput,
  LearningReviewsPage,
  SettingsCheckpoint,
} from "@openbot/contracts/agent-learning";
import { isDynamicRecord } from "@openbot/contracts/runtime-values";
import { AGENT_EFFICIENCY_ROUTES } from "@openbot/contracts/team-protocol/agent-efficiency-v1";
import { AGENT_LEARNING_ROUTES } from "@openbot/contracts/team-protocol/agent-learning-v1";
import type { TeamApiRequest } from "@openbot/team-client/team-api-requests";

/** The sleep, savings, review and playbook calls of a host, for an owner or an admin (agent-efficiency-v1). */
export interface EfficiencyCalls {
  sleep(target: SleepTarget, sleeping: boolean): Promise<SetAgentsSleepingResult>;
  modelSavings(): Promise<ModelSavingsSnapshot>;
  reviews(input: PerformanceReviewsInput): Promise<PerformanceReviewsPage>;
  runReview(agentId: string): Promise<PerformanceReview | null>;
  decideReview(input: DecideReviewProposalInput): Promise<PerformanceReview>;
  playbooks(): Promise<RolePlaybooksSnapshot>;
  savePlaybook(input: SaveRolePlaybookInput): Promise<RolePlaybooksSnapshot>;
  importPlaybook(input: ImportRolePlaybookInput): Promise<RolePlaybooksSnapshot>;
  removePlaybook(id: string): Promise<RolePlaybooksSnapshot>;
  decidePlaybook(proposalId: string, decision: "approve" | "dismiss"): Promise<RolePlaybooksSnapshot>;
  /** agent-learning-v1: the review items of the nightly cleanup and the task lessons. */
  learning(input: LearningReviewsInput): Promise<LearningReviewsPage>;
  decideLearning(itemId: string, decision: LearningDecision): Promise<LearningReviewItem>;
  dream(agentId: string): Promise<LearningReviewItem[]>;
  decisionQueue(): Promise<DecisionQueueEntry[]>;
  /** Approves or dismisses one entry of the decision queue, whatever its source. */
  decideQueue(id: string, decision: "approve" | "dismiss"): Promise<void>;
  settingsHistory(agentId: string): Promise<SettingsCheckpoint[]>;
  rollback(checkpointId: string): Promise<SettingsCheckpoint>;
  forgetConversation(agentId: string, confirm: boolean): Promise<ForgetConversationResult>;
}

// The route codecs of agent-efficiency-v1 check each answer on the way in; these only name its type.
function isSleepResult(value: unknown): value is SetAgentsSleepingResult {
  return isDynamicRecord(value) && Array.isArray(value.changedAgentIds) && Array.isArray(value.sleepingAgentIds);
}
function isSavings(value: unknown): value is ModelSavingsSnapshot {
  return isDynamicRecord(value) && typeof value.turns === "number" && typeof value.costUsd === "number";
}
function isReviewsPage(value: unknown): value is PerformanceReviewsPage {
  return isDynamicRecord(value) && Array.isArray(value.reviews);
}
function isReview(value: unknown): value is PerformanceReview {
  return isDynamicRecord(value) && typeof value.id === "string" && isDynamicRecord(value.scorecard);
}
function isPlaybooks(value: unknown): value is RolePlaybooksSnapshot {
  return (
    isDynamicRecord(value) &&
    Array.isArray(value.playbooks) &&
    Array.isArray(value.proposals) &&
    Array.isArray(value.candidates)
  );
}

function isLearningPage(value: unknown): value is LearningReviewsPage {
  return isDynamicRecord(value) && Array.isArray(value.items) && isDynamicRecord(value.settings);
}
function isForgetResult(value: unknown): value is ForgetConversationResult {
  return isDynamicRecord(value) && Array.isArray(value.memories) && typeof value.forgotten === "number";
}

/** The list or record under `key` of an answer that the route codec already checked. */
function field<T>(key: string, guard: (value: unknown) => value is T): (value: unknown) => T {
  return (value) => {
    const inner = isDynamicRecord(value) ? value[key] : undefined;
    if (!guard(inner)) throw new Error("Invalid answer.");
    return inner;
  };
}
const isItem = (value: unknown): value is LearningReviewItem => isDynamicRecord(value) && typeof value.id === "string";
const isItems = (value: unknown): value is LearningReviewItem[] => Array.isArray(value) && value.every(isItem);
const isEntries = (value: unknown): value is DecisionQueueEntry[] => Array.isArray(value);
const isCheckpoint = (value: unknown): value is SettingsCheckpoint =>
  isDynamicRecord(value) && typeof value.id === "string" && Array.isArray(value.changes);
const isCheckpoints = (value: unknown): value is SettingsCheckpoint[] =>
  Array.isArray(value) && value.every(isCheckpoint);

function decoder<T>(guard: (value: unknown) => value is T): (value: unknown) => T {
  return (value) => {
    if (!guard(value)) throw new Error("Invalid answer.");
    return value;
  };
}

const decodeReviewAnswer = (value: unknown): PerformanceReview | null => {
  if (!isDynamicRecord(value)) throw new Error("Invalid answer.");
  if (value.review === null) return null;
  if (!isReview(value.review)) throw new Error("Invalid answer.");
  return value.review;
};
const decodeDecidedReview = (value: unknown): PerformanceReview => {
  const review = decodeReviewAnswer(value);
  if (!review) throw new Error("Invalid answer.");
  return review;
};

export function hostEfficiencyCalls(request: () => TeamApiRequest): EfficiencyCalls {
  const playbooks = decoder(isPlaybooks);
  return {
    sleep: (target, sleeping) =>
      request()("POST", AGENT_EFFICIENCY_ROUTES.sleep, decoder(isSleepResult), { target: { ...target }, sleeping }),
    modelSavings: () => request()("POST", AGENT_EFFICIENCY_ROUTES.modelSavings, decoder(isSavings), {}),
    reviews: (input) => request()("POST", AGENT_EFFICIENCY_ROUTES.reviews, decoder(isReviewsPage), { ...input }),
    runReview: (agentId) => request()("POST", AGENT_EFFICIENCY_ROUTES.runReview, decodeReviewAnswer, { agentId }),
    decideReview: (input) => request()("POST", AGENT_EFFICIENCY_ROUTES.decideReview, decodeDecidedReview, { ...input }),
    playbooks: () => request()("POST", AGENT_EFFICIENCY_ROUTES.playbooks, playbooks, {}),
    savePlaybook: (input) =>
      request()("POST", AGENT_EFFICIENCY_ROUTES.savePlaybook, playbooks, { ...input, roles: [...input.roles] }),
    importPlaybook: (input) =>
      request()("POST", AGENT_EFFICIENCY_ROUTES.importPlaybook, playbooks, { ...input, roles: [...input.roles] }),
    removePlaybook: (id) => request()("POST", AGENT_EFFICIENCY_ROUTES.removePlaybook, playbooks, { id }),
    decidePlaybook: (proposalId, decision) =>
      request()("POST", AGENT_EFFICIENCY_ROUTES.decidePlaybook, playbooks, { proposalId, decision }),
    learning: (input) =>
      request()("POST", AGENT_LEARNING_ROUTES.reviews, decoder(isLearningPage), {
        ...input,
        ...(input.settings ? { settings: { ...input.settings } } : {}),
      }),
    decideLearning: (itemId, decision) =>
      request()("POST", AGENT_LEARNING_ROUTES.decide, field("item", isItem), { itemId, decision }),
    dream: (agentId) => request()("POST", AGENT_LEARNING_ROUTES.dream, field("items", isItems), { agentId }),
    decisionQueue: () => request()("POST", AGENT_LEARNING_ROUTES.queue, field("entries", isEntries), {}),
    decideQueue: async (id, decision) => {
      await request()("POST", AGENT_LEARNING_ROUTES.decideQueue, () => undefined, { id, decision });
    },
    settingsHistory: (agentId) =>
      request()("POST", AGENT_LEARNING_ROUTES.history, field("checkpoints", isCheckpoints), { agentId }),
    rollback: (checkpointId) =>
      request()("POST", AGENT_LEARNING_ROUTES.rollback, field("checkpoint", isCheckpoint), { checkpointId }),
    forgetConversation: (agentId, confirm) =>
      request()("POST", AGENT_LEARNING_ROUTES.forgetConversation, decoder(isForgetResult), {
        agentId,
        ...(confirm ? { confirm: true } : {}),
      }),
  };
}

/** The short name of a model for a line of text: "Haiku", "Sonnet 5.5", or the id. */
export function shortModelName(model: string): string {
  const match = /claude-(haiku|sonnet|opus)-(\d+)(?:-(\d+))?/u.exec(model);
  if (!match?.[1]) return model;
  const family = match[1].charAt(0).toUpperCase() + match[1].slice(1);
  return match[3] ? `${family} ${match[2]}.${match[3]}` : `${family} ${match[2]}`;
}
