// The fleet, step trail and artifact views of the Slack-style workspace (phase 7): what each agent
// does now, the steps of the turn that wrote an agent's channel answer, and the deliverables that
// agents shared. The host derives all three from state it already keeps; the artifact index and
// the page thumbnails are host-only files, never sent whole.
//
// Times are epoch milliseconds. Every text is host text, cut to the limits below.

import { INPUT_LIMITS } from "./input-limits";
import { integerInRange, isBoundedString, isIdentifier } from "./ipc-bounded-values";
import { type DynamicRecord, isBoolean, isDynamicRecord, isNumber, isOneOf } from "./runtime-values";

export const WORKSPACE_FLEET_TEXT_LIMIT = 240;
export const WORKSPACE_FLEET_AGENT_LIMIT = INPUT_LIMITS.agents;
export const WORKSPACE_STEP_LIMIT = 60;
export const WORKSPACE_STEP_LABEL_LIMIT = 160;
export const WORKSPACE_STEP_DETAIL_LIMIT = 300;
export const WORKSPACE_ARTIFACT_LIMIT = 200;
export const WORKSPACE_ARTIFACT_DEFAULT_LIMIT = 100;
export const WORKSPACE_ARTIFACT_TITLE_LIMIT = 200;
export const WORKSPACE_ARTIFACT_DESCRIPTION_LIMIT = 300;
export const WORKSPACE_ARTIFACT_URL_LIMIT = 2_048;
export const WORKSPACE_ARTIFACT_THUMBNAIL_VERSION_LIMIT = 64;
export const WORKSPACE_TIME_ZONE_LIMIT = 64;
/** The host sends one `workspace-fleet-changed` event at most this often. */
export const WORKSPACE_FLEET_EVENT_INTERVAL_MS = 1_000;

/** What a step of an agent turn did. The kinds of `AgentStepView` in the workspace UI kit. */
export const WORKSPACE_STEP_KINDS = ["search", "browse", "tool", "shell", "file", "skill", "think"] as const;
export type WorkspaceStepKind = (typeof WORKSPACE_STEP_KINDS)[number];

/**
 * Why an agent waits: a question for a person, an approval, a browser it needs a person in, or a
 * provider usage limit that holds its work until the limit resets.
 */
export const WORKSPACE_WAIT_REASONS = ["question", "approval", "browser", "usage-limit"] as const;
export type WorkspaceWaitReason = (typeof WORKSPACE_WAIT_REASONS)[number];

/**
 * What an agent does now. `working`: a turn runs; `what` is its channel task, agent task, routine or
 * request. `waiting`: a running turn waits for a person, or a usage limit holds the agent's work;
 * `forMemberId` is the person who must answer, when the host knows them; `resetsAt` is when a usage
 * limit ends, when the provider said. `queued`: no turn runs and `count` messages wait for one.
 */
export type WorkspaceFleetStatus =
  | { kind: "idle" }
  | {
      kind: "working";
      what: string;
      channelId?: string;
      threadRootId?: string;
      /** A channel task or an agent task. */
      taskId?: string;
      startedAt: number;
    }
  | {
      kind: "waiting";
      reason: WorkspaceWaitReason;
      what: string;
      forMemberId?: string;
      channelId?: string;
      threadRootId?: string;
      /** For `usage-limit`: when the limit resets, in epoch milliseconds. */
      resetsAt?: number;
    }
  | { kind: "queued"; count: number };

export interface WorkspaceFleetAgent {
  agentId: string;
  status: WorkspaceFleetStatus;
  /** Messages that wait behind the running turn. Absent when none waits. */
  queued?: number;
  /** The last step of the running turn. */
  currentStep?: string;
  currentStepKind?: WorkspaceStepKind;
  /** The estimated cost of today's usage, in the reader's time zone. Absent when no usage was priced. */
  todayCostUsd?: number;
  /** The time today's turns ran, the running one up to now. */
  todayDurationMs?: number;
  lastActiveAt?: number;
}

export interface WorkspaceFleet {
  agents: WorkspaceFleetAgent[];
  /** The revision of the last `workspace-fleet-changed` event the host sent. */
  revision: number;
  at: number;
}

export interface WorkspaceFleetInput {
  /** An IANA time zone for "today". The host's own when absent or unknown. */
  timeZone?: string;
}

export interface WorkspaceStep {
  /** The provider's item id. */
  id: string;
  kind: WorkspaceStepKind;
  label: string;
  /** A shell command, a path or a query, when the label is a summary of it. */
  detail?: string;
  status: "running" | "done" | "failed";
  at: number;
  durationMs?: number;
}

/** The step trail of the turn that wrote one agent message of a channel. */
export interface WorkspaceSteps {
  /** The last `WORKSPACE_STEP_LIMIT` steps, in start order. */
  steps: WorkspaceStep[];
  /** All the steps of the turn. */
  total: number;
  durationMs: number;
  streaming: boolean;
  startedAt?: number;
  costUsd?: number;
}

export interface WorkspaceStepsInput {
  channelId: string;
  messageId: string;
}

export const WORKSPACE_ARTIFACT_KINDS = ["website", "app", "doc", "deck", "dashboard", "file"] as const;
export type WorkspaceArtifactKind = (typeof WORKSPACE_ARTIFACT_KINDS)[number];

/**
 * Where the host found an artifact: a link in an agent message, a site the agent published on
 * openbot.site, a visual reply (an HTML page above a reply), or a file an agent attached.
 */
export const WORKSPACE_ARTIFACT_SOURCES = ["link", "site", "render", "attachment"] as const;
export type WorkspaceArtifactSource = (typeof WORKSPACE_ARTIFACT_SOURCES)[number];

/** The file of an attachment artifact. The client opens it as it opens the attachment of the message. */
export interface WorkspaceArtifactFile {
  id: string;
  name: string;
  size: number;
  mimeType: string;
}

export interface WorkspaceArtifactRecord {
  /** Stable for one URL or one attachment. */
  id: string;
  kind: WorkspaceArtifactKind;
  source: WorkspaceArtifactSource;
  title: string;
  description?: string;
  url?: string;
  /** An http or https image address for the card. */
  thumbnailUrl?: string;
  /**
   * The version of the image that the host drew of the page at `url`. The client reads the image
   * from the host with this version: `workspaceArtifactThumbnailRoute` over the Team API.
   */
  thumbnailVersion?: string;
  file?: WorkspaceArtifactFile;
  /** The agent whose message first shared it. */
  agentId?: string;
  /** The channel of that message. Absent for a message of the agent's own chat or tasks. */
  channelId?: string;
  /** The channel message, or the message of the agent's conversation when `channelId` is absent. */
  messageId?: string;
  threadRootId?: string;
  createdAt: number;
  /** The last message that shared it. */
  updatedAt: number;
  /** The cost and the time of the turn that first shared it, when the host knows them. */
  costUsd?: number;
  durationMs?: number;
}

export interface WorkspaceArtifacts {
  /** The newest first, by `updatedAt`. */
  artifacts: WorkspaceArtifactRecord[];
}

export interface WorkspaceArtifactsInput {
  /** Only this channel. Every channel the reader sees and every agent chat they can read when absent. */
  channelId?: string;
  limit?: number;
}

function isTime(value: unknown): value is number {
  return integerInRange(value, 0, Number.MAX_SAFE_INTEGER);
}

function isCost(value: unknown): value is number {
  return isNumber(value) && Number.isFinite(value) && value >= 0;
}

function optional(value: unknown, guard: (value: unknown) => boolean): boolean {
  return value === undefined || guard(value);
}

function isFleetText(value: unknown): value is string {
  return isBoundedString(value, WORKSPACE_FLEET_TEXT_LIMIT);
}

export function isWorkspaceFleetStatus(value: unknown): value is WorkspaceFleetStatus {
  if (!isDynamicRecord(value)) return false;
  switch (value.kind) {
    case "idle":
      return true;
    case "working":
      return (
        isFleetText(value.what) &&
        optional(value.channelId, isIdentifier) &&
        optional(value.threadRootId, isIdentifier) &&
        optional(value.taskId, isIdentifier) &&
        isTime(value.startedAt)
      );
    case "waiting":
      return (
        isOneOf(WORKSPACE_WAIT_REASONS, value.reason) &&
        isFleetText(value.what) &&
        optional(value.forMemberId, isIdentifier) &&
        optional(value.channelId, isIdentifier) &&
        optional(value.threadRootId, isIdentifier) &&
        optional(value.resetsAt, isTime)
      );
    case "queued":
      return integerInRange(value.count, 1, Number.MAX_SAFE_INTEGER);
    default:
      return false;
  }
}

function isWorkspaceFleetAgent(value: unknown): value is WorkspaceFleetAgent {
  return (
    isDynamicRecord(value) &&
    isIdentifier(value.agentId) &&
    isWorkspaceFleetStatus(value.status) &&
    optional(value.queued, (count) => integerInRange(count, 1, Number.MAX_SAFE_INTEGER)) &&
    optional(value.currentStep, isFleetText) &&
    optional(value.currentStepKind, (kind) => isOneOf(WORKSPACE_STEP_KINDS, kind)) &&
    optional(value.todayCostUsd, isCost) &&
    optional(value.todayDurationMs, isTime) &&
    optional(value.lastActiveAt, isTime)
  );
}

export function decodeWorkspaceFleet(value: unknown): WorkspaceFleet {
  if (
    !isDynamicRecord(value) ||
    !Array.isArray(value.agents) ||
    value.agents.length > WORKSPACE_FLEET_AGENT_LIMIT ||
    !value.agents.every(isWorkspaceFleetAgent) ||
    !isTime(value.revision) ||
    !isTime(value.at)
  )
    throw new Error("Invalid workspace fleet.");
  return { agents: value.agents, revision: value.revision, at: value.at };
}

function isWorkspaceStep(value: unknown): value is WorkspaceStep {
  return (
    isDynamicRecord(value) &&
    isIdentifier(value.id) &&
    isOneOf(WORKSPACE_STEP_KINDS, value.kind) &&
    isBoundedString(value.label, WORKSPACE_STEP_LABEL_LIMIT) &&
    optional(value.detail, (detail) => isBoundedString(detail, WORKSPACE_STEP_DETAIL_LIMIT)) &&
    isOneOf(["running", "done", "failed"] as const, value.status) &&
    isTime(value.at) &&
    optional(value.durationMs, isTime)
  );
}

export function decodeWorkspaceSteps(value: unknown): WorkspaceSteps {
  if (
    !isDynamicRecord(value) ||
    !Array.isArray(value.steps) ||
    value.steps.length > WORKSPACE_STEP_LIMIT ||
    !value.steps.every(isWorkspaceStep) ||
    !isTime(value.total) ||
    value.total < value.steps.length ||
    !isTime(value.durationMs) ||
    !isBoolean(value.streaming) ||
    !optional(value.startedAt, isTime) ||
    !optional(value.costUsd, isCost)
  )
    throw new Error("Invalid workspace steps.");
  const steps: WorkspaceSteps = {
    steps: value.steps,
    total: value.total,
    durationMs: value.durationMs,
    streaming: value.streaming,
  };
  if (isTime(value.startedAt)) steps.startedAt = value.startedAt;
  if (isCost(value.costUsd)) steps.costUsd = value.costUsd;
  return steps;
}

function isArtifactFile(value: unknown): value is WorkspaceArtifactFile {
  return (
    isDynamicRecord(value) &&
    isIdentifier(value.id) &&
    isBoundedString(value.name, INPUT_LIMITS.attachmentName) &&
    isTime(value.size) &&
    isBoundedString(value.mimeType, INPUT_LIMITS.mimeType)
  );
}

function isArtifactUrl(value: unknown): boolean {
  if (!isBoundedString(value, WORKSPACE_ARTIFACT_URL_LIMIT)) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}

/** A host thumbnail version: letters, digits, `-` and `_`, at most 64. */
export function isWorkspaceThumbnailVersion(value: unknown): value is string {
  return isBoundedString(value, WORKSPACE_ARTIFACT_THUMBNAIL_VERSION_LIMIT) && /^[A-Za-z0-9_-]+$/u.test(value);
}

function isWorkspaceArtifactRecord(value: unknown): value is WorkspaceArtifactRecord {
  return (
    isDynamicRecord(value) &&
    isBoundedString(value.id, 300) &&
    value.id.length > 0 &&
    isOneOf(WORKSPACE_ARTIFACT_KINDS, value.kind) &&
    isOneOf(WORKSPACE_ARTIFACT_SOURCES, value.source) &&
    isBoundedString(value.title, WORKSPACE_ARTIFACT_TITLE_LIMIT) &&
    optional(value.description, (text) => isBoundedString(text, WORKSPACE_ARTIFACT_DESCRIPTION_LIMIT)) &&
    optional(value.url, isArtifactUrl) &&
    optional(value.thumbnailUrl, isArtifactUrl) &&
    optional(value.thumbnailVersion, isWorkspaceThumbnailVersion) &&
    optional(value.file, isArtifactFile) &&
    optional(value.agentId, isIdentifier) &&
    optional(value.channelId, isIdentifier) &&
    optional(value.messageId, isIdentifier) &&
    optional(value.threadRootId, isIdentifier) &&
    isTime(value.createdAt) &&
    isTime(value.updatedAt) &&
    optional(value.costUsd, isCost) &&
    optional(value.durationMs, isTime)
  );
}

export function decodeWorkspaceArtifacts(value: unknown): WorkspaceArtifacts {
  if (
    !isDynamicRecord(value) ||
    !Array.isArray(value.artifacts) ||
    value.artifacts.length > WORKSPACE_ARTIFACT_LIMIT ||
    !value.artifacts.every(isWorkspaceArtifactRecord)
  )
    throw new Error("Invalid workspace artifacts.");
  return { artifacts: value.artifacts };
}

function isTimeZone(value: unknown): value is string {
  return isBoundedString(value, WORKSPACE_TIME_ZONE_LIMIT) && value.length > 0;
}

export function parseWorkspaceFleetInput(value: unknown): WorkspaceFleetInput {
  if (value === undefined || value === null) return {};
  if (!isDynamicRecord(value) || !optional(value.timeZone, isTimeZone))
    throw new Error("Invalid workspace fleet input.");
  return isTimeZone(value.timeZone) ? { timeZone: value.timeZone } : {};
}

export function parseWorkspaceStepsInput(value: unknown): WorkspaceStepsInput {
  if (!isDynamicRecord(value) || !isIdentifier(value.channelId) || !isIdentifier(value.messageId))
    throw new Error("Invalid workspace steps input.");
  return { channelId: value.channelId, messageId: value.messageId };
}

export function parseWorkspaceArtifactsInput(value: unknown): WorkspaceArtifactsInput {
  if (value === undefined || value === null) return {};
  if (
    !isDynamicRecord(value) ||
    !optional(value.channelId, isIdentifier) ||
    !optional(value.limit, (limit) => integerInRange(limit, 1, WORKSPACE_ARTIFACT_LIMIT))
  )
    throw new Error("Invalid workspace artifacts input.");
  const input: WorkspaceArtifactsInput = {};
  if (isIdentifier(value.channelId)) input.channelId = value.channelId;
  if (integerInRange(value.limit, 1, WORKSPACE_ARTIFACT_LIMIT)) input.limit = value.limit;
  return input;
}

/** Whether `value` is the body of a `workspace-fleet-changed` event. */
export function isWorkspaceFleetChange(value: DynamicRecord): boolean {
  return isTime(value.revision);
}

// --- Between agents: the messages that agents send each other ------------------------------------

export const WORKSPACE_AGENT_PAIR_LIMIT = 200;
export const WORKSPACE_AGENT_EXCHANGE_LIMIT = 100;
/** The longest text of one message between agents that the host sends. A longer one is cut. */
export const WORKSPACE_AGENT_EXCHANGE_TEXT_LIMIT = 8_000;
export const WORKSPACE_AGENT_EXCHANGE_RECIPIENT_LIMIT = 20;

/** Two agents that sent each other messages: the count of both directions, and the newest one. */
export interface WorkspaceAgentPair {
  /** The two agent ids, in the order of the strings. */
  agentIds: [string, string];
  count: number;
  lastAt: number;
  lastSenderId: string;
  /** The start of the newest message, at most `WORKSPACE_FLEET_TEXT_LIMIT`. */
  lastText: string;
}

export interface WorkspaceAgentPairs {
  /** The newest first, by `lastAt`. Only pairs of agents that the reader can see. */
  pairs: WorkspaceAgentPair[];
}

export interface WorkspaceAgentPairsInput {
  /** Only the pairs of this agent. */
  agentId?: string;
  limit?: number;
}

/** One message from an agent to one or more agents, as `send_message` sent it. */
export interface WorkspaceAgentExchangeMessage {
  id: string;
  senderAgentId: string;
  recipientAgentIds: string[];
  text: string;
  /** The host cut the text at `WORKSPACE_AGENT_EXCHANGE_TEXT_LIMIT`. */
  truncated?: boolean;
  createdAt: number;
  replyToMessageId?: string;
  attachmentCount?: number;
}

export interface WorkspaceAgentExchange {
  /** The oldest first. */
  messages: WorkspaceAgentExchangeMessage[];
  /** Older messages exist before the first one. */
  hasOlder: boolean;
}

export interface WorkspaceAgentExchangeInput {
  agentIds: [string, string];
  /** Only messages older than this time, for the previous page. */
  before?: number;
  limit?: number;
}

function isAgentPair(value: unknown): value is [string, string] {
  return Array.isArray(value) && value.length === 2 && value.every(isIdentifier) && value[0] !== value[1];
}

function isWorkspaceAgentPair(value: unknown): value is WorkspaceAgentPair {
  return (
    isDynamicRecord(value) &&
    isAgentPair(value.agentIds) &&
    isTime(value.count) &&
    isTime(value.lastAt) &&
    isIdentifier(value.lastSenderId) &&
    isBoundedString(value.lastText, WORKSPACE_FLEET_TEXT_LIMIT)
  );
}

function isWorkspaceAgentExchangeMessage(value: unknown): value is WorkspaceAgentExchangeMessage {
  return (
    isDynamicRecord(value) &&
    isIdentifier(value.id) &&
    isIdentifier(value.senderAgentId) &&
    Array.isArray(value.recipientAgentIds) &&
    value.recipientAgentIds.length <= WORKSPACE_AGENT_EXCHANGE_RECIPIENT_LIMIT &&
    value.recipientAgentIds.every(isIdentifier) &&
    isBoundedString(value.text, WORKSPACE_AGENT_EXCHANGE_TEXT_LIMIT) &&
    optional(value.truncated, isBoolean) &&
    isTime(value.createdAt) &&
    optional(value.replyToMessageId, isIdentifier) &&
    optional(value.attachmentCount, isTime)
  );
}

export function decodeWorkspaceAgentPairs(value: unknown): WorkspaceAgentPairs {
  if (
    !isDynamicRecord(value) ||
    !Array.isArray(value.pairs) ||
    value.pairs.length > WORKSPACE_AGENT_PAIR_LIMIT ||
    !value.pairs.every(isWorkspaceAgentPair)
  )
    throw new Error("Invalid agent pairs.");
  return { pairs: value.pairs };
}

export function decodeWorkspaceAgentExchange(value: unknown): WorkspaceAgentExchange {
  if (
    !isDynamicRecord(value) ||
    !Array.isArray(value.messages) ||
    value.messages.length > WORKSPACE_AGENT_EXCHANGE_LIMIT ||
    !value.messages.every(isWorkspaceAgentExchangeMessage) ||
    !isBoolean(value.hasOlder)
  )
    throw new Error("Invalid agent exchange.");
  return { messages: value.messages, hasOlder: value.hasOlder };
}

export function parseWorkspaceAgentPairsInput(value: unknown): WorkspaceAgentPairsInput {
  if (value === undefined || value === null) return {};
  if (
    !isDynamicRecord(value) ||
    !optional(value.agentId, isIdentifier) ||
    !optional(value.limit, (limit) => integerInRange(limit, 1, WORKSPACE_AGENT_PAIR_LIMIT))
  )
    throw new Error("Invalid agent pairs input.");
  const input: WorkspaceAgentPairsInput = {};
  if (isIdentifier(value.agentId)) input.agentId = value.agentId;
  if (integerInRange(value.limit, 1, WORKSPACE_AGENT_PAIR_LIMIT)) input.limit = value.limit;
  return input;
}

export function parseWorkspaceAgentExchangeInput(value: unknown): WorkspaceAgentExchangeInput {
  if (
    !isDynamicRecord(value) ||
    !isAgentPair(value.agentIds) ||
    !optional(value.before, isTime) ||
    !optional(value.limit, (limit) => integerInRange(limit, 1, WORKSPACE_AGENT_EXCHANGE_LIMIT))
  )
    throw new Error("Invalid agent exchange input.");
  const input: WorkspaceAgentExchangeInput = { agentIds: [value.agentIds[0], value.agentIds[1]] };
  if (isTime(value.before)) input.before = value.before;
  if (integerInRange(value.limit, 1, WORKSPACE_AGENT_EXCHANGE_LIMIT)) input.limit = value.limit;
  return input;
}
