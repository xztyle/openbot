import type {
  AgentEvent,
  AgentSummary,
  ConversationSnapshot,
  ConversationTurnTrace,
  WorkspaceArtifacts,
  WorkspaceArtifactsInput,
  WorkspaceFleet,
  WorkspaceFleetInput,
  WorkspaceSteps,
  WorkspaceStepsInput,
} from "@openbot/contracts/ipc";
import { sourceText } from "@openbot/i18n/source";
import { Effect } from "effect";
import type { AttentionRegistry } from "./agent/attention-registry";
import type { ChannelStore } from "./channel-store";
import { type ChannelViewer, canSeeChannel } from "./channel-visibility";
import type { MailboxStore } from "./mailbox-store";
import type { OpenBotDatabase } from "./openbot-database";
import { WorkspaceArtifactIndex } from "./workspace-artifacts";
import { WorkspaceFleetTracker } from "./workspace-fleet";
import { workspaceSteps } from "./workspace-steps";
import type { WorkspaceThumbnailMimeType, WorkspaceThumbnails } from "./workspace-thumbnails";

/** Usage of a running turn is read from this long before its start, as the turn trace reads it. */
const TURN_USAGE_MARGIN_MS = 60 * 60 * 1_000;

export interface WorkspaceInsightsOptions {
  agents(): readonly AgentSummary[];
  database: Pick<OpenBotDatabase, "workspace" | "usage">;
  channels: Pick<
    ChannelStore,
    "exists" | "get" | "ids" | "message" | "messages" | "messagesAfter" | "assignmentForDelivery" | "tasks"
  >;
  mailbox: Pick<MailboxStore, "fleetWork">;
  attention: Pick<AttentionRegistry, "waitingAgents">;
  /** The steps of a running turn so far. */
  liveTrace(turnId: string): ConversationTurnTrace | null;
  /**
   * Whether the host still runs this turn. The stored row closes a moment after the turn ends, so the
   * step trail of a finished turn reads this to stop streaming at once.
   */
  turnRunning?(turnId: string): boolean;
  /** The loaded conversation of an execution thread, which can be ahead of the stored one. */
  loadedSnapshot(threadId: string): ConversationSnapshot | undefined;
  agentTaskTitle(taskId: string): string | null;
  /** The usage limit that holds an agent's work now, as `UsageLimitGate.limitFor` answers. */
  usageLimit?(agentId: string): { resetsAt: number | null } | null;
  emit(event: AgentEvent): void;
  /** The host-only file of the artifact index. Omitted or null, the index is kept in memory only. */
  artifactsPath?: string | null;
  /** The thumbnails of the artifacts that are web pages. Omitted or null, no artifact has one. */
  thumbnails?: Pick<WorkspaceThumbnails, "request" | "version" | "file"> | null;
}

const NO_STEPS: WorkspaceSteps = { steps: [], total: 0, durationMs: 0, streaming: false };

/**
 * The fleet, step trail and artifact views of the workspace (phase 7). Owns the fleet tracker and the
 * artifact index, and checks what the reader may see: a channel through its visibility, an agent
 * through the caller's `visible` test (the roles of a Team API member; every agent for the host
 * user). The service hands it each agent event before the channels and the tasks take theirs.
 */
export class WorkspaceInsights {
  readonly #options: WorkspaceInsightsOptions;
  readonly #fleet: WorkspaceFleetTracker;
  readonly #artifacts: WorkspaceArtifactIndex;

  constructor(options: WorkspaceInsightsOptions) {
    this.#options = options;
    this.#fleet = new WorkspaceFleetTracker({
      agents: options.agents,
      database: options.database,
      mailbox: options.mailbox,
      attention: options.attention,
      liveTrace: options.liveTrace,
      agentTaskTitle: options.agentTaskTitle,
      ...(options.usageLimit ? { usageLimit: options.usageLimit } : {}),
      emit: options.emit,
      channelWork: (deliveryId) => {
        const assignment = options.channels.assignmentForDelivery(deliveryId);
        if (!assignment) return null;
        const task = options.channels.tasks(assignment.channelId).find((item) => item.id === assignment.taskId);
        const request = task ? options.channels.message(assignment.channelId, task.requestMessageId) : null;
        // A person's request; a routine, a bridged author or an agent names no team member.
        const requester =
          request?.author.kind === "member" && !request.externalAuthor && !request.author.id.startsWith("routine:")
            ? request.author.id
            : undefined;
        return {
          channelId: assignment.channelId,
          taskId: assignment.taskId,
          threadRootId: assignment.threadRootId,
          instruction: task?.instruction ?? null,
          ...(requester ? { requesterMemberId: requester } : {}),
        };
      },
    });
    this.#artifacts = new WorkspaceArtifactIndex({
      database: options.database,
      channels: options.channels,
      path: options.artifactsPath ?? null,
      thumbnails: options.thumbnails ?? null,
    });
  }

  observe(event: AgentEvent): void {
    this.#fleet.observe(event);
    this.#artifacts.observe(event);
  }

  /** Stops the fleet events and writes the artifact index file. */
  readonly stop = Effect.fn("WorkspaceInsights.stop")(function* (this: WorkspaceInsights) {
    this.#fleet.dispose();
    yield* this.#artifacts.stop();
  });

  fleet(input: WorkspaceFleetInput, visible: (agentId: string) => boolean = () => true): WorkspaceFleet {
    return this.#fleet.read(input, visible);
  }

  #requireChannel(channelId: string, viewer: ChannelViewer): void {
    const channels = this.#options.channels;
    if (!channels.exists(channelId) || !canSeeChannel(channels.get(channelId), viewer))
      throw new Error(sourceText("error.backend.channelNotFound"));
  }

  /** The step trail of the turn that wrote an agent message of a channel. Empty for any other message. */
  steps(input: WorkspaceStepsInput, viewer: ChannelViewer): WorkspaceSteps {
    this.#requireChannel(input.channelId, viewer);
    const message = this.#options.channels.message(input.channelId, input.messageId);
    if (!message || message.deletedAt) throw new Error(sourceText("error.backend.channelMessageNotFound"));
    const turnId = message.message.turnId;
    if (message.author.kind !== "agent" || !turnId) return NO_STEPS;
    const turn = this.#options.database.workspace.turn(turnId);
    if (!turn) {
      // A turn that just started can be ahead of its stored row.
      const live = this.#options.liveTrace(turnId);
      return live
        ? workspaceSteps({
            trace: live,
            messages: [],
            startedAt: live.startedAt,
            completedAt: null,
            running: true,
            now: Date.now(),
          })
        : NO_STEPS;
    }
    if (turn.agentId !== message.author.id) return NO_STEPS;
    const running =
      turn.status === "running" && turn.completedAt === null && (this.#options.turnRunning?.(turnId) ?? true);
    const loaded = this.#options.loadedSnapshot(turn.threadId);
    const messages =
      loaded?.agentId === turn.agentId
        ? loaded.messages.filter((item) => item.turnId === turnId)
        : this.#options.database.workspace.turnMessages(turn.threadId, turnId);
    const trace =
      (running ? this.#options.liveTrace(turnId) : null) ??
      messages.find((item) => item.trace)?.trace ??
      message.message.trace ??
      null;
    let costUsd = trace?.costUsd;
    if (costUsd === undefined && running) {
      const started = Date.parse(turn.startedAt);
      const since = new Date((Number.isFinite(started) ? started : Date.now()) - TURN_USAGE_MARGIN_MS).toISOString();
      costUsd = this.#options.database.usage.readTurnTotals(turn.agentId, turnId, since)?.costUsd;
    }
    return workspaceSteps({
      trace,
      messages,
      startedAt: turn.startedAt,
      completedAt: turn.completedAt,
      running,
      costUsd,
      now: Date.now(),
    });
  }

  /**
   * The artifacts the reader may see: those of the channels they see, and, without a channel, those
   * of the own conversations of the agents that `agentVisible` lets through.
   */
  artifacts(
    input: WorkspaceArtifactsInput,
    viewer: ChannelViewer,
    agentVisible: (agentId: string) => boolean = () => true,
  ): WorkspaceArtifacts {
    const channels = this.#options.channels;
    if (input.channelId) this.#requireChannel(input.channelId, viewer);
    const channelIds = input.channelId
      ? [input.channelId]
      : channels.ids().filter((channelId) => canSeeChannel(channels.get(channelId), viewer));
    const listed = new Set(this.#options.agents().map((agent) => agent.id));
    return this.#artifacts.list(input, {
      channelIds,
      agentVisible: (agentId) => listed.has(agentId) && agentVisible(agentId),
    });
  }

  #access(viewer: ChannelViewer, agentVisible: (agentId: string) => boolean) {
    const channels = this.#options.channels;
    const listed = new Set(this.#options.agents().map((agent) => agent.id));
    return {
      channelIds: channels.ids().filter((channelId) => canSeeChannel(channels.get(channelId), viewer)),
      agentVisible: (agentId: string) => listed.has(agentId) && agentVisible(agentId),
    };
  }

  /**
   * The thumbnail image of an artifact that the reader may see, when `version` is its current one.
   * Null for any other artifact or version.
   */
  artifactThumbnail(
    artifactId: string,
    version: string,
    viewer: ChannelViewer,
    agentVisible: (agentId: string) => boolean = () => true,
  ): { path: string; mimeType: WorkspaceThumbnailMimeType } | null {
    const file = this.#options.thumbnails?.file(artifactId, version) ?? null;
    if (!file || !this.#artifacts.visible(artifactId, this.#access(viewer, agentVisible))) return null;
    return file;
  }

  /** The thumbnail image of an artifact for the user of this computer, who sees every artifact. */
  localArtifactThumbnail(
    artifactId: string,
    version: string,
  ): { path: string; mimeType: WorkspaceThumbnailMimeType } | null {
    return this.#options.thumbnails?.file(artifactId, version) ?? null;
  }
}
