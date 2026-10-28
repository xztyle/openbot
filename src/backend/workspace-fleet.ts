import {
  type AgentEvent,
  type AgentSummary,
  analyticsDate,
  type ConversationTurnTrace,
  WORKSPACE_FLEET_EVENT_INTERVAL_MS,
  WORKSPACE_FLEET_TEXT_LIMIT,
  type WorkspaceFleet,
  type WorkspaceFleetAgent,
  type WorkspaceFleetInput,
  type WorkspaceFleetStatus,
  type WorkspaceStepKind,
} from "@openbot/contracts/ipc";
import { redactText } from "@openbot/logging";
import type { AttentionRegistry } from "./agent/attention-registry";
import type { MailboxStore } from "./mailbox-store";
import type { OpenBotDatabase } from "./openbot-database";
import { lastToolStep } from "./workspace-steps";

/** The channel task a delivery runs, as the fleet names it. */
export interface FleetChannelWork {
  channelId: string;
  taskId: string;
  threadRootId: string | null;
  instruction: string | null;
  /** The team member who wrote the request of the task, when a person did. */
  requesterMemberId?: string;
}

export interface WorkspaceFleetTrackerOptions {
  agents(): readonly AgentSummary[];
  database: Pick<OpenBotDatabase, "workspace">;
  mailbox: Pick<MailboxStore, "fleetWork">;
  attention: Pick<AttentionRegistry, "waitingAgents">;
  liveTrace(turnId: string): ConversationTurnTrace | null;
  channelWork(deliveryId: string): FleetChannelWork | null;
  agentTaskTitle(taskId: string): string | null;
  /** The usage limit that holds an agent's work now: `resetsAt` in epoch seconds, or null. Null when none. */
  usageLimit?(agentId: string): { resetsAt: number | null } | null;
  emit(event: AgentEvent): void;
}

/** The read of today's usage is cached this long; a finished turn clears it. */
const TODAY_CACHE_MS = 15_000;
const DAY_MS = 86_400_000;

interface TodayTotals {
  costUsd: Map<string, number>;
  durationMs: Map<string, number>;
  lastActiveAt: Map<string, number>;
}

function line(text: string): string {
  const first =
    text
      .split(/\r?\n/u)
      .map((part) => part.trim())
      .find(Boolean) ?? "";
  const clean = redactText(first).replace(/\s+/gu, " ");
  return clean.length > WORKSPACE_FLEET_TEXT_LIMIT
    ? `${clean.slice(0, WORKSPACE_FLEET_TEXT_LIMIT - 1).trimEnd()}…`
    : clean;
}

function hostTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

function validTimeZone(timeZone: string | undefined): string {
  if (!timeZone) return hostTimeZone();
  try {
    analyticsDate(new Date(), timeZone);
    return timeZone;
  } catch {
    return hostTimeZone();
  }
}

/**
 * Owns the fleet view of the workspace: what each agent does now, its last step, and its cost and
 * time today. It reads the mailbox, the attention registry, the live turn traces and the usage
 * tables; it stores nothing. It sends `workspace-fleet-changed` at most once a second while agents
 * work, so a fleet view reads it again.
 */
export class WorkspaceFleetTracker {
  readonly #options: WorkspaceFleetTrackerOptions;
  /** The last progress line of each agent's running turn, for a turn with no labelled step yet. */
  readonly #progress = new Map<string, { turnId: string; text: string }>();
  readonly #today = new Map<string, { at: number; totals: TodayTotals }>();
  #revision = 0;
  #timer: ReturnType<typeof setTimeout> | null = null;

  constructor(options: WorkspaceFleetTrackerOptions) {
    this.#options = options;
  }

  /** Every agent event passes here before the channels and the tasks take theirs. */
  observe(event: AgentEvent): void {
    switch (event.type) {
      case "turn-progress":
        this.#progress.set(event.agentId, { turnId: event.turnId, text: event.detail });
        break;
      case "turn-completed":
        if (this.#progress.get(event.agentId)?.turnId === event.turnId) this.#progress.delete(event.agentId);
        this.#today.clear();
        break;
      case "turn-started":
      case "usage-limit-reached":
      case "queue-changed":
      case "runtime-snapshot":
      case "agents-changed":
        break;
      default:
        return;
    }
    this.#schedule();
  }

  #schedule(): void {
    if (this.#timer !== null) return;
    this.#timer = setTimeout(() => {
      this.#timer = null;
      this.#revision += 1;
      this.#options.emit({ type: "workspace-fleet-changed", revision: this.#revision });
    }, WORKSPACE_FLEET_EVENT_INTERVAL_MS);
    this.#timer.unref?.();
  }

  dispose(): void {
    if (this.#timer !== null) clearTimeout(this.#timer);
    this.#timer = null;
  }

  /** The fleet: each listed agent that is not hidden or in the background and that `visible` lets through. */
  read(input: WorkspaceFleetInput, visible: (agentId: string) => boolean): WorkspaceFleet {
    const now = Date.now();
    const agents = this.#options
      .agents()
      .filter((agent) => agent.hiddenAt === undefined && agent.background !== true && visible(agent.id));
    const work = this.#options.mailbox.fleetWork(WORKSPACE_FLEET_TEXT_LIMIT * 4);
    const waiting = this.#options.attention.waitingAgents();
    const today = this.#todayTotals(validTimeZone(input.timeZone), now);
    const runningTurnIds = agents.flatMap((agent) => {
      const turnId = work.get(agent.id)?.running?.turnId;
      return turnId ? [turnId] : [];
    });
    const turnStarts = new Map(
      this.#options.database.workspace.turns(runningTurnIds).map((turn) => [turn.turnId, turn.startedAt] as const),
    );
    return {
      revision: this.#revision,
      at: now,
      agents: agents.map((agent): WorkspaceFleetAgent => {
        const agentWork = work.get(agent.id);
        const running = agentWork?.running ?? null;
        const channel = running ? this.#options.channelWork(running.deliveryId) : null;
        const pending = waiting.get(agent.id);
        const limit = this.#options.usageLimit?.(agent.id) ?? null;
        // The person who must answer: who asked for the channel task, or who sent the running message.
        const forMemberId = channel ? channel.requesterMemberId : running?.senderMemberId;
        let status: WorkspaceFleetStatus;
        if (pending) {
          status = {
            kind: "waiting",
            reason: pending.reason,
            what: line(pending.what),
            ...(forMemberId ? { forMemberId } : {}),
            ...(channel ? { channelId: channel.channelId } : {}),
            ...(channel?.threadRootId ? { threadRootId: channel.threadRootId } : {}),
          };
        } else if (limit) {
          // A spent plan window holds the agent's work until it resets: no person has to answer.
          status = {
            kind: "waiting",
            reason: "usage-limit",
            what: line(channel?.instruction ?? running?.text ?? ""),
            ...(channel ? { channelId: channel.channelId } : {}),
            ...(channel?.threadRootId ? { threadRootId: channel.threadRootId } : {}),
            ...(limit.resetsAt === null ? {} : { resetsAt: limit.resetsAt * 1_000 }),
          };
        } else if (running) {
          const started = Date.parse(
            (running.turnId &&
              (turnStarts.get(running.turnId) ?? this.#options.liveTrace(running.turnId)?.startedAt)) ||
              running.createdAt,
          );
          const taskTitle = running.taskId ? this.#options.agentTaskTitle(running.taskId) : null;
          status = {
            kind: "working",
            what: line(channel?.instruction ?? taskTitle ?? running.routineName ?? running.text),
            ...(channel ? { channelId: channel.channelId } : {}),
            ...(channel?.threadRootId ? { threadRootId: channel.threadRootId } : {}),
            ...(channel ? { taskId: channel.taskId } : running.taskId ? { taskId: running.taskId } : {}),
            startedAt: Number.isFinite(started) ? started : now,
          };
        } else if (agentWork?.queued) {
          status = { kind: "queued", count: agentWork.queued };
        } else {
          status = { kind: "idle" };
        }
        const step = running?.turnId ? this.#currentStep(agent.id, running.turnId) : null;
        const queued = status.kind !== "queued" && agentWork?.queued ? agentWork.queued : 0;
        const cost = today.costUsd.get(agent.id);
        const duration = today.durationMs.get(agent.id);
        const updated = agent.updatedAt ? Date.parse(agent.updatedAt) : Number.NaN;
        const lastActiveAt = today.lastActiveAt.get(agent.id) ?? (Number.isFinite(updated) ? updated : undefined);
        return {
          agentId: agent.id,
          status,
          ...(queued ? { queued } : {}),
          ...(step ? { currentStep: step.label, currentStepKind: step.kind } : {}),
          ...(cost === undefined ? {} : { todayCostUsd: cost }),
          ...(duration === undefined ? {} : { todayDurationMs: duration }),
          ...(lastActiveAt === undefined ? {} : { lastActiveAt }),
        };
      }),
    };
  }

  #currentStep(agentId: string, turnId: string): { label: string; kind: WorkspaceStepKind } | null {
    const step = lastToolStep(this.#options.liveTrace(turnId));
    if (step) return { label: line(step.label), kind: step.kind };
    const progress = this.#progress.get(agentId);
    return progress?.turnId === turnId && progress.text.trim() ? { label: line(progress.text), kind: "tool" } : null;
  }

  /** Each agent's cost, turn time and last activity of the reader's day. */
  #todayTotals(timeZone: string, now: number): TodayTotals {
    const cached = this.#today.get(timeZone);
    if (cached && now - cached.at < TODAY_CACHE_MS) return cached.totals;
    const today = analyticsDate(new Date(now), timeZone);
    // A day in any time zone starts within the last 48 hours.
    const since = new Date(now - 2 * DAY_MS).toISOString();
    const isToday = (at: number) => Number.isFinite(at) && analyticsDate(new Date(at), timeZone) === today;
    const totals: TodayTotals = { costUsd: new Map(), durationMs: new Map(), lastActiveAt: new Map() };
    const queries = this.#options.database.workspace;
    for (const record of queries.usageSince(since)) {
      if (record.costUsd === null || !isToday(Date.parse(record.occurredAt))) continue;
      totals.costUsd.set(record.agentId, (totals.costUsd.get(record.agentId) ?? 0) + record.costUsd);
    }
    for (const turn of queries.turnsSince(since)) {
      const started = Date.parse(turn.startedAt);
      const completed = turn.completedAt ? Date.parse(turn.completedAt) : turn.status === "running" ? now : started;
      if (!Number.isFinite(started) || !Number.isFinite(completed)) continue;
      const last = Math.max(started, completed);
      if (last > (totals.lastActiveAt.get(turn.agentId) ?? 0)) totals.lastActiveAt.set(turn.agentId, last);
      if (!isToday(started)) continue;
      totals.durationMs.set(
        turn.agentId,
        (totals.durationMs.get(turn.agentId) ?? 0) + Math.max(0, completed - started),
      );
    }
    if (this.#today.size > 8) this.#today.clear();
    this.#today.set(timeZone, { at: now, totals });
    return totals;
  }
}
