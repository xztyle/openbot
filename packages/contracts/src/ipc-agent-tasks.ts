import { type AgentProviderId, agentProviderDescriptor } from "./agent-providers";
import { INPUT_LIMITS } from "./input-limits";
import { integerInRange, isBoundedString, isIdentifier } from "./ipc-bounded-values";
import { isDynamicRecord, isOneOf } from "./runtime-values";

/**
 * The most tasks of one agent that run a turn at the same time by the agent's own limit, next to its
 * own chat. Frozen by `agent-task-limit-v1`, `agent-tasks-v1` and the instance archive.
 */
export const AGENT_TASK_LIMIT_MAX = 4;
/**
 * The most that an owner or admin can set as the host default for agents with no limit of their own
 * (`HostTurnLimits.agentTaskLimit`, `host-turn-limits-v1`).
 */
export const HOST_AGENT_TASK_LIMIT_MAX = 64;
/** The built-in task limit of an agent that has no limit of its own, when the host sets no default. */
export const AGENT_TASK_LIMIT_DEFAULT = 2;

export function isAgentTaskLimit(value: unknown): value is number {
  return integerInRange(value, 1, AGENT_TASK_LIMIT_MAX);
}

/** A host default task limit, or a limit that follows it. */
export function isHostAgentTaskLimit(value: unknown): value is number {
  return integerInRange(value, 1, HOST_AGENT_TASK_LIMIT_MAX);
}

/**
 * How many tasks of the agent run a turn at the same time. A provider that runs one turn at a time
 * runs one task, and the agent's own chat waits for it. `hostDefault` is the limit of an agent that
 * has no limit of its own.
 */
export function agentTaskLimit(
  agent: { provider: AgentProviderId; taskLimit?: number },
  hostDefault: number = AGENT_TASK_LIMIT_DEFAULT,
): number {
  if (!agentProviderDescriptor(agent.provider).concurrentTurns) return 1;
  return agent.taskLimit ?? hostDefault;
}

export const AGENT_TASK_STATES = ["running", "queued", "idle", "closed"] as const;
export type AgentTaskState = (typeof AGENT_TASK_STATES)[number];

/**
 * Why the next message of a task waits:
 * - `task-limit`: the agent already runs as many tasks as its limit allows.
 * - `agent-restarting`: the agent's provider process restarts after another turn ends.
 * - `usage-limit`: the provider plan refused a turn, and the agent waits for the reset.
 * - `server-busy`: the computer runs as many turns as its memory allows.
 * - `agent-busy`: other agent work holds the agent, for example a profile save or a routine.
 * - `one-turn`: the provider runs one turn at a time, and another turn of the agent runs.
 */
export const AGENT_TASK_HOLDS = [
  "task-limit",
  "agent-restarting",
  "usage-limit",
  "server-busy",
  "agent-busy",
  "one-turn",
] as const;
export type AgentTaskHold = (typeof AGENT_TASK_HOLDS)[number];

export const AGENT_TASK_OUTCOMES = ["completed", "failed", "interrupted"] as const;
export type AgentTaskOutcome = (typeof AGENT_TASK_OUTCOMES)[number];

/** The most characters of a queued message that a task row shows. */
export const AGENT_TASK_QUEUED_PREVIEW = 500;

/** A message that waits to start in a task. */
export interface AgentTaskQueuedMessage {
  deliveryId: string;
  /** The start of the message, at most `AGENT_TASK_QUEUED_PREVIEW` characters. */
  text: string;
  createdAt: string;
}

/**
 * A second conversation of one agent. The agent keeps its identity, workspace and memories; the task
 * has its own thread, provider session, progress and stop. A joined server sends its tasks through the
 * optional `agent-tasks-v1` capability, in the frozen bounds of `team-protocol/agent-tasks-v1.ts`.
 */
export interface AgentTask {
  id: string;
  agentId: string;
  threadId: string;
  /** `agent`: the agent started it with its `start_task` tool. */
  origin: "user" | "agent";
  title: string;
  state: AgentTaskState;
  /** The end of the last turn. Null before the first turn ends. */
  outcome: AgentTaskOutcome | null;
  /** Set only when `state` is `queued`. */
  hold: AgentTaskHold | null;
  activeTurnId: string | null;
  /** What the running turn does now, as the agent's own chat shows it. Null when no turn runs. */
  progress: string | null;
  /** What the provider reported, redacted, when the last turn failed. Null when it reported nothing. */
  error: string | null;
  /** The messages that wait to start in this task, oldest first. */
  queuedMessages: AgentTaskQueuedMessage[];
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
}

export interface AgentTasksSnapshot {
  agentId: string;
  /** The open tasks first, then the newest closed ones. */
  tasks: AgentTask[];
  /** How many tasks can run a turn at the same time. */
  limit: number;
}

export interface StartAgentTaskInput {
  agentId: string;
  text: string;
  attachmentDraftIds?: string[];
  clientMessageId?: string;
}

/** Moves a queued message of the agent's own chat into a new task. */
export interface RunQueuedMessageAsTaskInput {
  agentId: string;
  deliveryId: string;
}

export interface AgentTaskInput {
  agentId: string;
  taskId: string;
}

function isAgentTaskQueuedMessage(value: unknown): value is AgentTaskQueuedMessage {
  return (
    isDynamicRecord(value) &&
    isIdentifier(value.deliveryId) &&
    isBoundedString(value.text, AGENT_TASK_QUEUED_PREVIEW) &&
    isBoundedString(value.createdAt, 160)
  );
}

export function isAgentTask(value: unknown): value is AgentTask {
  return (
    isDynamicRecord(value) &&
    isIdentifier(value.id) &&
    isIdentifier(value.agentId) &&
    isIdentifier(value.threadId) &&
    (value.origin === "user" || value.origin === "agent") &&
    isBoundedString(value.title, INPUT_LIMITS.agentTaskTitle) &&
    isOneOf(AGENT_TASK_STATES, value.state) &&
    (value.outcome === null || isOneOf(AGENT_TASK_OUTCOMES, value.outcome)) &&
    (value.hold === null || isOneOf(AGENT_TASK_HOLDS, value.hold)) &&
    (value.activeTurnId === null || isIdentifier(value.activeTurnId)) &&
    (value.progress === null || isBoundedString(value.progress, INPUT_LIMITS.agentTaskProgress)) &&
    (value.error === null || isBoundedString(value.error, INPUT_LIMITS.agentTaskError)) &&
    Array.isArray(value.queuedMessages) &&
    value.queuedMessages.every(isAgentTaskQueuedMessage) &&
    isBoundedString(value.createdAt, 160) &&
    isBoundedString(value.updatedAt, 160) &&
    (value.closedAt === null || isBoundedString(value.closedAt, 160))
  );
}

export function isAgentTasksSnapshot(value: unknown): value is AgentTasksSnapshot {
  return (
    isDynamicRecord(value) &&
    isIdentifier(value.agentId) &&
    Array.isArray(value.tasks) &&
    value.tasks.length <= INPUT_LIMITS.agentTasks &&
    value.tasks.every(isAgentTask) &&
    isHostAgentTaskLimit(value.limit)
  );
}
