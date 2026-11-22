import { randomUUID } from "node:crypto";
import type { SetAgentsSleepingInput, SetAgentsSleepingResult, SleepTarget } from "@openbot/contracts/agent-efficiency";
import { agentManagers } from "@openbot/contracts/agent-org";
import { chatVisualItemType } from "@openbot/contracts/chat-visual";
import { sortConversationMessages } from "@openbot/contracts/conversation-order";
import { INPUT_LIMITS } from "@openbot/contracts/input-limits";
import type {
  AgentModelChoice,
  AgentModelOption,
  AgentSummary,
  AvatarImageInput,
  ConversationMessage,
  CreateAgentInput,
  McpServerConfig,
  SidebarLayoutSnapshot,
  UpdateAgentInput,
} from "@openbot/contracts/ipc";
import {
  agentAccessRank,
  agentComputerUseEnabled,
  agentNewChatAllowed,
  agentQuickAcknowledgementEnabled,
  CONNECTOR_IDS,
  isBackgroundAgent,
  isMessageReaction,
  isQueuedAgentNote,
  marketplaceSuggestionItemType,
  mcpSignInItemType,
  skillConversationEventItemType,
  VAULT_CHANGE_ITEM_TYPE,
  workspaceAccessEnforced,
} from "@openbot/contracts/ipc";
import { isString } from "@openbot/contracts/runtime-values";
import { isUiBlockId, normalizeUiBlockSpec } from "@openbot/contracts/ui-blocks";
import { sourceText } from "@openbot/i18n/source";
import { createOpenBotLogger, redactText } from "@openbot/logging";
import { Effect, Result } from "effect";
import { z } from "zod";
import pluginCatalog from "../../../resources/plugin-catalog/catalog.json";
import { type AgentApiKeys, removeKeySourceFile, SHARED_API_KEY_SCOPE } from "../agent-api-keys";
import type { AgentClient, AgentProvider } from "../agent-client";
import type { SpaceAgentTables } from "../agent-data/space-agent-tables";
import type { AgentStore } from "../agent-store";
import type { AgentTasks } from "../agent-tasks/agent-tasks";
import type { AgentWaits } from "../agent-waits/agent-waits";
import { OPENBOT_BROWSER_NAMESPACE } from "../browser-tools";
import type { ChannelService } from "../channel-service";
import {
  AGENT_CREATION_WINDOW_MS,
  AGENT_MESSAGE_FANOUT_LIMIT,
  AGENT_MESSAGE_LIMIT,
  AGENT_MESSAGE_WINDOW_MS,
} from "../collaboration-limits";
import type { ProviderSession } from "../database/provider-sessions";
import type { EventCheckScheduler } from "../event-check-scheduler";
import type { GuardrailsService } from "../guardrails/guardrails-service";
import type { LoopService } from "../loops/loop-service";
import type { MailboxStore } from "../mailbox-store";
import { agentMcpServers } from "../mcp-provider-shapes";
import type { MessagingThreads } from "../messaging/messaging-threads";
import { MESSAGING_OUTBOUND_TOOLS } from "../messaging/messaging-tools";
import {
  ACKNOWLEDGE_REQUEST_ACTIONS,
  acknowledgeRequestToolSchema,
  askUiToolSchema,
  CHAT_VISUAL_PREVIEW_DEFAULT_WIDTH,
  goalsToolSchema,
  htmlPreviewToolSchema,
  htmlRenderToolSchema,
  logDecisionToolSchema,
  normalizeSendMessageArguments,
  postCardToolSchema,
  removeApiKeyToolSchema,
  reportValidationToolSchema,
  requestApiKeyToolSchema,
  routineReportFailureToolSchema,
  SEND_MESSAGE_USAGE,
  saveApiKeyToolSchema,
  spaceMemoryToolSchema,
} from "../openbot-tools";
import type { OwnerAwayService } from "../owner-away";
import { type AppServerRequest, type DynamicToolCallParams, type DynamicToolResult, isRecord } from "../protocol";
import { handleRoutineFlowTool, type RoutineFlowTools } from "../routine-flows/routine-flow-tools";
import { auditActor, NO_SECURITY_AUDIT, type SecurityAuditSink } from "../security-audit-log";
import { agentSeesChannel, crossSpaceRefusal } from "../spaces/space-scope";
import type { StoredStateFailure } from "../stored-state-effects";
import type { TrustService } from "../trust/trust-service";
import { TRUST_CHECK_METHOD, TrustToolGate } from "../trust/trust-tool-gate";
import type { SharePreviewDrawer } from "../workspace-thumbnails";
import { AgentInterruptTool } from "./agent-interrupt-tool";
import type { AgentMemories } from "./agent-memories";
import { type ApprovalAutomationPolicy, NO_APPROVAL_AUTOMATION } from "./approval-automation";
import type { AttachmentGateway } from "./attachment-gateway";
import type { AttentionRegistry } from "./attention-registry";
import { loadAvatarFile } from "./avatar-file";
import type { BrowserUploads } from "./browser-uploads";
import { handleChannelAdminTool } from "./channel-admin-tools";
import type { ChatVisualPreviewHost } from "./chat-visual-preview";
import type { ConversationRuntime } from "./conversation-runtime";
import { handleDataTool } from "./data-tools";
import type { DelegationFollowUp } from "./delegation-follow-up";
import { responseAttachmentMessageId, visualReplyFileName, visualReplyMessageId } from "./delivery-content";
import type { DrainScheduler } from "./drain-scheduler";
import { handleEventCheckTool } from "./event-check-tools";
import { HistoryTools } from "./history-tools";
import type { HostedSiteCoordinator } from "./hosted-site-coordinator";
import { isHostedSiteMutationTool } from "./hosted-site-events";
import { handleLoopTool } from "./loop-tools";
import { type AgentMailPort, MAIL_TOOLS, parseMailToolCall } from "./mail-tools";
import type { MailboxSync } from "./mailbox-sync";
import { type AgentMcpServers, handleMcpServerTool, isMcpServerTool } from "./mcp-tools";
import {
  agentAccountSetup,
  listModelsPayload,
  modelList,
  type ProviderAccountRows,
  requestedBackupModels,
  requestedRuntime,
  requestedToolModel,
  requireReasoningEffort,
} from "./model-tools";
import {
  handleOrderTool,
  looksLikeOrder,
  needsPlan,
  type OrderCard,
  type OrderCardsPort,
  OrderPlans,
  orderCardSchema,
  planApprover,
} from "./order-tools";
import { OWNER_TOOL_NAMES, OwnerTools } from "./owner-tools";
import {
  createAgentToolSchema,
  listModelsToolSchema,
  newAgentLimits,
  PROFILE_TOOL_NAMES,
  profileToolErrorMessage,
  readAgentToolSchema,
  restrictionInput,
  updateProfileToolSchema,
  widensAgentSettings,
} from "./profile-tools";
import { apiKeyFormSpec, browserUserControlResult, commandText } from "./prompts";
import { ROUTINE_NO_UPDATE_TOOL, ROUTINE_REPORT_FAILURE_TOOL } from "./routine-quiet-runs";
import type { RoutineScheduler } from "./routine-scheduler";
import { type OpenBotToolResponse, openBotToolFailure, openBotToolResult } from "./routine-tools";
import {
  captureScreenToolSchema,
  type ScreenCaptureFailed,
  type ScreenCaptureHost,
  type ScreenCaptureImage,
  type ScreenCaptureRequest,
} from "./screen-capture";
import { type AgentSidebar, handleSidebarTool } from "./sidebar-tools";
import { LOCAL_SKILL_TOOL_DEFINITIONS, type LocalSkillTools, runLocalSkillTool } from "./skill-tools";
import { isDynamicToolCall } from "./thread-items";
import { toolCallIdempotencyKey } from "./tool-call-idempotency";
import { discoverTools, resolveDeferredTool, ToolDiscoveryError } from "./tool-catalog";
import { ToolOperationFailed, toolStep, toToolOperationFailed } from "./tool-operation";
import type { AgentBrowserHost } from "./turn-lifecycle";
import { handleUpdateAgentsTool } from "./update-agents-tool";
import type { WideResearch } from "./wide-research";

const logger = createOpenBotLogger("openbot-tool-router");

/** How long the plan card of `acknowledge_request` waits before the host presses its start button. */
const ACKNOWLEDGE_START_MS = 10_000;

/** The tools that `#apiKeyTool` answers. */
const API_KEY_TOOLS: ReadonlySet<string> = new Set([
  "request_api_key",
  "save_api_key",
  "list_api_keys",
  "remove_api_key",
]);

/** The Marketplace apps that the chat draws a card for: the bundled catalog plugins and the connectors. */
const MARKETPLACE_APP_IDS: readonly string[] = [
  ...pluginCatalog.plugins.map((plugin) => plugin.slug),
  ...CONNECTOR_IDS,
];

/** The reason says what to grant or to correct, and holds no screen content. */
function captureFailure(failure: ScreenCaptureFailed) {
  return openBotToolFailure(failure.reason);
}

/** The log fields for a cancelled call, with the reason the client gave when it cancelled it. */
function cancelContext<T extends object>(
  context: T,
  request: { signal?: AbortSignal | undefined },
): T & { reason: string } {
  const reason = request.signal?.reason;
  return { ...context, reason: typeof reason === "string" ? reason : "turn ended or provider stopped" };
}

export interface OpenBotToolRouterHooks {
  listAgents(): AgentSummary[];
  listModels(): AgentModelOption[];
  /** The accounts of a signed-in provider, as the settings page lists them. */
  providerAccounts: ProviderAccountRows;
  preferredProvider(): AgentProvider;
  /**
   * `creatorAgentId` is the agent that calls the tool: the new agent's first task comes from it, as a
   * request that expects a result.
   */
  createAgent(
    input: CreateAgentInput,
    configure?: (agent: AgentSummary) => Effect.Effect<AgentSummary, ToolOperationFailed>,
    creatorAgentId?: string,
  ): Effect.Effect<AgentSummary, ToolOperationFailed>;
  /** `initiatingAgentId` is the calling agent, recorded with a model change. */
  updateAgent(input: UpdateAgentInput, initiatingAgentId: string): Effect.Effect<AgentSummary, ToolOperationFailed>;
  setAvatar(agentId: string, image: AvatarImageInput | null): Effect.Effect<AgentSummary, ToolOperationFailed>;
  /** The MCP servers of this computer that are turned on, before the Computer Use setting of one agent. */
  enabledMcpServers(): McpServerConfig[];
  emitError(code: string, error: unknown, agentId?: string): void;
  /** Masks the MCP secret values and handoff values that `redactText` does not know. */
  redactMcp(text: string): string;
  /** True while the provider runs a turn for this agent, a context compaction included. */
  runsTurn(agentId: string): boolean;
  /** Takes a queued message into the running turn of a busy agent, when that agent steers by default. */
  steerWhenBusy(agentId: string, deliveryId: string): Effect.Effect<void>;
  /** `false` when the turn no longer runs or `mayStop` refuses, so no stop was sent. */
  interrupt(agentId: string, turnId: string, mayStop: () => boolean): Effect.Effect<boolean, ToolOperationFailed>;
  /** Epoch milliseconds from the turn lifecycle; null when this process has not seen the event. */
  turnActivity(agentId: string, turnId: string | null): { startedAt: number | null; lastEventAt: number | null };
  /** True while the newest turn of this agent failed and no later turn has completed. */
  lastTurnFailed(agentId: string): boolean;
  /** The plan limit that holds this agent, with its reset in epoch seconds when the provider gave one. */
  usageLimit(agentId: string): { resetsAt: number | null } | null;
  /** How many agents other agents may create in `AGENT_CREATION_WINDOW_MS`, or null for no limit. */
  agentCreationLimit(): number | null;
  /** Records a no-update tool call for the turn; null when no routine run started the turn. */
  requestNoUpdate(agentId: string, threadId: string, turnId: string): "quiet" | "shown" | null;
  /** Records the reason a routine run failed for the turn; false when no routine run started the turn. */
  reportRoutineFailure(agentId: string, turnId: string, reason: string): boolean;
  /** Starts a new chat with the agent when its turn ends and its queue is empty. */
  requestNewChat(agentId: string): void;
  /** The next turn of the agent runs on the large model. False when the agent has a fixed model. */
  escalateModel(agentId: string): boolean;
  /** The agents that a sleep request names (`AgentService.sleepTargetAgentIds`). */
  sleepTargetAgentIds(target: SleepTarget): string[];
  setAgentsSleeping(input: SetAgentsSleepingInput): Effect.Effect<SetAgentsSleepingResult, ToolOperationFailed>;
  /** Records an agent's proposal for a playbook it has. Answers an error for the agent, or null. */
  proposePlaybook(agentId: string, slug: string, content: string, note: string): Effect.Effect<string | null>;
  /** The host user of this computer, the owner of the server: the person of a channel that an agent makes. */
  channelHost(): { id: string; name: string };
  /** Puts a channel that does not exist yet in a space, and tells the readers of the spaces. */
  placeChannel(channelId: string, spaceId: string): void;
  /** `space_memory`: the shared memory of the agent's space. */
  spaceMemory?(
    agentId: string,
    turnId: string,
    input: z.infer<typeof spaceMemoryToolSchema>,
  ): Effect.Effect<OpenBotToolResponse>;
  /** Adds a decision to the decision log of the agent's space. */
  logSpaceDecision?(
    agentId: string,
    input: { decision: string; why: string; alternatives?: string | undefined; channelId?: string | undefined },
  ): Effect.Effect<void>;
  /** `post_card`: an interactive card in the chat of the turn. Absent before the portfolio service is attached. */
  postCard?(
    agentId: string,
    turnId: string,
    input: z.infer<typeof postCardToolSchema>,
  ): Effect.Effect<OpenBotToolResponse>;
  /** `report_validation`: the research agent's score of a new space from a template. */
  reportValidation?(
    agentId: string,
    input: z.infer<typeof reportValidationToolSchema>,
  ): Effect.Effect<OpenBotToolResponse>;
  /** The goals tool of the insight service; absent before the service is attached. */
  goals?(
    agentId: string,
    input: {
      action: "list" | "progress";
      goalId?: string | undefined;
      value?: number | undefined;
      note?: string | undefined;
    },
  ): Effect.Effect<unknown, { message: string }>;
}

export interface OpenBotToolRouterOptions {
  capturedSteps?: (session: ProviderSession) => Effect.Effect<Map<string, string> | null, ToolOperationFailed>;
  store: AgentStore;
  mailbox: MailboxStore;
  mailboxSync: MailboxSync;
  conversation: ConversationRuntime;
  attention: AttentionRegistry;
  browser: AgentBrowserHost;
  browserUploads: BrowserUploads;
  attachments: AttachmentGateway;
  channels: ChannelService;
  messaging: MessagingThreads;
  hostedSites: HostedSiteCoordinator;
  routines: RoutineScheduler;
  eventChecks: EventCheckScheduler;
  /** Receives the tool calls that change another agent. */
  audit?: SecurityAuditSink;
  memories: AgentMemories;
  waits: AgentWaits;
  tasks: AgentTasks;
  drain: DrainScheduler;
  followUp: DelegationFollowUp;
  tables: SpaceAgentTables | null;
  sidebarLayout: AgentSidebar | null;
  localSkillTools?: (() => LocalSkillTools) | undefined;
  routineFlowTools?: (() => RoutineFlowTools) | undefined;
  /** The loops of the spaces, for the loop tools. */
  loops?: (() => LoopService | null) | undefined;
  /** Makes the Motion card of an order (`send_message` with `card`); null where there is no Motion board. */
  orderCards?: (() => OrderCardsPort | null) | undefined;
  /** `wide_research`; absent, the tool answers that this host has none. */
  wideResearch?: WideResearch | null | undefined;
  /** The agent mailboxes for `email_reply` and `email_send`; null where the host has none. */
  mail?: (() => AgentMailPort | null) | undefined;
  approvalAutomation?: ApprovalAutomationPolicy | undefined;
  /** Draws pages for `html_preview`; null where no window can draw one. */
  visualPreview?: ChatVisualPreviewHost | null | undefined;
  /** Captures the desktop for `capture_screen`; null where this process has no desktop. */
  screenCapture?: ScreenCaptureHost | null | undefined;
  /** The MCP servers of this OpenBot server, for the MCP tools; null where nothing holds them. */
  mcpServers?: AgentMcpServers | null | undefined;
  /** The API keys that users saved for agents; null where nothing can save them. */
  apiKeys?: AgentApiKeys | null | undefined;
  /** `hold_for_owner`, `alert_owner` and `share_preview`; absent, they answer that this host has none. */
  ownerAway?: OwnerAwayService | null | undefined;
  /** Draws the pages of `share_preview`; null where no window can draw one. */
  sharePreviews?: SharePreviewDrawer | null | undefined;
  /** The trust policy and audit trail; null where nothing enforces one. */
  trust?: TrustService | null | undefined;
  /** The guardrails: the injection monitor and money approval expiry. Null where none run. */
  guardrails?: GuardrailsService | null | undefined;
  hooks: OpenBotToolRouterHooks;
}

/** Tools that take an `agentId` and change that agent's profile, instructions or skills. */
const CROSS_AGENT_TOOLS = new Set([
  "update_profile",
  "create_routine",
  "update_routine",
  "delete_routine",
  "install_local_skill",
  "set_skill_enabled",
  "uninstall_skill",
]);

/**
 * Owns the answer to every request a provider process sends to OpenBot: approvals and prompts go to
 * the attention registry, browser tools to the browser, and the `openbot` tools to the controller
 * that owns each one. The profile, reaction and `send_message` tools are answered here.
 *
 * It never imports the agent service facade.
 */
export class OpenBotToolRouter {
  readonly #history: HistoryTools;
  readonly #store: AgentStore;
  readonly #mailbox: MailboxStore;
  readonly #mailboxSync: MailboxSync;
  readonly #conversation: ConversationRuntime;
  readonly #attention: AttentionRegistry;
  readonly #browser: AgentBrowserHost;
  readonly #browserUploads: BrowserUploads;
  readonly #attachments: AttachmentGateway;
  readonly #channels: ChannelService;
  readonly #messaging: MessagingThreads;
  readonly #hostedSites: HostedSiteCoordinator;
  readonly #routines: RoutineScheduler;
  readonly #eventChecks: EventCheckScheduler;
  readonly #audit: SecurityAuditSink;
  readonly #memories: AgentMemories;
  readonly #waits: AgentWaits;
  readonly #tasks: AgentTasks;
  readonly #drain: DrainScheduler;
  readonly #tables: SpaceAgentTables | null;
  readonly #sidebarLayout: AgentSidebar | null;
  readonly #localSkillTools: (() => LocalSkillTools) | undefined;
  readonly #routineFlowTools: (() => RoutineFlowTools) | undefined;
  readonly #loops: (() => LoopService | null) | undefined;
  readonly #orderCards: (() => OrderCardsPort | null) | undefined;
  readonly #wideResearch: WideResearch | null;
  readonly #mail: (() => AgentMailPort | null) | undefined;
  readonly #plans: OrderPlans;
  readonly #approvalAutomation: ApprovalAutomationPolicy;
  readonly #visualPreview: ChatVisualPreviewHost | null;
  readonly #screenCapture: ScreenCaptureHost | null;
  readonly #mcpServers: AgentMcpServers | null;
  readonly #apiKeys: AgentApiKeys | null;
  readonly #hooks: OpenBotToolRouterHooks;
  readonly #interruptTool: AgentInterruptTool;
  readonly #ownerTools: OwnerTools;
  readonly #trust: TrustToolGate | null;
  readonly #guardrails: GuardrailsService | null;

  constructor(options: OpenBotToolRouterOptions) {
    this.#history = new HistoryTools({
      store: options.store,
      redact: options.hooks.redactMcp,
      capturedSteps: options.capturedSteps ?? (() => Effect.succeed(null)),
    });
    this.#store = options.store;
    this.#mailbox = options.mailbox;
    this.#mailboxSync = options.mailboxSync;
    this.#conversation = options.conversation;
    this.#attention = options.attention;
    this.#browser = options.browser;
    this.#browserUploads = options.browserUploads;
    this.#attachments = options.attachments;
    this.#channels = options.channels;
    this.#messaging = options.messaging;
    this.#hostedSites = options.hostedSites;
    this.#routines = options.routines;
    this.#eventChecks = options.eventChecks;
    this.#audit = options.audit ?? NO_SECURITY_AUDIT;
    this.#memories = options.memories;
    this.#waits = options.waits;
    this.#tasks = options.tasks;
    this.#drain = options.drain;
    this.#tables = options.tables;
    this.#sidebarLayout = options.sidebarLayout;
    this.#localSkillTools = options.localSkillTools;
    this.#routineFlowTools = options.routineFlowTools;
    this.#loops = options.loops;
    this.#orderCards = options.orderCards;
    this.#wideResearch = options.wideResearch ?? null;
    this.#mail = options.mail;
    this.#plans = new OrderPlans(options.store.database.userDataPath);
    this.#approvalAutomation = options.approvalAutomation ?? NO_APPROVAL_AUTOMATION;
    this.#visualPreview = options.visualPreview ?? null;
    this.#screenCapture = options.screenCapture ?? null;
    this.#mcpServers = options.mcpServers ?? null;
    this.#apiKeys = options.apiKeys ?? null;
    this.#hooks = options.hooks;
    this.#ownerTools = new OwnerTools({
      ownerAway: options.ownerAway ?? null,
      thumbnails: options.sharePreviews ?? null,
      visualPreview: options.visualPreview ?? null,
      attachments: options.attachments,
      mailbox: options.mailbox,
      conversation: options.conversation,
      teamChannel: (agentId, turnId) => options.channels.teamContext(agentId, turnId)?.channelId ?? null,
    });
    this.#trust = options.trust
      ? new TrustToolGate({
          trust: options.trust,
          attention: options.attention,
          agentForThread: (threadId) => options.conversation.agentForThread(threadId),
          publicThreadId: (agentId, threadId) => options.conversation.publicThreadId(agentId, threadId),
          listTabs: () => options.browser.listTabs(),
          messagingThread: (threadId) => options.messaging.linkForThread(threadId) !== null,
          guardrails: options.guardrails ?? null,
        })
      : null;
    this.#guardrails = options.guardrails ?? null;
    this.#interruptTool = new AgentInterruptTool({
      store: options.store,
      mailbox: options.mailbox,
      mailboxSync: options.mailboxSync,
      conversation: options.conversation,
      channels: options.channels,
      drain: options.drain,
      followUp: options.followUp,
      hooks: {
        listAgents: () => options.hooks.listAgents(),
        interrupt: (agentId, turnId, mayStop) => options.hooks.interrupt(agentId, turnId, mayStop),
      },
    });
  }

  readonly handle = Effect.fn("OpenBotToolRouter.handle")(function* (
    this: OpenBotToolRouter,
    client: AgentClient,
    request: AppServerRequest,
  ) {
    // What the log and the error event name when a tool call does not finish: which tool, which agent
    // and turn, and which provider. Only a dynamic tool call has them; another request names its method.
    const toolCall = isDynamicToolCall(request.params) ? request.params : null;
    const callContext = () => ({
      method: request.method,
      provider: client.provider,
      ...(toolCall
        ? {
            tool: `${toolCall.namespace ?? "openbot"}.${toolCall.tool}`,
            agentId: this.#conversation.agentForThread(toolCall.threadId),
            turnId: toolCall.turnId,
            callId: toolCall.callId,
          }
        : {}),
    });
    if (request.signal?.aborted) {
      // The provider ended the turn, or the process went away, before OpenBot started the call.
      if (toolCall) logger.warn("A tool call was cancelled before it ran.", cancelContext(callContext(), request));
      return;
    }
    request.signal?.addEventListener(
      "abort",
      () => {
        // The call keeps running until its own work stops, but the provider no longer waits for it.
        // The model then reports its tools as disconnected, so the log says why they were.
        if (toolCall)
          logger.warn("A tool call was cancelled before it answered.", cancelContext(callContext(), request));
        this.#attention.cancelRequest(client, request.id);
      },
      { once: true },
    );
    const reportFailure = (error: unknown) =>
      Effect.sync(() => {
        const cause = this.#hooks.redactMcp(String(error));
        const context = callContext();
        logger.warn(toolCall ? "A tool call failed." : "A server request failed.", {
          ...context,
          cause: cause.length > 500 ? `${cause.slice(0, 500)}…` : cause,
        });
        if (client.running) {
          try {
            // The provider shows this text to the model, which relays it to the user.
            client.respondError(request.id, { code: -32603, message: cause });
          } catch {
            // The process can exit between the running check and the write.
          }
        }
        this.#hooks.emitError(
          "server_request_failed",
          toolCall
            ? new Error(sourceText("error.agent.toolFailed", { tool: context.tool ?? "", reason: cause }))
            : error,
          context.agentId,
        );
      });
    return yield* Effect.gen({ self: this }, function* () {
      switch (request.method) {
        case "item/commandExecution/requestApproval":
          if (yield* this.#answeredMoneyCommand(client, request)) return;
          this.#attention.surfaceApproval(client, request, "command");
          return;
        case "item/fileChange/requestApproval":
          this.#attention.surfaceApproval(client, request, "file-change");
          return;
        case "item/permissions/requestApproval":
          this.#attention.surfaceApproval(client, request, "permissions");
          return;
        case "applyPatchApproval":
        case "execCommandApproval":
          if (request.method === "execCommandApproval" && (yield* this.#answeredMoneyCommand(client, request))) return;
          this.#attention.surfaceLegacyApproval(client, request);
          return;
        case "item/tool/call": {
          if (!isDynamicToolCall(request.params)) throw new Error("Invalid dynamic tool request.");
          let params = request.params;
          if (params.namespace === "openbot") {
            let discovery = params.tool === "tool_search" || params.tool === "tool_describe";
            if (params.tool === "tool_call") {
              const resolved = resolveDeferredTool(params);
              if (resolved.kind === "invalid") {
                client.respond(request.id, openBotToolFailure(resolved.message));
                return;
              }
              // A model sometimes calls tool_search or tool_describe through tool_call.
              discovery = resolved.kind === "discovery";
              params = resolved.params;
            }
            if (discovery) {
              const agentId = this.#conversation.agentForThread(params.threadId);
              if (!agentId) throw new Error("The calling Atelier agent is unknown.");
              try {
                const result = discoverTools(params, this.#requireAgent(agentId));
                client.respond(request.id, openBotToolResult(result));
              } catch (error) {
                // Only ToolDiscoveryError text is written for the agent; it names no argument value.
                client.respond(
                  request.id,
                  openBotToolFailure(
                    error instanceof ToolDiscoveryError ? error.message : sourceText("error.agent.toolRequestInvalid"),
                  ),
                );
              }
              return;
            }
          }
          if (params.namespace === "openbot" && (params.tool === "history_search" || params.tool === "history_read")) {
            const scope = this.#conversation.historyScope(params.threadId, client);
            if (!scope || this.#channels.store.channelForThread(scope.threadId)) {
              client.respond(request.id, openBotToolFailure(sourceText("error.agent.historyUnavailable")));
              return;
            }
            const result = yield* this.#history.call(scope.agentId, scope.threadId, params.tool, params.arguments).pipe(
              Effect.catch(() => Effect.succeed(openBotToolFailure(sourceText("error.agent.historyUnavailable")))),
              Effect.catchDefect(() =>
                Effect.succeed(openBotToolFailure(sourceText("error.agent.historyUnavailable"))),
              ),
            );
            const currentScope = this.#conversation.historyScope(params.threadId, client);
            if (!request.signal?.aborted && client.running)
              client.respond(
                request.id,
                currentScope?.threadId === scope.threadId
                  ? result
                  : openBotToolFailure(sourceText("error.agent.historyUnavailable")),
              );
            return;
          }
          // Keep the transport identifiers and abort signal; enter the original dispatch below.
          const toolRequest = { ...request, params };
          if (toolRequest.params.namespace === OPENBOT_BROWSER_NAMESPACE) {
            const agentId = this.#conversation.agentForThread(toolRequest.params.threadId);
            if (!agentId) throw new Error("The browsing Atelier agent is unknown.");
            if (toolRequest.params.tool === "request_takeover" || toolRequest.params.tool === "submit_secret") {
              // These calls wait for a person, so a call that never answers is only visible by these two lines.
              const takeoverContext = {
                tool: toolRequest.params.tool,
                agentId,
                callId: toolRequest.params.callId,
                provider: client.provider,
              };
              const arrivedAt = Date.now();
              logger.info("A browser takeover call arrived.", takeoverContext);
              const result = yield* this.#attention.surfaceBrowserTakeover(client, toolRequest);
              if (toolRequest.params.tool === "submit_secret")
                this.#trust?.recordSecret(agentId, toolRequest.params, result);
              logger.info("A browser takeover call answered.", {
                ...takeoverContext,
                success: result.success,
                durationMs: Date.now() - arrivedAt,
              });
              // A takeover of a stopped client ends with a cancel, and that process has nothing to answer.
              if (client.running) client.respond(toolRequest.id, result);
              else logger.warn("A browser takeover ended after its provider stopped.", { agentId });
              return;
            }
            if (this.#attention.hasBrowserTakeoverForAgent(agentId)) {
              client.respond(toolRequest.id, {
                success: false,
                contentItems: [{ type: "inputText", text: "Browser tools are unavailable during user takeover." }],
              });
              return;
            }
            const params = {
              ...toolRequest.params,
              threadId: this.#conversation.publicThreadId(agentId, toolRequest.params.threadId),
              ownerAgentId: agentId,
            };
            // The trust policy checks a payment or an action on an ads or checkout page first.
            const refused = this.#trust ? yield* this.#trust.checkBrowser(client, toolRequest, params, agentId) : null;
            if (refused) {
              if (!toolRequest.signal?.aborted && client.running) client.respond(toolRequest.id, refused);
              return;
            }
            // While the user controls the tab, the call waits for the release and does not run.
            const userControl = (tabId: string) =>
              this.#browser.awaitUserControlRelease(tabId).pipe(Effect.as(browserUserControlResult()));
            const operation = Effect.gen({ self: this }, function* () {
              const heldTabId = this.#browser.userControlTabFor(params);
              if (heldTabId) return yield* userControl(heldTabId);
              switch (params.tool) {
                case "upload_files":
                  return yield* this.#browserUploads.uploadFiles(agentId, params);
                case "list_logins":
                  return yield* this.#attention.listVaultLogins(params);
                case "list_vault_items":
                  return yield* this.#attention.listVaultItems(params);
                case "save_vault_item":
                  return yield* this.#attention.saveVaultItem(params);
                case "delete_vault_item":
                  return yield* this.#attention.deleteVaultItem(params);
                default:
                  return yield* this.#browser.handleDynamicTool(params, {
                    onUserControl: userControl,
                    cardVault: this.#attention.cardVault(client, toolRequest, params),
                  });
              }
            });
            const signal = toolRequest.signal;
            const cancelled = Effect.callback<never>((resume) => {
              const abort = () => resume(Effect.interrupt);
              if (signal?.aborted) abort();
              else signal?.addEventListener("abort", abort, { once: true });
              return Effect.sync(() => signal?.removeEventListener("abort", abort));
            });
            if (signal?.aborted) return;
            const result = yield* operation.pipe(
              Effect.raceFirst(cancelled),
              Effect.onInterrupt(() => Effect.sync(() => this.#browser.endControl(params.threadId, params.turnId))),
            );
            // Page text is untrusted: the guardrails check the turn's next high-impact action.
            this.#guardrails?.observeBrowserResult(params.turnId, params.tool, result);
            if (!signal?.aborted && client.running) client.respond(toolRequest.id, result);
            return;
          }
          if (toolRequest.params.namespace === "openbot") {
            if (toolRequest.params.tool === "ask_user") {
              this.#attention.surfaceDynamicPrompt(client, toolRequest);
              return;
            }
            // Every provider gets ask_ui, Claude too: its call arrives here through the SDK MCP server.
            if (toolRequest.params.tool === "ask_ui") {
              this.#askUi(client, toolRequest, toolRequest.params);
              return;
            }
            if (toolRequest.params.tool === "request_decision") {
              if (this.#trust) this.#trust.requestDecision(client, toolRequest, toolRequest.params);
              else
                client.respond(toolRequest.id, openBotToolFailure("This Atelier server cannot show decision cards."));
              return;
            }
            const refused = this.#trust
              ? yield* this.#trust.checkOpenBotTool(client, toolRequest, toolRequest.params)
              : null;
            if (refused) {
              if (!toolRequest.signal?.aborted && client.running) client.respond(toolRequest.id, refused);
              return;
            }
            if (toolRequest.params.tool === "acknowledge_request") {
              this.#acknowledgeRequest(client, toolRequest, toolRequest.params);
              return;
            }
            // Mail leaves Atelier: a first contact waits for the owner's card; a reply does not.
            if (MAIL_TOOLS.has(toolRequest.params.tool)) {
              const result = yield* this.#mailTool(client, toolRequest, toolRequest.params);
              if (!toolRequest.signal?.aborted && client.running) client.respond(toolRequest.id, result);
              return;
            }
            if (isHostedSiteMutationTool(toolRequest.params.tool)) {
              yield* this.#attention.surfaceHostedSiteApproval(
                client,
                toolRequest,
                toolRequest.params,
                toolRequest.params.tool,
              );
              return;
            }
            if (toolRequest.params.tool === "capture_screen" || toolRequest.params.tool === "list_capture_sources") {
              const result = yield* this.#screenCaptureTool(client, toolRequest, toolRequest.params);
              if (!toolRequest.signal?.aborted && client.running) client.respond(toolRequest.id, result);
              return;
            }
            if (API_KEY_TOOLS.has(toolRequest.params.tool)) {
              const result = yield* this.#apiKeyTool(client, toolRequest, toolRequest.params);
              if (result && !toolRequest.signal?.aborted && client.running) client.respond(toolRequest.id, result);
              return;
            }
            if (isMcpServerTool(toolRequest.params.tool)) {
              const result = yield* this.#mcpServerTool(client, toolRequest, toolRequest.params);
              if (!toolRequest.signal?.aborted && client.running) client.respond(toolRequest.id, result);
              return;
            }
            const tool = toolRequest.params.tool;
            // The calling agent can correct a profile request or an attachment path, so it gets the reason as a
            // failed tool result. Codex replaces a JSON-RPC error with "dynamic tool request failed" (#1728).
            const correctableFailure = (error: unknown) =>
              Effect.sync(() => {
                const message = this.#hooks.redactMcp(profileToolErrorMessage(error));
                if (!(error instanceof z.ZodError)) logger.warn("An OpenBot tool failed.", { tool, error: message });
                return openBotToolFailure(message);
              });
            const correctable = PROFILE_TOOL_NAMES.has(tool) || tool === "attach_files_to_response";
            const response = this.#handleOpenBotTool(toolRequest.params).pipe(
              Effect.catch((failure) => (correctable ? correctableFailure(failure.cause) : Effect.fail(failure))),
              Effect.catchDefect((defect) => (correctable ? correctableFailure(defect) : Effect.die(defect))),
              Effect.tap((result) => Effect.sync(() => client.respond(toolRequest.id, result))),
            );
            // Both store a file and then add the message that names it.
            yield* tool === "attach_files_to_response" || tool === "html_render"
              ? Effect.uninterruptible(response)
              : response;
            return;
          }
          throw new Error(`Unsupported dynamic tool namespace: ${toolRequest.params.namespace}`);
        }
        case "item/tool/requestUserInput":
          this.#attention.surfacePrompt(client, request);
          return;
        case "mcpServer/elicitation/request":
          this.#attention.surfaceMcpElicitation(client, request);
          return;
        case TRUST_CHECK_METHOD:
          if (this.#trust) yield* this.#trust.handleTrustCheck(client, request);
          else client.respond(request.id, { decision: "allow" });
          return;
        case "currentTime/read":
          client.respond(request.id, { currentTimeAt: Math.floor(Date.now() / 1_000) });
          return;
        default:
          client.respondError(request.id, {
            code: -32601,
            message: `Atelier does not implement server request ${request.method}.`,
          });
      }
    }).pipe(
      Effect.catch((failure) => reportFailure(failure.cause)),
      Effect.catchDefect(reportFailure),
    );
  }).bind(this);

  /**
   * Checks an `ask_ui` call and shows its block. Like `ask_user`, it answers the call only when the
   * person answers or the turn ends. The agent can correct a refused block, so it gets the reason.
   */
  #askUi(client: AgentClient, request: AppServerRequest, params: DynamicToolCallParams): void {
    const refuse = (message: string) => client.respond(request.id, openBotToolFailure(message));
    const parsed = askUiToolSchema.safeParse(params.arguments);
    if (!parsed.success) {
      refuse(`${z.prettifyError(parsed.error)}\nCorrect the arguments and retry.`);
      return;
    }
    const spec = normalizeUiBlockSpec(parsed.data.block);
    // The stored block must read back, so its id passes the same check as the read.
    const blockId = parsed.data.blockId ?? randomUUID();
    if (!spec || !isUiBlockId(blockId)) {
      refuse(
        "The block breaks a rule: ids and option labels must be unique, an id must not be botId or a similar name, a value must be one of its options, a single choice selects at most one option, and a secret field is a text field with no value. Correct the block and retry.",
      );
      return;
    }
    this.#attention.surfaceUiBlock(client, request, { blockId, spec });
  }

  /**
   * The API key tools. `request_api_key` shows a form with one secret field, and the attention registry
   * answers it with the path of the saved key, so it returns null. The others answer at once. No result
   * holds a key value.
   */
  readonly #apiKeyTool = Effect.fn("OpenBotToolRouter.apiKeyTool")(function* (
    this: OpenBotToolRouter,
    client: AgentClient,
    request: AppServerRequest,
    params: DynamicToolCallParams,
  ) {
    const agentId = this.#conversation.agentForThread(params.threadId);
    if (!agentId) throw new Error("The calling Atelier agent is unknown.");
    const apiKeys = this.#apiKeys;
    if (!apiKeys) return openBotToolFailure("This Atelier server cannot save API keys.");
    const failed = (failure: { cause: unknown }) =>
      Effect.succeed(
        openBotToolFailure(
          failure.cause instanceof Error ? failure.cause.message : sourceText("error.backend.apiKeySaveFailed"),
        ),
      );
    if (params.tool === "list_api_keys")
      return yield* apiKeys.listForAgent(agentId).pipe(
        Effect.map((keys) => openBotToolResult({ keys })),
        Effect.catch(failed),
      );
    if (params.tool === "save_api_key") {
      const parsed = saveApiKeyToolSchema.safeParse(params.arguments);
      if (!parsed.success)
        return openBotToolFailure(`${z.prettifyError(parsed.error)}\nCorrect the arguments and retry.`);
      const agent = this.#hooks.listAgents().find((candidate) => candidate.id === agentId);
      const scope = parsed.data.shared ? SHARED_API_KEY_SCOPE : agentId;
      return yield* apiKeys.sourceFile(parsed.data.file, agent?.workspacePath ?? null).pipe(
        Effect.flatMap((source) =>
          apiKeys.save(scope, parsed.data.name, source.value).pipe(Effect.tap(() => removeKeySourceFile(source.path))),
        ),
        Effect.map((key) =>
          openBotToolResult({ status: "saved", name: key.name, path: key.path, shared: key.shared === true }),
        ),
        Effect.catch(failed),
      );
    }
    if (params.tool === "remove_api_key") {
      const parsed = removeApiKeyToolSchema.safeParse(params.arguments);
      if (!parsed.success)
        return openBotToolFailure(`${z.prettifyError(parsed.error)}\nCorrect the arguments and retry.`);
      return yield* apiKeys.remove(parsed.data.shared ? SHARED_API_KEY_SCOPE : agentId, parsed.data.name).pipe(
        Effect.map((removed) =>
          openBotToolResult({ status: removed ? "removed" : "not_found", name: parsed.data.name }),
        ),
        Effect.catch(failed),
      );
    }
    const parsed = requestApiKeyToolSchema.safeParse(params.arguments);
    if (!parsed.success)
      return openBotToolFailure(`${z.prettifyError(parsed.error)}\nCorrect the arguments and retry.`);
    if (this.#messaging.linkForThread(this.#conversation.publicThreadId(agentId, params.threadId)))
      return openBotToolFailure(
        "request_api_key does not work in a Slack, Discord or Telegram chat. Ask the user to give you the key in Atelier.",
      );
    const spec = apiKeyFormSpec(parsed.data);
    if (!spec) return openBotToolFailure("Atelier could not show this form. Use a shorter title and retry.");
    this.#attention.surfaceUiBlock(client, request, {
      blockId: randomUUID(),
      spec,
      apiKey: { name: parsed.data.name, ...(parsed.data.shared ? { shared: true } : {}) },
    });
    return null;
  });

  /**
   * Shows the plan card of `acknowledge_request` and waits like `ask_ui`. When nobody answers in
   * `ACKNOWLEDGE_START_MS`, the host presses the start button, so the work never waits long for a
   * person who is away.
   */
  #acknowledgeRequest(client: AgentClient, request: AppServerRequest, params: DynamicToolCallParams): void {
    const refuse = (message: string) => client.respond(request.id, openBotToolFailure(message));
    const agentId = this.#conversation.agentForThread(params.threadId);
    const agent = agentId ? this.#store.list().find((candidate) => candidate.id === agentId) : undefined;
    if (!agent || !agentQuickAcknowledgementEnabled(agent, this.#store.agentDefaults())) {
      refuse("The user has not turned on the plan card for you. Start the work without it.");
      return;
    }
    const threadId = this.#conversation.publicThreadId(agent.id, params.threadId);
    // Nobody presses a button on Slack, Discord or Telegram.
    if (this.#messaging.linkForThread(threadId)) {
      refuse("This chat cannot show the plan card. Do not call it here; start the work.");
      return;
    }
    const parsed = acknowledgeRequestToolSchema.safeParse(params.arguments);
    if (!parsed.success) {
      refuse(`${z.prettifyError(parsed.error)}\nCorrect the arguments and retry.`);
      return;
    }
    const { message, steps, startLabel, cancelLabel, alternativeLabel } = parsed.data;
    const spec = normalizeUiBlockSpec({
      type: "confirm",
      title: message,
      fields: steps.map((step) => ({ label: step.label, value: step.step })),
      actions: [
        { id: ACKNOWLEDGE_REQUEST_ACTIONS.start, label: startLabel, style: "primary" },
        ...(alternativeLabel ? [{ id: ACKNOWLEDGE_REQUEST_ACTIONS.alternative, label: alternativeLabel }] : []),
        { id: ACKNOWLEDGE_REQUEST_ACTIONS.cancel, label: cancelLabel, style: "ghost" },
      ],
    });
    if (!spec) {
      refuse("Each button needs a different label. Correct the labels and retry.");
      return;
    }
    this.#attention.surfaceUiBlock(
      client,
      request,
      { blockId: randomUUID(), spec },
      { actionId: ACKNOWLEDGE_REQUEST_ACTIONS.start, afterMs: ACKNOWLEDGE_START_MS },
    );
  }

  /**
   * A provider's command that spends money goes to the owner through the trust gate, never to the
   * agent's auto-approve grant. True when the gate answered the request.
   */
  readonly #answeredMoneyCommand = Effect.fn("OpenBotToolRouter.answeredMoneyCommand")(function* (
    this: OpenBotToolRouter,
    client: AgentClient,
    request: AppServerRequest,
  ) {
    if (!this.#trust) return false;
    const allowed = yield* this.#trust.checkProviderCommand(client, request, commandText(request.params));
    if (allowed === null) return false;
    if (!request.signal?.aborted && client.running)
      client.respond(
        request.id,
        request.method === "execCommandApproval"
          ? { decision: allowed ? "approved" : { denied: { rejection: "The owner did not approve this payment." } } }
          : { decision: allowed ? "accept" : "decline" },
      );
    return true;
  });

  /**
   * The team members whose request this turn serves: the member who wrote a message of the turn, and
   * the members that an agent's message of the turn carries (upstream c57e4cb20). The owner and
   * admins have every agent at `manage`, so they limit nothing.
   */
  #memberRequesters(agentId: string, turnId: string): string[] {
    const ids = new Set<string>();
    for (const { delivery } of this.#mailbox.findDeliveriesByTurn(agentId, turnId)) {
      if (delivery.sender.kind === "agent") {
        for (const id of this.#mailbox.requesterIds(delivery.messageId)) ids.add(id);
        continue;
      }
      const member = this.#mailbox.senderMember(delivery.messageId);
      if (member && (this.#channels.hooks.remotePerson?.(member.id) ?? false)) ids.add(member.id);
    }
    return [...ids];
  }

  /** Whether an agent is one that every requesting member may chat with. The caller always is. */
  #reachableAgentIds(senderAgentId: string, requesterIds: readonly string[]): (agentId: string) => boolean {
    return (agentId) =>
      agentId === senderAgentId ||
      requesterIds.every(
        (personId) =>
          agentAccessRank(this.#channels.hooks.personAgentLevel?.(personId, agentId) ?? "manage") >=
          agentAccessRank("chat"),
      );
  }
  /** The agents in the space of `agentId`, itself included. */
  #spaceAgents(agentId: string): AgentSummary[] {
    return this.#hooks.listAgents().filter((agent) => this.#store.spaces.sameSpace(agentId, agent.id));
  }

  /** Whether an agent or a channel id of the sidebar layout is in the space of `agentId`. */
  #visibleInSpace(agentId: string, id: string): boolean {
    if (this.#hooks.listAgents().some((agent) => agent.id === id)) return this.#store.spaces.sameSpace(agentId, id);
    if (!this.#channels.store.exists(id)) return false;
    return agentSeesChannel(this.#store.spaces, agentId, this.#channels.store.get(id));
  }

  /** The manager of `agentId` in the org chart of its space, or null at the top level. */
  #managerOf(agentId: string): string | null {
    return agentManagers(this.#spaceAgents(agentId)).get(agentId) ?? null;
  }

  #requireAgent(agentId: string): AgentSummary {
    const agent = this.#hooks.listAgents().find((candidate) => candidate.id === agentId);
    if (!agent) throw new Error(sourceText("error.agent.unknown", { id: agentId }));
    return agent;
  }

  /**
   * One agent's whole setup, for another agent to read before it changes it. MCP servers belong to
   * the user and are shown by name and transport only: their commands, environment, URLs, and
   * headers can hold secrets.
   */

  readonly #readAgent = Effect.fn("OpenBotToolRouter.readAgent")(function* (this: OpenBotToolRouter, agentId: string) {
    const agent = yield* toolStep(() => this.#requireAgent(agentId));
    const computerUse = agentComputerUseEnabled(agent);
    let skills: unknown[] | undefined;
    let skillsError: string | undefined;
    const loaded = yield* Effect.result(
      Effect.gen({ self: this }, function* () {
        const tools = yield* toolStep(() => {
          if (!this.#localSkillTools) throw new Error("Skill tools are unavailable.");
          return this.#localSkillTools();
        });
        return (yield* tools.listInstalled(agent.id).pipe(toToolOperationFailed)).map((skill) => ({
          skillId: skill.skillId,
          name: skill.name,
          ...(skill.description ? { description: skill.description } : {}),
          origin: skill.origin ?? "marketplace",
          enabled: skill.enabled !== false,
          state: skill.state,
          installedVersion: skill.installedVersion,
          ...(skill.problem ? { problem: skill.problem } : {}),
        }));
      }),
    );
    if (Result.isSuccess(loaded)) skills = loaded.success;
    else {
      const error = loaded.failure.cause;
      // The rest of the setup stays readable when the skill folders cannot be read.
      skillsError = error instanceof Error ? error.message : String(error);
    }
    return {
      id: agent.id,
      name: agent.name,
      title: agent.title,
      description: agent.description,
      provider: agent.provider,
      model: agent.model,
      reasoningEffort: agent.reasoningEffort,
      ...agentAccountSetup(agent),
      access: workspaceAccessEnforced(agent) ? "workspace" : "full",
      computerUse,
      notifications: agent.notifications,
      background: isBackgroundAgent(agent),
      autoApprove: this.#approvalAutomation.autoApproves(agent.id),
      ...(skills ? { skills } : { skillsError }),
      routines: this.#routines.list(agent.id).map((routine) => ({
        id: routine.id,
        name: routine.name,
        active: routine.active,
        schedule: routine.trigger.schedule,
        nextRunAt: routine.trigger.nextRunAt,
      })),
      mcpServers: agentMcpServers(this.#hooks.enabledMcpServers(), computerUse).map((server) => ({
        name: server.name,
        transport: server.transport,
      })),
    };
  });

  /** A tool that changes another agent goes to the audit file, with the field names and no values. */
  #auditCrossAgent(params: DynamicToolCallParams, senderAgentId: string) {
    const args = params.arguments;
    if (!CROSS_AGENT_TOOLS.has(params.tool) || !isRecord(args)) return Effect.void;
    const target = args.agentId;
    if (typeof target !== "string" || target === senderAgentId) return Effect.void;
    const sender = this.#hooks.listAgents().find((agent) => agent.id === senderAgentId);
    return this.#audit.record({
      actor: auditActor({ kind: "agent", agentId: senderAgentId, name: sender?.name ?? senderAgentId }),
      action: "agent.cross-agent-tool",
      target: { kind: "agent", id: target },
      names: [params.tool, ...Object.keys(args).filter((key) => key !== "agentId" && args[key] !== undefined)],
    });
  }

  readonly #handleOpenBotTool = Effect.fn("OpenBotToolRouter.handleOpenBotTool")(function* (
    this: OpenBotToolRouter,
    params: DynamicToolCallParams,
  ) {
    const senderAgentId = this.#conversation.agentForThread(params.threadId);
    if (!senderAgentId) throw new Error("The sending Atelier agent is unknown.");
    // An agent sees and reaches only the agents of its own space, whatever the tool.
    const crossSpace = crossSpaceRefusal(this.#store.spaces, senderAgentId, params.arguments, (agentId) =>
      this.#hooks.listAgents().some((agent) => agent.id === agentId),
    );
    if (crossSpace) return openBotToolFailure(crossSpace);
    yield* this.#auditCrossAgent(params, senderAgentId);

    if (LOCAL_SKILL_TOOL_DEFINITIONS.some((tool) => tool.name === params.tool)) {
      const reportFailure = (error: unknown) =>
        Effect.sync(() => {
          return {
            success: false,
            contentItems: [
              { type: "inputText", text: redactText(error instanceof Error ? error.message : String(error)) },
            ],
          };
        });
      return yield* Effect.gen({ self: this }, function* () {
        if (!this.#localSkillTools) throw new Error("Local skill tools are unavailable.");
        const result = openBotToolResult(
          yield* runLocalSkillTool(
            this.#localSkillTools(),
            senderAgentId,
            params.tool,
            params.arguments,
            (agentId) => this.#requireAgent(agentId ?? senderAgentId).id,
            (event) => {
              const executionThreadId = this.#conversation.publicThreadId(senderAgentId, params.threadId);
              const snapshot = structuredClone(this.#conversation.ensureSnapshot(senderAgentId, executionThreadId));
              const message: ConversationMessage = {
                id: randomUUID(),
                turnId: params.turnId,
                author: "system",
                source: "system",
                status: "completed",
                createdAt: new Date().toISOString(),
                itemType: skillConversationEventItemType(event),
                text: redactText(event.skillName),
              };
              snapshot.messages.push(message);
              snapshot.revision = this.#store.database.persistConversationChanges({
                agentId: senderAgentId,
                threadId: executionThreadId,
                activeTurnId: snapshot.activeTurnId,
                changedMessages: [message],
                eventType: `skill.${event.action}`,
                detail: event,
              });
              const persisted = snapshot;
              this.#conversation.setSnapshot(senderAgentId, persisted);
              this.#conversation.publishConversation(persisted);
            },
          ),
        );
        return {
          ...result,
          contentItems: result.contentItems.map((item) => ({ ...item, text: redactText(item.text) })),
        };
      }).pipe(
        Effect.catch((failure) => reportFailure(failure.cause)),
        Effect.catchDefect(reportFailure),
      );
    }

    const executionThreadId = this.#conversation.publicThreadId(senderAgentId, params.threadId);
    // Any agent can post on its own initiative, such as a routine that reports to a Discord channel.
    if (MESSAGING_OUTBOUND_TOOLS.has(params.tool))
      return yield* this.#messaging.outboundTool(params.tool, params.arguments);
    if (params.tool.startsWith("messaging_")) {
      // Only the agent that answers a platform conversation, in that conversation's own thread.
      const link = this.#messaging.linkForThread(executionThreadId);
      if (!link || link.agentId !== senderAgentId)
        return openBotToolFailure(
          "Messaging tools work only in a turn that answers a Slack, Discord or Telegram message.",
        );
      return yield* this.#messaging.tool(link, params.turnId, params.callId, params.tool, params.arguments);
    }
    const channelId = this.#channels.store.channelForThread(executionThreadId);
    if (channelId && (params.tool.startsWith("channel_") || params.tool === "send_message")) {
      if (params.tool === "send_message") throw new Error("Use channel_assign or channel_transfer for channel work.");
      // A channel that was moved to another space after this turn started.
      if (!agentSeesChannel(this.#store.spaces, senderAgentId, this.#channels.store.get(channelId)))
        return openBotToolFailure(sourceText("error.backend.spaceOtherChannel"));
      return openBotToolResult(
        yield* this.#channels.tool(
          channelId,
          senderAgentId,
          params.turnId,
          params.callId,
          params.tool,
          params.arguments,
        ),
      );
    }
    if (params.tool.startsWith("channel_")) {
      return {
        success: false,
        contentItems: [
          {
            type: "inputText",
            text: "This chat has no active channel assignment. The channel_ tools work only inside a channel task. To make, change or post in channels from this chat, use openbot.list_channels, create_channel, update_channel, update_channel_members or post_channel_message. Use openbot.send_message for direct teammate work.",
          },
        ],
      };
    }

    if (params.tool === "html_preview") {
      return yield* this.#previewVisual(params);
    }

    if (params.tool === "html_render") {
      return yield* this.#renderVisual(params, senderAgentId, executionThreadId);
    }

    if (params.tool === "list_sites") {
      return openBotToolResult(yield* this.#hostedSites.listSites());
    }

    if (isHostedSiteMutationTool(params.tool)) throw new Error("Hosted site changes require user approval.");

    if (params.tool === "attach_files_to_response") {
      const args = params.arguments;
      if (!isRecord(args) || !Array.isArray(args.paths)) throw new Error("paths must be an array of local files.");
      if (
        args.paths.length === 0 ||
        args.paths.length > INPUT_LIMITS.attachments ||
        !args.paths.every((path) => isString(path) && path.trim().length > 0 && path.length <= INPUT_LIMITS.path)
      ) {
        throw new Error(`paths must contain between 1 and ${INPUT_LIMITS.attachments} valid local file paths.`);
      }

      const messageId = responseAttachmentMessageId(params.threadId, params.turnId, params.callId);
      return yield* this.#attachments.attachFiles(senderAgentId, params, args.paths, messageId);
    }

    if (params.tool === "list_agents") {
      // A delivery that is starting holds no turn yet, and a channel turn runs on a thread of its own.
      const unresolved = new Set(this.#mailbox.unresolvedDeliveries().map(({ delivery }) => delivery.recipientAgentId));
      const openWaits = this.#waits.countByAgent();
      // A hidden agent takes no new messages, so the list leaves it out. A background teammate stays:
      // it keeps working for other agents.
      // In a member's turn, only the agents that the member may chat with (upstream c57e4cb20).
      const reachable = this.#reachableAgentIds(senderAgentId, this.#memberRequesters(senderAgentId, params.turnId));
      const spaceAgents = this.#spaceAgents(senderAgentId).filter((agent) => reachable(agent.id));
      const managers = agentManagers(spaceAgents);
      const agents = spaceAgents
        .filter((agent) => agent.hiddenAt === undefined)
        .map((agent) => {
          const deliveries = this.#mailbox.listQueue(agent.id).deliveries;
          // A held note starts no turn, so an agent with only notes reads as ready.
          const queuedMessages = deliveries.filter(
            (delivery) => delivery.status === "queued" && !isQueuedAgentNote(delivery),
          ).length;
          const working = this.#hooks.runsTurn(agent.id) || unresolved.has(agent.id);
          const activeTurnId = this.#conversation.workingSnapshot(agent.id)?.activeTurnId ?? null;
          const { startedAt, lastEventAt } = this.#hooks.turnActivity(agent.id, activeTurnId);
          // A restart loses the provider clock, so the newest message for the agent stands in for it.
          const lastActivity = deliveries.reduce(
            (latest, delivery) => Math.max(latest, Date.parse(delivery.createdAt) || 0),
            Math.max(lastEventAt ?? 0, startedAt ?? 0),
          );
          // What keeps the agent from the work it was given. Counts only: an approval holds the command
          // text, and that text can hold a secret.
          const attention = this.#attention.attentionCountsFor(agent.id);
          const usageLimit = this.#hooks.usageLimit(agent.id);
          return {
            id: agent.id,
            name: agent.name,
            title: agent.title,
            description: agent.description,
            ...(isBackgroundAgent(agent) ? { background: true } : {}),
            reportsTo: managers.get(agent.id) ?? null,
            status: working ? "working" : queuedMessages > 0 ? "queued" : "ready",
            queuedMessages,
            ...(working && startedAt !== null ? { turnStartedAt: new Date(startedAt).toISOString() } : {}),
            ...(lastActivity > 0 ? { lastActivityAt: new Date(lastActivity).toISOString() } : {}),
            ...(openWaits.has(agent.id) ? { openWaits: openWaits.get(agent.id) } : {}),
            ...(attention.questions + attention.approvals + attention.browserTakeovers > 0
              ? { waitingForUser: attention }
              : {}),
            ...(usageLimit
              ? {
                  usageLimitedUntil:
                    usageLimit.resetsAt === null ? null : new Date(usageLimit.resetsAt * 1_000).toISOString(),
                }
              : {}),
            ...(this.#hooks.lastTurnFailed(agent.id) ? { lastTurnFailed: true } : {}),
            // Channel work reserves the host, so the messages of this agent wait behind it.
            ...(queuedMessages > 0 && this.#channels.queueHold(agent.id) ? { heldBy: "channel" } : {}),
          };
        });
      return openBotToolResult({ agents });
    }

    if (params.tool === "list_models") {
      const args = listModelsToolSchema.parse(params.arguments ?? {});
      const payload = listModelsPayload(
        this.#hooks.listModels(),
        this.#hooks.preferredProvider(),
        this.#hooks.providerAccounts,
        args.provider,
      );
      return { success: true, contentItems: [{ type: "inputText", text: redactText(JSON.stringify(payload)) }] };
    }

    if (params.tool === "interrupt_agent")
      return yield* this.#interruptTool.handle(
        params,
        senderAgentId,
        this.#memberRequesters(senderAgentId, params.turnId),
      );

    if (params.tool === "read_agent") {
      const args = readAgentToolSchema.parse(params.arguments ?? {});
      const payload = yield* this.#readAgent(args.agentId ?? senderAgentId);
      return { success: true, contentItems: [{ type: "inputText", text: redactText(JSON.stringify(payload)) }] };
    }

    if (params.tool === "create_agent") return yield* this.#createAgent(params, senderAgentId);

    if (params.tool === "update_profile") return yield* this.#updateProfile(params, senderAgentId);

    if (params.tool === "update_agents") return yield* handleUpdateAgentsTool(params, senderAgentId, this.#hooks);

    if (params.tool === "start_new_chat") {
      const agent = this.#store.list().find((candidate) => candidate.id === senderAgentId);
      if (!agent || !agentNewChatAllowed(agent, this.#store.agentDefaults()))
        return openBotToolFailure(
          "The user has not allowed you to start a new chat. Ask the user to allow it in your settings, or to start a new chat there.",
        );
      if (agent.threadId !== this.#conversation.publicThreadId(senderAgentId, params.threadId))
        return openBotToolFailure("You can start a new chat only from your own chat, not from a task or a channel.");
      this.#hooks.requestNewChat(senderAgentId);
      return openBotToolResult({
        status: "requested",
        note: "The new chat starts when this turn ends, your background subagents and commands finish, and your queue is empty. A queued message that runs first ends the request. Finish your answer now.",
      });
    }

    if (params.tool === "escalate_model") {
      if (!this.#hooks.escalateModel(senderAgentId))
        return openBotToolFailure(
          "Your model policy is Fixed, so every turn runs on your model. Ask the user to set it to Automatic, or to change your model.",
        );
      return openBotToolResult({
        status: "escalated",
        note: "Your next turn runs on the largest model. Finish this turn now, and say what you will try next.",
      });
    }

    if (params.tool === "set_team_sleep") {
      const args = z
        .object({ agentId: z.string().min(1), team: z.boolean().optional(), sleeping: z.boolean() })
        .parse(params.arguments ?? {});
      if (args.agentId === senderAgentId) return openBotToolFailure("You cannot put yourself to sleep.");
      const mine = new Set(this.#hooks.sleepTargetAgentIds({ kind: "team", id: senderAgentId }));
      if (!mine.has(args.agentId))
        return openBotToolFailure(
          "That agent is not under you in the org chart. Only its own lead or a person can change it.",
        );
      const result = yield* this.#hooks.setAgentsSleeping({
        target: { kind: args.team ? "team" : "agent", id: args.agentId },
        sleeping: args.sleeping,
      });
      const names = new Map(this.#hooks.listAgents().map((agent) => [agent.id, agent.name]));
      return openBotToolResult({
        status: args.sleeping ? "asleep" : "awake",
        changed: result.changedAgentIds.map((id) => names.get(id) ?? id),
      });
    }

    if (params.tool === "propose_playbook_update") {
      const args = z
        .object({
          slug: z.string().min(1).max(64),
          content: z.string().min(1).max(64_000),
          note: z.string().min(1).max(600),
        })
        .parse(params.arguments ?? {});
      const refused = yield* this.#hooks.proposePlaybook(senderAgentId, args.slug, args.content, args.note);
      if (refused) return openBotToolFailure(refused);
      return openBotToolResult({
        status: "proposed",
        note: "The owner sees the proposal in Settings → Playbooks. Nothing changes until they approve it.",
      });
    }

    if (params.tool === ROUTINE_NO_UPDATE_TOOL) {
      const outcome = this.#hooks.requestNoUpdate(senderAgentId, executionThreadId, params.turnId);
      if (outcome === null) return openBotToolFailure("Use this tool only in a routine run.");
      return openBotToolResult(
        outcome === "quiet"
          ? { status: "quiet", note: "This run ends without a message or a notification. End your turn now." }
          : { status: "shown", note: "Someone waits for this answer. Report the result as usual." },
      );
    }

    if (params.tool === ROUTINE_REPORT_FAILURE_TOOL) {
      const { reason } = routineReportFailureToolSchema.parse(params.arguments ?? {});
      if (!this.#hooks.reportRoutineFailure(senderAgentId, params.turnId, reason))
        return openBotToolFailure("Use this tool only in a routine run.");
      return openBotToolResult({ status: "failed", note: "This run ends as failed. Give your answer as usual." });
    }

    const channelAdminResult = yield* handleChannelAdminTool(
      params.tool,
      params.arguments,
      {
        agentId: senderAgentId,
        turnId: params.turnId,
        callId: params.callId,
        channelTaskId: this.#channels.store.channelForThread(executionThreadId),
      },
      {
        channels: this.#channels,
        agents: () => this.#hooks.listAgents(),
        sameSpace: (agentId, otherAgentId) => this.#store.spaces.sameSpace(agentId, otherAgentId),
        seesChannel: (agentId, channel) => agentSeesChannel(this.#store.spaces, agentId, channel),
        agentSpace: (agentId) => this.#store.spaces.agentSpace(agentId),
        host: () => this.#hooks.channelHost(),
        placeChannel: (channelId, spaceId) => this.#hooks.placeChannel(channelId, spaceId),
      },
    );
    if (channelAdminResult) return channelAdminResult;

    const sidebarResult = yield* handleSidebarTool(
      params.tool,
      params.arguments,
      this.#sidebarLayout,
      new Set(this.#hooks.listAgents().map((agent) => agent.id)),
      (id) => this.#visibleInSpace(senderAgentId, id),
    );
    if (sidebarResult) return sidebarResult;

    const checkResult = yield* handleEventCheckTool(params, senderAgentId, this.#eventChecks, () =>
      this.#requireAgent(senderAgentId),
    );
    if (checkResult) return checkResult;
    const routineResult = yield* this.#routines.handleTool(params, senderAgentId);
    if (routineResult) {
      // A one-time routine made while the agent answers Discord in its own chat answers there too.
      if (params.tool === "create_routine")
        this.#messaging.noteRoutineCreated(senderAgentId, params.turnId, routineResult);
      return routineResult;
    }

    const flowResult = yield* handleRoutineFlowTool(
      params.tool,
      params.arguments,
      senderAgentId,
      this.#routineFlowTools?.() ?? null,
      new Set(this.#spaceAgents(senderAgentId).map((agent) => agent.id)),
    );
    if (flowResult) return flowResult;

    const memoryResult = this.#memories.handleTool(params, senderAgentId, this.#hooks.redactMcp);
    if (memoryResult) return memoryResult;

    const caller = {
      agentId: senderAgentId,
      inExecutionThread: this.#conversation.isExecutionThread(
        this.#conversation.publicThreadId(senderAgentId, params.threadId),
      ),
      requesterIds: this.#memberRequesters(senderAgentId, params.turnId),
    };
    const waitResult = this.#waits.handleTool(params, caller);
    if (waitResult) return waitResult;

    const taskResult = yield* this.#tasks.handleTool(params, caller);
    if (taskResult) return taskResult;

    const tableResult = yield* handleDataTool(
      params.tool,
      params.arguments,
      senderAgentId,
      this.#tables?.forAgent(senderAgentId) ?? null,
    );
    if (tableResult) return tableResult;

    const loopResult = yield* handleLoopTool(params.tool, params.arguments, senderAgentId, this.#loops?.() ?? null);
    if (loopResult) return loopResult;

    const orderResult = yield* handleOrderTool(params.tool, params.arguments, senderAgentId, {
      plans: this.#plans,
      agents: () => this.#hooks.listAgents(),
      notify: (input) => this.#notifyAgent(input),
    }).pipe(Effect.mapError((cause) => new ToolOperationFailed({ cause })));
    if (orderResult) return orderResult;

    if (params.tool === "wide_research") {
      const research = this.#wideResearch?.handleTool(params.tool, params.arguments, senderAgentId);
      return research ?? openBotToolFailure("Wide research is unavailable on this server.");
    }

    if (params.tool === "suggest_marketplace_app") {
      const args = params.arguments;
      if (!isRecord(args) || !isString(args.app)) throw new Error("app must be a Marketplace app slug.");
      if (!MARKETPLACE_APP_IDS.includes(args.app)) {
        return openBotToolResult({ status: "not_found", app: args.app, apps: MARKETPLACE_APP_IDS });
      }
      this.#postSystemCard(senderAgentId, executionThreadId, params.turnId, {
        itemType: marketplaceSuggestionItemType({ appId: args.app }),
        text: sourceText("status.agent.marketplaceSuggested", { app: args.app }),
        eventType: "marketplace.suggested",
        detail: { appId: args.app },
      });
      return openBotToolResult({ status: "suggested", app: args.app });
    }

    if (params.tool === "react_to_user_message") return yield* this.#react(params, senderAgentId);

    if (params.tool === "space_memory") {
      const parsed = spaceMemoryToolSchema.safeParse(params.arguments);
      if (!parsed.success)
        return openBotToolFailure(`${z.prettifyError(parsed.error)}\nCorrect the arguments and retry.`);
      const spaceMemory = this.#hooks.spaceMemory;
      if (!spaceMemory) return openBotToolFailure("The space memory is not available on this host yet.");
      return yield* spaceMemory(senderAgentId, params.turnId, parsed.data);
    }

    if (params.tool === "post_card") {
      const parsed = postCardToolSchema.safeParse(params.arguments);
      if (!parsed.success)
        return openBotToolFailure(`${z.prettifyError(parsed.error)}\nCorrect the arguments and retry.`);
      const postCard = this.#hooks.postCard;
      if (!postCard) return openBotToolFailure("Cards are not available on this host yet. Ask in words instead.");
      return yield* postCard(senderAgentId, params.turnId, parsed.data);
    }

    if (params.tool === "report_validation") {
      const parsed = reportValidationToolSchema.safeParse(params.arguments);
      if (!parsed.success)
        return openBotToolFailure(`${z.prettifyError(parsed.error)}\nCorrect the arguments and retry.`);
      const report = this.#hooks.reportValidation;
      if (!report) return openBotToolFailure("This host has no validation stage.");
      return yield* report(senderAgentId, parsed.data);
    }

    if (params.tool === "goals") {
      const parsed = goalsToolSchema.safeParse(params.arguments);
      if (!parsed.success)
        return openBotToolFailure(`${z.prettifyError(parsed.error)}\nCorrect the arguments and retry.`);
      const goals = this.#hooks.goals;
      if (!goals) return openBotToolFailure("Goals are not available on this host yet.");
      const answer = yield* Effect.result(goals(senderAgentId, parsed.data));
      return Result.isSuccess(answer) ? openBotToolResult(answer.success) : openBotToolFailure(answer.failure.message);
    }

    if (OWNER_TOOL_NAMES.has(params.tool)) {
      const owned = yield* this.#ownerTools.handle(params, senderAgentId, executionThreadId);
      if (owned) return owned;
    }

    if (params.tool === "log_decision") {
      const parsed = logDecisionToolSchema.safeParse(params.arguments);
      if (!parsed.success)
        return openBotToolFailure(`${z.prettifyError(parsed.error)}\nCorrect the arguments and retry.`);
      const context = this.#channels.teamContext(senderAgentId, params.turnId);
      const { decision, why, alternatives } = parsed.data;
      if (this.#hooks.logSpaceDecision)
        yield* this.#hooks.logSpaceDecision(senderAgentId, {
          decision,
          why,
          alternatives,
          ...(context ? { channelId: context.channelId } : {}),
        });
      if (!context)
        return this.#hooks.logSpaceDecision
          ? openBotToolResult({ status: "logged", log: "space" })
          : openBotToolFailure(
              "log_decision records decisions of a team channel's work, and this turn works for no team channel. Tell the person about the decision in your answer instead.",
            );
      const posted = this.#channels.postDecision(
        senderAgentId,
        context.channelId,
        context.threadRootId,
        `${decision} Why: ${why}${alternatives ? ` Rejected: ${alternatives}` : ""}`,
      );
      return posted
        ? openBotToolResult({ status: "logged", channel: context.name })
        : openBotToolFailure(
            "Atelier could not post the decision in the channel. Continue, and name it in your report.",
          );
    }

    return yield* this.#sendMessage(params, senderAgentId);
  });

  /**
   * `html_render`: stores the page as an HTML attachment and adds a visual reply message, which the
   * app shows in a sandboxed frame above the final answer. A retried call finds its message by id.
   */
  readonly #renderVisual = Effect.fn("OpenBotToolRouter.renderVisual")(function* (
    this: OpenBotToolRouter,
    params: DynamicToolCallParams,
    senderAgentId: string,
    executionThreadId: string,
  ) {
    // The agent can correct its page, so it gets the reason. The reason does not repeat the page.
    const parsed = htmlRenderToolSchema.safeParse(params.arguments, { reportInput: true });
    if (!parsed.success) return openBotToolFailure(profileToolErrorMessage(parsed.error));
    const args = parsed.data;
    const messageId = visualReplyMessageId(params.threadId, params.turnId, params.callId);
    if (
      this.#conversation.ensureSnapshot(senderAgentId, executionThreadId).messages.some(({ id }) => id === messageId)
    ) {
      return openBotToolResult({ status: "shown", messageId });
    }
    yield* this.#addGeneratedMessage({
      agentId: senderAgentId,
      threadId: executionThreadId,
      turnId: params.turnId,
      messageId,
      file: {
        bytes: new TextEncoder().encode(args.html),
        name: `${visualReplyFileName(args.title)}.html`,
        mimeType: "text/html",
      },
      text: args.title,
      itemType: chatVisualItemType(args.height),
      eventType: "response.visual-added",
      detail: (attachmentId) => ({ turnId: params.turnId, messageId, attachmentId }),
    });
    return openBotToolResult({ status: "shown", messageId });
  });

  /**
   * Stores generated bytes as the attachment of one new assistant message. The file and its message
   * are saved together, so a failed save keeps no file and a retry stores one.
   */
  readonly #addGeneratedMessage = Effect.fn("OpenBotToolRouter.addGeneratedMessage")(function* (
    this: OpenBotToolRouter,
    message: {
      agentId: string;
      threadId: string;
      turnId: string;
      messageId: string;
      file: { bytes: Uint8Array; name: string; mimeType: string };
      text: string;
      itemType: string;
      eventType: string;
      detail: (attachmentId: string) => Record<string, string | number>;
    },
  ) {
    const attachment = yield* this.#mailbox
      .stageGeneratedBytes({ ...message.file, ownerAgentId: message.agentId, ownerThreadId: message.threadId })
      .pipe(toToolOperationFailed);
    // A concurrent `attach_files_to_response` keeps the live snapshot while it reads files, then saves
    // it. A replaced snapshot would make that save delete this message, so the message goes in place.
    const snapshot = this.#conversation.ensureSnapshot(message.agentId, message.threadId);
    snapshot.messages.push({
      id: message.messageId,
      turnId: message.turnId,
      author: "assistant",
      source: "assistant",
      text: message.text,
      createdAt: new Date().toISOString(),
      status: "completed",
      itemType: message.itemType,
      attachments: [attachment],
    });
    sortConversationMessages(snapshot.messages);
    try {
      const persisted = this.#mailbox.persistGeneratedAttachmentsWithConversation(
        snapshot,
        message.eventType,
        message.detail(attachment.id),
        [attachment.id],
      );
      snapshot.revision = persisted.revision;
    } catch (error) {
      const messageIndex = snapshot.messages.findIndex((candidate) => candidate.id === message.messageId);
      if (messageIndex >= 0) snapshot.messages.splice(messageIndex, 1);
      yield* this.#mailbox.discardStagedGeneratedAttachments([attachment.id]).pipe(toToolOperationFailed);
      throw error;
    }
    this.#conversation.publishConversation(snapshot);
  });

  /**
   * `html_preview`: draws the page out of view and gives the agent the image, the content height and
   * the console output. A page that fails to draw is a result the agent can correct.
   */
  readonly #previewVisual = Effect.fn("OpenBotToolRouter.previewVisual")(function* (
    this: OpenBotToolRouter,
    params: DynamicToolCallParams,
  ) {
    const parsed = htmlPreviewToolSchema.safeParse(params.arguments, { reportInput: true });
    if (!parsed.success) return openBotToolFailure(profileToolErrorMessage(parsed.error));
    const args = parsed.data;
    const preview = this.#visualPreview;
    if (!preview) return openBotToolFailure("This Atelier cannot draw a page. Call html_render without a preview.");
    return yield* preview
      .capture({
        html: args.html,
        width: args.width ?? CHAT_VISUAL_PREVIEW_DEFAULT_WIDTH,
        appearance: args.appearance ?? "dark",
      })
      .pipe(
        Effect.map(
          ({ imageUrl, contentHeight, console }): DynamicToolResult => ({
            success: true,
            contentItems: [
              { type: "inputText", text: JSON.stringify({ contentHeight, console }) },
              { type: "inputImage", imageUrl },
            ],
          }),
        ),
        Effect.catchTag("ChatVisualPreviewFailed", (failure) => Effect.succeed(openBotToolFailure(failure.reason))),
      );
  });

  /**
   * `list_capture_sources` and `capture_screen`. The agent's Computer Use setting allows both. Each
   * capture waits for the user's approval, and the user sees the image in the conversation.
   */
  readonly #screenCaptureTool = Effect.fn("OpenBotToolRouter.screenCaptureTool")(function* (
    this: OpenBotToolRouter,
    client: AgentClient,
    request: AppServerRequest,
    params: DynamicToolCallParams,
  ) {
    const agentId = this.#conversation.agentForThread(params.threadId);
    const agent = agentId ? this.#hooks.listAgents().find((candidate) => candidate.id === agentId) : undefined;
    if (!agent) return openBotToolFailure(sourceText("error.agent.toolRequestInvalid"));
    if (!agentComputerUseEnabled(agent)) return openBotToolFailure(sourceText("error.agent.screenCaptureOff"));
    const host = this.#screenCapture;
    if (!host) return openBotToolFailure(sourceText("error.agent.screenCaptureUnavailable"));
    const threadId = this.#conversation.publicThreadId(agent.id, params.threadId);
    // A Slack, Discord or Telegram link sends each agent attachment of the turn to the platform. The
    // screen of this computer must stay on this computer.
    if (this.#messaging.linkForThread(threadId)) {
      return openBotToolFailure(sourceText("error.agent.screenCaptureShared"));
    }
    // A channel shows the image to each member who reads it, so each capture asks, with Full access too.
    const channelId = this.#channels.store.channelForThread(threadId);
    if (params.tool === "list_capture_sources") {
      const sources = yield* Effect.result(host.listSources());
      return Result.isFailure(sources) ? captureFailure(sources.failure) : openBotToolResult(sources.success);
    }
    const parsed = captureScreenToolSchema.safeParse(params.arguments, { reportInput: true });
    if (!parsed.success) return openBotToolFailure(profileToolErrorMessage(parsed.error));
    const capture = parsed.data;
    const messageId = responseAttachmentMessageId(params.threadId, params.turnId, params.callId);
    if (this.#conversation.ensureSnapshot(agent.id, threadId).messages.some(({ id }) => id === messageId)) {
      return openBotToolResult({ status: "shown", messageId });
    }
    const target = yield* this.#captureApprovalReason(host, capture);
    if (typeof target !== "string") return target;
    const channelName = channelId ? this.#channels.store.get(channelId).name : null;
    const reason =
      channelName === null
        ? target
        : `${target} ${sourceText("status.agent.screenCaptureChannel", { channel: channelName })}`;
    const decision = yield* this.#attention.awaitToolApproval(
      client,
      request,
      {
        requestId: request.id,
        agentId: agent.id,
        threadId,
        turnId: params.turnId,
        kind: "permissions",
        command: null,
        cwd: null,
        reason,
        grantRoot: null,
        permissions: null,
      },
      { alwaysAsk: channelId !== null },
    );
    if (decision !== "accept") return openBotToolFailure(sourceText("error.agent.screenCaptureDeclined"));
    const image = yield* Effect.result(host.capture(capture));
    if (Result.isFailure(image)) return captureFailure(image.failure);
    return yield* this.#showCapture(agent.id, threadId, params, messageId, image.success);
  });

  /**
   * `email_reply` and `email_send`: the host's mailboxes check the address, the mode, the limits and
   * an opt-out; a first contact from `email_send` waits for the owner's approval card, which Full
   * access does not answer.
   */
  readonly #mailTool = Effect.fn("OpenBotToolRouter.mailTool")(function* (
    this: OpenBotToolRouter,
    client: AgentClient,
    request: AppServerRequest,
    params: DynamicToolCallParams,
  ) {
    const agentId = this.#conversation.agentForThread(params.threadId);
    if (!agentId) return openBotToolFailure(sourceText("error.agent.toolRequestInvalid"));
    const port = this.#mail?.() ?? null;
    if (!port)
      return openBotToolFailure(
        "This server has no agent mailboxes. Tell the owner that mail needs the mail Worker and an address in Secrets, under Agent mailboxes.",
      );
    const call = parseMailToolCall(params.tool, params.arguments);
    if ("error" in call) return openBotToolFailure(`${call.error}\nCorrect the arguments and retry.`);
    const planned = port.plan(agentId, call);
    if (!planned.ok) return openBotToolFailure(planned.message);
    const { plan } = planned;
    if (plan.needsApproval) {
      const decision = yield* this.#attention.awaitToolApproval(
        client,
        request,
        {
          requestId: request.id,
          agentId,
          threadId: this.#conversation.publicThreadId(agentId, params.threadId),
          turnId: params.turnId,
          kind: "permissions",
          command: [
            `From: ${plan.from}`,
            `To: ${plan.to}`,
            `Subject: ${plan.subject}`,
            "",
            call.input.text.slice(0, 1_500),
          ].join("\n"),
          cwd: null,
          reason: sourceText("status.agent.mailFirstRecipient", { address: plan.to }),
          grantRoot: null,
          permissions: null,
        },
        { alwaysAsk: true, ownerOnly: true },
      );
      if (decision !== "accept")
        return openBotToolFailure(
          `The owner did not approve the first mail to ${plan.to}. Do not retry it or write to them another way.`,
        );
    }
    const sent = yield* Effect.promise(() =>
      port
        .send(agentId, call, { approved: plan.needsApproval, key: `${params.turnId}:${params.callId}` })
        .catch(() => ({ ok: false as const, message: "The mail was not sent. Try again later." })),
    );
    return sent.ok ? openBotToolResult(sent.result) : openBotToolFailure(sent.message);
  });

  /**
   * The MCP tools. A change waits for the user's approval, given at once for an agent with Full
   * access, and a server that needs a sign-in gets a card in the conversation. Every failure is a
   * result the agent can correct, with the MCP secrets masked.
   */
  readonly #mcpServerTool = Effect.fn("OpenBotToolRouter.mcpServerTool")(function* (
    this: OpenBotToolRouter,
    client: AgentClient,
    request: AppServerRequest,
    params: DynamicToolCallParams,
  ) {
    const agentId = this.#conversation.agentForThread(params.threadId);
    const servers = this.#mcpServers;
    if (!agentId || !servers || !isMcpServerTool(params.tool))
      return openBotToolFailure(sourceText("error.agent.toolRequestInvalid"));
    const threadId = this.#conversation.publicThreadId(agentId, params.threadId);
    return yield* handleMcpServerTool(servers, {
      tool: params.tool,
      arguments: params.arguments,
      approve: (reason, cwd) =>
        this.#attention
          .awaitToolApproval(client, request, {
            requestId: request.id,
            agentId,
            threadId,
            turnId: params.turnId,
            kind: "permissions",
            command: null,
            cwd: cwd ?? null,
            reason,
            grantRoot: null,
            permissions: null,
          })
          .pipe(
            Effect.map((decision) => decision === "accept"),
            toToolOperationFailed,
          ),
      requestSignIn: (config) =>
        toolStep(() =>
          this.#postSystemCard(agentId, threadId, params.turnId, {
            itemType: mcpSignInItemType({ mcpServerId: config.id }),
            text: sourceText("status.agent.mcpSignInRequested", { name: config.name }),
            eventType: "mcp.sign_in_requested",
            detail: { mcpServerId: config.id },
          }),
        ),
    });
  });

  /** Adds the note that an agent changed the Vault. `text` names the item, never a secret. */
  postVaultNote(agentId: string, threadId: string, turnId: string, text: string): void {
    this.#postSystemCard(agentId, threadId, turnId, {
      itemType: VAULT_CHANGE_ITEM_TYPE,
      text,
      eventType: "vault.changed",
      detail: {},
    });
  }

  /** Adds a card that the renderer draws from its item type, with `text` for a client that cannot. */
  #postSystemCard(
    agentId: string,
    threadId: string,
    turnId: string,
    card: {
      itemType: string;
      text: string;
      eventType: string;
      detail: { appId: string } | { mcpServerId: string } | Record<string, never>;
    },
  ): void {
    const snapshot = structuredClone(this.#conversation.ensureSnapshot(agentId, threadId));
    const message: ConversationMessage = {
      id: randomUUID(),
      turnId,
      author: "system",
      source: "system",
      status: "completed",
      createdAt: new Date().toISOString(),
      itemType: card.itemType,
      text: card.text,
    };
    snapshot.messages.push(message);
    snapshot.revision = this.#store.database.persistConversationChanges({
      agentId,
      threadId,
      activeTurnId: snapshot.activeTurnId,
      changedMessages: [message],
      eventType: card.eventType,
      detail: card.detail,
    });
    this.#conversation.setSnapshot(agentId, snapshot);
    this.#conversation.publishConversation(snapshot);
  }

  /** What the approval card says. A window that is gone is a result the agent can correct. */
  readonly #captureApprovalReason = Effect.fn("OpenBotToolRouter.captureApprovalReason")(function* (
    host: ScreenCaptureHost,
    capture: ScreenCaptureRequest,
  ) {
    if (capture.target === "region") {
      const { x, y, width, height } = capture.region;
      return sourceText("status.agent.screenCaptureRegion", { x, y, width, height });
    }
    // A failure here, such as a missing permission, is the same failure that the capture would give.
    const listed = yield* Effect.result(host.listSources());
    if (Result.isFailure(listed)) return captureFailure(listed.failure);
    const sources = listed.success;
    if (capture.target === "window") {
      const window = sources.windows.find(({ id }) => id === capture.windowId);
      if (!window) return openBotToolFailure(sourceText("error.agent.screenCaptureWindowMissing"));
      return sourceText("status.agent.screenCaptureWindow", { name: window.name });
    }
    const display = capture.displayId
      ? sources.displays.find(({ id }) => id === capture.displayId)
      : sources.displays.find(({ primary }) => primary);
    if (capture.displayId && !display) return openBotToolFailure(sourceText("error.agent.screenCaptureDisplayMissing"));
    return display?.name
      ? sourceText("status.agent.screenCaptureDisplay", { name: display.name })
      : sourceText("status.agent.screenCaptureScreen");
  });

  /**
   * Stores the capture as an attachment of a message in the conversation and gives the agent the
   * image. The image and its message are saved together, as for `html_render`.
   */
  readonly #showCapture = Effect.fn("OpenBotToolRouter.showCapture")(function* (
    this: OpenBotToolRouter,
    agentId: string,
    threadId: string,
    params: DynamicToolCallParams,
    messageId: string,
    image: ScreenCaptureImage,
  ) {
    yield* this.#addGeneratedMessage({
      agentId,
      threadId,
      turnId: params.turnId,
      messageId,
      file: {
        bytes: image.png,
        name: `Screen capture ${new Date().toISOString().replace(/[:.]/gu, "-")}.png`,
        mimeType: "image/png",
      },
      text: "",
      itemType: "agent_attachment",
      eventType: "response.attachments-added",
      detail: () => ({ turnId: params.turnId, messageId, attachmentCount: 1 }),
    });
    const result: DynamicToolResult = {
      success: true,
      contentItems: [
        {
          type: "inputText",
          text: JSON.stringify({
            status: "shown",
            messageId,
            source: image.sourceName,
            width: image.width,
            height: image.height,
          }),
        },
        { type: "inputImage", imageUrl: `data:image/png;base64,${Buffer.from(image.png).toString("base64")}` },
      ],
    };
    return result;
  }, Effect.uninterruptible);

  readonly #createAgent = Effect.fn("OpenBotToolRouter.createAgent")(
    function* (
      this: OpenBotToolRouter,
      params: DynamicToolCallParams,
      senderAgentId: string,
    ): Effect.fn.Return<OpenBotToolResponse, ToolOperationFailed> {
      const args = createAgentToolSchema.parse(params.arguments, { reportInput: true });
      const hue = args.avatarHue ?? null;
      const caller = this.#requireAgent(senderAgentId);
      // The user can cap how many agents agents create, so a loop cannot fill the host. There is no
      // cap by default. The user's own creations do not count.
      const creationLimit = this.#hooks.agentCreationLimit();
      if (creationLimit !== null) {
        const createdRecently = this.#store.createdByAgentsSince(new Date(Date.now() - AGENT_CREATION_WINDOW_MS));
        if (createdRecently >= creationLimit) {
          return openBotToolFailure(
            sourceText("error.agent.creationLimit", {
              made: createdRecently,
              hours: AGENT_CREATION_WINDOW_MS / 3_600_000,
              limit: creationLimit,
            }),
          );
        }
      }
      const listed = this.#hooks.listModels();
      // Checked before the agent exists: a named model the provider does not list, or an effort the
      // model does not support, is an error the calling agent can correct, never a silent default.
      const named = requestedToolModel(args, listed);
      // A request that names no provider and no model gives the new agent the caller's own model, so
      // a team that one agent recruits runs where that agent runs. When the caller's provider no
      // longer lists that model, the new agent starts where one the user creates does.
      const inherited =
        named === null
          ? (listed.find((model) => model.provider === caller.provider && model.id === caller.model) ?? null)
          : null;
      if (inherited && args.reasoningEffort !== undefined) requireReasoningEffort(inherited, args.reasoningEffort);
      const requested = named ?? inherited;
      const reasoningEffort = args.reasoningEffort ?? (inherited ? caller.reasoningEffort : undefined);
      // An effort alone applies to the model the new agent starts on, known only once it exists.
      const lateEffort = requested === null ? args.reasoningEffort : undefined;
      const sectionId = this.#sidebarLayout?.getSnapshot().agentAssignments[senderAgentId] ?? null;
      // A new agent starts with Full access, Computer Use and the auto-approve grant; the limits below
      // take Computer Use away unless asked for, and pass on the caller's own limits.
      const limits = newAgentLimits(caller, args);
      if (typeof limits === "string") return openBotToolFailure(limits);
      const create = (assign?: (agentId: string) => Effect.Effect<SidebarLayoutSnapshot, StoredStateFailure>) =>
        this.#hooks.createAgent(
          {
            name: args.name,
            description: args.description,
            initialMessage: args.initialMessage,
            ...(args.background ? { background: true } : {}),
            avatarSeed: args.avatarSeed ?? randomUUID(),
            avatarHue: hue,
            ...(requested
              ? {
                  provider: requested.provider,
                  model: requested.id,
                  ...(reasoningEffort ? { reasoningEffort } : {}),
                }
              : {}),
          },
          (agent) =>
            Effect.gen({ self: this }, function* () {
              // Before the first task is queued, so the new agent knows its creator from its first turn.
              this.#store.recordCreator(agent.id, senderAgentId);
              if (assign) yield* assign(agent.id).pipe(toToolOperationFailed);
              // Saved before the first message starts a turn. A failed write removes the new agent.
              if (!this.#approvalAutomation.autoApproves(caller.id) && this.#approvalAutomation.autoApproves(agent.id))
                yield* this.#approvalAutomation
                  .set({ agentId: agent.id, autoApprove: false })
                  .pipe(toToolOperationFailed);
              if (lateEffort !== undefined) {
                const models = this.#hooks.listModels();
                const model = models.find(
                  (candidate) => candidate.provider === agent.provider && candidate.id === agent.model,
                );
                // The new agent can keep a stored default that its provider does not list. The error names
                // that model and the listed ones, so the caller can name a model and try again.
                if (!model) {
                  throw new Error(
                    sourceText("error.agent.modelNotListed", {
                      model: agent.model,
                      models: modelList(models, agent.provider),
                    }),
                  );
                }
                requireReasoningEffort(model, lateEffort);
              }
              if (args.title === undefined && lateEffort === undefined && Object.keys(limits).length === 0)
                return agent;
              return yield* this.#store
                .updateAgent({
                  agentId: agent.id,
                  ...(args.title === undefined ? {} : { title: args.title }),
                  ...(lateEffort === undefined ? {} : { reasoningEffort: lateEffort }),
                  ...limits,
                })
                .pipe(toToolOperationFailed);
            }).pipe(Effect.catchDefect((cause) => Effect.fail(new ToolOperationFailed({ cause })))),
          senderAgentId,
        );
      const sidebar = this.#sidebarLayout;
      const created =
        sidebar && sectionId !== null
          ? yield* sidebar.withProfileAssignment(sectionId, create).pipe(toToolOperationFailed)
          : yield* create().pipe(toToolOperationFailed);
      // The first task is a message from the caller, so its chat shows the outgoing request.
      const callerSnapshot = this.#conversation.ensureSnapshot(senderAgentId, params.threadId);
      this.#mailboxSync.syncMailboxMessages(callerSnapshot);
      this.#conversation.emitConversation(callerSnapshot);
      yield* this.#audit.record({
        actor: auditActor({ kind: "agent", agentId: senderAgentId, name: caller.name }),
        action: "agent.create",
        target: { kind: "agent", id: created.id, name: created.name },
        names: Object.entries(args)
          .filter(([, value]) => value !== undefined)
          .map(([key]) => key),
      });
      return { success: true, contentItems: [{ type: "inputText", text: JSON.stringify(created) }] };
    },
    Effect.catchDefect((cause) => Effect.fail(new ToolOperationFailed({ cause }))),
    Effect.uninterruptible,
  );

  readonly #updateProfile = Effect.fn("OpenBotToolRouter.updateProfile")(
    function* (
      this: OpenBotToolRouter,
      params: DynamicToolCallParams,
      senderAgentId: string,
    ): Effect.fn.Return<OpenBotToolResponse, ToolOperationFailed> {
      const args = updateProfileToolSchema.parse(params.arguments, { reportInput: true });
      const {
        agentId,
        avatarHue,
        avatarPath,
        provider,
        model,
        reasoningEffort,
        providerAccountId,
        backupModels,
        access,
        computerUse,
        reportsToAgentId,
        ...fields
      } = args;
      if (avatarPath !== undefined && args.avatarSeed !== undefined) {
        throw new Error("Use avatarPath or avatarSeed, not both.");
      }
      const runtimeRequest = { provider, model, reasoningEffort };
      if (
        Object.values(fields).every((value) => value === undefined) &&
        Object.values(runtimeRequest).every((value) => value === undefined) &&
        providerAccountId === undefined &&
        backupModels === undefined &&
        access === undefined &&
        computerUse === undefined &&
        avatarHue === undefined &&
        avatarPath === undefined &&
        reportsToAgentId === undefined
      ) {
        throw new Error("At least one profile field is required.");
      }
      const sender = this.#hooks.listAgents().find((agent) => agent.id === senderAgentId);
      if (!sender) throw new Error("The calling agent no longer exists.");
      const target = this.#requireAgent(agentId);
      if (widensAgentSettings(target, access, computerUse)) {
        return openBotToolFailure(sourceText("error.agent.onlyUserWidensSettings"));
      }
      // Checked before anything is written, so a model the provider does not list leaves the name
      // and every other field of the same call unchanged.
      const runtime = requestedRuntime(target, runtimeRequest, this.#hooks.listModels());
      // The model and account the agent has after this call. A provider change without an account
      // moves the agent to the new provider's own sign-in.
      const ownProvider = runtime.provider ?? target.provider;
      const own: AgentModelChoice = {
        provider: ownProvider,
        model: runtime.model ?? target.model,
        providerAccountId:
          providerAccountId !== undefined
            ? (providerAccountId ?? undefined)
            : ownProvider === target.provider
              ? target.providerAccountId
              : undefined,
      };
      const backups =
        backupModels === undefined
          ? undefined
          : requestedBackupModels(backupModels, this.#hooks.listModels(), this.#hooks.providerAccounts, own);
      const image =
        avatarPath === undefined
          ? undefined
          : yield* loadAvatarFile(avatarPath, sender.workspacePath).pipe(toToolOperationFailed);
      const input: UpdateAgentInput = {
        agentId,
        ...(fields.name === undefined ? {} : { name: fields.name }),
        ...(fields.title === undefined ? {} : { title: fields.title }),
        ...(fields.description === undefined ? {} : { description: fields.description }),
        ...(fields.avatarSeed === undefined ? {} : { avatarSeed: fields.avatarSeed }),
        ...(fields.notifications === undefined ? {} : { notifications: fields.notifications }),
        ...runtime,
        // The agent service checks that the account exists for the agent's provider after this change.
        ...(providerAccountId === undefined ? {} : { providerAccountId }),
        ...(backups === undefined ? {} : { backupModels: backups }),
        ...restrictionInput(access, computerUse),
        ...(avatarHue === undefined ? {} : { avatarHue }),
        // The agent store refuses a manager in another space and a loop.
        ...(reportsToAgentId === undefined ? {} : { reportsToAgentId }),
      };
      let updated = yield* this.#hooks.updateAgent(input, senderAgentId).pipe(toToolOperationFailed);
      if (image !== undefined) {
        updated = yield* this.#hooks.setAvatar(agentId, image).pipe(toToolOperationFailed);
      } else if (args.avatarSeed !== undefined) {
        // Only a new generated face replaces an image. A color keeps it, as in the agent settings.
        updated = yield* this.#hooks.setAvatar(agentId, null).pipe(toToolOperationFailed);
      }
      return {
        success: true,
        contentItems: [
          {
            type: "inputText",
            text: JSON.stringify({
              id: updated.id,
              name: updated.name,
              title: updated.title,
              description: updated.description,
              avatarSeed: updated.avatarSeed,
              avatarHue: updated.avatarHue,
              avatarUrl: updated.avatarUrl,
              provider: updated.provider,
              model: updated.model,
              reasoningEffort: updated.reasoningEffort,
              // A runtime change during work applies before the next turn.
              ...(updated.pendingRuntime ? { pendingRuntime: updated.pendingRuntime } : {}),
              ...agentAccountSetup(updated),
              access: workspaceAccessEnforced(updated) ? "workspace" : "full",
              computerUse: agentComputerUseEnabled(updated),
              notifications: updated.notifications,
              background: isBackgroundAgent(updated),
              reportsTo: this.#managerOf(updated.id),
            }),
          },
        ],
      };
    },
    Effect.catchDefect((cause) => Effect.fail(new ToolOperationFailed({ cause }))),
    Effect.uninterruptible,
  );

  readonly #react = Effect.fn("OpenBotToolRouter.react")(
    function* (
      this: OpenBotToolRouter,
      params: DynamicToolCallParams,
      senderAgentId: string,
    ): Effect.fn.Return<OpenBotToolResponse, ToolOperationFailed> {
      const args = params.arguments;
      if (!isRecord(args) || !isMessageReaction(args.emoji)) {
        throw new Error("emoji must be exactly one complete Unicode emoji.");
      }
      const delivery = this.#mailbox
        .findDeliveriesByTurn(senderAgentId, params.turnId)
        .find((candidate) => candidate.delivery.sender.kind === "user");
      if (!delivery) throw new Error("Only the current user message can receive an agent reaction.");
      const emoji = args.emoji;
      yield* this.#mailbox
        .setReaction(senderAgentId, delivery.delivery.id, { kind: "agent", agentId: senderAgentId }, emoji)
        .pipe(toToolOperationFailed);
      const snapshot = this.#conversation.ensureSnapshot(senderAgentId, params.threadId);
      this.#mailboxSync.syncMailboxMessages(snapshot);
      this.#conversation.emitConversation(snapshot);
      return openBotToolResult({ status: "reacted", messageId: delivery.delivery.id, emoji: args.emoji });
    },
    Effect.catchDefect((cause) => Effect.fail(new ToolOperationFailed({ cause }))),
    Effect.uninterruptible,
  );

  /**
   * A message from one agent to another that a tool sends for it (a plan and its verdict): it wakes
   * the recipient and asks no reply. A retry with the same key sends nothing twice.
   */
  #notifyAgent(input: { from: string; to: string; text: string; key: string }) {
    return Effect.gen({ self: this }, function* () {
      if (this.#mailbox.receiptForKey(input.key)) return;
      const receipt = yield* this.#mailbox.enqueue({
        sender: { kind: "agent", agentId: input.from },
        recipientAgentIds: [input.to],
        text: input.text,
        sourcePaths: [],
        replyToMessageId: null,
        expectsReply: false,
        idempotencyKey: input.key,
      });
      for (const delivery of receipt.deliveries)
        yield* this.#hooks.steerWhenBusy(delivery.recipientAgentId, delivery.id);
      this.#mailboxSync.emitQueue(input.to);
      this.#drain.scheduleDrain(input.to);
    });
  }

  /**
   * The Motion card of an order that a `send_message` call asks for with `card`: made as the sender,
   * assigned to the one recipient, before the message goes, so the message can name it. A big order
   * also starts in plan mode. Null with a reason when no card can be made: the message goes anyway.
   */
  #orderCard(
    senderAgentId: string,
    recipients: readonly string[],
    text: string,
    summary: string | undefined,
    raw: unknown,
  ): Effect.Effect<{ card: OrderCard | null; append: string; note: string | null }> {
    return Effect.promise(async () => {
      const none = (note: string) => ({ card: null, append: "", note });
      const parsed = orderCardSchema.safeParse(raw === true ? {} : raw);
      if (!parsed.success) return none(`No card: ${z.prettifyError(parsed.error)}`);
      const port = this.#orderCards?.() ?? null;
      if (!port?.available()) return none("No card: this server has no Motion board.");
      const [recipient] = recipients;
      if (!recipient || recipients.length > 1)
        return none("No card: an order card goes to one recipient. Send one message per assignee.");
      const agents = this.#hooks.listAgents();
      const title = parsed.data.title ?? summary ?? text.split("\n")[0]?.slice(0, 120) ?? "Order";
      try {
        const card = await port.create({
          senderAgentId,
          recipientAgentId: recipient,
          recipientName: agents.find((agent) => agent.id === recipient)?.name ?? recipient,
          text,
          card: { ...parsed.data, title: title.slice(0, 200) },
        });
        const lines = [
          `Motion card: ${card.key} “${card.title}” ${card.url} (assigned to you${card.existing ? ", made earlier" : ""}). Keep it current as you work, and request review on it when done.`,
        ];
        if (needsPlan(parsed.data)) {
          const approver = planApprover(agents, recipient, senderAgentId);
          if (approver) {
            this.#plans.expect({
              assigneeAgentId: recipient,
              approverAgentId: approver,
              cardKey: card.key,
              title: card.title,
            });
            const approverName =
              approver === senderAgentId ? "I" : (agents.find((agent) => agent.id === approver)?.name ?? approver);
            lines.push(
              `Plan first: this is a big order. Before you spend money or start building, send your plan with openbot.submit_plan {"card":"${card.key}"}; ${approverName} approve${approverName === "I" ? "" : "s"} it, and you start when the approval reaches you.`,
            );
          }
        }
        return { card, append: `\n\n${lines.join("\n")}`, note: null };
      } catch (error) {
        logger.warn("Could not make the Motion card of an order.", { error });
        return none(
          `No card: Motion refused it (${error instanceof Error ? error.message.slice(0, 200) : "failed"}). The message went without one.`,
        );
      }
    });
  }

  readonly #sendMessage = Effect.fn("OpenBotToolRouter.sendMessage")(
    function* (
      this: OpenBotToolRouter,
      params: DynamicToolCallParams,
      senderAgentId: string,
    ): Effect.fn.Return<OpenBotToolResponse, ToolOperationFailed> {
      if (params.tool !== "send_message" || !isRecord(params.arguments)) {
        throw new Error(`Unsupported Atelier tool: ${params.tool}`);
      }
      const args = normalizeSendMessageArguments(params.arguments);
      const recipientValues = args.recipientAgentIds;
      if (recipientValues === undefined) throw new Error(`recipientAgentIds is missing. ${SEND_MESSAGE_USAGE}`);
      if (!Array.isArray(recipientValues) || !recipientValues.every((item) => isString(item))) {
        throw new Error(`recipientAgentIds must be an array of agent ids. ${SEND_MESSAGE_USAGE}`);
      }
      if (recipientValues.length === 0) throw new Error(`recipientAgentIds is empty. ${SEND_MESSAGE_USAGE}`);
      if (recipientValues.length !== new Set(recipientValues).size) {
        throw new Error("Duplicate recipients are not allowed.");
      }
      if (recipientValues.includes(senderAgentId)) throw new Error("An agent cannot message itself.");
      // An agent that the requesting member may not chat with reads as unknown, so the refusal does
      // not name it (upstream c57e4cb20).
      const requesterIds = this.#memberRequesters(senderAgentId, params.turnId);
      const reachable = this.#reachableAgentIds(senderAgentId, requesterIds);
      const known = new Map(
        this.#hooks
          .listAgents()
          .filter((agent) => reachable(agent.id))
          .map((agent) => [agent.id, agent]),
      );
      for (const recipient of recipientValues) {
        const agent = known.get(recipient);
        if (!agent) throw new Error(`Unknown Atelier agent: ${recipient}`);
        // A hidden agent receives no new messages until the user restores it.
        if (agent.hiddenAt !== undefined)
          throw new Error(`${recipient}: ${sourceText("error.backend.recipientHidden")}`);
      }
      const paths = args.paths ?? [];
      if (!Array.isArray(paths) || !paths.every((item) => isString(item))) {
        throw new Error("paths must be an array of local file paths.");
      }
      const replyToMessageId = args.replyToMessageId;
      if (
        replyToMessageId !== undefined &&
        replyToMessageId !== null &&
        (!isString(replyToMessageId) || replyToMessageId.length > INPUT_LIMITS.identifier)
      ) {
        throw new Error("replyToMessageId must be a message id.");
      }
      if (!isString(args.text) || args.text.trim() === "") throw new Error(`text is missing. ${SEND_MESSAGE_USAGE}`);
      const expectsReply = args.expectsReply;
      if (expectsReply !== undefined && typeof expectsReply !== "boolean") {
        throw new Error("expectsReply must be a boolean.");
      }
      const fyiValue = args.fyi;
      if (fyiValue !== undefined && typeof fyiValue !== "boolean") throw new Error("fyi must be a boolean.");
      // A reply is never held, so fyi marks only a new message.
      const fyi = fyiValue === true && !replyToMessageId?.trim();
      if (!fyi && recipientValues.length > AGENT_MESSAGE_FANOUT_LIMIT)
        throw new Error(
          `A message that wakes its recipients goes to at most ${AGENT_MESSAGE_FANOUT_LIMIT} teammates. Post an announcement in a channel, send it with fyi true, or message only the teammates who must act.`,
        );

      // A retried call finds its own message by the tool call id, so the guards below never turn the
      // retry of a send that worked into a failure.
      const idempotencyKey = toolCallIdempotencyKey(params);
      if (!this.#mailbox.receiptForKey(idempotencyKey)) {
        // The same words, to the same agents, while the first copy still waits or runs, add nothing.
        const duplicate =
          paths.length === 0
            ? this.#mailbox.activeDuplicate({
                senderAgentId,
                recipientAgentIds: recipientValues,
                text: args.text,
                replyToMessageId: replyToMessageId ?? null,
                expectsReply: expectsReply !== false,
                fyi,
              })
            : null;
        if (duplicate) {
          return openBotToolResult({
            ...duplicate,
            duplicate: true,
            note: sourceText("status.agent.messageDuplicate"),
          });
        }
        // A loop between two agents is told to stop and ask the user. A fan-out to several agents
        // is not a loop: each pair has its own count.
        const since = new Date(Date.now() - AGENT_MESSAGE_WINDOW_MS);
        for (const recipient of recipientValues) {
          const count = this.#mailbox.agentMessagesBetween(senderAgentId, recipient, since);
          if (count < AGENT_MESSAGE_LIMIT) continue;
          const name = this.#hooks.listAgents().find((agent) => agent.id === recipient)?.name ?? recipient;
          return openBotToolFailure(
            sourceText("error.agent.messageRateLimit", {
              sent: count,
              name,
              minutes: AGENT_MESSAGE_WINDOW_MS / 60_000,
              limit: AGENT_MESSAGE_LIMIT,
            }),
          );
        }
      }

      // A request from a Slack turn: the teammate's answer goes back to that Slack thread.
      const messagingReturn = this.#mailbox
        .findDeliveriesByTurn(senderAgentId, params.turnId)
        .map(({ delivery }) => this.#mailbox.messagingOrigin(delivery.id))
        .find((origin) => origin !== null);
      const summary = isString(args.summary) ? args.summary.slice(0, 240) : undefined;
      // An order with `card`: its Motion card first, so the message names it. A retry finds its message.
      const order =
        args.card !== undefined && args.card !== false && !fyi && !this.#mailbox.receiptForKey(idempotencyKey)
          ? yield* this.#orderCard(senderAgentId, recipientValues, args.text, summary, args.card)
          : null;
      const text = `${args.text}${order?.append ?? ""}`;
      const receipt = yield* this.#mailbox
        .enqueue({
          sender: { kind: "agent", agentId: senderAgentId },
          ...(requesterIds.length > 0 ? { requesterIds } : {}),
          recipientAgentIds: recipientValues,
          text,
          ...(summary ? { summary } : {}),
          sourcePaths: paths,
          // An agent can send "" for no reply. Every reader rejects an empty id.
          replyToMessageId: replyToMessageId?.trim() || null,
          ...(expectsReply === undefined ? {} : { expectsReply }),
          ...(fyi ? { fyi } : {}),
          ...(messagingReturn ? { messagingReturn } : {}),
          idempotencyKey,
        })
        .pipe(toToolOperationFailed);
      // Like a message from the user, a message from an agent joins the turn that runs now.
      for (const delivery of receipt.deliveries) {
        yield* this.#hooks.steerWhenBusy(delivery.recipientAgentId, delivery.id);
      }
      for (const recipient of recipientValues) {
        this.#mailboxSync.emitQueue(recipient);
        this.#drain.scheduleDrain(recipient);
      }
      const snapshot = this.#conversation.ensureSnapshot(senderAgentId, params.threadId);
      this.#mailboxSync.syncMailboxMessages(snapshot);
      this.#conversation.emitConversation(snapshot);
      // A held note starts no turn. The sender learns it here, so work it meant to start is sent again
      // without fyi.
      if (fyi)
        return openBotToolResult({
          ...receipt,
          note: looksLikeOrder(args.text)
            ? `${sourceText("status.agent.messageHeld")} It reads like an order: if they must act on it, send it again without fyi and with card.`
            : sourceText("status.agent.messageHeld"),
        });
      const orderNote = order
        ? (order.note ?? `Card ${order.card?.key} made and assigned; Atelier nudges it when it stalls.`)
        : args.card === undefined &&
            !replyToMessageId?.trim() &&
            looksLikeOrder(args.text) &&
            this.#orderCards?.()?.available()
          ? "Sent. It reads like an order: give a real order card ({title, criteria, dedupeKey}) next time, so it shows on Motion and cannot stall."
          : null;
      // A sleeping teammate keeps the message in its queue until a person or its lead wakes it.
      const sleeping = recipientValues.filter((recipient) => known.get(recipient)?.sleepingSince !== undefined);
      if (sleeping.length > 0)
        return openBotToolResult({
          ...receipt,
          note: `Asleep, so the message waits until it wakes: ${sleeping.map((id) => known.get(id)?.name ?? id).join(", ")}. Do not wait for an answer now.`,
          ...(order?.card ? { card: order.card } : {}),
        });
      return openBotToolResult({
        ...receipt,
        ...(order?.card ? { card: order.card } : {}),
        ...(orderNote ? { note: orderNote } : {}),
      });
    },
    Effect.catchDefect((cause) => Effect.fail(new ToolOperationFailed({ cause }))),
    Effect.uninterruptible,
  );
}
