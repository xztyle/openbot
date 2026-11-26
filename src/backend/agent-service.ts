import { createHash, randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { join } from "node:path";
import type { OwnerSummary } from "@openbot/contracts/agent-approvals";
import {
  agentHasPlaybookRole,
  type ModelSavingsSnapshot,
  type SetAgentsSleepingInput,
  type SleepTarget,
  teamAgentIds,
} from "@openbot/contracts/agent-efficiency";
import type { ForgetConversationInput, SettingsAuthor } from "@openbot/contracts/agent-learning";
import { agentManagers } from "@openbot/contracts/agent-org";
import { AGENT_PROVIDERS, agentProviderDescriptor, customAgentIdOfModel } from "@openbot/contracts/agent-providers";
import { sortConversationMessages } from "@openbot/contracts/conversation-order";
import { developmentStartingModel } from "@openbot/contracts/development-defaults";
import { INPUT_LIMITS } from "@openbot/contracts/input-limits";
import type {
  AgentAccessLevel,
  AgentAnalyticsInput,
  AgentAttentionItem,
  AgentEvent,
  AgentMemory,
  AgentMemorySelectionState,
  AgentModelId,
  AgentModelOption,
  AgentPendingRuntime,
  AgentPromptQuestion,
  AgentReasoningEffort,
  AgentRuntimeSnapshot,
  AgentSessionSettings,
  AgentStatus,
  AgentSummary,
  AgentTask,
  AgentTaskInput,
  AgentTasksSnapshot,
  AgentWaitsSnapshot,
  AskSideQuestionInput,
  AttachmentDataInput,
  AvatarImageInput,
  CancelMcpSignInInput,
  CapabilityState,
  ChannelMemory,
  ChannelRoutine,
  ChannelRoutineRun,
  ConversationFileSearchPage,
  ConversationMessage,
  ConversationMessageSender,
  ConversationPage,
  ConversationPageAnchor,
  ConversationReadState,
  ConversationSearchPage,
  ConversationSnapshot,
  ConversationWithReadState,
  CreateAgentInput,
  CreateAgentMemoryInput,
  CreateChannelMemoryInput,
  CreateChannelRoutineInput,
  CreateRoutineInput,
  CustomProviderRestart,
  DeleteAgentMemoryInput,
  DeleteChannelMemoryInput,
  DeleteChannelRoutineInput,
  DeleteRoutineInput,
  DeleteSharedTableInput,
  DraftAttachment,
  DuplicateAgentResult,
  GenerateAgentProfileInput,
  HiddenAgentsSnapshot,
  HostAnalyticsInput,
  ListChannelRoutineRunsInput,
  ListRoutineRunsInput,
  LocalBrowserSecretResponse,
  McpServerConfig,
  McpSignInAppInput,
  McpSignInAppState,
  McpSignInState,
  McpTestResult,
  ProviderCodeLoginStart,
  ProviderUsageResets,
  QueuedMessageReceipt,
  QueueSnapshot,
  RemoveMcpServerInput,
  ReorderQueueInput,
  ResetAgentSessionSettingInput,
  RespondToApprovalInput,
  RespondToBrowserTakeoverInput,
  RespondToPromptInput,
  Routine,
  RoutineRun,
  RunQueuedMessageAsTaskInput,
  SaveAgentProfileInput,
  SaveAgentProfileResult,
  SaveMcpServerInput,
  SaveMcpSignInAppInput,
  SendMessageInput,
  SetAgentHiddenInput,
  SetAgentMemoryInclusionInput,
  SetAgentSessionSettingInput,
  SetMcpServerEnabledInput,
  SetMessageReactionInput,
  SharedTable,
  SidebarLayoutSnapshot,
  SidebarSection,
  SignOutMcpServerInput,
  StartAgentTaskInput,
  SteerQueuedMessageInput,
  SystemNoticeKind,
  TestChannelRoutineInput,
  TestMcpServerInput,
  TestRoutineInput,
  TicketAsks,
  TicketVerdict,
  UpdateAgentInput,
  UpdateAgentMemoryInput,
  UpdateChannelMemoryInput,
  UpdateChannelRoutineInput,
  UpdateQueuedMessageInput,
  UpdateRoutineInput,
} from "@openbot/contracts/ipc";
import {
  AGENT_ATTENTION_TEXT_LIMIT,
  AGENT_REASONING_EFFORTS,
  AGENT_TASK_LIMIT_DEFAULT,
  type AgentDefaults,
  type AgentModelChoice,
  agentAutomationAllowed,
  agentBrowserProfile,
  agentNewChatAllowed,
  agentTaskLimit,
  type BusyMessageMode,
  CONDENSED_ORIGINAL_LIMIT,
  CONTEXT_RESET_ITEM_TYPE,
  channelKind,
  DEFAULT_BUSY_MESSAGE_MODE,
  DEFAULT_PROVIDER_ACCOUNT_ID,
  DEFAULT_WORKSPACE_CONDENSE,
  DEFAULT_WORKSPACE_LEARNING,
  DEFAULT_WORKSPACE_SETTINGS,
  defaultProviderModel,
  isAgentAccess,
  isAgentBackupModels,
  isAgentProvider,
  isContextResetMarker,
  isOwnQueuedMessage,
  isReasoningEffort,
  MODEL_SWITCH_ITEM_TYPES,
  MOTION_TICKET_TURN,
  type ModelSwitchReason,
  type QueueSteerFallback,
  SIGNED_OUT_CHANNEL_MEMBER_ID,
  sameAgentBrowserProfile,
  sameAgentModelChoice,
  WORKFLOWS_USAGE_ID,
  type WorkspaceFleetTicket,
  type WorkspaceGateSettings,
  type WorkspaceSettings,
  workspaceAccessEnforced,
} from "@openbot/contracts/ipc";
import { OWNER_MESSAGE_ITEM_TYPE } from "@openbot/contracts/owner-conversation";
import { CLAUDE_API_KEY_ACCOUNT_ID } from "@openbot/contracts/team-protocol/claude-api-key-v1";
import { ContextResetBusyError } from "@openbot/contracts/team-protocol/context-reset-v1";
import type { QueueEditRequest } from "@openbot/contracts/team-protocol/queue-edit-v1";
import { sourceText } from "@openbot/i18n/source";
import { createOpenBotLogger } from "@openbot/logging";
import { classifyFailure } from "@openbot/telemetry";
import { Cause, Deferred, Effect, Exit, Fiber, Result, Schema, Scope, Semaphore } from "effect";
import { AgentMemories } from "./agent/agent-memories";
import { AgentRemoval, AgentRemovalFailed } from "./agent/agent-removal";
import { AgentSettingsRefused } from "./agent/agent-settings-refused";
import type { ApprovalAutomationPolicy } from "./agent/approval-automation";
import { AttachmentGateway } from "./agent/attachment-gateway";
import {
  type ApprovalResponder,
  AttentionRegistry,
  type LocalAttentionResponse,
  type PromptResponder,
} from "./agent/attention-registry";
import { fanoutCandidates, reviewJudgeCandidates } from "./agent/background-models";
import { BootRecovery } from "./agent/boot-recovery";
import { BrowserUploads } from "./agent/browser-uploads";
import type { ChatVisualPreviewHost } from "./agent/chat-visual-preview";
import { ContextCompaction, IDLE_PRECOMPACT_STATE_FILE } from "./agent/context-compaction";
import { ConversationReader } from "./agent/conversation-reader";
import { ConversationRuntime } from "./agent/conversation-runtime";
import { CustomEndpoints, toEndpointChangeFailed } from "./agent/custom-endpoints";
import { DelegationFollowUp } from "./agent/delegation-follow-up";
import { agentNamesById, displayMessageReferences } from "./agent/delivery-content";
import { DeltaBuffer } from "./agent/delta-buffer";
import type { SectionTeammates } from "./agent/developer-instructions";
import { DrainScheduler, type FailoverReason } from "./agent/drain-scheduler";
import { DuplicationGate, toAgentDuplicationFailed } from "./agent/duplication-gate";
import type { FailureContext, FailureSignal } from "./agent/failure-signal";
import { GateGenerations } from "./agent/gate-generations";
import { type AgentHostedSites, HostedSiteCoordinator } from "./agent/hosted-site-coordinator";
import type { MotionPagePreview } from "./agent/human-view-preview";
import { ImageGenRuntime } from "./agent/image-gen-runtime";
import { InputEscalations } from "./agent/input-escalations";
import type { AgentMailPort } from "./agent/mail-tools";
import { MailboxSync } from "./agent/mailbox-sync";
import { type GitHubConnectorSource, McpGateway, type TestMcpServerOptions } from "./agent/mcp-gateway";
import { mcpServersFromGateway } from "./agent/mcp-tools";
import { MemoryHold } from "./agent/memory-hold";
import { MEMORY_REVIEW_MESSAGES, MEMORY_REVIEW_STATE_FILE, MemoryReview } from "./agent/memory-review";
import type { ReviewSkill } from "./agent/memory-review-prompt";
import { MemoryReviewState } from "./agent/memory-review-state";
import {
  creationModel,
  developmentDefaultsApply,
  type ModelChoice,
  modelUnavailableError,
  type ProviderPreference,
  startingChoice,
  startingModel,
} from "./agent/model-choice";
import { ModelPolicy, tierModel } from "./agent/model-policy";
import { OpenBotToolRouter } from "./agent/openbot-tool-router";
import type { OrderCardsPort } from "./agent/order-tools";
import { PAST_DECISIONS_FILE, PastDecisions } from "./agent/past-decisions";
import { ProfileClients } from "./agent/profile-clients";
import {
  GenerationUsageLimitError,
  generateProfile,
  generateTextWithoutTools,
  ProfileGenerationFailed,
} from "./agent/profile-generation";
import { ProfileSave, standingProfileChanged, toProfileSaveFailed } from "./agent/profile-save";
import { pickPoolAccount } from "./agent/provider-account-pool";
import type { ProviderAccountStore } from "./agent/provider-account-store";
import { isPlanLimitDiagnostic } from "./agent/provider-diagnostics";
import { type AgentClientFactory, ProviderRuntime, toProviderOperationFailed } from "./agent/provider-runtime";
import { QueueControls } from "./agent/queue-controls";
import { type CondenseModel, condenseAnswer } from "./agent/reply-condenser";
import { RoutinePrechecks } from "./agent/routine-prechecks";
import { quietRoutineRun } from "./agent/routine-quiet-runs";
import { type RoutineMutationOptions, RoutineScheduler, toRoutineOperationFailed } from "./agent/routine-scheduler";
import { localTimezone, openBotToolFailure } from "./agent/routine-tools";
import { buildRuntimeSnapshot } from "./agent/runtime-snapshot";
import type { ScreenCaptureHost } from "./agent/screen-capture";
import { SessionSettings } from "./agent/session-settings";
import { SIDE_QUESTION_CHAT_MESSAGES, sideQuestionPrompt } from "./agent/side-question";
import type { AgentSidebar } from "./agent/sidebar-tools";
import type { SkillLearner } from "./agent/skill-learning";
import type { LocalSkillTools } from "./agent/skill-tools";
import {
  agentProviderAccount,
  isRequestTimeout,
  providerForAgent,
  providerLabel,
  type ToolUsageSignal,
} from "./agent/thread-items";
import { ThreadLifecycle } from "./agent/thread-lifecycle";
import { toToolOperationFailed } from "./agent/tool-operation";
import { type AgentBrowserHost, type FinishedAnswer, TurnLifecycle } from "./agent/turn-lifecycle";
import {
  backgroundUsageObserver,
  condenseUsageObserver,
  gateUsageObserver,
  memoryReviewUsageObserver,
  workflowUsageObserver,
} from "./agent/usage-collection";
import { toUsageReadFailed, UsageLimitGate, type UsageLimitKey } from "./agent/usage-limit-gate";
import { WarmGenerations } from "./agent/warm-generations";
import type { WebhookRoutineWriter } from "./agent/webhook-routine-tool";
import { WideResearch } from "./agent/wide-research";
import { workspaceWritableRoots } from "./agent/workspace-sandbox";
import type { AgentApiKeys } from "./agent-api-keys";
import type { AgentProvider } from "./agent-client";
import type { SpaceAgentTables } from "./agent-data/space-agent-tables";
import { modelSavings } from "./agent-efficiency/model-savings";
import { PERFORMANCE_REVIEWS_FILE, PerformanceReviews } from "./agent-efficiency/performance-reviews";
import { ROLE_PLAYBOOKS_FILE, RolePlaybooks } from "./agent-efficiency/role-playbooks";
import { AGENT_LEARNING_FILE, AgentLearning } from "./agent-learning/agent-learning";
import { withLesson } from "./agent-learning/learning-prompts";
import {
  isCutText,
  recordedSkillLearner,
  SETTINGS_HISTORY_FILE,
  SettingsHistory,
  settingsSnapshot,
  snapshotChanges,
} from "./agent-learning/settings-history";
import { SPACE_KNOWLEDGE_FILE } from "./agent-learning/space-knowledge";
import { spaceMemoryTool } from "./agent-learning/space-memory-tool";
import type { AgentStore } from "./agent-store";
import { AgentTaskStore } from "./agent-tasks/agent-task-store";
import { AgentTasks } from "./agent-tasks/agent-tasks";
import { AgentWaitStore } from "./agent-waits/agent-wait-store";
import { AgentWaits } from "./agent-waits/agent-waits";
import type { ApprovalRouter } from "./approvals/approval-router";
import { automationRunCommand } from "./automation-command";
import { toChannelOperationError } from "./channel-effects";
import type { ChannelGateGeneration } from "./channel-gate";
import { ChannelRoutineScheduler } from "./channel-routine-scheduler";
import { hideChannelSecrets } from "./channel-secrets";
import { ChannelService } from "./channel-service";
import type { BundledProviderExecutables } from "./cli";
import type { ConversationMarkerExclusions } from "./conversation-read-store";
import { createEventCheckScheduler } from "./create-event-check-scheduler";
import type { EncodedResponseRoute } from "./database/database-read-protocol";
import type { ProviderSession } from "./database/provider-sessions";
import { reportOriginalFailure } from "./effect-boundary";
import type { EventCheckApiReader } from "./event-check-api-reader";
import { EventCheckDelivery } from "./event-check-delivery";
import type { EventCheckReader } from "./event-check-reader";
import type { EventCheckScheduler } from "./event-check-scheduler";
import type { EventCheckTemplates } from "./event-check-templates";
import { guardrailsRuntime } from "./guardrails/guardrails-runtime";
import type { GuardrailsService } from "./guardrails/guardrails-service";
import type { HostMemory } from "./host-memory";
import type { InsightService } from "./insight/insight-service";
import { motionTicketCreator } from "./loops/loop-motion";
import { LoopService } from "./loops/loop-service";
import type { MailboxStore } from "./mailbox-store";
import { type McpAgent, personalizeMcpConfig } from "./mcp-agent-values";
import { type McpOperationError, toMcpOperationError } from "./mcp-effects";
import type { McpSignInOpener } from "./mcp-oauth-provider";
import type { McpEndpoint, McpEndpointRefusal } from "./mcp-provider-shapes";
import { McpServerStore } from "./mcp-server-store";
import { MessagingThreads, toMessagingThreadFailed } from "./messaging/messaging-threads";
import type { OwnerAwayService } from "./owner-away";
import type { PasswordVault } from "./password-vault";
import type { PortfolioService } from "./portfolio/portfolio-service";
import { postCardTool, reportValidationTool } from "./portfolio/portfolio-tools";
import { decodeRecordResponse, getString } from "./protocol";
import { NO_PROVIDER_CREDENTIALS, type ProviderClientContext } from "./provider-drivers";
import { providerHistoryPersistence } from "./provider-history-persistence";
import { recordAgentRestartActivity } from "./restart-activity";
import type { RoutineFlowTools } from "./routine-flows/routine-flow-tools";
import { RoutineRecords } from "./routine-records";
import type { RoutineHoldWindow } from "./routine-store";
import { type RoutineDueSource, RoutineTimer } from "./routine-timer";
import { LOCAL_USER_ACTOR, type SecurityActor } from "./security-actor";
import { auditActor, NO_SECURITY_AUDIT, type SecurityAuditSink } from "./security-audit-log";
import type { SidebarLayoutStore } from "./sidebar-layout-store";
import { agentSeesChannel } from "./spaces/space-scope";
import { SpaceService } from "./spaces/space-service";
import type { TrustService } from "./trust/trust-service";
import type { VaultItems } from "./vault-items";
import type { WorkflowRunEnd } from "./workflows/workflows";
import { WorkspaceInsights, type WorkspaceInsightsOptions } from "./workspace-insights";
import {
  listWorkspaceDirectory,
  type ResolvedSharedFile,
  resolveSharedFile,
  resolveWorkspaceFile,
} from "./workspace-paths";
import { WorkspaceSecretsService } from "./workspace-secrets";
import type { SharePreviewDrawer } from "./workspace-thumbnails";

const logger = createOpenBotLogger("agent-service");

/** The events after which the list of requests that wait for the user can change. */
const ATTENTION_LIST_EVENTS: ReadonlySet<AgentEvent["type"]> = new Set([
  "prompt",
  "approval",
  "browser-takeover-requested",
  "agent-input-resolved",
  "browser-takeover-resolved",
  "turn-completed",
  "runtime-snapshot",
  // The owner's message to an agent with a waiting ticket marks it asked (`ownerAsked`).
  "turn-started",
  "queue-changed",
]);

/**
 * Only the application knows which managed CLIs it downloaded, so a caller that says nothing gets
 * none of them. Codex is left out on purpose: it is the one provider that can also ship inside the
 * application, and an unset entry keeps that copy in the search.
 */
const DEFAULT_BUNDLED_EXECUTABLES: BundledProviderExecutables = { claude: null, grok: null };

export type { TestMcpServerOptions } from "./agent/mcp-gateway";
export type { RoutineMutationOptions } from "./agent/routine-scheduler";
export type { ResolvedSharedFile } from "./workspace-paths";

interface AgentServiceEvents {
  failure: [failure: FailureSignal];
  event: [event: AgentEvent];
  /** Finished tool steps for the local host's product analytics. Never forwarded to a client. */
  toolUsage: [usage: ToolUsageSignal];
  /** A workflow run ended, for the local host's product analytics. Never forwarded to a client. */
  workflowRun: [end: WorkflowRunEnd];
}

export interface AgentServiceOptions {
  eventCheckReader?: EventCheckReader;
  eventCheckApiReader?: EventCheckApiReader;
  eventCheckTemplates?: EventCheckTemplates;
  /** Where changes that move trust are recorded. Without it nothing is recorded. */
  securityAudit?: SecurityAuditSink;
  /** The trust policy that gates spend, publishing, email and deletes, and its audit trail. */
  trust?: TrustService;
  /** Budgets, run breakers, the stuck watch, the injection monitor and the subscription failover. */
  guardrails?: GuardrailsService;
  /** Tier 1 of `docs/approvals.md`: requests that the asking agent's manager answers. */
  approvals?: ApprovalRouter;
  store: AgentStore;
  mailbox: MailboxStore;
  browser: AgentBrowserHost;
  requestTimeoutMs?: number;
  /**
   * How long a provider takes to start a context compaction before OpenBot stops it. A started
   * compaction runs ten times as long. Tests make it short.
   */
  contextCompactionTimeoutMs?: number;
  preferredProvider?: AgentProvider;
  /** The model chosen beside `preferredProvider`, or `null` for that provider's own default. */
  preferredModel?: AgentModelId | null;
  clientFactory?: AgentClientFactory | null;
  bundledExecutables?: BundledProviderExecutables;
  prepareAgentWorkspace?: (agent: AgentSummary) => Effect.Effect<void, AgentLifecycleFailed>;
  hostedSites?: AgentHostedSites | null;
  /** Draws pages for `html_preview`. Without it the tool tells the agent to show the page unchecked. */
  visualPreview?: ChatVisualPreviewHost | null;
  /** Captures the desktop for `capture_screen`; null where this process has no desktop. */
  screenCapture?: ScreenCaptureHost | null;
  /**
   * What an agent's MCP server test waits for first, as the Test button does: the managed tool
   * runtimes a stdio command may need. Without it the test runs with what this machine holds.
   */
  prepareMcpTest?: (config: McpServerConfig) => Effect.Effect<void, unknown>;
  sidebarLayout?: AgentSidebar | null;
  /**
   * What a spawned CLI is given beyond its own binary: the stored keys, and the user's own model
   * endpoints. The main process owns both, because they carry secrets that must not reach the
   * renderer or the database.
   */
  credentials?: ProviderClientContext;
  offProviders?: readonly AgentProvider[];
  /** The provider accounts after the first. Omitted, each provider holds its own sign-in only. */
  providerAccounts?: ProviderAccountStore;
  saveProviderUse?: (provider: AgentProvider, on: boolean) => Effect.Effect<void, AgentLifecycleFailed>;
  localSkillTools?: (() => LocalSkillTools) | undefined;
  /** Built after the service, so read when a tool call needs it. */
  routineFlowTools?: () => RoutineFlowTools;
  /** Built after the service, so read when a tool call needs it. */
  webhookRoutines?: () => WebhookRoutineWriter;
  /** The agent mailboxes (`email_reply`, `email_send`). Built after the service; null where there are none. */
  agentMail?: () => AgentMailPort | null;
  /**
   * Whose approvals are answered without asking. The main process owns the preference, because it
   * is a property of this computer and never crosses the Team API. Omitted, every approval asks.
   */
  approvalAutomation?: ApprovalAutomationPolicy | undefined;
  /**
   * The app default for a message sent while its agent works. The main process owns the preference.
   * Omitted, such a message waits in the queue, as every one did before the setting existed.
   */
  busyMessageMode?: () => BusyMessageMode;
  /**
   * How many memories one agent can hold. The main process owns the preference. Omitted, the
   * default cap, which was the only cap before the setting existed.
   */
  agentMemoryLimit?: () => number;
  /**
   * How many agents other agents may create in `AGENT_CREATION_WINDOW_MS`, or null for no limit. The
   * main process owns the preference. Omitted, no limit.
   */
  agentCreationLimit?: () => number | null;
  /**
   * The server timezone, for a routine an agent creates without a zone from the tool call or the
   * sender. The main process owns the preference. Omitted, the host system zone.
   */
  timezone?: () => string;
  /**
   * Other owners of scheduled work on the same routine timer, such as workflow triggers. They are
   * read on each arm, because the main process builds them after this service.
   */
  extraRoutineSources?: () => Iterable<RoutineDueSource>;
  /**
   * The access level of the person who asked a channel member to add or remove an agent, for that
   * agent, as the Team API gives it for their own save. Omitted, `manage`.
   */
  channelPersonAgentLevel?: (personId: string, agentId: string) => AgentAccessLevel;
  /** Whether that person uses a remote client, which has only the released routine schedules. Omitted, no. */
  channelRemotePerson?: (personId: string) => boolean;
  /** A person of the team by id, for channel invitations and DMs. Omitted, every id is a person. */
  channelPerson?: (personId: string) => { id: string; name: string } | null;
  /** The workspace settings of this server. Omitted, the defaults. */
  workspaceSettings?: () => WorkspaceSettings;
  /** The skills that a memory review may revise, and the library it saves learned skills in. Omitted, no skill learning. */
  reviewSkills?: (agentId: string) => Effect.Effect<readonly ReviewSkill[], unknown>;
  skillLearner?: () => SkillLearner;
  /** Installs a local skill of the library on another agent, for a suggestion across spaces. */
  copySkill?: (skillId: string, toAgentId: string) => Effect.Effect<void, unknown>;
  /** Every active person of the team, the host user first, for the onboarding `#general`. */
  channelPeople?: () => { id: string; name: string }[];
  deleteWithRevokedApproval?: (
    agentId: string,
    remove: () => Effect.Effect<void, AgentRemovalFailed>,
  ) => Effect.Effect<void, AgentRemovalFailed>;
  /**
   * The shared database agents keep their tables in. Injected because the host child's packaged
   * path is the main process's knowledge, not this class's.
   */
  tables?: SpaceAgentTables | null;
  /**
   * Whether a new agent starts on the development default model rather than the built-in one.
   * The main process passes the app variant; only a dev build turns it on.
   */
  developmentDefaults?: boolean;
  /**
   * The Computer Use driver's MCP entry while its daemon runs, or `null`.
   *
   * A function rather than a value because the daemon starts and stops under the user, and the
   * answer is read at each spawn. It is the main process's knowledge: the driver is a child of the
   * main process, not of this class.
   */
  computerUseMcpServer?: () => McpServerConfig | null;
  /**
   * The built-in GitHub connection of this computer, or `null`. Read at each spawn and each hand-off,
   * for the same reason as `computerUseMcpServer`: the user connects and disconnects while OpenBot runs.
   */
  githubConnector?: GitHubConnectorSource | null;
  /** The 1Password vault the user shared with OpenBot, or `null`. The browser fills logins from it. */
  passwordVault?: PasswordVault | null;
  /** The cards and contact info of the Vault, or `null`. The browser fills cards from it. */
  vaultItems?: VaultItems | null;
  /** Where the API keys that users enter through `request_api_key` are saved, or `null`. */
  agentApiKeys?: AgentApiKeys | null;
  /**
   * The memory of a server, or `null` on a desktop computer. With it, no new turn starts
   * while memory is low, and only a fixed number of turns run at the same time.
   */
  hostMemory?: HostMemory | null;
  /**
   * The turn limits that an owner or admin set for this host. `turnLimit` is the total, "unlimited"
   * for no limit, or null for automatic (see `hostMemory`); `agentTaskLimit` is the task limit of an
   * agent with no limit of its own. Without it, both keep their defaults. Call `turnLimitsChanged`
   * after a change.
   */
  hostTurnLimits?: { turnLimit(): number | "unlimited" | null; agentTaskLimit(): number };
  /** The host-only file of the workspace artifact index. Omitted or null, it is kept in memory only. */
  workspaceArtifactsPath?: string | null;
  /** The thumbnails of the workspace artifacts that are web pages. Omitted or null, none is drawn. */
  workspaceThumbnails?: WorkspaceInsightsOptions["thumbnails"];
  /** The owner's quiet hours, focus and held requests: `hold_for_owner`, `alert_owner`, the turn note. */
  ownerAway?: OwnerAwayService | null;
  /** Draws the pages of `share_preview`. Omitted or null, a url preview tells the agent to send the link. */
  sharePreviews?: SharePreviewDrawer | null;
  /**
   * Text that an agent sent the owner (an owner-started answer, `message_owner`, a held request, a
   * preview): the Motion pages it links get a human version (`motion-human-views.ts`).
   */
  ownerText?: ((agentId: string, text: string) => void) | null;
  /** The human version of a Motion page link, for the chat preview of `share_preview`. */
  motionPreview?: MotionPagePreview | null;
}

/** How long a user send's `clientMessageId` answers a retry. A retry follows a lost reply, not a day. */
const USER_SEND_RETRY_WINDOW_MS = 24 * 60 * 60 * 1000;
/** How long a deploy hold outlives its wait, for a deploy that stopped before it restarted the server. */
const DEPLOY_DRAIN_HOLD_GRACE_MS = 5 * 60_000;
/** The cheap checks of scheduled routine runs. See `routine-prechecks.ts`. */
const ROUTINE_PRECHECKS_FILE = "openbot-routine-prechecks-v1.json";
/** The `send_message` recipient limit, so one message can reach every section-mate the prompt names. */
const MAX_SECTION_TEAMMATES = 32;

/** The user's update, and the browser profile choice that the profile operations set after their checks. */
export type AgentUpdate = UpdateAgentInput & { ownBrowserSession?: boolean; browserProfileId?: string | null };

export class AgentService extends EventEmitter<AgentServiceEvents> {
  readonly channels: ChannelService;
  /** The fleet, step trail and artifact views of the workspace. */
  readonly workspace: WorkspaceInsights;
  /** The Secrets view: the agent key store, for the owner and the admins. */
  readonly secrets: WorkspaceSecretsService;
  /** The spaces, and the space of each agent and channel. Agents see and reach only their own space. */
  readonly spaces: SpaceService;
  /** The owner's loops (pipelines) of each space, their items, experiments and decisions. */
  readonly loops: LoopService;
  /** Goals, money, costs and the briefing (`insight/`), which the application attaches after start. */
  insight: InsightService | null = null;
  /** Test suites, live scores, templates, value, the reality check and cards (`portfolio/`), attached after start. */
  portfolio: PortfolioService | null = null;
  readonly messaging: MessagingThreads;
  readonly #profileSave: ProfileSave;
  readonly #profileClients = new ProfileClients();
  readonly #warmGenerations = new WarmGenerations({
    ownerFor: (provider) => this.#providers.currentClient(provider),
    createClient: (provider) => this.#providers.createProfileClient(provider),
    profileClients: this.#profileClients,
  });
  /**
   * The disposable generations of the channel answer gate. Apart from `#profileClients`, so the gate
   * has its own concurrency budget (`GATE_CONCURRENCY`) and does not hold back the others.
   */
  readonly #gateClients = new ProfileClients();
  /** The warm clients of the channel answer gate, apart from the workflow one. */
  readonly #gateGenerations = new GateGenerations({
    ownerFor: (provider) => this.#providers.currentClient(provider),
    createClient: (provider) => this.#providers.createProfileClient(provider),
    profileClients: this.#gateClients,
  });
  #scope = Scope.makeUnsafe();
  /** The server's workspace settings, read on each use: the gate model and the reply condenser. */
  readonly #workspaceSettings: () => WorkspaceSettings;
  /** The Motion ticket each agent works on now (`setCurrentTickets`). */
  #currentTicket: (agentId: string) => WorkspaceFleetTicket | null = () => null;
  /** Makes the Motion cards of orders between agents (`setOrderCards`). */
  #orderCards: OrderCardsPort | null = null;
  /** The disposable clients of the grader and the wide research runs, apart from the profile drafts'. */
  readonly #backgroundClients = new ProfileClients();
  readonly #wideResearch: WideResearch;
  /** User sends still before their mailbox write, by idempotency key: a retry joins the first call. */
  readonly #pendingUserSends = new Map<string, Deferred.Deferred<QueuedMessageReceipt, AgentLifecycleFailed>>();
  readonly #store: AgentStore;
  readonly #mailbox: MailboxStore;
  readonly #browser: AgentBrowserHost;
  readonly #reader: ConversationReader;
  readonly #memories: AgentMemories;
  readonly #memoryReview: MemoryReview;
  /** The playbooks of roles, which every agent of a role gets as a skill. */
  readonly playbooks: RolePlaybooks;
  /** The weekly performance reviews of the agents. */
  readonly reviews: PerformanceReviews;
  /** The checkpoints of each agent's settings, with their authors, for a rollback. */
  readonly settingsHistory: SettingsHistory;
  /** The nightly memory cleanup, the lessons of finished tasks and the knowledge of each space. */
  readonly learning: AgentLearning;
  /**
   * Whether a decision queue entry (`learning:<id>`, `playbook:<id>`, `review:<id>`) is with the
   * agent's manager (`docs/approvals.md`): the owner's queue and inbox leave it out. Set by the host.
   */
  lessonWithManager: (queueId: string) => boolean = () => false;
  /** The skill library of the reviews, with each save in the settings history. Null without skill learning. */
  readonly #learnedSkills: (() => SkillLearner) | null;
  readonly #skillLibrary: (() => SkillLearner) | null;
  readonly #reviewSkills: AgentServiceOptions["reviewSkills"];
  readonly #waits: AgentWaits;
  readonly #tasks: AgentTasks;
  readonly #tables: SpaceAgentTables | null;
  readonly #routines: RoutineScheduler;
  readonly #routineTimer: RoutineTimer;
  readonly #audit: SecurityAuditSink;
  readonly #channelRoutines: ChannelRoutineScheduler;
  /** Agent and channel routines of every trigger kind, with their webhook routes. */
  readonly routineRecords: RoutineRecords;
  readonly eventChecks: EventCheckScheduler;
  readonly #mcp: McpGateway;
  readonly #agentApiKeys: AgentApiKeys | null;
  readonly #providers: ProviderRuntime;
  readonly #providerUseChanges = Semaphore.makeUnsafe(1);
  readonly #endpoints: CustomEndpoints;
  readonly #prepareAgentWorkspace: (agent: AgentSummary) => Effect.Effect<void, AgentLifecycleFailed>;
  readonly #hostedSites: HostedSiteCoordinator;
  readonly #conversation: ConversationRuntime;
  readonly #attention: AttentionRegistry;
  /** The owner decision cards that wait for the owner after their call ended. */
  readonly #pastDecisions: PastDecisions;
  readonly #images: ImageGenRuntime;
  readonly #threads: ThreadLifecycle;
  readonly #memoryHold: MemoryHold;
  readonly #usageLimits: UsageLimitGate;
  readonly #guardrails: GuardrailsService | null;
  readonly #drain: DrainScheduler;
  readonly #modelPolicy: ModelPolicy;
  readonly #sessionSettings: SessionSettings;
  readonly #queue: QueueControls;
  readonly #attachments: AttachmentGateway;
  readonly #browserUploads: BrowserUploads;
  readonly #mailboxSync: MailboxSync;
  readonly #followUp: DelegationFollowUp;
  /** Built after the attention registry and the mailbox; an event before then has no request to escalate. */
  readonly #escalations: InputEscalations | undefined;
  /** The last list that `agent-attention-changed` sent, as JSON. */
  #attentionEncoded = "[]";
  readonly #boot: BootRecovery;
  readonly #deltas: DeltaBuffer;
  readonly #turn: TurnLifecycle;
  readonly #compaction: ContextCompaction;
  readonly #duplication: DuplicationGate;
  readonly #removal: AgentRemoval;
  readonly #tools: OpenBotToolRouter;
  readonly #sidebarLayout: AgentSidebar | null;
  readonly #localSkillTools: (() => LocalSkillTools) | undefined;
  readonly #routineFlowTools: (() => RoutineFlowTools) | undefined;
  readonly #developmentDefaults: boolean;
  /** The task limit of an agent that has no limit of its own on this host. */
  readonly #defaultTaskLimit: () => number;
  readonly #busyMessageMode: () => BusyMessageMode;
  /** The last turn of each agent's chat that the user stopped. One per agent, so it needs no clean-up. */
  readonly #stoppedTurns = new Map<string, string>();
  /** The agents that asked for a new chat with `start_new_chat`. A restart forgets the request. */
  readonly #requestedNewChats = new Set<string>();
  /**
   * The deliveries that boot recovery ended as interrupted in this process: the work that the last
   * restart, or a provider process that exited, cut off. The operator's resume route reads it.
   */
  readonly #restartInterruptedDeliveryIds = new Set<string>();
  /** When the service last asked for each pool's usage, in epoch milliseconds, and the pools whose read runs. */
  readonly #poolReads = new Map<AgentProvider, number>();
  readonly #poolReading = new Set<AgentProvider>();
  #initialized = false;
  #stopping = false;
  /** Until when a deploy holds new turns, in epoch milliseconds, or null. See `drainForDeploy`. */
  #deployDrainUntil: number | null = null;
  #deployDrainTimer: NodeJS.Timeout | null = null;

  constructor(options: AgentServiceOptions) {
    super();
    // The main process subscribes one listener to `event` per feature (renderers, trace, routines,
    // Motion, learning, guardrails, resources...): a dozen is the design, not a leak. The warning at
    // Node's default of 10 showed in the live log after each start.
    this.setMaxListeners(40);
    const {
      store,
      mailbox,
      browser,
      requestTimeoutMs = 30_000,
      preferredProvider = "codex",
      preferredModel = null,
      clientFactory = null,
      bundledExecutables = DEFAULT_BUNDLED_EXECUTABLES,
      prepareAgentWorkspace = () => Effect.void,
      hostedSites = null,
      sidebarLayout = null,
      credentials = NO_PROVIDER_CREDENTIALS,
      localSkillTools,
      routineFlowTools,
      developmentDefaults = false,
      computerUseMcpServer = () => null,
      githubConnector = null,
      hostMemory = null,
      hostTurnLimits,
      busyMessageMode = () => DEFAULT_BUSY_MESSAGE_MODE,
    } = options;
    this.#developmentDefaults = developmentDefaults;
    this.#defaultTaskLimit = () => hostTurnLimits?.agentTaskLimit() ?? AGENT_TASK_LIMIT_DEFAULT;
    this.#audit = options.securityAudit ?? NO_SECURITY_AUDIT;
    this.#busyMessageMode = busyMessageMode;
    this.#localSkillTools = localSkillTools;
    this.#routineFlowTools = routineFlowTools;
    this.#guardrails = options.guardrails ?? null;
    this.#store = store;
    // First of the sub-objects, because `#emitError` reads it to redact and every one of them is
    // given that callback.
    this.#agentApiKeys = options.agentApiKeys ?? null;
    this.#mcp = new McpGateway({
      servers: new McpServerStore(store.database),
      credentials,
      computerUseMcpServer,
      githubConnector,
      logger,
      // Read late: the conversation runtime is built further down this constructor.
      personalize: (threadId, configs) => this.#personalMcp(threadId, configs),
      hooks: {
        emitError: (code, error) => this.#emitError(code, error),
        // Read late: the threads are built further down this constructor.
        refreshAllAgentRuntimes: () => this.#threads.refreshAllAgentRuntimes(),
      },
    });
    this.#sidebarLayout = sidebarLayout;
    this.#profileSave = new ProfileSave(store, {
      create: (input, configure, sender) =>
        this.createAgent(
          { ...input.draft, initialMessage: input.initialMessage ?? "" },
          (agent) =>
            configure(agent).pipe(
              Effect.mapError(
                (failure) => new AgentLifecycleFailed({ operation: "configure profile", cause: failure.cause }),
              ),
            ),
          input.operationId,
          sender,
        ).pipe(toProfileSaveFailed),
      changed: (agent, previous) => {
        if (standingProfileChanged(previous, agent, this.#store.agentDefaults()))
          this.#conversation.unloadAgentThreads(agent.id);
        this.#emit({ type: "agents-changed", agents: this.listAgents() });
        this.#drain.scheduleDrain(agent.id);
      },
      delete: (agent) =>
        this.#removal.deleteData(agent).pipe(
          toProfileSaveFailed,
          Effect.tap(() => Effect.sync(() => this.#emit({ type: "agents-changed", agents: this.listAgents() }))),
        ),
    });
    this.#mailbox = mailbox;
    this.#browser = browser;
    this.#prepareAgentWorkspace = prepareAgentWorkspace;
    this.#conversation = new ConversationRuntime(
      store,
      (event) => this.#emit(event),
      () => this.listAgents(),
    );
    this.#tasks = new AgentTasks({
      store: new AgentTaskStore(store.database),
      mailbox,
      conversation: this.#conversation,
      hooks: {
        emit: (event) => this.#emit(event),
        agent: (agentId) => store.list().find((agent) => agent.id === agentId),
        defaultTaskLimit: () => this.#defaultTaskLimit(),
        // Read late: the drain is built further down this constructor.
        hold: (agentId, taskId) => this.#drain.taskHold(agentId, taskId),
        queued: (agentId) => {
          this.#mailboxSync.emitQueue(agentId);
          this.#drain.scheduleDrain(agentId);
        },
      },
    });
    this.#tables = options.tables ?? null;
    this.#workspaceSettings = () => options.workspaceSettings?.() ?? DEFAULT_WORKSPACE_SETTINGS;
    this.#memories = new AgentMemories({
      store,
      conversation: this.#conversation,
      emit: (event) => this.#emit(event),
      emitError: (code, error, agentId) => this.#emitError(code, error, agentId),
      ...(options.agentMemoryLimit ? { limit: options.agentMemoryLimit } : {}),
    });
    this.settingsHistory = new SettingsHistory(join(store.database.userDataPath, SETTINGS_HISTORY_FILE));
    // A change of an agent's settings runs its test suite again, after a short wait.
    this.settingsHistory.onRecord((checkpoint) =>
      this.portfolio?.suites.settingsChanged(
        checkpoint.agentId,
        checkpoint.id,
        checkpoint.changes.map((change) => change.field),
      ),
    );
    this.playbooks = new RolePlaybooks({
      path: join(store.database.userDataPath, ROLE_PLAYBOOKS_FILE),
      agents: () => this.#store.list(),
      contentChanged: (playbook, before, after, author) => {
        for (const agent of this.#store.list())
          if (agentHasPlaybookRole(agent, playbook.roles))
            Effect.runFork(
              this.settingsHistory.record(agent.id, author, [
                { field: "playbook", ref: playbook.id, label: playbook.slug, before, after },
              ]),
            );
      },
    });
    this.reviews = new PerformanceReviews({
      path: join(store.database.userDataPath, PERFORMANCE_REVIEWS_FILE),
      database: () => this.#store.database.connection,
      agents: () => this.#store.list(),
      running: () => this.#initialized && !this.#stopping,
      generate: (agent, prompt) => this.#generateReview(agent, prompt),
      applyInstruction: (agentId, text) => this.#applyReviewInstruction(agentId, text),
    });
    const rawSkillLearner = options.skillLearner;
    this.#skillLibrary = rawSkillLearner ?? null;
    this.#reviewSkills = options.reviewSkills;
    this.#learnedSkills = rawSkillLearner ? () => recordedSkillLearner(rawSkillLearner(), this.settingsHistory) : null;
    const skillLearner = this.#learnedSkills;
    this.learning = new AgentLearning({
      path: join(store.database.userDataPath, AGENT_LEARNING_FILE),
      knowledgePath: join(store.database.userDataPath, SPACE_KNOWLEDGE_FILE),
      agents: () => this.#store.list(),
      agentSpace: (agentId) => store.spaces.agentSpaceId(agentId),
      spaces: () => store.spaces.list(),
      running: () => this.#initialized && !this.#stopping,
      timeZone: () => options.timezone?.() ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
      generate: (agent, prompt) => this.#generateReview(agent, prompt, "agent_learning_failed"),
      memoryBase: (agentId) => this.#memories.reviewBase(agentId),
      applyMemory: (agentId, base, operations, turnId) => {
        this.#memories.applyReview(agentId, base, operations, turnId);
      },
      memories: (agentId) => this.#memories.listFor(agentId),
      forgetMemories: (agentId, memoryIds) => this.#memories.forgetMany(agentId, memoryIds),
      chat: (agentId) => this.#ownChat(agentId),
      addInstruction: (agentId, text) => this.#applyReviewInstruction(agentId, text),
      playbooks: () => this.playbooks.snapshot(),
      addPlaybookLesson: (playbookId, text) => this.playbooks.appendLesson(playbookId, text).pipe(Effect.asVoid),
      skills: (agentId) => options.reviewSkills?.(agentId) ?? Effect.succeed([]),
      addSkillLesson: (agentId, skillId, text) => this.#addSkillLesson(agentId, skillId, text),
      copySkill: (skillId, toAgentId) =>
        options.copySkill
          ? options.copySkill(skillId, toAgentId)
          : Effect.fail(new Error("This host cannot install a skill on another agent.")),
      redact: (text) => this.#mcp.redact(text),
      vet: (item) =>
        this.portfolio ? this.portfolio.vetLearning(item) : Effect.succeed({ outcome: "apply", note: null }),
    });
    this.#memoryReview = new MemoryReview({
      memories: this.#memories,
      profileClients: this.#profileClients,
      state: new MemoryReviewState(join(store.database.userDataPath, MEMORY_REVIEW_STATE_FILE)),
      settings: () => options.workspaceSettings?.().learning ?? DEFAULT_WORKSPACE_LEARNING,
      listAgents: () => this.listAgents(),
      model: (agent) =>
        this.#providers.ensureProvider(agent.provider).pipe(Effect.map(() => this.#backgroundModel(agent))),
      createClient: (agent) => this.#providers.createProfileClient(agent.provider),
      usageObserver: (agent, model) =>
        memoryReviewUsageObserver(this.#store.database.usage, agent.provider, model.id, agent.id),
      chat: (agentId) => this.#ownChat(agentId),
      turnActive: (agentId) => Boolean(this.#conversation.loadedSnapshot(agentId)?.activeTurnId),
      appendSystemMessage: (agentId, message) => this.#appendReviewMessage(agentId, message),
      ...(options.reviewSkills ? { skills: options.reviewSkills } : {}),
      ...(skillLearner
        ? {
            skillLearner: {
              read: (skillId) => Effect.suspend(() => skillLearner().read(skillId)),
              save: (agentId, draft) => Effect.suspend(() => skillLearner().save(agentId, draft)),
            },
          }
        : {}),
      redact: (text) => this.#mcp.redact(text),
      reviewed: (agentId, reviewTurnId, turnIds) => this.learning.reviewed(agentId, reviewTurnId, turnIds),
      stopping: () => this.#stopping,
    });
    // One timer for every routine owner. The sources are read lazily because `channels` and its
    // scheduler are built further down, and because an owner's earliest routine changes constantly.
    this.#routineTimer = new RoutineTimer(
      () => [this.#routines, this.#channelRoutines, this.eventChecks, ...(options.extraRoutineSources?.() ?? [])],
      () => this.#initialized && !this.#stopping,
      (code, error) => this.#emitError(code, error),
    );
    this.#waits = new AgentWaits({
      store: new AgentWaitStore({ database: store.database }),
      mailbox,
      hooks: {
        emit: (event) => this.#emit(event),
        ownsRoutine: (agentId, routineId) => this.#routines.getRecord(agentId, routineId) !== null,
        hasRoutine: (agentId) => this.#routines.listRecordsFor(agentId).length > 0,
        requireKnownAgent: (agentId) => {
          this.#conversation.requireKnownAgent(agentId);
        },
      },
    });
    this.#routines = new RoutineScheduler({
      timer: this.#routineTimer,
      waits: this.#waits,
      ...(options.timezone ? { timezone: options.timezone } : {}),
      webhookRoutines: options.webhookRoutines,
      prechecks: new RoutinePrechecks(join(store.database.userDataPath, ROUTINE_PRECHECKS_FILE)),
      store,
      mailbox,
      conversation: this.#conversation,
      hooks: {
        emit: (event) => this.#emit(event),
        emitError: (code, error, agentId) => this.#emitError(code, error, agentId),
        emitQueue: (agentId) => this.#mailboxSync.emitQueue(agentId),
        scheduleDrain: (agentId) => this.#drain.scheduleDrain(agentId),
        interrupt: (agentId, turnId) => this.interrupt(agentId, turnId).pipe(toRoutineOperationFailed),
        awaitDrain: (agentId) => this.#drain.taskFor(agentId)?.pipe(toRoutineOperationFailed),
        syncMailboxMessages: (snapshot) => this.#mailboxSync.syncMailboxMessages(snapshot),
        listAgents: () => this.listAgents(),
        // A hidden agent keeps its routines, but they do not run until the user restores it.
        excludedAgents: () =>
          new Set([
            ...this.#duplication.pendingAgents(),
            ...this.#removal.deleting(),
            ...this.#hiddenAgentIds(),
            ...this.#sleepingAgentIds(),
          ]),
        isRunning: () => this.#initialized && !this.#stopping,
        usageLimited: (agentId) => !this.#usageLimits.mayDrain(agentId),
      },
    });
    this.#hostedSites = new HostedSiteCoordinator({
      store,
      conversation: this.#conversation,
      hostedSites,
      emitError: (code, error, agentId) => this.#emitError(code, error, agentId),
      isStopping: () => this.#stopping,
    });
    this.#providers = new ProviderRuntime({
      offProviders: options.offProviders ?? [],
      ...(options.providerAccounts ? { accounts: options.providerAccounts } : {}),
      saveProviderUse: (provider, on) =>
        (options.saveProviderUse?.(provider, on) ?? Effect.void).pipe(toProviderOperationFailed),
      conversation: this.#conversation,
      hooks: {
        bindClient: (client) => {
          client.on("notification", (notification) => {
            if (notification.method === "openbot/sessionSettings/updated") {
              const threadId = getString(notification.params, "threadId");
              const agentId = threadId ? this.#conversation.agentForThread(threadId) : undefined;
              if (agentId) this.#emit({ type: "agent-session-settings-changed", agentId });
              return;
            }
            Effect.runFork(
              this.#turn
                .handleNotification(notification, client)
                .pipe(Effect.forkIn(this.#scope, { startImmediately: true })),
            );
          });
          client.on("request", (request) =>
            Effect.runFork(
              this.#tools.handle(client, request).pipe(Effect.forkIn(this.#scope, { startImmediately: true })),
            ),
          );
        },
        onProvidersReady: () =>
          Effect.gen({ self: this }, function* () {
            // A failed reconcile must not skip the channels and drains below (#2214).
            yield* this.#boot
              .reconcileUnresolvedDeliveries()
              .pipe(
                Effect.catchCause((cause) =>
                  Cause.hasInterruptsOnly(cause)
                    ? Effect.failCause(cause)
                    : reportOriginalFailure(cause, (failure) => this.#emitError("delivery_reconcile_failed", failure)),
                ),
              );
            yield* this.channels.recover();
            this.#channelRoutines.reconcileAll();
            yield* this.#boot.backfillProviderHistory().pipe(Effect.forkIn(this.#scope));
          }).pipe(
            // Limits are not kept over a restart, so an agent on a backup model goes back first.
            // The drains also run when a step above fails, so no settled lane stays idle.
            Effect.ensuring(
              Effect.sync(() => {
                for (const agent of this.#store.list()) this.#drain.scheduleDrain(agent.id);
                // An edit from before the restart holds its message for a new time.
                for (const agentId of this.#mailbox.agentsWithEditHolds()) this.#queue.wakeAfterEditHold(agentId);
              }),
            ),
            toProviderOperationFailed,
          ),
        onProviderLost: (client) => {
          this.#boot.orphanDeliveriesOf(client.provider, (agentId) => this.#providers.runsOnOwnProcess(agentId));
          this.#compaction.clientEnded(client);
          this.#attention.clearPrompts(client);
          this.#attention.clearBrowserTakeovers(client);
          this.#attention.clearApprovals(client);
          Effect.runFork(
            this.#turn
              .interruptTurnsOf(client, { keepRecoverable: true })
              .pipe(Effect.forkIn(this.#scope, { startImmediately: true })),
          );
        },
        onClientStopped: (client) =>
          Effect.gen({ self: this }, function* () {
            this.#attention.clearPrompts(client);
            this.#attention.clearBrowserTakeovers(client);
            this.#attention.clearApprovals(client);
            this.#compaction.clientEnded(client);
            yield* this.#warmGenerations.ownerStopped(client);
            yield* this.#gateGenerations.ownerStopped(client);
            yield* this.#turn.interruptTurnsOf(client);
          }),
        onAgentClientLost: (agentId, client) =>
          Effect.gen({ self: this }, function* () {
            this.#attention.clearPrompts(client);
            this.#attention.clearBrowserTakeovers(client);
            this.#attention.clearApprovals(client);
            this.#boot.orphanDeliveriesOfAgent(agentId);
            this.#compaction.clientEnded(client);
            yield* this.#turn.interruptTurnsOf(client, { keepRecoverable: true });
            // A teammate that asked this agent may hold the other answers until this work ends.
            const requesters = this.#mailbox
              .unresolvedDeliveries()
              .flatMap(({ delivery }) =>
                delivery.recipientAgentId === agentId && delivery.sender.kind === "agent"
                  ? [delivery.sender.agentId]
                  : [],
              );
            yield* this.#boot.reconcileUnresolvedDeliveries().pipe(
              Effect.catch((failure) =>
                Effect.sync(() => this.#emitError("delivery_reconcile_failed", failure.cause, agentId)),
              ),
              Effect.ensuring(
                Effect.sync(() => {
                  this.#drain.scheduleDrain(agentId);
                  for (const requester of new Set(requesters)) this.#drain.scheduleDrain(requester);
                }),
              ),
            );
          }),
        sharedRoot: (agentId) => this.#store.spaces.agentSharedDirectory(agentId),
        // Teammates of one space read each other's work, as in Claude's jail (`ThreadLifecycle`).
        teammateWorkspaces: (agentId) =>
          this.#store
            .list()
            .filter((other) => other.id !== agentId && this.#store.spaces.sameSpace(agentId, other.id))
            .map((other) => other.workspacePath),
        isStopping: () => this.#stopping,
        isProviderBusy: (provider) => this.#isProviderBusy(provider),
        isProviderBusyApartFrom: (provider, agentId) => this.#isProviderBusyApartFrom(provider, agentId),
        isAgentBusy: (agentId) => this.#runsTurn(agentId),
        isProviderAssigned: (provider) => this.#store.list().some((agent) => providerForAgent(agent) === provider),
        captureConfigRevision: () => this.#endpoints.committedRevision(),
        onProviderActivated: (provider, configRevision) =>
          Effect.gen({ self: this }, function* () {
            if (provider === "opencode") this.#endpoints.clearReleased(configRevision);
            yield* this.#endpoints.runExclusive(() => this.#endpoints.moveAgentsOffUnlistedModels(provider));
          }),
        onProviderResumed: (provider) => {
          for (const agent of this.#store.list()) {
            if (providerForAgent(agent) === provider) this.#drain.scheduleDrain(agent.id);
          }
        },
      },
      emit: (event) => this.#emit(event),
      emitError: (code, error, agentId) => this.#emitError(code, error, agentId),
      requestTimeoutMs,
      preferredProvider,
      preferredModel,
      clientFactory,
      bundledExecutables,
      // The exclusion travels with the credentials, so the client that holds a session on a removed
      // endpoint can refuse the prompt itself, after the waits every caller above it makes.
      credentials: {
        ...credentials,
        // The server variables reach Claude and the ACP providers with the agent environment. The
        // thread lifecycle below gets the agent environment without them, so the fingerprint of a
        // Codex session stays the same; Codex reads them from the spawn environment of its app-server.
        ...(credentials.serverEnvironment
          ? {
              agentEnvironment: (inherited) => ({
                ...credentials.serverEnvironment,
                ...credentials.agentEnvironment?.(inherited),
              }),
            }
          : {}),
        history: (provider) => {
          const history = credentials.history
            ? credentials.history(provider)
            : providerHistoryPersistence(this.#store.database, provider);
          const append = history?.append;
          // A routine run's own session is not saved: its items reach the chat live, and nothing
          // reads its history after the run.
          return append
            ? {
                ...history,
                append: (threadId, fragment) =>
                  this.#conversation.isRoutineSession(threadId) ? Effect.void : append(threadId, fragment),
              }
            : history;
        },
        servesModel: (modelId) => this.#endpoints.serves(modelId),
        // Every MCP set that leaves for a provider is remembered, so its secrets stay redactable
        // after the user edits them. This is the second of the two ways one leaves; the other is
        // `enabledMcpServers`, which the Codex thread configuration reads.
        mcpServers: (threadId) => this.#mcp.record(credentials.mcpServers(threadId)),
        reportMcpDrops: (provider, drops) => this.#mcp.reportDrops(provider, drops),
        mcpEndpoint: (config) => this.#mcp.endpoint(config).pipe(toMcpOperationError),
      },
      mcpHandoff: this.#mcp.handoffLog(),
      redactMcp: (text) => this.#mcp.redact(text),
    });
    this.#endpoints = new CustomEndpoints({
      store,
      mailbox: this.#mailbox,
      conversation: this.#conversation,
      providers: this.#providers,
      hooks: {
        applyAgentUpdate: (input) => this.#applyAgentUpdate(input).pipe(toEndpointChangeFailed),
        // The model list reaches the renderer by pull, refreshed on a status event, and an exclusion
        // changes what that pull answers while no provider state moves.
        modelsChanged: () => this.#emit({ type: "status", status: this.getStatus() }),
        stopProfileClients: () =>
          this.#profileClients
            .stopOpenCode()
            .pipe(
              Effect.andThen(this.#gateClients.stopOpenCode()),
              Effect.andThen(this.#backgroundClients.stopOpenCode()),
              Effect.andThen(this.#warmGenerations.stopIdle("opencode")),
              Effect.andThen(this.#gateGenerations.stopIdle("opencode")),
            ),
        emitError: (code, error, agentId) => this.#emitError(code, error, agentId),
        providerAvailable: (provider) => this.#providerAvailable(provider),
        preference: () => this.#preference(),
      },
    });
    this.#compaction = new ContextCompaction({
      timeoutMs: options.contextCompactionTimeoutMs,
      changed: () => this.#emitRuntimeSnapshot(),
      store,
      providers: this.#providers,
      emitError: (code, error, agentId) => this.#emitError(code, error, agentId),
      scheduleDrain: (agentId) => this.#drain.scheduleDrain(agentId),
      rotateSession: (agentId, client, threadId) => this.#threads.rotateProviderSession(agentId, client, threadId),
      rotatesSession: (agentId, threadId) => this.#threads.rotatesSession(agentId, threadId),
      agentBusy: (agentId) => {
        const agent = this.#store.list().find((candidate) => candidate.id === agentId);
        return (
          !agent ||
          this.#conversation.anyWorkingSnapshot(agentId) != null ||
          this.#mailbox.hasUnfinishedDelivery(agentId) ||
          this.#threads.providerContextBusy(agent)
        );
      },
      idlePrecompactPath: join(store.database.userDataPath, IDLE_PRECOMPACT_STATE_FILE),
      compacted: (threadId) => {
        this.channels.contextCompacted(threadId);
        // A compaction of an agent's own chat drops detail: its memory review runs now.
        const agent = this.#store.list().find((candidate) => candidate.threadId === threadId);
        if (agent) Effect.runFork(this.#memoryReview.compacted(agent.id));
      },
    });
    this.#pastDecisions = new PastDecisions(join(store.database.userDataPath, PAST_DECISIONS_FILE));
    Effect.runFork(
      this.#pastDecisions.load().pipe(
        Effect.tap(() => Effect.sync(() => this.#emitRuntimeSnapshot())),
        Effect.forkIn(this.#scope),
      ),
    );
    this.#attention = new AttentionRegistry({
      // The channel service starts later; a question only arrives once both run.
      teamQuestion: {
        context: (agentId, turnId) => this.channels.teamContext(agentId, turnId),
        post: (agentId, channelId, text) => this.channels.postTeamQuestion(agentId, channelId, text),
      },
      ...(options.ownerAway
        ? {
            ownerHold: (agentId: string, turnId: string, questions: readonly AgentPromptQuestion[]) =>
              options.ownerAway?.holdQuestions(
                agentId,
                questions,
                this.channels.teamContext(agentId, turnId)?.channelId ?? null,
              ) ?? null,
          }
        : {}),
      conversation: this.#conversation,
      browser: this.#browser,
      hostedSites: this.#hostedSites,
      routines: this.#routines,
      ...(options.approvalAutomation === undefined ? {} : { approvalAutomation: options.approvalAutomation }),
      workspaceSandboxed: (agentId) => {
        const agent = store.list().find((candidate) => candidate.id === agentId);
        return agent !== undefined && workspaceAccessEnforced(agent);
      },
      messagingThread: (threadId) => this.messaging.linkForThread(threadId) !== null,
      emit: (event) => this.#emit(event),
      emitError: (code, error, agentId) => this.#emitError(code, error, agentId),
      emitRuntimeSnapshot: () => this.#emitRuntimeSnapshot(),
      ...(options.passwordVault === undefined ? {} : { passwordVault: options.passwordVault }),
      ...(options.vaultItems === undefined ? {} : { vaultItems: options.vaultItems }),
      agentName: (agentId) => store.list().find((candidate) => candidate.id === agentId)?.name,
      // The router is made later; a note comes only from a tool call, after both exist.
      noteVaultChange: (agentId, threadId, turnId, text) => this.#tools.postVaultNote(agentId, threadId, turnId, text),
      apiKeys: options.agentApiKeys ?? null,
      pastDecisions: this.#pastDecisions,
      readStoredMessage: (agentId, threadId, messageId) =>
        store.database.readConversationMessages(agentId, threadId, [messageId])[0],
    });
    this.#duplication = new DuplicationGate({
      store,
      mailbox,
      conversation: this.#conversation,
      memories: this.#memories,
      routines: this.#routines,
      hooks: {
        emit: (event) => this.#emit(event),
        listAgents: () => this.listAgents(),
        deleteAgentData: (agent) => this.#removal.deleteData(agent).pipe(toAgentDuplicationFailed),
        hasAttentionFor: (agentId) => this.#attention.hasAttentionFor(agentId),
        scheduleDrain: (agentId) => this.#drain.scheduleDrain(agentId),
      },
    });
    // The Team API sends the held list as its own event; the frozen tab projection drops the flag.
    let userControlTabIds = "";
    // `browser-page-state` sends the history state the same way.
    let browserPageStates = "";
    this.#browser.onChanged((tabs, activeTabId) => {
      this.#attention.cancelTakeoversForMissingTabs(tabs);
      Effect.runFork(this.#browserUploads.retainTabs(tabs).pipe(Effect.forkIn(this.#scope)));
      this.#emit({ type: "browser-changed", tabs, activeTabId });
      const pageStates = tabs.map((tab) => ({
        tabId: tab.id,
        canGoBack: tab.canGoBack === true,
        canGoForward: tab.canGoForward === true,
      }));
      const pageStateKey = JSON.stringify(pageStates);
      if (pageStateKey !== browserPageStates) {
        browserPageStates = pageStateKey;
        this.#emit({ type: "browser-page-state-changed", tabs: pageStates });
      }
      const held = tabs.filter((tab) => tab.userControl).map((tab) => tab.id);
      if (held.join("\n") === userControlTabIds) return;
      userControlTabIds = held.join("\n");
      this.#emit({ type: "browser-user-control-changed", tabIds: held });
    });
    this.#browser.onDocumentChanged((tabId, documentIds) =>
      Effect.runFork(this.#browserUploads.retainDocuments(tabId, documentIds).pipe(Effect.forkIn(this.#scope))),
    );
    this.#images = new ImageGenRuntime({
      conversation: this.#conversation,
      mailbox,
      hooks: {
        trackItem: (itemId, turnId) => {
          this.#turn.trackItem(itemId, turnId);
        },
      },
    });
    this.#deltas = new DeltaBuffer({
      conversation: this.#conversation,
      database: store.database,
      hooks: { emit: (event) => this.#emit(event) },
    });
    this.#mailboxSync = new MailboxSync({
      database: store.database,
      mailbox,
      conversation: this.#conversation,
      routines: this.#routines,
      scope: () => this.#scope,
      hooks: {
        emit: (event) => this.#emit(event),
        emitError: (code, error, agentId) => this.#emitError(code, error, agentId),
        // Read late: `channels` is built after this.
        queueHold: (agentId) => this.channels.queueHold(agentId),
      },
    });
    this.#reader = new ConversationReader({
      store,
      conversation: this.#conversation,
      mailboxSync: this.#mailboxSync,
      hooks: {
        emit: (event) => this.#emit(event),
        listAgents: () => this.listAgents(),
      },
    });
    this.#attachments = new AttachmentGateway({
      conversation: this.#conversation,
      mailbox,
      sharedRoot: (agentId) => store.spaces.agentSharedDirectory(agentId),
      hooks: {
        emit: (event) => this.#emit(event),
        emitError: (code, error, agentId) => this.#emitError(code, error, agentId),
      },
    });
    this.#browserUploads = new BrowserUploads({
      browser,
      attachments: this.#attachments,
      isStopping: () => this.#stopping,
      hasTakeover: (agentId) => this.#attention.hasBrowserTakeoverForAgent(agentId),
    });
    this.#threads = new ThreadLifecycle({
      store,
      mailbox,
      conversation: this.#conversation,
      memories: this.#memories,
      compaction: this.#compaction,
      mcpServers: (threadId) => this.#mcp.enabled(threadId),
      mcpToolRuntimes: () => this.#mcp.toolRuntimes(),
      mcpEndpoint: (config) => this.#mcp.endpoint(config).pipe(toMcpOperationError),
      mcpProxyFingerprint: (configs) => this.#mcp.proxyFingerprint(configs).pipe(toMcpOperationError),
      ...(credentials.agentEnvironment ? { agentEnvironment: credentials.agentEnvironment } : {}),
      passwordVaultConnected: () => options.passwordVault?.connected() ?? false,
      vaultItems: () => ({
        available: options.vaultItems?.ready() ?? false,
        cards: options.vaultItems?.hasCards() ?? false,
        contacts: options.vaultItems?.hasContacts() ?? false,
      }),
      // Only a server has a memory reading.
      serverHost: hostMemory !== null,
      sectionTeammates: (agentId) => this.sectionTeammates(agentId),
      goalLines: (agentId) => this.insight?.goalLines(agentId) ?? [],
      channelThread: (threadId) => this.channels.store.channelForThread(threadId) !== null,
      hooks: {
        logRecovery: (agentId, provider, outcome) =>
          logger.warn("Recovered an unavailable provider session.", { agentId, provider, outcome }),
        logReleaseFailure: (provider, error) =>
          logger.warn("Could not close a replaced provider session.", { provider, error }),
        reportMcpDrops: (provider, drops) => this.#mcp.reportDrops(provider, drops),
        logHandoffReadFailure: (provider, error) =>
          logger.warn("Could not read the work steps of an earlier provider session.", { provider, error }),
      },
    });
    this.#followUp = new DelegationFollowUp({
      store,
      mailbox,
      mailboxSync: this.#mailboxSync,
      conversation: this.#conversation,
      hooks: {
        scheduleDrain: (agentId) => this.#drain.scheduleDrain(agentId),
        redactMcp: (text) => this.#mcp.redact(text),
        emitError: (code, error, agentId) => this.#emitError(code, error, agentId),
      },
    });
    this.#escalations = new InputEscalations({
      store,
      mailbox,
      mailboxSync: this.#mailboxSync,
      conversation: this.#conversation,
      hooks: {
        pendingRequests: () => this.#attention.pendingRequests(),
        scheduleDrain: (agentId) => this.#drain.scheduleDrain(agentId),
        emit: (event) => this.emit("event", event),
        emitError: (code, error, agentId) => this.#emitError(code, error, agentId),
      },
    });
    this.#boot = new BootRecovery({
      store,
      mailbox,
      providers: this.#providers,
      conversation: this.#conversation,
      mailboxSync: this.#mailboxSync,
      threads: this.#threads,
      followUp: this.#followUp,
      hooks: {
        emitError: (code, error, agentId) => this.#emitError(code, error, agentId),
        // A deleted routine takes its runs with it, so a run without a record counts as quiet:
        // otherwise the import would bring back the answers that its quiet turns settled.
        quietRoutineDelivery: (deliveryId) => {
          const run = this.#routines.runForDelivery(deliveryId);
          return run === null || quietRoutineRun(run);
        },
        executionThreads: () => [...this.channels.store.executionThreads(), ...this.messaging.store.executionThreads()],
        taskThreads: () => this.#tasks.executionThreads(),
        deliveryThreadId: (deliveryId) => this.#deliveryThreadId(deliveryId),
        deliverySettled: (deliveryId, terminal) => {
          if (terminal === "interrupted") this.#restartInterruptedDeliveryIds.add(deliveryId);
          this.messaging.deliverySettled(deliveryId, terminal);
        },
      },
    });
    // The team channel shows one short line for each message between agents outside channel work.
    mailbox.onAgentMessage = (message) =>
      Effect.runFork(
        this.channels.relayAgentMessage(message).pipe(
          Effect.catch((failure) =>
            Effect.sync(() => this.#emitError("channel_relay_failed", failure, message.senderAgentId)),
          ),
          Effect.forkIn(this.#scope),
        ),
      );
    this.spaces = new SpaceService({
      store: store.spaces,
      agentIds: () => this.listAgents().map((agent) => agent.id),
      channels: () => this.channels.store.spaceFields(),
      onChanged: () => {
        this.emit("event", { type: "workspace-spaces-changed" });
        Effect.runFork(
          this.spaces
            .writeIndex()
            .pipe(Effect.catch((failure) => Effect.sync(() => this.#emitError("spaces_index_failed", failure.cause)))),
        );
      },
    });
    this.channels = new ChannelService(store.database, mailbox, {
      agents: () => this.listAgents(),
      // A sleeping member takes no channel work either: a channel task would hold the channel until it wakes.
      hidden: (agentId) => this.#store.isHidden(agentId) || this.#store.isSleeping(agentId),
      inChannelSpace: (agentId, channel) => agentSeesChannel(this.#store.spaces, agentId, channel),
      channelSpaceId: (channel) => this.#store.spaces.channelSpaceId(channel),
      generate: (lead, prompt) =>
        Effect.gen({ self: this }, function* () {
          yield* this.#providers.ensureProvider(lead.provider);
          const model = this.#endpoints
            .available()
            .find((item) => item.provider === lead.provider && item.id === lead.model);
          if (!model)
            return yield* new ProfileGenerationFailed({
              cause: new Error(sourceText("error.backend.channelLeadModelUnavailable")),
            });
          const client = this.#providers.createProfileClient(lead.provider);
          return yield* this.#profileClients
            .run(client, (cancelled) =>
              generateTextWithoutTools(
                client,
                { ...model, defaultReasoningEffort: lead.reasoningEffort },
                prompt,
                cancelled,
              ),
            )
            .pipe(
              // A routing turn can be the first one a spent plan refuses: in its completion, or as the
              // error of the `turn/start` request. It holds the lead's model the way a refused member turn
              // does, and the channel keeps the task queued for the reset.
              Effect.tapError((failure) =>
                failure instanceof GenerationUsageLimitError
                  ? this.#usageLimits.reached(lead.id, failure.resetsAt, lead.model)
                  : failure.cause instanceof Error && isPlanLimitDiagnostic(failure.cause.message)
                    ? this.#usageLimits.reached(lead.id, null, lead.model)
                    : Effect.void,
              ),
            );
        }).pipe(toChannelOperationError),
      schedule: (agentId) => this.#drain.scheduleDrain(agentId),
      awaitDrain: (agentId) => this.#drain.taskFor(agentId)?.pipe(toChannelOperationError),
      contextCharacters: (agentId, threadId) => {
        const agent = this.#store.list().find((item) => item.id === agentId);
        const session = agent ? this.#store.database.activeProviderSession(threadId, agent.provider) : null;
        return session ? this.#compaction.contextInputCharacters(session.externalSessionId) : 120_000;
      },
      // Claude and the app-server providers report each compaction. A `handoff` provider is
      // compacted by OpenBot, which gives the new session the complete packet, and the ACP client
      // reports a compaction that the agent does by itself. Another ACP agent or Pi can compact with
      // no signal, so its next packet would leave out what the summary dropped.
      reportsCompactions: (agentId) => {
        const agent = this.#store.list().find((item) => item.id === agentId);
        const mode = agent ? this.#providers.clientForAgent(agent)?.contextCompaction : undefined;
        return mode === "native" || mode === "events" || mode === "handoff";
      },
      forgetThread: (threadId) => this.#forgetExecutionThread(threadId).pipe(toChannelOperationError),
      loadedSnapshot: (threadId) => this.#conversation.loadedExecutionSnapshot(threadId),
      // A held agent gets no channel assignment: one that waited for the reset would hold its
      // resources. A channel turn runs beside the agent's tasks, unless its provider runs one turn
      // of the agent at a time.
      busy: (agentId) =>
        Boolean(this.#conversation.workingSnapshot(agentId)?.activeTurnId || this.#mailbox.nextQueued(agentId)) ||
        (this.#tasks.oneTurnAtATime(agentId) &&
          this.#conversation.workingTaskSnapshots(agentId).some((snapshot) => snapshot.activeTurnId)) ||
        !this.#usageLimits.mayDrain(agentId) ||
        // A paused agent takes no new channel work: another member can answer.
        (this.#guardrails?.pauseFor(agentId) ?? null) !== null,
      usageLimited: (agentId) => !this.#usageLimits.mayDrain(agentId),
      skipAtLimit: (task) => this.#channelRoutines.skipAtLimit(task.channelId, task.requestMessageId),
      usageLimitBackup: (agentId) => this.#usageLimitBackup(agentId) !== undefined || this.#poolBackup(agentId),
      steer: (agentId, threadId, turnId, messageId, text) =>
        Effect.gen({ self: this }, function* () {
          const agent = this.#store.list().find((item) => item.id === agentId);
          const session = agent ? this.#store.database.activeProviderSession(threadId, agent.provider) : null;
          const client = agent ? this.#providers.clientForAgent(agent) : null;
          if (!session || !client) return "rejected" as const;
          return yield* client
            .request(
              "turn/steer",
              {
                threadId: session.externalSessionId,
                expectedTurnId: turnId,
                clientUserMessageId: messageId,
                input: [{ type: "text", text }],
              },
              decodeRecordResponse,
            )
            .pipe(
              Effect.match({
                onSuccess: () => "accepted" as const,
                onFailure: (failure) =>
                  isRequestTimeout(failure.cause, "turn/steer") ? ("uncertain" as const) : ("rejected" as const),
              }),
            );
        }),
      interrupt: (agentId, turnId, threadId) => this.interrupt(agentId, turnId, threadId).pipe(toChannelOperationError),

      // Every channel state change ends in `publish`, so this is the complete trigger surface for
      // reconciling a channel routine run. It does not depend on `turn-completed`, which never
      // reaches the agent event forwarder for a channel thread.
      changed: (channelId, revision) => {
        this.#channelRoutines.reconcile(channelId);
        this.#routineTimer.arm();
        this.#emit({ type: "channels-changed", channelId, revision });
      },
      memoriesChanged: (channelId) => this.#emit({ type: "channel-memories-changed", channelId }),
      ...(options.channelPersonAgentLevel ? { personAgentLevel: options.channelPersonAgentLevel } : {}),
      ...(options.channelRemotePerson ? { remotePerson: options.channelRemotePerson } : {}),
      ...(options.channelPerson ? { person: options.channelPerson } : {}),
      defaultAnswerMode: () => (options.workspaceSettings?.() ?? DEFAULT_WORKSPACE_SETTINGS).defaults.agentAnswerMode,
      handsOff: (channelId) =>
        (options.workspaceSettings?.() ?? DEFAULT_WORKSPACE_SETTINGS).handsOffChannelIds?.includes(channelId) ?? false,
      agentDefaults: (agentId) => {
        const agents = (options.workspaceSettings?.() ?? DEFAULT_WORKSPACE_SETTINGS).defaults.agents;
        // An own property only: an id such as `constructor` names no saved default.
        return agents && Object.hasOwn(agents, agentId) ? agents[agentId] : undefined;
      },
      ...(options.channelPeople ? { people: options.channelPeople } : {}),
      gate: () => {
        const settings = (options.workspaceSettings?.() ?? DEFAULT_WORKSPACE_SETTINGS).gate;
        return {
          label: `${settings.provider}/${settings.model}`,
          timeoutMs: settings.timeoutMs,
          generate: (agentId, prompt, generation) => this.#generateGateText(settings, agentId, prompt, generation),
        };
      },
      activity: (agentId) => this.#gateActivity(agentId),
      typingChanged: (channelId, typing) => this.#emit({ type: "channel-typing", channelId, typing }),
      savedChanged: (memberId) => this.#emit({ type: "workspace-saved-changed", memberId }),
      readStateChanged: (memberId, channelId, threadRootId) =>
        this.#emit({
          type: "workspace-read-state-changed",
          memberId,
          channelId,
          ...(threadRootId === undefined ? {} : { threadRootId }),
        }),
      // Sent before `channels-changed`, so a client that appends the message has it when the list moves.
      messagesChanged: (channelId, changes, revision) => {
        for (const change of changes)
          this.#emit(
            change.removed
              ? { type: "channel-message-removed", channelId, messageId: change.message.id, revision }
              : { type: "channel-message", channelId, message: change.message, revision },
          );
      },
      routines: {
        list: (channelId) => this.#channelRoutines.list(channelId),
        create: (input) => this.#channelRoutines.create(input),
        update: (input) => this.#channelRoutines.update(input),
        delete: (input) => this.#channelRoutines.delete(input),
        timezone: options.timezone ?? localTimezone,
      },
      // A held agent starts nothing, so its queue has no event of its own while the reservation
      // moves. Without this its panel keeps naming the channel task that has already ended.
      queueHoldChanged: () => {
        for (const agent of this.#store.list())
          if (this.#mailbox.queuedDeliveryIds(agent.id).length) this.#mailboxSync.emitQueue(agent.id);
      },
      error: (error) => this.#emitError("channel_coordination_failed", error),
    });
    this.#channelRoutines = new ChannelRoutineScheduler({
      channels: this.channels,
      hooks: {
        changed: (channelId) => {
          this.#emit({ type: "channel-routines-changed", channelId });
          this.#routineTimer.arm();
        },
        emitError: (code, error) => this.#emitError(code, error),
        excludedChannels: () => new Set(),
        usageLimited: (channelId) => {
          const lead = this.channels.store.get(channelId).leadAgentId;
          return lead !== null && !this.#usageLimits.mayDrain(lead);
        },
      },
    });
    this.routineRecords = new RoutineRecords({
      database: store.database,
      agentRoutines: this.#routines,
      channelRoutines: this.#channelRoutines,
      agentExists: (agentId) => this.listAgents().some((agent) => agent.id === agentId),
      channelExists: (channelId) => this.channels.store.exists(channelId),
      channelRoutinesChanged: (channelId) => this.#emit({ type: "channel-routines-changed", channelId }),
      routinesHeld: () => this.#routineTimer.held,
    });
    const eventDelivery = new EventCheckDelivery({
      store,
      mailbox,
      conversation: this.#conversation,
      sync: (snapshot) => this.#mailboxSync.syncMailboxMessages(snapshot),
      changed: (agents, agentId) => {
        this.#emit({ type: "agents-changed", agents });
        this.#mailboxSync.emitQueue(agentId);
      },
      drain: (agentId) => this.#drain.scheduleDrain(agentId),
    });
    this.eventChecks = createEventCheckScheduler(store.database, options, {
      scope: () => this.#scope,
      timer: this.#routineTimer,
      agentExists: (id) =>
        this.#store.list().some((agent) => agent.id === id) &&
        !this.#removal.deleting().has(id) &&
        !this.#duplication.isPending(id),
      sleeping: (id) => this.#store.isSleeping(id),
      running: () => this.#initialized && !this.#stopping && !this.#routineTimer.held,
      audit: options.securityAudit,
      // The agent event "error" with these codes reaches every client without a new protocol field.
      // It is a notice for the user, not a system failure, so it skips the failure analytics.
      notify: (agentId, code, message) =>
        this.#emit({ type: "error", agentId, code, message: this.#mcp.redact(message) }),
      deliver: eventDelivery.send.bind(eventDelivery),
    });

    this.messaging = new MessagingThreads(store.database, mailbox, {
      schedule: (agentId) => this.#drain.scheduleDrain(agentId),
      queueChanged: (agentId) => this.#mailboxSync.emitQueue(agentId),
      busy: (agentId) =>
        Boolean(this.#conversation.workingSnapshot(agentId)?.activeTurnId || this.#mailbox.nextQueued(agentId)),
      interrupt: (agentId, turnId, threadId) => this.interrupt(agentId, turnId, threadId).pipe(toMessagingThreadFailed),
      forgetThread: (threadId) => this.#forgetExecutionThread(threadId).pipe(toMessagingThreadFailed),
      ownChat: (threadId) => this.#store.ownsThread(threadId),
      wokenWaitRequests: (deliveryId) => this.#waits.wokenBy(deliveryId).map((wait) => wait.requestMessageId),
      // Only a provider that reads a message at its next step is asked; any refusal leaves it queued.
      steer: (agentId, deliveryId, turnId) =>
        this.#queue.steer({ agentId, deliveryId, expectedTurnId: turnId }).pipe(
          Effect.as(true),
          Effect.catch(() => Effect.succeed(false)),
        ),
    });
    this.#memoryHold = new MemoryHold({
      memory: hostMemory,
      chosenTurnLimit: () => hostTurnLimits?.turnLimit() ?? null,
      hooks: {
        scheduleAll: () => {
          for (const agent of this.#store.list()) this.#drain.scheduleDrain(agent.id);
        },
        retryWaiting: () => this.#drain.retrySlotWaiters(),
        releaseIdleThreads: () => this.#providers.releaseIdleThreads(),
        emitError: (code, error, agentId) => this.#emitError(code, error, agentId),
      },
    });
    this.#usageLimits = new UsageLimitGate({
      store,
      hooks: {
        emit: (event) => this.#emit(event),
        emitRuntimeSnapshot: () => this.#emitRuntimeSnapshot(),
        scheduleDrain: (agentId) => this.#drain.scheduleDrain(agentId),
        readUsage: (provider, model, accountId) =>
          this.#providers.usage({ provider, model, ...(accountId ? { accountId } : {}) }).pipe(toUsageReadFailed),
        // The refused turn's drain must not wait for the queues, so the owned scope settles them. An
        // agent set to switch without asking keeps its queue for the backup model; an idle one moves now,
        // and the refused one at the end of its turn.
        held: (agentIds) =>
          Effect.sync(() => {
            for (const agentId of agentIds) this.#drain.scheduleDrain(agentId);
          }).pipe(
            Effect.andThen(
              this.#settleHeldQueues(
                agentIds.filter((agentId) => !this.#usageLimitBackup(agentId) && !this.#poolBackup(agentId)),
              ),
            ),
            Effect.catch((failure) => Effect.sync(() => this.#emitError("usage_limit_hold_failed", failure.cause))),
            Effect.forkIn(this.#scope, { startImmediately: true }),
            Effect.asVoid,
          ),
        // A channel task that went back to its queue is assigned again only by a pump. An agent that
        // left this model for a backup goes back to it.
        released: (limit) =>
          this.channels.wake().pipe(
            Effect.catch((failure) => Effect.sync(() => this.#emitError("usage_limit_release_failed", failure.cause))),
            Effect.andThen(
              Effect.forEach(
                this.#store
                  .list()
                  .filter((agent) => agent.usageLimitReturn && sameUsageLimit(agent.usageLimitReturn, limit)),
                (agent) => Effect.sync(() => this.#drain.scheduleDrain(agent.id)),
                { discard: true },
              ),
            ),
            Effect.forkIn(this.#scope, { startImmediately: true }),
            Effect.asVoid,
          ),
      },
    });
    this.#modelPolicy = new ModelPolicy({
      agents: () => this.#store.list(),
      models: () => this.#providers.listModels(),
      limited: (agentId, model) => this.#usageLimits.holdsModel(agentId, model),
    });
    this.#drain = new DrainScheduler({
      modelPolicy: this.#modelPolicy,
      channels: this.channels,
      messaging: this.messaging,
      store,
      mailbox,
      mailboxSync: this.#mailboxSync,
      conversation: this.#conversation,
      providers: this.#providers,
      duplication: this.#duplication,
      profileSave: this.#profileSave,
      compaction: this.#compaction,
      routines: this.#routines,
      threads: this.#threads,
      memory: this.#memoryHold,
      usageLimits: this.#usageLimits,
      followUp: this.#followUp,
      tasks: this.#tasks,
      ...(options.ownerAway ? { ownerNote: () => options.ownerAway?.turnNote() ?? null } : {}),
      hooks: {
        emitError: (code, error, agentId) => this.#emitError(code, error, agentId),
        staleTurnSettlement: (agentId, threadId, turnId) =>
          this.#turnRunsNowhere(agentId, turnId) ? this.#settleStaleOwnTurn(agentId, threadId, turnId) : null,
        orphanedDeliveryRecovery: (agentId) =>
          this.#mayRecoverOrphanedDeliveries(agentId) ? this.#recoverOrphanedDeliveries(agentId) : null,
        redactMcp: (text) => this.#mcp.redact(text),
        isStopping: () => this.#stopping,
        isDeployDraining: () => this.#deployDrainUntil !== null && Date.now() < this.#deployDrainUntil,
        servesModel: (model) => this.#endpoints.serves(model),
        requeueChannelDelivery: (deliveryId, continueWork) => this.#requeueChannelDelivery(deliveryId, continueWork),
        mayFailOver: (agentId, reason) =>
          this.#usageLimitBackup(agentId, reason) !== undefined || this.#poolBackup(agentId),
        guardrailsHold: (agentId, headSender) => !(this.#guardrails?.mayDrain(agentId, headSender) ?? true),
        turnEnded: (turnId) => this.#turn.hasEnded(turnId),
        turnRestarting: (turnId) => this.#turn.forgetEnded(turnId),
        startRequestedNewChat: (agentId) => this.#startRequestedNewChat(agentId),
        dropRequestedNewChat: (agentId) => {
          if (this.#requestedNewChats.delete(agentId))
            logger.info(`Agent ${agentId} dropped its new chat request: a turn in its chat started first.`);
        },
        followUsageLimit: (agentId) => {
          if (this.#pendingRuntimeDue(agentId)) {
            Effect.runFork(
              this.#followPendingRuntime(agentId).pipe(
                // A change that is gone, applied or dropped, lets the next drain make a due usage-limit move.
                Effect.andThen((moved) =>
                  Effect.sync(() => this.#drain.scheduleDrain(agentId, moved || !this.#pendingRuntimeDue(agentId))),
                ),
                Effect.forkIn(this.#scope, { startImmediately: true }),
              ),
            );
            return true;
          }
          if (!this.#usageLimitMove(agentId)) return false;
          Effect.runFork(
            this.#followUsageLimit(agentId).pipe(
              // The `held` hook kept the queue for this move, so a move that failed settles it.
              Effect.tap((moved) =>
                moved || this.#usageLimits.mayDrain(agentId)
                  ? Effect.void
                  : this.#settleHeldQueues([agentId]).pipe(
                      Effect.catch((failure) =>
                        Effect.sync(() => this.#emitError("usage_limit_hold_failed", failure.cause, agentId)),
                      ),
                    ),
              ),
              // A channel task waits in its channel, and only a pump assigns it to the new model.
              Effect.tap((moved) =>
                moved
                  ? this.channels
                      .wake()
                      .pipe(
                        Effect.catch((failure) =>
                          Effect.sync(() => this.#emitError("channel_coordination_failed", failure.cause, agentId)),
                        ),
                      )
                  : Effect.void,
              ),
              Effect.andThen((moved) => Effect.sync(() => this.#drain.scheduleDrain(agentId, moved))),
              Effect.forkIn(this.#scope, { startImmediately: true }),
            ),
          );
          return true;
        },
      },
    });
    this.#sessionSettings = new SessionSettings({
      store,
      providers: this.#providers,
      threads: this.#threads,
      drain: this.#drain,
      busy: (agentId) => this.#runsTurn(agentId),
      exclusive: (run) => this.#endpoints.runExclusive(run),
      changed: (agentId) => this.#emit({ type: "agent-session-settings-changed", agentId }),
    });
    this.#browser.onControlChanged((state) => {
      this.#emit({ type: "browser-control-changed", state });
    });
    this.#queue = new QueueControls({
      store,
      mailbox,
      mailboxSync: this.#mailboxSync,
      conversation: this.#conversation,
      providers: this.#providers,
      endpoints: this.#endpoints,
      drain: this.#drain,
      routines: this.#routines,
      followUp: this.#followUp,
      hooks: {
        channelAssignment: (deliveryId) => this.channels.store.assignmentForDelivery(deliveryId),
        taskThreadId: (deliveryId) => this.#tasks.threadForDelivery(deliveryId),
        externalTurn: (turnId, deliveryId) => this.messaging.answersExternalMessage(turnId, deliveryId),
        messagingThreadId: (deliveryId) => this.messaging.threadForDelivery(deliveryId),
        steerText: (deliveryId) => this.messaging.steerText(deliveryId),
        endTakeoversForTurn: (agentId, turnId) => this.#attention.completeBrowserTakeoversForTurn(agentId, turnId),
      },
    });
    this.#turn = new TurnLifecycle({
      store,
      mailbox,
      mailboxSync: this.#mailboxSync,
      conversation: this.#conversation,
      providers: this.#providers,
      memories: this.#memories,
      attention: this.#attention,
      browser,
      compaction: this.#compaction,
      images: this.#images,
      deltas: this.#deltas,
      usageLimits: this.#usageLimits,
      followUp: this.#followUp,
      hooks: {
        emitFailure: (failure) => this.emit("failure", failure),
        emit: (event) => this.#emit(event),
        emitError: (code, error, agentId, context) => this.#emitError(code, error, agentId, context),
        emitRuntimeSnapshot: () => this.#emitRuntimeSnapshot(),
        scheduleDrain: (agentId) => this.#drain.scheduleDrain(agentId),
        dropRefusedSession: (agentId, externalThreadId) =>
          this.#threads.dropRefusedProviderSession(agentId, externalThreadId),
        listAgents: () => this.listAgents(),
        redactMcp: (text) => this.#mcp.redact(text),
        emitToolUsage: (usage) => this.emit("toolUsage", usage),
        observeToolStep: (agentId, threadId, turnId, item, completed) =>
          this.#guardrails?.observeTool(agentId, threadId, turnId, item, completed),
        observeContext: (agentId, threadId, tokens) => this.#guardrails?.observeContext(agentId, threadId, tokens),
        turnModel: (agentId, turnId) => this.#drain.modelForTurn(agentId, turnId),
        mayFailOver: (agentId, reason) =>
          this.#usageLimitBackup(agentId, reason) !== undefined || this.#poolBackup(agentId),
        requeueChannelDelivery: (deliveryId, continueWork) => this.#requeueChannelDelivery(deliveryId, continueWork),
        quietRoutineDelivery: (deliveryId) => this.#routines.quietRunForDelivery(deliveryId),
        takeRoutinePreview: (deliveryId) => this.#routines.takePreviewBeforeRun(deliveryId),
        closeRoutineSession: (externalThreadId) => this.#threads.closeRoutineThread(externalThreadId),
        conversationTurnEnded: (agentId, turn) => this.#memoryReview.turnEnded(agentId, turn),
        answerFinished: (answer) => {
          this.#condenseLater(answer);
          this.#scoreAnswerLater(answer);
          this.#noteOwnerAnswer(answer, options.ownerText ?? null);
        },
        routineAnswered: (agentId, deliveryId, answer) => {
          const agent = this.#store.list().find((item) => item.id === agentId);
          const run = this.#routines.runForDelivery(deliveryId);
          if (!agent || !run) return Effect.void;
          return this.#threads
            .addRoutineDigest(agent, run.routineName, answer)
            .pipe(
              Effect.catch((failure) =>
                Effect.sync(() => this.#emitError("routine_digest_failed", failure.cause, agentId)),
              ),
            );
        },
        taskForThread: (threadId) => this.#tasks.taskForThread(threadId),
        taskFailed: (taskId, message) => this.#tasks.failed(taskId, this.#mcp.redact(message)),
      },
    });
    this.loops = LoopService.create(store.database, {
      agents: () => this.listAgents(),
      agentSpace: (agentId) => store.spaces.agentSpaceId(agentId),
      spaceExists: (spaceId) => store.spaces.get(spaceId) !== undefined,
      notifyAgent: (agentId, text) =>
        Effect.runFork(
          this.sendMessage({ agentId, text }, undefined, undefined, "operator-note").pipe(
            Effect.catch((failure) => Effect.sync(() => this.#emitError("loop_note_failed", failure.cause, agentId))),
          ),
        ),
      runRoutine: (agentId, routineId) =>
        Effect.runPromise(this.testRoutine({ agentId, routineId }).pipe(Effect.asVoid)),
      createTicket: motionTicketCreator({
        mcpServers: () => this.enabledMcpServers(),
        mcpAgent: (agentId) => this.mcpAgent(agentId),
        agentName: (agentId) => this.listAgents().find((agent) => agent.id === agentId)?.name ?? null,
        secret: (scope, agentId, name) => options.agentApiKeys?.readNow(scope, agentId, name) ?? null,
      }),
      itemFinished: ({ agentIds, loop, item, outcome }) =>
        this.learning.taskFinished(agentIds, { source: "loop", ref: loop, title: `${item} (${outcome})` }),
    });
    this.secrets = new WorkspaceSecretsService(options.agentApiKeys ?? null, (agentId) =>
      this.listAgents().some((agent) => agent.id === agentId),
    );
    this.workspace = new WorkspaceInsights({
      agents: () => this.listAgents(),
      database: store.database,
      channels: this.channels.store,
      mailbox,
      attention: this.#attention,
      liveTrace: (turnId) => this.#turn.liveTrace(turnId),
      turnModel: (turnId) => {
        const chosen = this.#modelPolicy.running(turnId);
        return chosen ? { model: chosen.model, reason: chosen.reason } : null;
      },
      turnRunning: (turnId) => this.#turn.turnStartedAt(turnId) !== null,
      loadedSnapshot: (threadId) => this.#conversation.loadedExecutionSnapshot(threadId),
      agentTaskTitle: (taskId) => this.#tasks.title(taskId),
      usageLimit: (agentId) => this.#usageLimits.limitFor(agentId),
      emit: (event) => this.#emit(event),
      artifactsPath: options.workspaceArtifactsPath ?? null,
      thumbnails: options.workspaceThumbnails ?? null,
      channelDecisions: (channelId) => this.channels.decisions(channelId),
      currentTicket: (agentId) => this.#currentTicket(agentId),
    });
    this.#removal = new AgentRemoval({
      store,
      mailbox,
      conversation: this.#conversation,
      browser,
      channels: this.channels,
      messaging: this.messaging,
      routines: this.#routines,
      duplication: this.#duplication,
      drain: this.#drain,
      threads: this.#threads,
      turn: this.#turn,
      hostedSites: this.#hostedSites,
      compaction: this.#compaction,
      apiKeys: options.agentApiKeys ?? null,
      deleteWithRevokedApproval: options.deleteWithRevokedApproval ?? ((_agentId, remove) => remove()),
      logger: createOpenBotLogger("agent-removal"),
      hooks: {
        emit: (event) => this.#emit(event),
        listAgents: () => this.listAgents(),
        deleteTasks: (agentId) =>
          Effect.gen({ self: this }, function* () {
            const threadIds = yield* lifecycleStep("list agent tasks", () => this.#tasks.threadIdsForAgent(agentId));
            for (const threadId of threadIds) yield* this.#forgetExecutionThread(threadId);
            yield* lifecycleStep("delete agent tasks", () => this.#tasks.deleteForAgent(agentId));
          }).pipe(Effect.mapError((failure) => new AgentRemovalFailed({ cause: failure.cause }))),
        stopAgentProcess: (agentId) =>
          this.#memoryReview
            .cancel(agentId)
            .pipe(Effect.andThen(this.learning.forgetAgent(agentId)))
            .pipe(Effect.andThen(this.settingsHistory.forgetAgent(agentId)))
            .pipe(Effect.andThen(Effect.suspend(() => this.portfolio?.forgetAgent(agentId) ?? Effect.void)))
            .pipe(Effect.andThen(this.#providers.stopAgentProcess(agentId)))
            .pipe(Effect.mapError((failure) => new AgentRemovalFailed({ cause: failure.cause }))),
      },
    });
    this.#wideResearch = new WideResearch({
      generate: (input) =>
        this.#backgroundGeneration(
          fanoutCandidates(input.tier, this.#endpoints.available()),
          input.agentId,
          input.prompt,
          { kind: "fanout", sessionId: input.sessionId, web: input.web, timeoutMs: input.timeoutMs, lowEffort: true },
        ).pipe(Effect.map((result) => result.text)),
      cost: (agentId, runId) => this.#store.database.usage.sessionCostUsd(agentId, `fanout:${runId}:`),
      directory: (agentId) => this.#store.spaces.agentSharedDirectory(agentId),
      finished: (agentId, text) => {
        Effect.runFork(
          this.sendMessage({ agentId, text }, undefined, undefined, "operator-note").pipe(
            Effect.catchCause((cause) =>
              Effect.sync(() => logger.warn("Could not send the wide research note.", { agentId, cause })),
            ),
          ),
        );
      },
    });
    this.#tools = new OpenBotToolRouter({
      capturedSteps: (session) => this.#threads.capturedWorkSteps(session).pipe(toToolOperationFailed),
      store,
      mailbox,
      mailboxSync: this.#mailboxSync,
      conversation: this.#conversation,
      attention: this.#attention,
      browser,
      browserUploads: this.#browserUploads,
      attachments: this.#attachments,
      channels: this.channels,
      messaging: this.messaging,
      hostedSites: this.#hostedSites,
      routines: this.#routines,
      eventChecks: this.eventChecks,
      audit: this.#audit,
      memories: this.#memories,
      waits: this.#waits,
      tasks: this.#tasks,
      drain: this.#drain,
      followUp: this.#followUp,
      tables: this.#tables,
      sidebarLayout: this.#sidebarLayout,
      ...(this.#localSkillTools === undefined ? {} : { localSkillTools: this.#localSkillTools }),
      ...(this.#routineFlowTools === undefined ? {} : { routineFlowTools: this.#routineFlowTools }),
      loops: () => this.loops,
      orderCards: () => this.#orderCards,
      wideResearch: this.#wideResearch,
      ...(options.agentMail === undefined ? {} : { mail: options.agentMail }),
      ...(options.approvalAutomation === undefined ? {} : { approvalAutomation: options.approvalAutomation }),
      ...(options.visualPreview === undefined ? {} : { visualPreview: options.visualPreview }),
      ownerAway: options.ownerAway ?? null,
      sharePreviews: options.sharePreviews ?? null,
      ownerText: options.ownerText ?? null,
      motionPreview: options.motionPreview ?? null,
      ...(options.screenCapture === undefined ? {} : { screenCapture: options.screenCapture }),
      mcpServers: mcpServersFromGateway(this.#mcp, options.prepareMcpTest),
      apiKeys: options.agentApiKeys ?? null,
      trust: options.trust ?? null,
      guardrails: options.guardrails ?? null,
      approvals: options.approvals ?? null,
      summarizePurpose: async (agentId, prompt) =>
        (await Effect.runPromise(this.generateReviewText({ agentId, important: false, prompt }))).text,
      ownerLanguage: () => this.ownerLanguage(),
      hooks: {
        listAgents: () => this.listAgents(),
        listModels: () => this.listModels(),
        providerAccounts: (provider) => this.getStatus().providers?.find((row) => row.id === provider)?.accounts,
        preferredProvider: () => this.preferredProvider(),
        createAgent: (input, configure, creatorAgentId) =>
          this.createAgent(
            input,
            configure
              ? (agent) =>
                  configure(agent).pipe(
                    Effect.mapError(
                      (failure) =>
                        new AgentLifecycleFailed({ operation: "configure tool agent", cause: failure.cause }),
                    ),
                  )
              : undefined,
            undefined,
            undefined,
            creatorAgentId,
          ).pipe(toToolOperationFailed),
        updateAgent: (input, initiatingAgentId) =>
          this.updateAgent(input, initiatingAgentId).pipe(toToolOperationFailed),
        setAvatar: (agentId, image) => this.setAvatar(agentId, image).pipe(toToolOperationFailed),
        enabledMcpServers: () => this.enabledMcpServers(),
        emitError: (code, error, agentId) => this.#emitError(code, error, agentId),
        redactMcp: (text) => this.#mcp.redact(text),
        runsTurn: (agentId) => this.#runsTurn(agentId),
        steerWhenBusy: (agentId, deliveryId) => this.#steerAgentMessage(agentId, deliveryId),
        interrupt: (agentId, turnId, mayStop) =>
          this.#interruptTurn(agentId, turnId, undefined, mayStop).pipe(toToolOperationFailed),
        turnActivity: (agentId, turnId) => ({
          startedAt: turnId ? this.#turn.turnStartedAt(turnId) : null,
          lastEventAt: this.#turn.lastEventAt(agentId),
        }),
        lastTurnFailed: (agentId) => this.#turn.failedTurns().has(agentId),
        usageLimit: (agentId) => this.#usageLimits.limitFor(agentId),
        agentCreationLimit: () => options.agentCreationLimit?.() ?? null,
        requestNoUpdate: (agentId, threadId, turnId) => this.#turn.requestNoUpdate(agentId, threadId, turnId),
        reportRoutineFailure: (agentId, turnId, reason) => this.#turn.reportRoutineFailure(agentId, turnId, reason),
        requestNewChat: (agentId) => {
          this.#requestedNewChats.add(agentId);
        },
        escalateModel: (agentId) => this.escalateModel(agentId),
        sleepTargetAgentIds: (target) => this.sleepTargetAgentIds(target),
        setAgentsSleeping: (input) => this.setAgentsSleeping(input).pipe(toToolOperationFailed),
        proposePlaybook: (agentId, slug, content, note) => this.playbooks.propose(agentId, slug, content, note),
        spaceMemory: (agentId, turnId, input) =>
          spaceMemoryTool(this.learning.knowledge, this.#store.spaces.agentSpaceId(agentId), agentId, turnId, input),
        logSpaceDecision: (agentId, input) =>
          this.learning.knowledge
            .logDecision(this.#store.spaces.agentSpaceId(agentId), agentId, input)
            .pipe(Effect.asVoid),
        // The first person is the host user of this computer; signed out, the signed-out reader.
        channelHost: () => options.channelPeople?.()[0] ?? { id: SIGNED_OUT_CHANNEL_MEMBER_ID, name: "You" },
        placeChannel: (channelId, spaceId) => this.spaces.place("channel", channelId, spaceId),
        postCard: (agentId, turnId, input) =>
          this.portfolio
            ? postCardTool(
                this.portfolio,
                {
                  channelFor: (id, turn) => this.#cardChannel(id, turn),
                  postInChannel: (id, channelId, text) => this.channels.postTeamQuestion(id, channelId, text),
                  postInOwnChat: (id, text) => this.#appendAgentLine(id, text),
                },
                agentId,
                turnId,
                input,
              )
            : Effect.succeed(openBotToolFailure("Cards are not available on this host yet. Ask in words instead.")),
        reportValidation: (agentId, input) =>
          this.portfolio
            ? reportValidationTool(this.portfolio, agentId, input)
            : Effect.succeed(openBotToolFailure("This host has no validation stage.")),
        goals: (agentId, input) =>
          this.insight
            ? this.insight.goalTool(agentId, input)
            : Effect.fail({ message: "Goals are not available yet." }),
      },
    });
    // The owner answers a decision card after the agent's call ended: the agent gets it as a message
    // from the owner, which starts its turn.
    this.#attention.onPastDecisionAnswered((decision, response, responder) =>
      Effect.suspend(() =>
        this.sendMessage(
          { agentId: decision.agentId, text: this.#tools.pastDecisionAnswered(decision, response, responder) },
          responder?.sender,
        ),
      ).pipe(Effect.asVoid),
    );
    this.#guardrails?.connect(
      guardrailsRuntime({
        store,
        mailbox,
        status: () => this.getStatus(),
        models: () => this.#endpoints.available(),
        usageAccounts: (provider) => this.#providers.usageAccounts(provider),
        poolOf: (provider) => this.#providers.accountPool(provider),
        clientFor: (agent) => this.#providers.clientForAgent(agent),
        publicThread: (agentId, threadId) => this.#conversation.publicThreadId(agentId, threadId),
        routineTrigger: (agentId, routineId) => this.#routines.getRecord(agentId, routineId)?.trigger.kind ?? null,
        interrupt: (agentId, turnId, executionThreadId) => this.interrupt(agentId, turnId, executionThreadId),
        scheduleDrain: (agentId) => this.#drain.scheduleDrain(agentId),
        generateCheap: (prompt) => this.generateCheapText(prompt, Date.now() + 20_000),
        ownerAway: options.ownerAway ?? null,
        noteAgent: (agentId, text) =>
          Effect.runFork(
            this.sendMessage({ agentId, text }, undefined, undefined, "operator-note").pipe(
              Effect.catch((failure) =>
                Effect.sync(() => this.#emitError("guardrail_note_failed", failure.cause, agentId)),
              ),
            ),
          ),
        recordTrust: (entry) => {
          options.trust?.record(entry);
        },
        modelReady: (choice) => this.#usageLimitReady(choice),
        changed: () => undefined,
      }),
    );
  }

  getStatus(): AgentStatus {
    return this.#providers.status();
  }

  getProviderAccountKind(provider: AgentProvider): { type: string; planType: string | null } | null {
    return this.#providers.accountKind(provider);
  }

  getAnalytics(input: AgentAnalyticsInput) {
    if (!this.listAgents().some((agent) => agent.id === input.agentId))
      throw new Error(sourceText("error.team.agentNotFound"));
    return this.#store.database.usage.read(input);
  }

  getHostAnalytics(input: HostAnalyticsInput) {
    if (
      input.agentId &&
      input.agentId !== WORKFLOWS_USAGE_ID &&
      !this.listAgents().some((agent) => agent.id === input.agentId)
    )
      throw new Error(sourceText("error.team.agentNotFound"));
    return this.#store.database.usage.readHost(input);
  }

  /** The provider-reported token counts of one turn by provider and model, for host analytics. */
  getTurnUsage(agentId: string, turnId: string, since: string) {
    return this.#store.database.usage.readTurn(agentId, turnId, since);
  }

  readonly getUsage = Effect.fn("AgentService.getUsage")(function* (this: AgentService, agentId?: string) {
    const agent = yield* lifecycleStep("find usage agent", () => {
      if (!agentId) return null;
      const found = this.listAgents().find((candidate) => candidate.id === agentId);
      if (!found) throw new Error(sourceText("error.team.agentNotFound"));
      return found;
    });
    return yield* this.#providers
      .usage(
        agent
          ? {
              provider: agent.provider,
              model: agent.model,
              ...(agent.providerAccountId ? { accountId: agent.providerAccountId } : {}),
            }
          : undefined,
      )
      .pipe(Effect.mapError((failure) => new AgentLifecycleFailed({ operation: "get usage", cause: failure.cause })));
  }).bind(this);

  /** The readings of the provider accounts after the first. The provider's own sign-ins are not read. */
  getProviderAccountUsage() {
    return this.#providers.accountUsage();
  }

  listAgents(): AgentSummary[] {
    return this.#duplication.visibleAgents(this.#store.list());
  }

  /**
   * After the account defaults changed from `previous`: each agent that follows a changed one loads
   * its sessions again before its next turn, so its instructions say what it may do now, as after a
   * change of its own setting. The listeners of `agents-changed`, such as the automation server, read
   * the new defaults.
   */
  agentDefaultsChanged(previous: AgentDefaults): void {
    const defaults = this.#store.agentDefaults();
    for (const agent of this.#store.list()) {
      if (standingProfileChanged(agent, agent, defaults, previous)) this.#conversation.unloadAgentThreads(agent.id);
    }
    this.#emit({ type: "agents-changed", agents: this.listAgents() });
  }

  /**
   * The other agents in the agent's sidebar section, in sidebar order, for its instructions. Null when
   * the agent has no section of the user's, or is in the Integrations section: the orchestrators there
   * serve unrelated integrations and choose teammates by fit.
   */
  sectionTeammates(agentId: string): SectionTeammates | null {
    const layout = this.#sidebarLayout?.getSnapshot();
    const section = layout?.sections.find((entry) => entry.id === layout.agentAssignments[agentId]);
    if (!layout || !section || section.name === sourceText("status.messaging.integrationsSection")) return null;
    const rank = (id: string) => {
      const index = layout.agentOrder.indexOf(id);
      return index === -1 ? Number.MAX_SAFE_INTEGER : index;
    };
    const members = this.listAgents()
      // A hidden agent takes no new messages, so it is not offered as a teammate.
      .filter(
        (agent) =>
          agent.id !== agentId &&
          agent.hiddenAt === undefined &&
          layout.agentAssignments[agent.id] === section.id &&
          this.#store.spaces.sameSpace(agentId, agent.id),
      )
      .sort((a, b) => rank(a.id) - rank(b.id))
      .slice(0, MAX_SECTION_TEAMMATES)
      .map((agent) => ({ id: agent.id, name: agent.name, title: agent.title }));
    return members.length > 0 ? { name: section.name, members } : null;
  }

  /**
   * Every id the sidebar layout may place: agents and channels alike, because the user files and
   * orders both in the same sections. An id missing from this set is pruned as gone the next time
   * the layout is reconciled, which would silently drop where the user put a channel.
   *
   * Channels come first. The layout store appends the ids that `agentOrder` does not hold yet in this
   * order, and the sidebar shows those channels above those agents. In another order, the first drop
   * after a chat was filed with "Move to" lands in a different place than the sidebar showed (#3229).
   */
  sidebarChatIds(): Set<string> {
    const ids = new Set(this.channels.store.ids());
    for (const agent of this.listAgents()) ids.add(agent.id);
    return ids;
  }

  /** The approvals and takeovers that a runtime snapshot leaves out, by its attention limit or its size. */
  attentionOverflowEvents(
    snapshot?: Pick<AgentRuntimeSnapshot, "pendingApprovals" | "pendingBrowserTakeovers">,
  ): AgentEvent[] {
    return this.#attention.attentionOverflowEvents(snapshot);
  }

  /** Every request of every agent that waits for the user now. */
  attentionItems(): AgentAttentionItem[] {
    return this.#attentionList();
  }

  /**
   * The attention list, with `ownerAsked` on a Motion ticket whose agent the owner wrote to while it
   * waits and that has not answered since: a question decides nothing, so the ticket stays, and the
   * card says the owner asked. It comes back to "waits for your decision" when the agent answers.
   */
  #attentionList(): AgentAttentionItem[] {
    return this.#attention.attentionItems().map((item) => {
      if (item.turnId !== MOTION_TICKET_TURN) return item;
      const asked = this.#store.database.connection
        .prepare(
          `SELECT 1 FROM projection_thread_messages asked
           WHERE asked.thread_id = ?1 AND asked.author = 'user' AND asked.created_at > ?2
             AND COALESCE(asked.item_type, '') != 'routine' AND COALESCE(asked.item_type, '') NOT LIKE 'system-notice:%'
             AND NOT EXISTS (
               SELECT 1 FROM projection_thread_messages answer
               WHERE answer.thread_id = ?1 AND answer.author = 'assistant' AND answer.created_at > asked.created_at
                 AND COALESCE(answer.item_type, 'agentMessage') IN ('agentMessage', 'final_answer', '${OWNER_MESSAGE_ITEM_TYPE}')
             )
           LIMIT 1`,
        )
        .get(item.threadId, item.createdAt);
      return asked ? { ...item, ownerAsked: true as const } : item;
    });
  }

  /**
   * The Motion tickets that wait on the user (`src/main/motion-events`), the whole list: each shows
   * in Needs you as a question of its agent that opens the ticket. A ticket of an unknown agent is left
   * out.
   */
  setWaitingTickets(
    tickets: readonly {
      agentId: string;
      issueId: string;
      key: string;
      title: string;
      url: string;
      createdAt: string;
      asks?: TicketAsks | undefined;
      reason?: string | undefined;
      plain?: OwnerSummary | undefined;
      escalatedBy?: string | undefined;
      escalationReason?: string | undefined;
    }[],
  ): void {
    const threads = new Map(this.listAgents().map((agent) => [agent.id, agent.threadId]));
    this.#attention.setTickets(
      tickets.flatMap((ticket) => {
        const threadId = threads.get(ticket.agentId);
        if (!threadId) return [];
        const summary = `${ticket.key} · ${ticket.title}`.slice(0, AGENT_ATTENTION_TEXT_LIMIT);
        return [
          {
            kind: "question" as const,
            requestId: `motion:${ticket.issueId}`.slice(0, 128),
            agentId: ticket.agentId,
            threadId,
            turnId: MOTION_TICKET_TURN,
            createdAt: ticket.createdAt,
            summary,
            url: ticket.url,
            ...(ticket.asks ? { asks: ticket.asks } : {}),
            ...(ticket.reason ? { reason: ticket.reason.slice(0, AGENT_ATTENTION_TEXT_LIMIT) } : {}),
            ...(ticket.plain ? { plain: ticket.plain } : {}),
            ...(ticket.escalatedBy ? { escalatedBy: ticket.escalatedBy.slice(0, AGENT_ATTENTION_TEXT_LIMIT) } : {}),
            ...(ticket.escalationReason
              ? { escalationReason: ticket.escalationReason.slice(0, AGENT_ATTENTION_TEXT_LIMIT) }
              : {}),
          },
        ];
      }),
    );
    const items = this.#attentionList();
    const encoded = JSON.stringify(items);
    if (encoded === this.#attentionEncoded) return;
    this.#attentionEncoded = encoded;
    this.emit("event", { type: "agent-attention-changed", items });
  }

  /**
   * Where a Motion ticket that the owner dismissed or answered in Needs you goes, by its id in Motion.
   * An answer is the text the owner wrote; a dismissal has none. An escalated review's answer can carry
   * the owner's verdict.
   */
  onWaitingTicketDismissed(
    dismiss: (issueId: string, answer: string | null, verdict: TicketVerdict | null) => Promise<void>,
  ): void {
    this.#attention.onTicketDismissed((requestId, answer, verdict) =>
      dismiss(requestId.replace(/^motion:/u, ""), answer, verdict),
    );
  }

  /** The source of each agent's current Motion ticket, which the fleet shows. */
  setCurrentTickets(source: (agentId: string) => WorkspaceFleetTicket | null): void {
    this.#currentTicket = source;
    this.workspace?.fleetChanged();
  }

  /** The fleet reads the current tickets again. */
  currentTicketsChanged(): void {
    this.workspace?.fleetChanged();
  }

  /** Who makes the Motion card of an order that `send_message` carries with `card`. */
  setOrderCards(port: OrderCardsPort | null): void {
    this.#orderCards = port;
  }

  /** The newest messages of the agent's own chat, oldest first: the evidence of its recent work. */
  /** The folders an agent may write: its workspace and its space's shared folder. */
  workRoots(agentId: string): readonly string[] {
    const agent = this.#store.list().find((candidate) => candidate.id === agentId);
    return agent ? workspaceWritableRoots(agent, this.#store.spaces.agentSharedDirectory(agentId)) : [];
  }

  recentWork(agentId: string): readonly ConversationMessage[] {
    const agent = this.#store.list().find((candidate) => candidate.id === agentId);
    if (!agent) return [];
    return this.#store.database.readConversationPage(agentId, agent.threadId, { type: "latest" }, 100).messages;
  }

  /**
   * One answer of the independent grader of a Motion ticket of `agentId` (`motion-grader.ts`), in a
   * fresh context without tools: the workspace's cheap model, or for an important ticket a model of
   * the other vendor (`reviewJudgeCandidates`). Its usage counts under the agent as a `grader` session.
   */
  /** The language the owner reads, for text the host writes for them; the host sets it at start. */
  ownerLanguage: () => string = () => process.env.OPENBOT_OWNER_LANGUAGE?.trim() || "Spanish";

  generateReviewText(input: { agentId: string; important: boolean; prompt: string; timeoutMs?: number | undefined }) {
    return Effect.suspend(() => {
      const agent = this.#store.list().find((candidate) => candidate.id === input.agentId);
      const gate = this.#workspaceSettings().gate;
      const candidates = reviewJudgeCandidates(
        agent ?? { provider: "claude", model: "" },
        input.important,
        this.#endpoints.available(),
        gate,
      );
      return this.#backgroundGeneration(candidates, input.agentId, input.prompt, {
        kind: "grader",
        lowEffort: !input.important,
        ...(input.timeoutMs ? { timeoutMs: input.timeoutMs } : {}),
      });
    });
  }

  /**
   * One generation without the agent's tools on the first candidate model whose provider starts and
   * answers; a model that fails hands over to the next. `web` lets it search and read the web.
   */
  #backgroundGeneration(
    candidates: readonly AgentModelOption[],
    agentId: string,
    prompt: string,
    options: { kind: "grader" | "fanout"; sessionId?: string; web?: boolean; timeoutMs?: number; lowEffort?: boolean },
  ): Effect.Effect<{ text: string; model: string }, ProfileGenerationFailed> {
    return Effect.gen({ self: this }, function* () {
      let last: unknown = new Error(sourceText("error.provider.noModel"));
      for (const candidate of candidates) {
        if (this.#stopping) break;
        const started = yield* Effect.result(this.#providers.ensureProvider(candidate.provider));
        if (Result.isFailure(started)) {
          last = started.failure;
          continue;
        }
        const effort = options.lowEffort
          ? (AGENT_REASONING_EFFORTS.find((value) => candidate.supportedReasoningEfforts.includes(value)) ??
            candidate.defaultReasoningEffort)
          : candidate.defaultReasoningEffort;
        const model = { ...candidate, defaultReasoningEffort: effort };
        const client = this.#providers.createProfileClient(candidate.provider);
        const answer = yield* Effect.result(
          this.#backgroundClients.run(client, (cancelled) =>
            generateTextWithoutTools(
              client,
              model,
              prompt,
              cancelled,
              backgroundUsageObserver(
                options.kind,
                this.#store.database.usage,
                candidate.provider,
                candidate.id,
                agentId,
                options.sessionId,
              ),
              { ...(options.web ? { web: true } : {}), ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}) },
            ),
          ),
        );
        if (Result.isSuccess(answer)) return { text: answer.success, model: `${candidate.provider}/${candidate.id}` };
        last = answer.failure;
      }
      return yield* new ProfileGenerationFailed({ cause: last instanceof Error ? last : new Error(String(last)) });
    });
  }

  /**
   * Whether no provider runs this turn of the agent's own chat any more: the provider ended it, its
   * normal end does not run, and no message starts or runs on it. A turn that waits for its
   * `turn/started` keeps a starting or running message, so it stays.
   */
  #turnRunsNowhere(agentId: string, turnId: string): boolean {
    return (
      !this.#stopping &&
      this.#turn.hasEnded(turnId) &&
      this.#turn.turnStartedAt(turnId) === null &&
      !this.#turn.isCompleting(turnId) &&
      this.#mailbox.findDeliveriesByTurn(agentId, turnId).length === 0 &&
      this.#mailbox.startingDeliveriesForAgent(agentId).length === 0
    );
  }

  readonly #settleStaleOwnTurn = Effect.fn("AgentService.settleStaleOwnTurn")(function* (
    this: AgentService,
    agentId: string,
    threadId: string,
    turnId: string,
  ) {
    if (!this.#turnRunsNowhere(agentId, turnId)) return;
    logger.warn("A chat turn that no provider runs held the agent's queue. It ends as interrupted.", {
      agentId,
      turnId,
    });
    yield* this.#turn.settleOrphanedTurn(agentId, threadId, turnId, "interrupted");
  });

  /** The agent's own chat has an orphaned delivery, and its provider is up to read the history. */
  #mayRecoverOrphanedDeliveries(agentId: string): boolean {
    if (this.#stopping || !this.#boot.hasOrphanedOwnChatDelivery(agentId)) return false;
    const agent = this.#store.list().find((candidate) => candidate.id === agentId);
    return agent !== undefined && this.#providers.clientFor(providerForAgent(agent)) !== null;
  }

  readonly #recoverOrphanedDeliveries = Effect.fn("AgentService.recoverOrphanedDeliveries")(function* (
    this: AgentService,
    agentId: string,
  ) {
    if (!this.#mayRecoverOrphanedDeliveries(agentId)) return;
    logger.warn("A message that no provider runs held the agent's queue. It is settled again.", { agentId });
    yield* this.#boot
      .reconcileUnresolvedDeliveries(agentId)
      .pipe(
        Effect.catch((failure) =>
          Effect.sync(() => this.#emitError("delivery_reconcile_failed", failure.cause, agentId)),
        ),
      );
    if (!this.#boot.hasOrphanedOwnChatDelivery(agentId)) this.#drain.scheduleDrain(agentId);
  });

  getRuntimeSnapshot(): AgentRuntimeSnapshot {
    return buildRuntimeSnapshot({
      contextStates: this.#compaction.snapshot(),
      agents: this.listAgents(),
      conversation: this.#conversation,
      database: this.#store.database,
      mailbox: this.#mailbox,
      turn: this.#turn,
      attention: this.#attention,
      usageLimits: this.#usageLimits,
      inputEscalations: this.#escalations?.list() ?? [],
      attentionItems: this.#attentionList(),
    });
  }

  agentIdForRequest(requestId: string | number): string | undefined {
    return this.#attention.agentIdForRequest(requestId);
  }

  getLocalAttention(agentId: string) {
    return this.#attention.localAttention(agentId);
  }

  respondToLocalAttention(agentId: string, input: LocalAttentionResponse): Effect.Effect<void, AgentLifecycleFailed> {
    return this.#attention
      .respondToLocalAttention(agentId, input)
      .pipe(
        Effect.mapError(
          (failure) => new AgentLifecycleFailed({ operation: "respondToLocalAttention", cause: failure.cause }),
        ),
      );
  }

  /**
   * Why this instance must not restart right now, or empty when nothing holds it. Read-only:
   * every source below is also what the drain loop and the shutdown path consult, so the answer
   * agrees with what stopping would interrupt. Scheduled future routine runs do not count; they
   * resume from durable rows after a restart.
   */
  /** The next scheduled routine run of any agent or channel, or null when none is scheduled. */
  nextRoutineDueAt(): string | null {
    return this.#routineTimer.nextDueAt();
  }

  /** Each running turn with its start and its last provider event, in epoch milliseconds. Read-only. */
  runningTurnActivity(): { turnId: string; agentId: string; startedAt: number; lastEventAt: number }[] {
    return this.#turn.runningTurnActivity();
  }

  /** The providers that wait for an automatic restart after they stopped. Read-only. */
  providerRestarts(): { provider: AgentProvider; attempts: number; nextAttemptAt: number }[] {
    return this.#providers.pendingRestarts();
  }

  hasActiveWork(): string[] {
    const reasons: string[] = [];
    for (const [, snapshot] of this.#conversation.activeSnapshots()) {
      if (snapshot.activeTurnId && !this.#conversation.isExecutionThread(snapshot.threadId)) {
        reasons.push("agent-turn");
        break;
      }
    }
    if (this.listAgents().some((agent) => this.#mailbox.hasUnfinishedDelivery(agent.id))) {
      reasons.push("queued-delivery");
    }
    // A scheduled drain with nothing behind it is a no-op microtask, not work: only an
    // in-flight drain carrying an unfinished delivery or a live turn holds the restart.
    for (const agent of this.listAgents()) {
      if (
        this.#drain.taskFor(agent.id) &&
        (this.#mailbox.hasUnfinishedDelivery(agent.id) || this.#conversation.anyWorkingSnapshot(agent.id)?.activeTurnId)
      ) {
        reasons.push("drain-task");
        break;
      }
    }
    if (this.#routines.hasActiveRuns() || this.#channelRoutines.hasActiveRuns()) reasons.push("routine-run");
    if (this.channels.hasActiveWork()) reasons.push("channel-work");
    if (this.#providers.activeProcessCount() > 0) reasons.push("provider-process");
    return reasons;
  }

  listMemories(agentId: string): AgentMemory[] {
    return this.#memories.list(agentId);
  }

  getMemorySelection(agentId: string): AgentMemorySelectionState {
    return this.#memories.selectionState(agentId);
  }

  setMemoryInclusion(input: SetAgentMemoryInclusionInput): AgentMemorySelectionState {
    return this.#memories.setInclusions(input);
  }

  initializeMemorySelection(agentId: string): void {
    this.#memories.initializeSelection(agentId);
  }

  /** How many memories one agent can hold now. */
  /** Where one http MCP server is reached for a chat app connection, as for an agent's provider. */
  mcpEndpoint(config: McpServerConfig): Effect.Effect<McpEndpoint | McpEndpointRefusal, McpOperationError> {
    return this.#mcp.endpoint(config).pipe(toMcpOperationError);
  }

  memoryLimit(): number {
    return this.#memories.limit();
  }

  /** The developer instructions state the limit, so a new limit reloads every agent's threads. */
  memoryLimitChanged(): void {
    for (const agent of this.listAgents()) this.#conversation.unloadAgentThreads(agent.id);
  }

  createMemory(input: CreateAgentMemoryInput): AgentMemory {
    return this.#memories.create(input);
  }

  updateMemory(input: UpdateAgentMemoryInput): AgentMemory {
    return this.#memories.update(input);
  }

  deleteMemory(input: DeleteAgentMemoryInput): void {
    this.#memories.delete(input);
  }

  clearMemories(agentId: string): void {
    this.#memories.clear(agentId);
  }

  listTables(): Effect.Effect<SharedTable[], AgentLifecycleFailed> {
    return (
      this.#tables
        ?.listShared()
        .pipe(Effect.mapError((cause) => new AgentLifecycleFailed({ operation: "list tables", cause }))) ??
      Effect.succeed([])
    );
  }

  readonly deleteTable = Effect.fn("AgentService.deleteTable")(function* (
    this: AgentService,
    input: DeleteSharedTableInput,
  ) {
    if (!this.#tables)
      return yield* new AgentLifecycleFailed({
        operation: "delete table",
        cause: new Error(sourceText("error.backend.sharedDataUnavailable")),
      });
    yield* this.#tables
      .removeAsUser(input.name, input.spaceId)
      .pipe(Effect.mapError((cause) => new AgentLifecycleFailed({ operation: "delete table", cause })));
  }).bind(this);

  /** Plans the routine timer again, after an outside source changed its next due time. */
  armRoutines(): void {
    this.#routineTimer.arm();
  }

  /** Holds routine firing while the system sleeps. See RoutineTimer.suspend. */
  suspendRoutines(): void {
    this.#routineTimer.suspend();
  }

  resumeRoutines(): void {
    this.#routineTimer.resume();
  }

  /** Holds routine firing while a restart of the app waits for the agents. See RoutineTimer.hold. */
  holdRoutines(): void {
    this.#routineTimer.hold();
  }

  releaseRoutines(): void {
    this.#routineTimer.release();
  }

  listRoutines(agentId: string): Routine[] {
    return this.#routines.list(agentId);
  }

  createRoutine(input: CreateRoutineInput, options: RoutineMutationOptions = {}): Routine {
    return this.#routines.create(input, options);
  }

  updateRoutine(input: UpdateRoutineInput, options: RoutineMutationOptions = {}): Routine {
    return this.#routines.update(input, options);
  }

  deleteRoutine(
    input: DeleteRoutineInput,
    options: RoutineMutationOptions = {},
  ): Effect.Effect<void, AgentLifecycleFailed> {
    return this.#routines
      .delete(input, options)
      .pipe(
        Effect.mapError((failure) => new AgentLifecycleFailed({ operation: "deleteRoutine", cause: failure.cause })),
      );
  }

  testRoutine(input: TestRoutineInput): Effect.Effect<RoutineRun, AgentLifecycleFailed> {
    return this.#routines
      .test(input)
      .pipe(Effect.mapError((failure) => new AgentLifecycleFailed({ operation: "testRoutine", cause: failure.cause })));
  }

  /** Hands a routine run's work on to the next agent of its flow; answers the delivery id. */
  enqueueRoutineHandoff(input: {
    run: Pick<RoutineRun, "id" | "routineId" | "routineName" | "scheduledFor">;
    /** The agent whose routine flow hands on. Absent for a workflow, which a person set up. */
    fromAgentId?: string;
    agentId: string;
    text: string;
    idempotencyKey: string;
    report?: true;
  }): Effect.Effect<string, AgentLifecycleFailed> {
    // A link drawn before the agents moved to different spaces hands nothing on.
    if (input.fromAgentId !== undefined && !this.#store.spaces.sameSpace(input.fromAgentId, input.agentId))
      return Effect.fail(
        new AgentLifecycleFailed({
          operation: "enqueueRoutineHandoff",
          cause: new Error(sourceText("error.backend.spaceOtherAgent", { agent: input.agentId })),
        }),
      );
    return this.#routines
      .enqueueHandoff(input)
      .pipe(
        Effect.mapError(
          (failure) => new AgentLifecycleFailed({ operation: "enqueueRoutineHandoff", cause: failure.cause }),
        ),
      );
  }

  /** A run that a local script starts through the automation server. Only for agents that allow it. */
  readonly runRoutineFromAutomation = Effect.fn("AgentService.runRoutineFromAutomation")(function* (
    this: AgentService,
    input: TestRoutineInput & { payload: string; waitId?: string },
  ) {
    yield* lifecycleStep("validate automation run", () => {
      this.#requireAutomationAllowed(input.agentId);
      if (input.payload.length > INPUT_LIMITS.automationPayload) {
        throw new Error(sourceText("error.agent.automationPayloadTooLong", { limit: INPUT_LIMITS.automationPayload }));
      }
    });
    return yield* this.#routines
      .runWithPayload({ ...input, source: "script" })
      .pipe(
        Effect.mapError(
          (failure) => new AgentLifecycleFailed({ operation: "run routine from automation", cause: failure.cause }),
        ),
      );
  }).bind(this);

  /** The command the user copies to run a routine from a local script. */
  automationRunCommand(input: TestRoutineInput): string {
    this.#requireAutomationAllowed(input.agentId);
    if (!this.#routines.list(input.agentId).some((routine) => routine.id === input.routineId)) {
      throw new Error(sourceText("error.backend.routineGone"));
    }
    return automationRunCommand({
      root: this.#store.automationRoot,
      agentId: input.agentId,
      routineId: input.routineId,
      payload: "",
      platform: process.platform,
    });
  }

  #requireAutomationAllowed(agentId: string): void {
    const agent = this.listAgents().find((candidate) => candidate.id === agentId);
    if (!agent || !agentAutomationAllowed(agent, this.#store.agentDefaults()))
      throw new Error(sourceText("error.agent.automationOff"));
  }

  /** `withSkipped` adds the skipped-run records, which only the local history shows. */
  listRoutineRuns(input: ListRoutineRunsInput, withSkipped = false): RoutineRun[] {
    return this.#routines.listRuns(input, withSkipped);
  }

  listChannelMemories(channelId: string): ChannelMemory[] {
    return this.channels.listMemories(channelId);
  }

  createChannelMemory(input: CreateChannelMemoryInput): ChannelMemory {
    return this.channels.createMemory(input);
  }

  updateChannelMemory(input: UpdateChannelMemoryInput): ChannelMemory {
    return this.channels.updateMemory(input);
  }

  deleteChannelMemory(input: DeleteChannelMemoryInput): void {
    this.channels.deleteMemory(input);
  }

  clearChannelMemories(channelId: string): void {
    this.channels.clearMemories(channelId);
  }

  listChannelRoutines(channelId: string): ChannelRoutine[] {
    return this.#channelRoutines.list(channelId);
  }

  createChannelRoutine(input: CreateChannelRoutineInput): ChannelRoutine {
    return this.#channelRoutines.create(input);
  }

  updateChannelRoutine(input: UpdateChannelRoutineInput): ChannelRoutine {
    return this.#channelRoutines.update(input);
  }

  deleteChannelRoutine(input: DeleteChannelRoutineInput): void {
    this.#channelRoutines.delete(input);
  }

  testChannelRoutine(input: TestChannelRoutineInput): Effect.Effect<ChannelRoutineRun, AgentLifecycleFailed> {
    return this.#channelRoutines
      .test(input)
      .pipe(
        Effect.mapError(
          (failure) => new AgentLifecycleFailed({ operation: "testChannelRoutine", cause: failure.cause }),
        ),
      );
  }

  listChannelRoutineRuns(input: ListChannelRoutineRunsInput, withSkipped = false): ChannelRoutineRun[] {
    return this.#channelRoutines.listRuns(input, withSkipped);
  }

  /**
   * The MCP servers this machine holds.
   *
   * Configurations only: OpenBot holds no connection of its own to report. A connection is made
   * when the user asks for a test, and when an agent starts - and the second is the provider's own.
   */
  listMcpServers(): McpServerConfig[] {
    return this.#mcp.list();
  }

  /**
   * `actor` is who asked. The app calls these for the user and the team API for a member; no agent
   * tool reaches them. Each change goes to the security audit file with names, never values.
   */
  saveMcpServer(
    input: SaveMcpServerInput,
    actor: SecurityActor = LOCAL_USER_ACTOR,
  ): Effect.Effect<McpServerConfig[], AgentLifecycleFailed> {
    const { config } = input;
    return this.#mcp.save(input).pipe(
      Effect.mapError((failure) => new AgentLifecycleFailed({ operation: "saveMcpServer", cause: failure.cause })),
      Effect.tap(() =>
        this.#audit.record({
          actor: auditActor(actor),
          action: "mcp-server.save",
          target: { kind: "mcp-server", id: config.id, name: config.name },
          names: [
            `transport:${config.transport}`,
            ...config.env.map((entry) => `env:${entry.key}`),
            ...config.headers.map((entry) => `header:${entry.key}`),
          ],
        }),
      ),
    );
  }

  removeMcpServer(
    input: RemoveMcpServerInput,
    actor: SecurityActor = LOCAL_USER_ACTOR,
  ): Effect.Effect<McpServerConfig[], AgentLifecycleFailed> {
    return this.#mcp.remove(input).pipe(
      Effect.mapError((failure) => new AgentLifecycleFailed({ operation: "removeMcpServer", cause: failure.cause })),
      Effect.tap(() =>
        this.#audit.record({
          actor: auditActor(actor),
          action: "mcp-server.remove",
          target: { kind: "mcp-server", id: input.mcpServerId },
        }),
      ),
    );
  }

  setMcpServerEnabled(
    input: SetMcpServerEnabledInput,
    actor: SecurityActor = LOCAL_USER_ACTOR,
  ): Effect.Effect<McpServerConfig[], AgentLifecycleFailed> {
    return this.#mcp.setEnabled(input).pipe(
      Effect.mapError(
        (failure) => new AgentLifecycleFailed({ operation: "setMcpServerEnabled", cause: failure.cause }),
      ),
      Effect.tap(() =>
        this.#audit.record({
          actor: auditActor(actor),
          action: input.enabled ? "mcp-server.enable" : "mcp-server.disable",
          target: { kind: "mcp-server", id: input.mcpServerId },
        }),
      ),
    );
  }

  /**
   * Marks every agent's provider session for refresh, spent before its next turn.
   *
   * The mark is what a managed tool runtime becoming ready spends: a session that dropped its
   * `npx` servers before Bun finished downloading is replaced once they can start. Mid-turn
   * sessions keep the mark until the turn ends, and the public threads and their histories stay.
   */
  refreshAllAgentRuntimes(): Effect.Effect<void, AgentLifecycleFailed> {
    return this.#threads.refreshAllAgentRuntimes();
  }

  testMcpServer(
    input: TestMcpServerInput,
    options: TestMcpServerOptions = {},
  ): Effect.Effect<McpTestResult, AgentLifecycleFailed> {
    return this.#mcp
      .test(input, options)
      .pipe(
        Effect.mapError((failure) => new AgentLifecycleFailed({ operation: "testMcpServer", cause: failure.cause })),
      );
  }

  signInMcpServer(
    input: TestMcpServerInput,
    open?: McpSignInOpener,
  ): Effect.Effect<McpTestResult, AgentLifecycleFailed> {
    return this.#mcp
      .signIn(input, open)
      .pipe(
        Effect.mapError((failure) => new AgentLifecycleFailed({ operation: "signInMcpServer", cause: failure.cause })),
      );
  }

  cancelMcpSignIn(input: CancelMcpSignInInput): void {
    this.#mcp.cancelSignIn(input.url);
  }

  signOutMcpServer(input: SignOutMcpServerInput): Effect.Effect<McpSignInState[], AgentLifecycleFailed> {
    return this.#mcp
      .signOut(input)
      .pipe(
        Effect.mapError((failure) => new AgentLifecycleFailed({ operation: "signOutMcpServer", cause: failure.cause })),
      );
  }

  listMcpSignIns(): McpSignInState[] {
    return this.#mcp.signIns();
  }

  mcpSignInApp(input: McpSignInAppInput): McpSignInAppState {
    return this.#mcp.signInApp(input);
  }

  saveMcpSignInApp(input: SaveMcpSignInAppInput): Effect.Effect<McpSignInAppState, AgentLifecycleFailed> {
    return this.#mcp
      .saveSignInApp(input)
      .pipe(
        Effect.mapError((failure) => new AgentLifecycleFailed({ operation: "saveMcpSignInApp", cause: failure.cause })),
      );
  }

  removeMcpSignInApp(input: McpSignInAppInput): Effect.Effect<McpSignInAppState, AgentLifecycleFailed> {
    return this.#mcp
      .removeSignInApp(input)
      .pipe(
        Effect.mapError(
          (failure) => new AgentLifecycleFailed({ operation: "removeMcpSignInApp", cause: failure.cause }),
        ),
      );
  }

  enabledMcpServers(threadId?: string): McpServerConfig[] {
    return this.#mcp.enabled(threadId);
  }

  /** The enabled MCP rows before their Secrets links and agent templates are filled. */
  storedMcpServers(): McpServerConfig[] {
    return this.#mcp.stored();
  }

  /** The agent a thread belongs to, as an MCP row names it. */
  mcpAgentForThread(threadId: string | undefined): McpAgent | null {
    if (!threadId) return null;
    // Provider sessions and chat apps name a thread by its public id; the conversation runtime keys
    // its own map by the provider's id, so each is tried, then the agent's main and channel threads.
    const agents = this.listAgents();
    const agentId =
      agents.find((item) => item.threadId === threadId)?.id ??
      this.#conversation.agentForPublicThread(threadId) ??
      this.#conversation.agentForThread(threadId) ??
      this.channels.store.agentForThread(threadId) ??
      undefined;
    return agentId ? this.mcpAgent(agentId) : null;
  }

  /** An agent and its space as an MCP row names them, or null when there is no such agent. */
  mcpAgent(agentId: string): McpAgent | null {
    const agent = this.listAgents().find((item) => item.id === agentId);
    if (!agent) return null;
    const { id, name, slug } = this.#store.spaces.agentSpace(agent.id);
    return { id: agent.id, name: agent.name, space: { id, name, slug } };
  }

  /** One row filled for an agent, or null when it names a key that is not saved. */
  personalMcpServer(config: McpServerConfig, agent: McpAgent | null): McpServerConfig | null {
    const keys = this.#agentApiKeys;
    return personalizeMcpConfig(config, agent, (scope, agentId, name) => keys?.readNow(scope, agentId, name) ?? null);
  }

  #personalMcp(threadId: string | undefined, configs: readonly McpServerConfig[]): McpServerConfig[] {
    const agent = this.mcpAgentForThread(threadId);
    return configs.flatMap((config) => this.personalMcpServer(config, agent) ?? []);
  }

  /**
   * The Computer Use capability, as the main process alone can know it.
   *
   * Here rather than on the runtime directly, so the main process does not reach past this class
   * into the providers it owns.
   */
  setComputerUseCapability(state: CapabilityState): void {
    this.#providers.setComputerUseCapability(state);
  }

  /**
   * The driver appeared or went away, so every loaded provider session now lists the wrong tools.
   *
   * Same treatment as a saved or removed server: the agents are marked for a fresh provider session
   * and the public thread is untouched.
   */
  notifyComputerUseChanged(): Effect.Effect<void, AgentLifecycleFailed> {
    return this.#mcp.changed().pipe(
      Effect.asVoid,
      Effect.mapError(
        (failure) => new AgentLifecycleFailed({ operation: "refresh computer use", cause: failure.cause }),
      ),
    );
  }

  /**
   * When the oldest running agent turn started, or null while none runs. The Computer Use rim is up
   * only for an action made since then.
   */
  earliestRunningTurnStartedAt(): number | null {
    return this.#turn.earliestRunningTurnStartedAt();
  }

  /**
   * Holds every queue for a deploy and waits, for `timeoutMs` at most, until no turn runs, so the
   * restart that follows cuts off no work. Messages still queue, and the next process starts them.
   * The hold ends by itself `DEPLOY_DRAIN_HOLD_GRACE_MS` after the wait, for a deploy that stopped
   * before its restart, or with `endDeployDrain`. Returns the turns that still run.
   */
  readonly drainForDeploy = Effect.fn("AgentService.drainForDeploy")(function* (this: AgentService, timeoutMs: number) {
    const deadline = Date.now() + timeoutMs;
    this.#holdForDeploy(deadline + DEPLOY_DRAIN_HOLD_GRACE_MS);
    logger.info("A deploy holds new turns until the running ones end.", {
      running: this.#turn.runningTurnActivity().length,
    });
    while (this.#turn.runningTurnActivity().length > 0 && Date.now() < deadline)
      yield* Effect.sleep(Math.min(1_000, Math.max(0, deadline - Date.now())));
    return this.#turn.runningTurnActivity();
  });

  /** Whether a deploy holds new work now (`drainForDeploy`). Background jobs wait for the restart. */
  isDeployDraining(): boolean {
    return this.#deployDrainUntil !== null && Date.now() < this.#deployDrainUntil;
  }

  /** Ends the hold of `drainForDeploy`, and the queues start again. */
  endDeployDrain(): void {
    if (this.#deployDrainTimer) clearTimeout(this.#deployDrainTimer);
    this.#deployDrainTimer = null;
    if (this.#deployDrainUntil === null) return;
    this.#deployDrainUntil = null;
    logger.info("The deploy hold ended; queued turns start again.");
    for (const agent of this.#store.list()) this.#drain.scheduleDrain(agent.id);
  }

  #holdForDeploy(until: number): void {
    if (this.#deployDrainTimer) clearTimeout(this.#deployDrainTimer);
    this.#deployDrainUntil = until;
    this.#deployDrainTimer = setTimeout(() => this.endDeployDrain(), Math.max(0, until - Date.now()));
    this.#deployDrainTimer.unref?.();
  }

  /**
   * GitHub was connected, disconnected or expired. The same treatment as the Computer Use entry,
   * and the processes that read the `gh` and `git` variables only at spawn start again.
   */
  readonly notifyGitHubConnectorChanged = Effect.fn("AgentService.notifyGitHubConnectorChanged")(function* (
    this: AgentService,
  ) {
    yield* this.#mcp
      .changed()
      .pipe(
        Effect.mapError(
          (failure) => new AgentLifecycleFailed({ operation: "refresh GitHub tools", cause: failure.cause }),
        ),
      );
    yield* this.#providers.reloadAgentEnvironment();
  }).bind(this);

  /**
   * A setting that lives outside the agent store changed, such as an agent's auto-approve grant.
   * Clients of this host read those settings again when the agent list changes. A grant given now
   * also answers the requests that already wait for it.
   */
  notifyAgentsChanged(): void {
    this.#attention.answerGrantedRequests();
    this.#emit({ type: "agents-changed", agents: this.listAgents() });
  }

  /** The installed skills of one agent changed, so every open skills list reads them again. */
  notifySkillsChanged(agentId: string): void {
    this.#emit({ type: "skills-changed", agentId });
  }

  /** A routine result destination or delivery of one agent changed, so every routine editor reads it again. */
  notifyRoutineResultsChanged(agentId: string): void {
    this.#emit({ type: "routines-changed", agentId });
  }

  /** The routine canvas of one agent changed, so every view showing it reads it again. */
  notifyRoutineFlowsChanged(agentId: string): void {
    this.#emit({ type: "routine-flows-changed", agentId });
  }

  /** A workflow changed, so every view showing it reads it again. */
  notifyWorkflowsChanged(workflowId: string): void {
    this.#emit({ type: "workflows-changed", workflowId });
  }

  notifyWorkflowRunEnded(end: WorkflowRunEnd): void {
    this.emit("workflowRun", end);
  }

  listModels(): AgentModelOption[] {
    return this.#endpoints.available();
  }

  readonly generateProfile = Effect.fn("AgentService.generateProfile")(
    function* (this: AgentService, input: GenerateAgentProfileInput, sections: SidebarSection[]) {
      const agent = input.agentId ? this.listAgents().find((candidate) => candidate.id === input.agentId) : null;
      if (input.agentId && !agent)
        return yield* new ProfileGenerationFailed({ cause: new Error(sourceText("error.agent.gone")) });
      if (this.#stopping)
        return yield* new ProfileGenerationFailed({ cause: new Error(sourceText("error.backend.shuttingDown")) });
      if (this.#profileClients.busy())
        return yield* new ProfileGenerationFailed({
          cause: new Error(sourceText("error.agent.profileGenerationBusy")),
        });
      const provider = agent?.provider ?? this.#startingChoice()?.provider ?? this.#providers.preferredProvider();
      yield* this.#providers.ensureProvider(provider);
      const models = this.#endpoints.available();
      const model = agent
        ? models.find((candidate) => candidate.id === agent.model && candidate.provider === provider)
        : startingModel(provider, models, this.#preference());
      if (!model) return yield* new ProfileGenerationFailed({ cause: new Error(sourceText("error.provider.noModel")) });
      if (this.#stopping)
        return yield* new ProfileGenerationFailed({ cause: new Error(sourceText("error.backend.shuttingDown")) });
      if (this.#profileClients.busy())
        return yield* new ProfileGenerationFailed({
          cause: new Error(sourceText("error.agent.profileGenerationBusy")),
        });
      const client = this.#providers.createProfileClient(provider);
      return yield* this.#profileClients.run(client, (cancelled) =>
        generateProfile(client, model, input, sections, cancelled),
      );
    },
    Effect.mapError((failure) => new AgentLifecycleFailed({ operation: "generate profile", cause: failure.cause })),
  ).bind(this);

  /**
   * The model of a background review: the provider's default model when it is listed, which is its
   * smaller one (Claude Haiku, the small GPT), else the agent's own. At the lowest effort it takes.
   */
  #backgroundModel(agent: AgentSummary): AgentModelOption | null {
    const models = this.#endpoints.available().filter((candidate) => candidate.provider === agent.provider);
    const model =
      models.find((candidate) => candidate.id === defaultProviderModel(agent.provider)) ??
      models.find((candidate) => candidate.id === agent.model);
    if (!model) return null;
    const effort =
      model.reasoningEffortConfigurable === false
        ? undefined
        : AGENT_REASONING_EFFORTS.find((candidate) => model.supportedReasoningEfforts.includes(candidate));
    return effort ? { ...model, defaultReasoningEffort: effort } : model;
  }

  /**
   * Runs a performance review prompt on the agent's small model (its background model when the
   * provider lists none). Null when no model can run it. Its usage is saved like a memory review's.
   */
  #generateReview(agent: AgentSummary, prompt: string, errorCode = "performance_review_failed") {
    return Effect.gen({ self: this }, function* () {
      yield* this.#providers.ensureProvider(agent.provider);
      const listed = this.#endpoints.available();
      const smallId = tierModel(agent, "small", listed);
      const model =
        listed.find((candidate) => candidate.provider === agent.provider && candidate.id === smallId) ??
        this.#backgroundModel(agent);
      if (!model) return null;
      const client = this.#providers.createProfileClient(agent.provider);
      const text = yield* this.#profileClients.run(client, (cancelled) =>
        generateTextWithoutTools(
          client,
          model,
          prompt,
          cancelled,
          memoryReviewUsageObserver(this.#store.database.usage, agent.provider, model.id, agent.id),
        ),
      );
      return { text, costUsd: null };
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.sync(() => {
          this.#emitError(errorCode, cause, agent.id);
          return null;
        }),
      ),
    );
  }

  /**
   * Adds an approved review instruction to the agent's instructions, or to its memories when the
   * instructions have no room left for it.
   */
  #applyReviewInstruction(agentId: string, text: string) {
    return Effect.gen({ self: this }, function* () {
      const agent = this.#store.list().find((candidate) => candidate.id === agentId);
      if (!agent) return;
      const description = `${agent.description.trimEnd()}\n\n${text}`;
      if (description.length <= INPUT_LIMITS.agentDescription)
        yield* this.updateAgent({ agentId, description }, undefined, true, { author: { kind: "improver" } });
      else this.#memories.create({ agentId, text });
    });
  }

  /** The agent's own chat, without the turn that runs now, from memory or the newest page of the database. */
  #ownChat(agentId: string): readonly ConversationMessage[] {
    const loaded = this.#conversation.loadedSnapshot(agentId);
    if (loaded)
      return loaded.activeTurnId
        ? loaded.messages.filter((message) => message.turnId !== loaded.activeTurnId)
        : loaded.messages;
    const threadId = this.#store.list().find((agent) => agent.id === agentId)?.threadId;
    return threadId
      ? this.#store.database.readConversationPage(agentId, threadId, { type: "latest" }, MEMORY_REVIEW_MESSAGES)
          .messages
      : [];
  }

  /** Adds an accepted lesson to the "Lessons" part of one of the agent's local skills. */
  #addSkillLesson(agentId: string, skillId: string, text: string) {
    return Effect.gen({ self: this }, function* () {
      const learner = this.#learnedSkills?.();
      if (!learner) return yield* Effect.fail(new Error("This host has no skill library."));
      const current = yield* learner.read(skillId);
      yield* learner.save(agentId, {
        action: "update",
        skillId,
        expectedRevision: current.revision,
        description: current.description,
        instructions: withLesson(current.instructions, text),
      });
    });
  }

  /**
   * Puts each field of a settings checkpoint back to its value before it: the agent's settings in one
   * update, then each skill and playbook text. Answers the agent's newest checkpoint after it.
   */
  readonly rollbackSettings = Effect.fn("AgentService.rollbackSettings")(function* (
    this: AgentService,
    checkpointId: string,
  ) {
    const checkpoint = yield* this.settingsHistory.get(checkpointId);
    if (!checkpoint) return yield* Effect.fail(new Error("The checkpoint does not exist any more."));
    const agent = this.#store.list().find((candidate) => candidate.id === checkpoint.agentId);
    if (!agent) return yield* Effect.fail(new Error("The agent does not exist any more."));
    if (checkpoint.changes.some((change) => isCutText(change.before)))
      return yield* Effect.fail(
        new Error("A text of this checkpoint was too long to keep whole, so it cannot roll back."),
      );
    const update: AgentUpdate = { agentId: agent.id };
    for (const change of checkpoint.changes) {
      const before = change.before;
      switch (change.field) {
        case "name":
          if (before) update.name = before;
          break;
        case "title":
          update.title = before ?? "";
          break;
        case "instructions":
          update.description = before ?? "";
          break;
        case "provider":
          if (isAgentProvider(before)) update.provider = before;
          break;
        case "model":
          if (before) update.model = before;
          break;
        case "reasoningEffort":
          if (isReasoningEffort(before)) update.reasoningEffort = before;
          break;
        case "modelPolicy":
          update.modelPolicy = before === "auto" ? "auto" : "fixed";
          break;
        case "playbookRole":
          update.playbookRole = before;
          break;
        case "access":
          if (isAgentAccess(before)) update.access = before;
          break;
        case "computerUse":
          update.computerUse = before !== "off";
          break;
        case "backupModels":
          {
            const models = before ? JSON.parse(before) : null;
            update.backupModels = isAgentBackupModels(models) ? models : null;
          }
          break;
        default:
          break;
      }
    }
    if (Object.keys(update).length > 1)
      yield* this.updateAgent(update, undefined, true, { author: { kind: "owner" }, rollbackOf: checkpoint.id });
    for (const change of checkpoint.changes) {
      if (change.field === "skill" && change.ref) {
        const library = this.#skillLibrary;
        const learner = library
          ? recordedSkillLearner(library(), this.settingsHistory, { kind: "owner" }, checkpoint.id)
          : null;
        if (!learner || change.before === null)
          return yield* Effect.fail(new Error("A skill that a review made is removed in Skills, not rolled back."));
        const current = yield* learner.read(change.ref);
        yield* learner.save(agent.id, {
          action: "update",
          skillId: change.ref,
          expectedRevision: current.revision,
          description: current.description,
          instructions: change.before,
        });
      }
      if (change.field === "playbook" && change.ref && change.before !== null) {
        const playbook = (yield* this.playbooks.snapshot()).playbooks.find((candidate) => candidate.id === change.ref);
        if (!playbook) return yield* Effect.fail(new Error("The playbook does not exist any more."));
        yield* this.playbooks.save(
          { id: playbook.id, slug: playbook.slug, roles: playbook.roles, content: change.before },
          { kind: "owner" },
        );
      }
    }
    return (yield* this.settingsHistory.list(agent.id))[0] ?? null;
  }).bind(this);

  /**
   * The memories and space facts that an agent learned from one of its chats (its own chat, a task or
   * a channel thread of its), which go with `confirm`.
   */
  readonly forgetConversation = Effect.fn("AgentService.forgetConversation")(function* (
    this: AgentService,
    input: ForgetConversationInput,
  ) {
    const agent = this.#store.list().find((candidate) => candidate.id === input.agentId);
    if (!agent) return yield* Effect.fail(new Error("The agent does not exist any more."));
    const threadId = input.threadId ?? agent.threadId;
    const own = [
      ...(agent.threadId ? [agent.threadId] : []),
      ...this.#tasks.threadIdsForAgent(agent.id),
      ...this.channels.store.contextThreadsForAgent(agent.id),
    ];
    if (!threadId || !own.includes(threadId)) return { memories: [], facts: [], forgotten: 0 };
    const turnIds = new Set(this.#store.database.threadTurnIds(threadId));
    for (const message of this.#conversation.loadedSnapshot(agent.id)?.messages ?? [])
      if (threadId === agent.threadId && message.turnId) turnIds.add(message.turnId);
    return yield* this.learning.forgetConversation(agent.id, turnIds, input.confirm === true);
  }).bind(this);

  /** Adds a line of a background memory review to the agent's own chat. It wakes nobody. */
  /** The channel of a card that an agent posts in a turn: the turn's channel, else its DM with a person. */
  #cardChannel(agentId: string, turnId: string): string | null {
    const context = this.channels.teamContext(agentId, turnId);
    if (context) return context.channelId;
    const store = this.channels.store;
    const archived = store.archivedIds();
    return (
      store
        .ids()
        .filter((channelId) => !archived.has(channelId))
        .map((channelId) => store.get(channelId))
        .find(
          (channel) => channelKind(channel) === "dm" && channel.members.some((member) => member.agentId === agentId),
        )?.id ?? null
    );
  }

  /** Adds a line of the agent to its own chat, beside the turn that runs, such as a card it posted. */
  #appendAgentLine(agentId: string, text: string): void {
    const database = this.#store.database;
    const message: ConversationMessage = {
      id: randomUUID(),
      author: "assistant",
      text,
      createdAt: new Date().toISOString(),
      status: "completed",
    };
    this.#conversation.withConversationTransaction(agentId, ({ threadId, snapshot }) => {
      snapshot.messages.push(message);
      sortConversationMessages(snapshot.messages);
      snapshot.revision = database.appendConversationMessage({
        agentId,
        threadId,
        activeTurnId: snapshot.activeTurnId,
        message,
        eventType: "thread.card-posted",
      });
      return { result: undefined, snapshot };
    });
  }

  /** An answer to a turn the owner started: its Motion links are for the owner. */
  #noteOwnerAnswer(answer: FinishedAnswer, ownerText: ((agentId: string, text: string) => void) | null): void {
    if (!ownerText || answer.channel || !answer.senders.some((sender) => sender.kind === "user")) return;
    try {
      const text = this.#conversation
        .loadedSnapshot(answer.agentId)
        ?.messages.find((message) => message.id === answer.messageId)?.text;
      if (text) ownerText(answer.agentId, text);
    } catch (cause) {
      logger.warn("Could not read the Motion links of an answer.", { agentId: answer.agentId, cause });
    }
  }

  /** Gives a finished answer to a person to the live score, which samples a few of them. */
  #scoreAnswerLater(answer: FinishedAnswer): void {
    const quality = this.portfolio?.quality;
    if (!quality) return;
    try {
      const asked = answer.senders
        .filter((sender) => sender.kind === "user")
        .map((sender) => sender.text)
        .join("\n")
        .trim();
      if (!asked) return;
      const text = this.#conversation
        .loadedSnapshot(answer.agentId)
        ?.messages.find((message) => message.id === answer.messageId)?.text;
      const found =
        text ??
        this.#store.database
          .readConversationPage(answer.agentId, answer.threadId, { type: "latest" }, 20)
          .messages.find((message) => message.id === answer.messageId)?.text;
      if (!found) return;
      quality.finished({ agentId: answer.agentId, turnId: answer.turnId, asked, answer: found });
    } catch (cause) {
      logger.warn("Could not give an answer to the live score.", { agentId: answer.agentId, cause });
    }
  }

  /**
   * The agent as a rehearsal sees it: its instructions, the playbooks of its role and the text of its
   * local skills. Null for an unknown agent.
   */
  readonly sandboxProfile = Effect.fn("AgentService.sandboxProfile")(function* (this: AgentService, agentId: string) {
    const agent = this.#store.list().find((candidate) => candidate.id === agentId);
    if (!agent) return null;
    const snapshot = yield* this.playbooks.snapshot().pipe(Effect.orElseSucceed(() => null));
    const playbooks = (snapshot?.playbooks ?? [])
      .filter((playbook) => agentHasPlaybookRole(agent, playbook.roles))
      .map((playbook) => ({ slug: playbook.slug, content: playbook.content }));
    const listed = yield* (this.#reviewSkills?.(agentId) ?? Effect.succeed([])).pipe(
      Effect.orElseSucceed((): readonly ReviewSkill[] => []),
    );
    const learner = this.#skillLibrary?.();
    const skills: { name: string; instructions: string }[] = [];
    for (const skill of listed.slice(0, 10)) {
      const source = learner ? yield* learner.read(skill.skillId).pipe(Effect.orElseSucceed(() => null)) : null;
      skills.push({ name: skill.name, instructions: source?.instructions ?? skill.description ?? "" });
    }
    return { name: agent.name, title: agent.title, instructions: agent.description, playbooks, skills };
  });

  /**
   * Runs a prompt with no tools on the agent's own model (`own`) or its small model (`small`), as the
   * rehearsals of the test suites and their judges do. Null when no model can run it.
   */
  generateWithoutTools(agentId: string, prompt: string, tier: "own" | "small") {
    const agent = this.#store.list().find((candidate) => candidate.id === agentId);
    if (!agent) return Effect.succeed(null);
    if (tier === "small")
      return this.#generateReview(agent, prompt, "portfolio_generation_failed").pipe(
        Effect.map((answer) => answer?.text ?? null),
      );
    return Effect.gen({ self: this }, function* () {
      yield* this.#providers.ensureProvider(agent.provider);
      const model =
        this.#endpoints
          .available()
          .find((candidate) => candidate.provider === agent.provider && candidate.id === agent.model) ??
        this.#backgroundModel(agent);
      if (!model) return null;
      const client = this.#providers.createProfileClient(agent.provider);
      return yield* this.#profileClients.run(client, (cancelled) =>
        generateTextWithoutTools(
          client,
          model,
          prompt,
          cancelled,
          memoryReviewUsageObserver(this.#store.database.usage, agent.provider, model.id, agent.id),
        ),
      );
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.sync(() => {
          this.#emitError("portfolio_generation_failed", cause, agent.id);
          return null;
        }),
      ),
    );
  }

  #appendReviewMessage(agentId: string, message: ConversationMessage): void {
    const database = this.#store.database;
    this.#conversation.withConversationTransaction(agentId, ({ threadId, snapshot }) => {
      snapshot.messages.push(message);
      sortConversationMessages(snapshot.messages);
      snapshot.revision = database.appendConversationMessage({
        agentId,
        threadId,
        activeTurnId: snapshot.activeTurnId,
        message,
        eventType: "thread.memory-reviewed",
      });
      return { result: undefined, snapshot };
    });
  }

  /**
   * Answers a question about an agent's chat with the agent's own model. Nothing is kept: the
   * generation has no tools, no session and no thread, and the answer goes back to the caller only.
   */
  readonly askSideQuestion = Effect.fn("AgentService.askSideQuestion")(
    function* (this: AgentService, input: AskSideQuestionInput) {
      const failed = (message: string) => new ProfileGenerationFailed({ cause: new Error(message) });
      const agent = this.listAgents().find((candidate) => candidate.id === input.agentId);
      if (!agent) return yield* failed(sourceText("error.agent.gone"));
      if (this.#stopping) return yield* failed(sourceText("error.backend.shuttingDown"));
      if (this.#profileClients.busy()) return yield* failed(sourceText("error.agent.sideQuestionBusy"));
      yield* this.#providers.ensureProvider(agent.provider);
      const model = this.#endpoints
        .available()
        .find((candidate) => candidate.provider === agent.provider && candidate.id === agent.model);
      if (!model) return yield* failed(sourceText("error.provider.noModel"));
      if (this.#stopping) return yield* failed(sourceText("error.backend.shuttingDown"));
      if (this.#profileClients.busy()) return yield* failed(sourceText("error.agent.sideQuestionBusy"));
      const messages =
        this.#conversation.loadedSnapshot(agent.id)?.messages ??
        this.#store.database.readConversationPage(
          agent.id,
          agent.threadId,
          { type: "latest" },
          SIDE_QUESTION_CHAT_MESSAGES,
        ).messages;
      const client = this.#providers.createProfileClient(agent.provider);
      return yield* this.#profileClients
        .run(client, (cancelled) =>
          generateTextWithoutTools(
            client,
            { ...model, defaultReasoningEffort: agent.reasoningEffort },
            sideQuestionPrompt(agent, messages, input),
            cancelled,
          ),
        )
        .pipe(
          Effect.tapError((failure) =>
            Effect.sync(() =>
              logger.warn("Could not answer a side question.", { provider: agent.provider, error: failure.cause }),
            ),
          ),
          // The generation's own messages name a profile.
          Effect.mapError((failure) =>
            failed(
              failure instanceof GenerationUsageLimitError
                ? sourceText("error.provider.usageLimitReached")
                : sourceText("error.agent.sideQuestionFailed"),
            ),
          ),
        );
    },
    Effect.mapError((failure) => new AgentLifecycleFailed({ operation: "ask side question", cause: failure.cause })),
  ).bind(this);

  /**
   * Answers one model step of a workflow. Like a side question, the generation has no tools, no
   * session and no thread. A missing provider or model falls back to the user's starting choice.
   */
  readonly generateWorkflowText = Effect.fn("AgentService.generateWorkflowText")(
    function* (
      this: AgentService,
      input: {
        provider: AgentProvider | null;
        model: string | null;
        effort: AgentReasoningEffort | null;
        prompt: string;
      },
    ) {
      const failed = (message: string) => new ProfileGenerationFailed({ cause: new Error(message) });
      if (this.#stopping) return yield* failed(sourceText("error.backend.shuttingDown"));
      if (this.#profileClients.busy()) return yield* failed(sourceText("error.workflow.modelBusy"));
      const provider = input.provider ?? this.#startingChoice()?.provider ?? this.#providers.preferredProvider();
      yield* this.#providers.ensureProvider(provider);
      const models = this.#endpoints.available();
      const model =
        (input.model === null
          ? undefined
          : models.find((candidate) => candidate.provider === provider && candidate.id === input.model)) ??
        startingModel(provider, models, this.#preference());
      if (!model) return yield* failed(sourceText("error.provider.noModel"));
      if (this.#stopping) return yield* failed(sourceText("error.backend.shuttingDown"));
      if (this.#profileClients.busy()) return yield* failed(sourceText("error.workflow.modelBusy"));
      return yield* this.#warmGenerations
        .generate(
          provider,
          { ...model, defaultReasoningEffort: input.effort ?? model.defaultReasoningEffort },
          input.prompt,
          workflowUsageObserver(this.#store.database.usage, provider, model.id),
        )
        .pipe(
          Effect.tapError((failure) =>
            Effect.sync(() => logger.warn("Could not answer a workflow step.", { provider, error: failure.cause })),
          ),
          // The generation's own messages name a profile.
          Effect.mapError((failure) =>
            failed(
              failure instanceof GenerationUsageLimitError
                ? sourceText("error.provider.usageLimitReached")
                : sourceText("error.workflow.modelFailed"),
            ),
          ),
        );
    },
    Effect.mapError(
      (failure) => new AgentLifecycleFailed({ operation: "generate workflow text", cause: failure.cause }),
    ),
  ).bind(this);

  /**
   * One question of the channel answer gate: a toolless generation on the workspace gate model, at
   * the lowest reasoning effort the model takes unless the settings name one. It fails at once when
   * the provider or the model is not there; when the gate's own budget is full it waits for a place
   * until the deadline. The gate then lets the member answer only when it is addressed.
   */
  #generateGateText(
    settings: WorkspaceGateSettings,
    agentId: string,
    prompt: string,
    generation: ChannelGateGeneration,
    observer: typeof gateUsageObserver = gateUsageObserver,
  ) {
    return Effect.gen({ self: this }, function* () {
      const failed = (message: string) => new ProfileGenerationFailed({ cause: new Error(message) });
      if (this.#stopping) return yield* failed(sourceText("error.backend.shuttingDown"));
      const provider = settings.provider;
      if (!isAgentProvider(provider)) return yield* failed(sourceText("error.provider.noModel"));
      yield* this.#providers.ensureProvider(provider);
      const model = this.#endpoints
        .available()
        .find((candidate) => candidate.provider === provider && candidate.id === settings.model);
      if (!model) return yield* failed(sourceText("error.provider.noModel"));
      const efforts = model.supportedReasoningEfforts;
      const effort =
        isReasoningEffort(settings.effort) && efforts.includes(settings.effort)
          ? settings.effort
          : (AGENT_REASONING_EFFORTS.find((candidate) => efforts.includes(candidate)) ?? model.defaultReasoningEffort);
      return yield* this.#gateGenerations.generate(
        provider,
        { ...model, defaultReasoningEffort: effort },
        prompt,
        generation,
        observer(this.#store.database.usage, provider, model.id, agentId),
      );
    });
  }

  /**
   * One toolless answer of the workspace gate model (the cheap one, such as Claude Haiku), as the
   * reply condenser asks it. The daily briefing writes its message with it; its usage counts under
   * the Workflows row.
   */
  /** The plan limit that holds an agent's work now, or null. */
  usageLimitFor(agentId: string): { resetsAt: number | null } | null {
    return this.#usageLimits.limitFor(agentId);
  }

  generateCheapText(prompt: string, deadline: number) {
    const gate = this.#workspaceSettings().gate;
    return this.#generateGateText(gate, WORKFLOWS_USAGE_ID, prompt, { pool: 1, deadline }, gateUsageObserver);
  }

  /**
   * The reply condenser (`reply-condenser.ts`): an answer that people read, long or shaped like a
   * report, is rewritten on the workspace gate model after its turn ended, and the message keeps the
   * agent's own text. Not an answer to an agent that waits for it, nor one in a channel to anything
   * but a person's message. The original shows until the rewrite is there; a rewrite that fails or
   * comes too late leaves it.
   */
  #condenseLater(answer: FinishedAnswer): void {
    // The turn has ended already: nothing here may fail its completion.
    try {
      this.#startCondense(answer);
    } catch (cause) {
      logger.warn("Could not condense an agent answer.", { agentId: answer.agentId, cause });
    }
  }

  #startCondense(answer: FinishedAnswer): void {
    if (this.#stopping) return;
    const workspace = this.#workspaceSettings();
    const settings = workspace.condense ?? DEFAULT_WORKSPACE_CONDENSE;
    if (!settings.enabled) return;
    let personMessage: string | undefined;
    if (answer.channel) {
      const request = this.channels?.personRequestForTurn(answer.threadId, answer.turnId);
      if (!request) return;
      personMessage = request.text;
    } else {
      // The answer goes back to a teammate that asked for it: talk between agents stays whole.
      if (answer.senders.some((sender) => sender.kind === "agent" && sender.expectsReply)) return;
      personMessage = answer.senders.findLast((sender) => sender.kind === "user")?.text;
    }
    const snapshot = this.#conversation.ensureSnapshot(answer.agentId, answer.threadId);
    const message =
      snapshot.threadId === answer.threadId
        ? snapshot.messages.find((candidate) => candidate.id === answer.messageId)
        : undefined;
    if (!message || message.condensed || message.questionPrompt || message.uiBlock) return;
    const original = message.text;
    const gate = workspace.gate;
    const model: CondenseModel = {
      label: `${gate.provider}/${gate.model}`,
      generate: (prompt, deadline) =>
        this.#generateGateText(gate, answer.agentId, prompt, { pool: 1, deadline }, condenseUsageObserver),
    };
    const started = Date.now();
    Effect.runFork(
      condenseAnswer(
        {
          text: original,
          writer: this.#store.list().find((agent) => agent.id === answer.agentId)?.name,
          ...(personMessage ? { personMessage } : {}),
        },
        settings,
        model,
      ).pipe(
        Effect.flatMap((result) =>
          Effect.gen({ self: this }, function* () {
            if (result.kind === "skipped") return;
            logger.info("The reply condenser finished.", {
              agentId: answer.agentId,
              outcome: result.kind === "condensed" ? "condensed" : result.reason,
              model: model.label,
              ms: Date.now() - started,
              originalLength: original.length,
              ...(result.kind === "condensed" ? { condensedLength: result.text.length } : {}),
            });
            if (result.kind === "condensed") yield* this.#applyCondensed(answer, original, result.text);
          }),
        ),
        Effect.catchCause((cause) =>
          Effect.sync(() => logger.warn("Could not condense an agent answer.", { agentId: answer.agentId, cause })),
        ),
        Effect.forkIn(this.#scope, { startImmediately: true }),
      ),
    );
  }

  /**
   * Puts a condensed answer in place of the original, which stays on the message. Nothing when the
   * message changed meanwhile, such as an edit, or left the snapshot. The agent's preview follows when
   * it still shows this answer.
   */
  #applyCondensed(answer: FinishedAnswer, original: string, text: string) {
    return Effect.gen({ self: this }, function* () {
      if (this.#stopping) return;
      const snapshot = this.#conversation.ensureSnapshot(answer.agentId, answer.threadId);
      if (snapshot.threadId !== answer.threadId) return;
      const message = snapshot.messages.find((candidate) => candidate.id === answer.messageId);
      if (!message || message.text !== original || message.condensed) return;
      message.text = text;
      message.condensed = { original: original.slice(0, CONDENSED_ORIGINAL_LIMIT) };
      this.#conversation.emitReplacedMessage(snapshot, message.id, "conversation.message-condensed");
      if (answer.channel) return;
      const agent = this.#store.list().find((item) => item.id === answer.agentId);
      if (agent && agent.preview === original.slice(0, agent.preview.length) && agent.preview.length > 0) {
        yield* this.#store.updatePreview(answer.agentId, text).pipe(Effect.ignore);
        this.#emit({ type: "agents-changed", agents: this.listAgents() });
      }
    });
  }

  /** What an agent does now, for the channel answer gate: its own chat's running turn and its open tasks. */
  #gateActivity(agentId: string): string[] {
    const lines: string[] = [];
    const working = this.#conversation.workingSnapshot(agentId);
    if (working?.activeTurnId) {
      const request = working.messages.findLast((message) => message.author === "user")?.text.trim();
      lines.push(request ? `working in its own chat on: ${request.slice(0, 200)}` : "working in its own chat");
    }
    for (const task of this.#tasks.snapshot(agentId).tasks)
      if (task.state !== "closed" && lines.length < 6)
        lines.push(`${task.state === "running" ? "running" : "open"} task: ${task.title}`);
    return lines;
  }

  saveProfile(
    input: SaveAgentProfileInput,
    sidebar: Pick<SidebarLayoutStore, "getSnapshot" | "withProfileAssignment">,
    sender?: ConversationMessageSender,
  ): Effect.Effect<SaveAgentProfileResult, AgentLifecycleFailed> {
    return this.#profileSave
      .save(input, sidebar, sender)
      .pipe(Effect.mapError((failure) => new AgentLifecycleFailed({ operation: "saveProfile", cause: failure.cause })));
  }

  preferredProvider(): AgentProvider {
    return this.#providers.preferredProvider();
  }

  /**
   * The provider that `createAgent` or `createAgentProfile` puts a new agent on: the one of the model
   * or provider that `input` names, else the starting choice. `null` when nothing lists a model, and
   * the record keeps the built-in default.
   */
  newAgentProvider(input: Pick<CreateAgentInput, "provider" | "model"> = {}): AgentProvider | null {
    return (
      (creationModel(input, this.#endpoints.available(), this.#providers.status().providers) ?? this.#startingChoice())
        ?.provider ?? null
    );
  }

  /** The provider and model setup or Settings recorded. */
  #preference(): ProviderPreference {
    return { provider: this.#providers.preferredProvider(), model: this.#providers.preferredModel() };
  }

  /**
   * `sender` is the person who writes the first message, as `sendMessage` takes it. `creatorAgentId`
   * names the agent that creates this one through a tool: the first task then comes from that agent,
   * as a request that expects a result, and not from the person.
   */

  readonly createAgent = Effect.fn("AgentService.createAgent")(function* (
    this: AgentService,
    input: CreateAgentInput,
    configure?: (agent: AgentSummary) => Effect.Effect<AgentSummary, AgentLifecycleFailed>,
    profileOperationId?: string,
    sender?: ConversationMessageSender,
    creatorAgentId?: string,
  ) {
    const initialMessage = yield* lifecycleStep("validate initial message", () => {
      const text = input.initialMessage.trim();
      if (!text) throw new Error(sourceText("error.agent.initialMessageRequired"));
      if (input.initialMessage.length > INPUT_LIMITS.messageText)
        throw new Error(sourceText("error.agent.initialMessageTooLong"));
      return text;
    });
    let agent = yield* this.#store
      .createAgent(input, profileOperationId)
      .pipe(
        Effect.mapError((failure) => new AgentLifecycleFailed({ operation: "create agent", cause: failure.cause })),
      );
    // Before the first turn, which starts in this space. An agent never makes one in another space.
    const spaceId = creatorAgentId ? this.#store.spaces.agentSpaceId(creatorAgentId) : input.spaceId;
    if (spaceId !== undefined) this.spaces.place("agent", agent.id, spaceId);
    const result = yield* Effect.result(
      Effect.gen({ self: this }, function* () {
        yield* this.#prepareAgentWorkspace(agent);
        agent = yield* this.#assignNewAgentModel(agent, input, true);
        if (configure) agent = yield* configure(agent);
        const firstTask = { agentId: agent.id, text: initialMessage, attachmentDraftIds: [] };
        if (creatorAgentId) yield* this.#sendUserMessage(firstTask, undefined, undefined, undefined, creatorAgentId);
        else yield* this.sendMessage(firstTask, sender);
        return this.#store.list().find((candidate) => candidate.id === agent.id) ?? agent;
      }).pipe(
        Effect.catchDefect((cause) => Effect.fail(new AgentLifecycleFailed({ operation: "create agent", cause }))),
      ),
    );
    if (Result.isSuccess(result)) return result.success;
    const rollback = yield* Effect.result(this.#removal.deleteData(agent));
    this.#emit({ type: "agents-changed", agents: this.listAgents() });
    return yield* new AgentLifecycleFailed({
      operation: "create agent",
      cause: Result.isFailure(rollback)
        ? new AggregateError(
            [result.failure.cause, rollback.failure.cause],
            sourceText("error.agent.setupCleanupFailed"),
          )
        : result.failure.cause,
    });
  }, Effect.uninterruptible).bind(this);

  #assignNewAgentModel(agent: AgentSummary, input: Omit<CreateAgentInput, "initialMessage">, needsModel: boolean) {
    return this.#endpoints
      .runExclusive(() =>
        Effect.gen({ self: this }, function* () {
          const requested = yield* lifecycleStep("select requested model", () =>
            creationModel(input, this.#endpoints.available(), this.#providers.status().providers),
          );
          if (requested) {
            yield* lifecycleStep("check provider switch", () => this.#providers.requireProviderOn(requested.provider));
            // The new-agent form names the development default's model but no effort, so the effort
            // comes from that default, as it does for an agent that names no model.
            const development = developmentStartingModel({
              enabled: developmentDefaultsApply(this.#preference(), this.#developmentDefaults),
              models: [requested.model],
              providerAvailable: () => true,
            });
            return yield* this.#store.updateAgent({
              agentId: agent.id,
              provider: requested.provider,
              model: requested.model.id,
              reasoningEffort:
                input.reasoningEffort && requested.model.supportedReasoningEfforts.includes(input.reasoningEffort)
                  ? input.reasoningEffort
                  : (development?.model ?? requested.model).defaultReasoningEffort,
            });
          }
          const starting = this.#startingChoice();
          if (starting) return yield* this.#landOnStartingChoice(agent, starting);
          yield* lifecycleStep("check starting model", () => {
            this.#providers.requireProviderOn(agent.provider);
            if (needsModel)
              throw new Error(
                sourceText("error.agent.noStartingModelInSettings", {
                  provider: providerLabel(this.#preference().provider),
                }),
              );
          });
          return agent;
        }),
      )
      .pipe(
        Effect.mapError(
          (failure) => new AgentLifecycleFailed({ operation: "assignNewAgentModel", cause: failure.cause }),
        ),
      );
  }

  /** Where a new agent that names no model starts: the saved choice, else its provider default (Luna 6 for ChatGPT). */
  #startingChoice(): ModelChoice | null {
    return startingChoice(this.#endpoints.available(), this.#preference(), {
      developmentDefaults: this.#developmentDefaults,
      providerAvailable: (provider) => this.#providerAvailable(provider),
    });
  }

  /**
   * Moves a new record onto `starting`. A new record starts on the built-in default provider, so this
   * is the one place a preferred provider lands on a new agent -- and with it the model setup chose,
   * which is how a custom endpoint becomes the default: it is a model of the CLI that runs it, never a
   * provider. A record already on the chosen model keeps its effort, which is the low one a new agent
   * leads with rather than the one the CLI reports.
   */
  readonly #landOnStartingChoice = Effect.fn("AgentService.landOnStartingChoice")(function* (
    this: AgentService,
    agent: AgentSummary,
    starting: ModelChoice,
  ) {
    if (starting.provider === agent.provider && starting.model.id === agent.model) return agent;
    return yield* this.#store
      .updateAgent({
        agentId: agent.id,
        provider: starting.provider,
        model: starting.model.id,
        reasoningEffort: starting.model.defaultReasoningEffort,
      })
      .pipe(
        Effect.mapError(
          (failure) => new AgentLifecycleFailed({ operation: "set starting model", cause: failure.cause }),
        ),
      );
  });

  readonly createAgentProfile = Effect.fn("AgentService.createAgentProfile")(function* (
    this: AgentService,
    input: Omit<CreateAgentInput, "initialMessage"> & { title?: string },
  ) {
    let agent = yield* this.#store
      .createAgent(input)
      .pipe(
        Effect.mapError(
          (failure) => new AgentLifecycleFailed({ operation: "create agent profile", cause: failure.cause }),
        ),
      );
    const result = yield* Effect.result(
      Effect.gen({ self: this }, function* () {
        yield* this.#prepareAgentWorkspace(agent).pipe(
          Effect.mapError(
            (failure) => new AgentLifecycleFailed({ operation: "prepare agent workspace", cause: failure.cause }),
          ),
        );
        agent = yield* this.#assignNewAgentModel(agent, input, false);
        if (input.title)
          agent = yield* this.#store
            .updateAgent({ agentId: agent.id, title: input.title })
            .pipe(
              Effect.mapError(
                (failure) => new AgentLifecycleFailed({ operation: "set profile title", cause: failure.cause }),
              ),
            );
        this.#emit({ type: "agents-changed", agents: this.listAgents() });
        return agent;
      }).pipe(
        Effect.catchDefect((cause) =>
          Effect.fail(new AgentLifecycleFailed({ operation: "create agent profile", cause })),
        ),
      ),
    );
    if (Result.isSuccess(result)) return result.success;
    yield* this.#removal
      .deleteData(agent)
      .pipe(
        Effect.mapError(
          (failure) => new AgentLifecycleFailed({ operation: "rollback agent profile", cause: failure.cause }),
        ),
      );
    return yield* result.failure;
  }, Effect.uninterruptible).bind(this);

  committedAgentDuplication(operationId: string, sourceAgentId: string): DuplicateAgentResult | null {
    return this.#store.committedAgentDuplication(operationId, sourceAgentId);
  }

  duplicateAgent(
    sourceAgentId: string,
    operationId: string = randomUUID(),
  ): Effect.Effect<AgentSummary, AgentLifecycleFailed> {
    return this.#duplication.duplicate(sourceAgentId, operationId).pipe(
      // The copy starts in the space of its source.
      Effect.tap((agent) =>
        Effect.sync(() => this.spaces.place("agent", agent.id, this.#store.spaces.agentSpaceId(sourceAgentId))),
      ),
      Effect.mapError((failure) => new AgentLifecycleFailed({ operation: "duplicateAgent", cause: failure.cause })),
    );
  }

  commitAgentDuplication(
    agentId: string,
    layout: SidebarLayoutSnapshot,
  ): Effect.Effect<DuplicateAgentResult, AgentLifecycleFailed> {
    return this.#duplication
      .commit(agentId, layout)
      .pipe(
        Effect.mapError(
          (failure) => new AgentLifecycleFailed({ operation: "commitAgentDuplication", cause: failure.cause }),
        ),
      );
  }

  /** The agents a user hid, oldest hide first. */
  listHiddenAgents(): HiddenAgentsSnapshot {
    return {
      agents: this.listAgents()
        .flatMap((agent) => (agent.hiddenAt === undefined ? [] : [{ agentId: agent.id, hiddenAt: agent.hiddenAt }]))
        .sort(
          (left, right) => left.hiddenAt.localeCompare(right.hiddenAt) || left.agentId.localeCompare(right.agentId),
        ),
    };
  }

  #sleepingAgentIds(): string[] {
    return this.#store
      .list()
      .filter((agent) => agent.sleepingSince !== undefined)
      .map((agent) => agent.id);
  }

  /** The agents that a sleep request names: one agent, a lead and every agent under it, or a space. */
  sleepTargetAgentIds(target: SleepTarget): string[] {
    const agents = this.#store.list();
    if (target.kind === "space")
      return agents.filter((agent) => this.#store.spaces.agentSpaceId(agent.id) === target.id).map((agent) => agent.id);
    if (!agents.some((agent) => agent.id === target.id))
      throw new Error(sourceText("error.agent.unknown", { id: target.id }));
    if (target.kind === "agent") return [target.id];
    const space = agents.filter((agent) => this.#store.spaces.sameSpace(target.id, agent.id));
    const managers = agentManagers(space);
    return teamAgentIds(
      target.id,
      space.map((agent) => agent.id),
      (agentId) => managers.get(agentId) ?? null,
    );
  }

  /**
   * Puts agents to sleep or wakes them. A sleeping agent keeps all of its data and finishes the turn
   * that runs; no routine, event check, channel task or message starts a turn of it, so it costs
   * nothing. Messages to it wait in its queue. On wake, the routine occurrences that came due while it
   * slept are skipped, and its queue drains again.
   */
  readonly setAgentsSleeping = Effect.fn("AgentService.setAgentsSleeping")(function* (
    this: AgentService,
    input: SetAgentsSleepingInput,
  ) {
    const changed = yield* lifecycleStep("set agents sleeping", () => {
      const ids = this.sleepTargetAgentIds(input.target);
      const now = new Date();
      // While the agents still sleep, so the timer cannot fire an occurrence that this skips.
      if (!input.sleeping) for (const id of ids) if (this.#store.isSleeping(id)) this.#routines.skipMissedFor(id, now);
      return this.#store.setSleeping(ids, input.sleeping ? now.toISOString() : null);
    });
    if (changed.length > 0) {
      this.#routines.arm();
      for (const agentId of changed) {
        if (input.sleeping) {
          // The channel work that waits in its queue goes back to the channel, so it holds nothing.
          yield* this.channels
            .releaseAgent(agentId)
            .pipe(
              Effect.catch((failure) =>
                Effect.sync(() => this.#emitError("channel_coordination_failed", failure.cause)),
              ),
            );
        } else {
          this.#mailboxSync.emitQueue(agentId);
          this.#drain.scheduleDrain(agentId);
        }
      }
      this.#emit({ type: "agents-changed", agents: this.listAgents() });
    }
    return { changedAgentIds: changed, sleepingAgentIds: this.#sleepingAgentIds() };
  }).bind(this);

  #hiddenAgentIds(): string[] {
    return this.#store
      .list()
      .filter((agent) => agent.hiddenAt !== undefined)
      .map((agent) => agent.id);
  }

  /**
   * Hides or restores an agent. A request that does not change the state answers the same list. A
   * hidden agent keeps all of its data. A turn that runs finishes, and its queued messages wait. On
   * restore, the routine occurrences that came due while it was hidden are skipped, and its queue
   * drains again.
   */
  readonly setAgentHidden = Effect.fn("AgentService.setAgentHidden")(function* (
    this: AgentService,
    input: SetAgentHiddenInput,
  ) {
    const changed = yield* lifecycleStep("set agent hidden", () => {
      if (!this.listAgents().some((agent) => agent.id === input.agentId)) {
        throw new Error(sourceText("error.agent.unknown", { id: input.agentId }));
      }
      if (this.#store.isHidden(input.agentId) === input.hidden) return false;
      const now = new Date();
      // While the agent is still hidden, so the timer cannot fire an occurrence that this skips.
      if (!input.hidden) this.#routines.skipMissedFor(input.agentId, now);
      this.#store.setHidden(input.agentId, input.hidden ? now.toISOString() : null);
      return true;
    });
    const snapshot = this.listHiddenAgents();
    if (!changed) return snapshot;
    this.#routines.arm();
    if (input.hidden) {
      // The channel work that waits in its queue goes back to the channel, so it holds nothing.
      yield* this.channels
        .releaseAgent(input.agentId)
        .pipe(
          Effect.catch((failure) => Effect.sync(() => this.#emitError("channel_coordination_failed", failure.cause))),
        );
    } else {
      // The queue event also wakes the channels whose task waits for this agent.
      this.#mailboxSync.emitQueue(input.agentId);
      this.#drain.scheduleDrain(input.agentId);
    }
    this.#emit({ type: "hidden-agents-changed", agents: snapshot.agents });
    this.#emit({ type: "agents-changed", agents: this.listAgents() });
    return snapshot;
  }).bind(this);

  /** The agent asked for the large model for its next turn. Only an agent on the automatic policy has one. */
  escalateModel(agentId: string): boolean {
    const agent = this.#store.list().find((candidate) => candidate.id === agentId);
    if (agent?.modelPolicy !== "auto") return false;
    this.#modelPolicy.escalate(agentId);
    return true;
  }

  /** What the automatic model policy did in the last week. */
  modelSavings(): ModelSavingsSnapshot {
    return {
      ...modelSavings(this.#store.database.connection, this.#store.list()),
      warmSwitches: this.#modelPolicy.warmSwitches(),
    };
  }

  /** The model that the automatic policy chose for a running turn, and why, or null. */
  turnModelChoice(turnId: string) {
    return this.#modelPolicy.running(turnId);
  }

  /** Refuses new work for a hidden agent. A turn that already runs is not affected. */
  #requireNotHidden(agentId: string): void {
    if (this.#store.isHidden(agentId)) throw new Error(sourceText("error.backend.recipientHidden"));
  }

  setMarketplaceSource(agentId: string, source: NonNullable<AgentSummary["marketplaceSource"]>): AgentSummary {
    const agent = this.#store.setMarketplaceSource(agentId, source);
    this.#emit({ type: "agents-changed", agents: this.listAgents() });
    return agent;
  }

  readAgentSessionSettings(agentId: string): Effect.Effect<AgentSessionSettings, AgentLifecycleFailed> {
    return this.#sessionSettings
      .read(agentId)
      .pipe(
        Effect.mapError(
          (failure) => new AgentLifecycleFailed({ operation: "read session settings", cause: failure.cause }),
        ),
      );
  }

  setAgentSessionSetting(
    input: SetAgentSessionSettingInput,
  ): Effect.Effect<AgentSessionSettings, AgentLifecycleFailed> {
    return this.#sessionSettings
      .set(input)
      .pipe(
        Effect.mapError(
          (failure) => new AgentLifecycleFailed({ operation: "set session setting", cause: failure.cause }),
        ),
      );
  }

  resetAgentSessionSetting(
    input: ResetAgentSessionSettingInput,
  ): Effect.Effect<AgentSessionSettings, AgentLifecycleFailed> {
    return this.#sessionSettings
      .reset(input)
      .pipe(
        Effect.mapError(
          (failure) => new AgentLifecycleFailed({ operation: "reset session setting", cause: failure.cause }),
        ),
      );
  }

  /**
   * `initiatingAgentId` is set when an agent, not the user, asks for the change. `queueWhileBusy`
   * is false for a Team API client: its released protocol has no `pendingRuntime`, so a provider
   * change during work is refused for it as before.
   */
  updateAgent(
    input: AgentUpdate,
    initiatingAgentId?: string,
    queueWhileBusy = true,
    history: { author?: SettingsAuthor; rollbackOf?: string } = {},
  ): Effect.Effect<AgentSummary, AgentLifecycleFailed> {
    return this.#endpoints
      .runExclusive(() =>
        Effect.suspend(() => {
          const before = this.#store.list().find((agent) => agent.id === input.agentId);
          return this.#applyAgentUpdate(input, initiatingAgentId, null, queueWhileBusy).pipe(
            Effect.tap((after) => {
              if (!before) return Effect.void;
              const author: SettingsAuthor =
                history.author ??
                (initiatingAgentId ? { kind: "agent", agentId: initiatingAgentId } : { kind: "owner" });
              return this.settingsHistory.record(
                after.id,
                author,
                snapshotChanges(settingsSnapshot(before), settingsSnapshot(after)),
                history.rollbackOf,
              );
            }),
          );
        }),
      )
      .pipe(Effect.mapError((failure) => new AgentLifecycleFailed({ operation: "updateAgent", cause: failure.cause })));
  }

  /**
   * `move` is "return" for the move back to the model a usage limit or a provider error made the
   * agent leave, "provider-error" for the move away from a model that failed a turn, and "next-turn"
   * for a queued `pendingRuntime` that applies before the next turn. `queueWhileBusy` is set for a
   * change that a user or an agent asks for: while work runs, a handover is stored as
   * `pendingRuntime` instead of refused.
   */
  readonly #applyAgentUpdate = Effect.fn("AgentService.updateAgent")(function* (
    this: AgentService,
    input: AgentUpdate,
    initiatingAgentId?: string,
    move: ModelMove | null = null,
    queueWhileBusy = false,
  ) {
    const returning = move === "return";
    const failingOver = move === "provider-error";
    // The guardrails move an agent off a subscription pool that nearly ran out, and back after it.
    const poolFailover = move === "pool-failover";
    const handedOverThreads = (previous: AgentSummary) => [
      ...(previous.threadId ? [previous.threadId] : []),
      ...this.#tasks.threadIdsForAgent(previous.id),
      ...this.channels.store.contextThreadsForAgent(previous.id),
    ];
    // A provider change waits until the agent has no work. It is checked again after the reads below.
    // The text of the refusal, or null when the agent is idle.
    const idleRefusal = (previous: AgentSummary) => {
      // A spent plan holds the queue until it resets, and a switch to another provider is the way out
      // of that hold. So while the hold lasts, only started work blocks the switch; the queue then
      // runs on the new provider. The move back after the limit takes the queue with it too, and so
      // does the move away from a model that failed: the failed turn's messages wait in the queue.
      // A queued change applies before the next queued message starts, so it takes the queue too.
      const hasPendingWork =
        move === null && this.#usageLimits.mayDrain(input.agentId)
          ? this.#mailbox.hasUnfinishedDelivery(input.agentId)
          : this.#mailbox.hasStartedDelivery(input.agentId);
      const activeTurn =
        this.#conversation.anyWorkingSnapshot(input.agentId)?.activeTurnId ??
        (previous.threadId ? this.#store.database.readActiveTurnId(input.agentId, previous.threadId) : null);
      if (this.#conversation.workingTaskSnapshots(input.agentId).length > 0)
        return sourceText("error.agent.waitForTasksBeforeProviderChange");
      if (hasPendingWork || activeTurn) return sourceText("error.agent.waitBeforeProviderChange");
      return null;
    };
    const requireIdle = (previous: AgentSummary) => {
      const refusal = idleRefusal(previous);
      if (refusal !== null) throw new AgentSettingsRefused(refusal);
    };
    const { previous, requestedModel, requestedProvider, previousAccount, requestedAccount } = yield* lifecycleStep(
      "validate agent update",
      () => {
        this.#conversation.requireKnownAgent(input.agentId);
        const previous = this.#store.list().find((agent) => agent.id === input.agentId);
        const requestedModel = input.model
          ? this.#endpoints
              .available()
              .find((model) => model.id === input.model && (!input.provider || model.provider === input.provider))
          : undefined;
        if (input.model && !requestedModel) {
          // A change of model alone stays on the agent's provider, so that provider is the one to explain.
          const provider = input.provider ?? (previous ? providerForAgent(previous) : undefined);
          throw new AgentSettingsRefused(
            modelUnavailableError(
              input.model,
              provider,
              this.#endpoints.available(),
              this.#providers.status().providers ?? [],
            ).message,
          );
        }
        const requestedProvider = input.provider ?? requestedModel?.provider ?? previous?.provider;
        if (input.provider && requestedModel && requestedModel.provider !== input.provider) {
          throw new AgentSettingsRefused(sourceText("error.agent.modelProviderMismatch"));
        }
        if (requestedProvider && previous && requestedProvider !== providerForAgent(previous)) {
          if (!input.model || !input.provider) {
            throw new Error("Changing provider requires an atomic provider and model selection.");
          }
          // A change that a user or an agent asks for while work runs is queued below. Automatic moves wait.
          if (!queueWhileBusy) requireIdle(previous);
        }
        // An account belongs to one provider, so a provider change without one returns the agent to
        // the new provider's own sign-in.
        const previousAccount = previous ? agentProviderAccount(previous) : null;
        const requestedAccount =
          input.providerAccountId !== undefined
            ? agentProviderAccount({ providerAccountId: input.providerAccountId ?? undefined })
            : previous && requestedProvider !== providerForAgent(previous)
              ? null
              : previousAccount;
        // Only a requested account is checked: an agent whose account record is lost (a damaged or
        // newer store) can still be renamed or moved to another account.
        if (
          requestedAccount &&
          input.providerAccountId !== undefined &&
          (!requestedProvider || !this.#providers.hasProviderAccount(requestedProvider, requestedAccount))
        )
          throw new AgentSettingsRefused(
            sourceText("error.provider.accountNotFound", {
              provider: requestedProvider ? providerLabel(requestedProvider) : "",
            }),
          );
        // The sessions of one account are not in the folder of another, so an account change is
        // handed over like a provider change. A requested change while work runs is queued below.
        if (previous && requestedAccount !== previousAccount && !queueWhileBusy) requireIdle(previous);
        return { previous, requestedModel, requestedProvider, previousAccount, requestedAccount };
      },
    );
    const accountChanged = previous !== undefined && requestedAccount !== previousAccount;
    const nextModelId = requestedModel?.id ?? previous?.model;
    const customAgentChanged = Boolean(
      previous &&
        requestedProvider === "acp" &&
        providerForAgent(previous) === "acp" &&
        nextModelId !== undefined &&
        customAgentIdOfModel(nextModelId) !== customAgentIdOfModel(previous.model),
    );
    const handoverNeeded = Boolean(
      previous &&
        requestedProvider &&
        (requestedProvider !== providerForAgent(previous) || accountChanged || customAgentChanged),
    );
    const runtimeFields =
      input.provider !== undefined ||
      input.model !== undefined ||
      input.reasoningEffort !== undefined ||
      input.providerAccountId !== undefined;
    // Only an update of the runtime alone waits for the next turn. An update with other fields is
    // refused while work runs, as before, and so is a move to a backup model: `pendingRuntime` does
    // not keep the model to go back to.
    const queueable =
      queueWhileBusy &&
      previous !== undefined &&
      !input.leaveUsageLimit &&
      Object.keys(input).every((key) => RUNTIME_UPDATE_KEYS.has(key));
    const pinnedAccountId = this.#accountPin(
      input,
      move,
      initiatingAgentId,
      previous && requestedProvider
        ? {
            provider: requestedProvider,
            model: requestedModel?.id ?? previous.model,
            ...(requestedAccount ? { providerAccountId: requestedAccount } : {}),
          }
        : undefined,
    );
    const pin = pinnedAccountId === undefined ? {} : { pinnedAccountId };
    const queue = (pendingRuntime: AgentPendingRuntime) =>
      this.#store.updateAgent({ agentId: input.agentId, pendingRuntime, ...pin }, initiatingAgentId).pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            this.#emit({ type: "agents-changed", agents: this.listAgents() });
            this.#drain.scheduleDrain(input.agentId);
          }),
        ),
      );
    // An effort that the queued model does not support becomes the model's default.
    const queuedEffort = (effort: AgentReasoningEffort, model = requestedModel) =>
      model && !model.supportedReasoningEfforts.includes(effort) ? model.defaultReasoningEffort : effort;
    if (queueable && previous && requestedProvider && runtimeFields && handoverNeeded && idleRefusal(previous)) {
      yield* this.#providers.ensureProvider(requestedProvider);
      if (input.provider || input.model)
        yield* lifecycleStep("check provider switch", () => this.#providers.requireProviderOn(requestedProvider));
      return yield* queue({
        provider: requestedProvider,
        model: requestedModel?.id ?? previous.model,
        reasoningEffort: queuedEffort(
          input.reasoningEffort ?? previous.pendingRuntime?.reasoningEffort ?? previous.reasoningEffort,
        ),
        ...(requestedAccount ? { providerAccountId: requestedAccount } : {}),
      });
    }
    // An effort change while a queued change waits edits the queued change, also when a hold keeps
    // the change from applying on an idle agent: the pickers show the queued runtime. So does a model
    // change of the same provider when the queued change keeps the provider (an account or a custom
    // agent). A model of another provider names the provider, and is queued or applied above or below.
    const queued = previous?.pendingRuntime;
    if (
      queueable &&
      queued &&
      !handoverNeeded &&
      input.provider === undefined &&
      input.providerAccountId === undefined &&
      (requestedModel ? requestedModel.provider === queued.provider : input.reasoningEffort !== undefined)
    ) {
      const queuedModel =
        requestedModel ??
        this.#endpoints.available().find((model) => model.provider === queued.provider && model.id === queued.model);
      return yield* queue({
        ...queued,
        ...(requestedModel ? { model: requestedModel.id } : {}),
        reasoningEffort: queuedEffort(input.reasoningEffort ?? queued.reasoningEffort, queuedModel),
      });
    }
    const wasHeld = !this.#usageLimits.mayDrain(input.agentId);
    const captures: Array<readonly [ProviderSession, string]> = [];
    if (handoverNeeded && requestedProvider && previous) {
      yield* this.#providers.ensureProvider(requestedProvider);
      // Before the sessions are retired below, while the previous provider still holds them. The
      // steps are saved only once the switch is stored: a switch that fails keeps the session.
      // A task is a conversation of the agent, so it moves to the new provider with the agent's chat.
      const sessions = yield* lifecycleStep("read provider sessions", () =>
        handedOverThreads(previous).flatMap((threadId) => this.#store.database.listProviderSessions(threadId)),
      );
      for (const session of sessions.filter((one) => one.state === "active")) {
        const steps = yield* this.#threads.readWorkSteps(session);
        if (steps !== null) captures.push([session, steps]);
      }
      // The reads and the provider start take time, and a message sent in it can start a turn.
      yield* lifecycleStep("validate agent update", () => requireIdle(previous));
    }
    if (requestedProvider && (input.provider || input.model))
      yield* lifecycleStep("check provider switch", () => this.#providers.requireProviderOn(requestedProvider));
    // Leaving a model at its usage limit or after a provider error keeps the model to go back to:
    // the first one left, when the agent moves on from one backup to the next.
    const previousChoice = previous ? agentModelChoice(previous) : undefined;
    const nextChoice: AgentModelChoice | undefined =
      previous && requestedProvider
        ? {
            provider: requestedProvider,
            model: requestedModel?.id ?? previous.model,
            ...(requestedAccount ? { providerAccountId: requestedAccount } : {}),
          }
        : undefined;
    const moved = previousChoice && nextChoice && !sameAgentModelChoice(previousChoice, nextChoice);
    const leaving = Boolean(moved && input.leaveUsageLimit && (wasHeld || failingOver || poolFailover));
    const returnTo =
      leaving && previous && previousChoice
        ? (previous.usageLimitReturn ?? {
            ...previousChoice,
            reasoningEffort: previous.reasoningEffort,
            ...(failingOver ? { cause: "provider-error" as const } : {}),
          })
        : undefined;
    const usageLimitReturn =
      returning || (returnTo && nextChoice && sameAgentModelChoice(returnTo, nextChoice)) ? null : returnTo;
    const agent = yield* this.#store.updateAgent(
      {
        ...input,
        ...(requestedModel && !input.provider ? { provider: requestedModel.provider } : {}),
        ...(previous && (accountChanged || input.providerAccountId !== undefined)
          ? { providerAccountId: requestedAccount }
          : {}),
        ...(usageLimitReturn !== undefined ? { usageLimitReturn } : {}),
        // A Team API client cannot see the queued change, so only a handover from it ends the change.
        ...(runtimeFields && (queueWhileBusy || handoverNeeded) ? { pendingRuntime: null } : {}),
        ...pin,
      },
      initiatingAgentId,
    );
    // A tab keeps the session it opened in, so the agent's next tab opens in the session it chose now.
    if (previous && !sameAgentBrowserProfile(agentBrowserProfile(previous), agentBrowserProfile(agent)))
      yield* this.#removal.closeBrowserTabs(agent);
    if (moved && (leaving || returning))
      this.#appendModelSwitchMarker(
        agent,
        leaving
          ? failingOver
            ? "provider-error"
            : "usage-limit"
          : previous?.usageLimitReturn?.cause === "provider-error"
            ? "provider-error-ended"
            : "usage-limit-ended",
      );
    const profileChanged = standingProfileChanged(previous, agent, this.#store.agentDefaults());
    const activeSession = this.#store.activeProviderSession(agent.id);
    const providerChanged = handoverNeeded;
    if (previous && providerChanged) {
      // Retire first, with no wait after the update: a turn that starts while a file is written
      // binds a session of the new provider, and a later retirement would close that one too.
      for (const threadId of handedOverThreads(previous)) this.#store.database.deactivateProviderSessions(threadId);
      for (const [session, steps] of captures) yield* this.#threads.saveWorkSteps(session, steps);
    } else if (activeSession && (input.model || input.reasoningEffort)) {
      this.#store.database.updateProviderSessionConfig(
        activeSession.id,
        activeSession.threadId,
        agent.model,
        agent.reasoningEffort,
      );
    }
    // Re-resume before the next turn so the provider receives the updated standing instructions.
    // Codex keeps the ones a loaded session started with, so `ThreadLifecycle.ensureThread` replaces
    // that session instead - see `toolFingerprint`. The
    // agent chat is not the only session that holds them: a channel turn runs on a session of its
    // own, and it is written from the same profile.
    if (profileChanged) this.#conversation.unloadAgentThreads(agent.id);
    const privileged = (["access", "computerUse", "allowAutomation"] as const).filter(
      (field) => input[field] !== undefined,
    );
    if (privileged.length > 0) {
      const initiator = initiatingAgentId
        ? this.#store.list().find((item) => item.id === initiatingAgentId)
        : undefined;
      yield* this.#audit.record({
        actor: auditActor(
          initiatingAgentId
            ? { kind: "agent", agentId: initiatingAgentId, name: initiator?.name ?? initiatingAgentId }
            : LOCAL_USER_ACTOR,
        ),
        action: "agent.privilege-change",
        target: { kind: "agent", id: agent.id, name: agent.name },
        names: privileged,
      });
    }
    // A Workspace only agent moved to Full access gets no grant event, and its cards wait for that grant.
    if (previous && workspaceAccessEnforced(previous) && !workspaceAccessEnforced(agent))
      this.#attention.answerGrantedRequests();
    this.#emit({ type: "agents-changed", agents: this.listAgents() });
    // The task limit follows the agent's own setting and its provider. A higher one can start a task now.
    if (
      providerChanged ||
      (previous &&
        agentTaskLimit(previous, this.#defaultTaskLimit()) !== agentTaskLimit(agent, this.#defaultTaskLimit()))
    ) {
      this.#tasks.changed(agent.id);
      this.#drain.scheduleDrain(agent.id);
    }
    // A plan limit belongs to a provider and a model, so a model change can end a hold or start one.
    // Leaving a hold, nothing else would start the queue before the limit it left resets. Entering
    // one, the queue is settled as at any other start of a hold.
    const isHeld = !this.#usageLimits.mayDrain(agent.id);
    if (providerChanged || wasHeld !== isHeld) this.#emitRuntimeSnapshot();
    if (wasHeld && !isHeld) {
      this.#drain.scheduleDrain(agent.id);
      // A channel task that the hold gave back waits in its channel, not in this queue.
      yield* this.channels
        .wake()
        .pipe(
          Effect.catch((failure) =>
            Effect.sync(() => this.#emitError("usage_limit_release_failed", failure.cause, agent.id)),
          ),
        );
    } else if (!wasHeld && isHeld) {
      // Not awaited, as at any other start of a hold.
      yield* this.#settleHeldQueues([agent.id]).pipe(
        Effect.catch((failure) =>
          Effect.sync(() => this.#emitError("usage_limit_hold_failed", failure.cause, agent.id)),
        ),
        Effect.forkIn(this.#scope),
      );
    } else if (providerChanged && !isHeld) {
      // A hold that started during the switch let queued work through the second `requireIdle`, and
      // its release drains only the agents still on the spent model.
      this.#drain.scheduleDrain(agent.id);
    } else if (isHeld && input.backupModels !== undefined) {
      // New backup models can let the held queue move now, and the chat no longer asks.
      this.#drain.scheduleDrain(agent.id);
    }
    return agent;
  }, Effect.uninterruptible);

  /**
   * The model a usage limit or a provider error moves this agent to now, or null. An agent goes back
   * to the model it left once no limit or provider error holds that model. An agent held by a limit,
   * or whose model failed a turn with a provider error, set to switch without asking and with queued
   * work or channel work that waits for it, moves to its first backup model that is ready. Only an
   * agent with no started work moves; the end of its turn tries again.
   */
  #usageLimitMove(agentId: string): { input: UpdateAgentInput; move: ModelMove | null } | null {
    const agent = this.#store.list().find((candidate) => candidate.id === agentId);
    if (!agent) return null;
    // A pooled provider moves the agent to the account its pool picks before the next work starts.
    const pooled =
      this.#runsTurn(agentId) || this.#mailbox.hasStartedDelivery(agentId) || !this.#hasWaitingWork(agentId)
        ? null
        : this.#poolMove(agent);
    if (pooled)
      return {
        input: {
          agentId,
          provider: pooled.provider,
          model: pooled.model,
          providerAccountId: pooled.providerAccountId ?? null,
        },
        move: "next-turn",
      };
    // The guardrails' failover: a Claude agent whose subscription is out. Its turn failed with the
    // provider's usage limit, which holds its model now, or the meter shows its whole pool used up.
    const failover =
      !agent.usageLimitReturn && this.#hasWaitingWork(agentId)
        ? (this.#guardrails?.failoverChoice(agent, { limited: !this.#usageLimits.mayDrain(agentId) }) ?? null)
        : null;
    if (!agent.usageLimitReturn && !agent.backupModels?.automatic && !failover) return null;
    if (this.#runsTurn(agentId) || this.#mailbox.hasStartedDelivery(agentId)) return null;
    // The agent keeps its reasoning effort where the other model has it. It goes back with the effort it left.
    const move = (choice: AgentModelChoice, reasoningEffort = agent.reasoningEffort) => {
      const model = this.#endpoints
        .available()
        .find((option) => option.provider === choice.provider && option.id === choice.model);
      return {
        agentId,
        provider: choice.provider,
        model: choice.model,
        providerAccountId: choice.providerAccountId ?? null,
        reasoningEffort:
          model && !model.supportedReasoningEfforts.includes(reasoningEffort)
            ? model.defaultReasoningEffort
            : reasoningEffort,
      };
    };
    if (
      agent.usageLimitReturn &&
      this.#usageLimitReady(agent.usageLimitReturn) &&
      !this.#guardrails?.holdsReturn(agentId, agent.usageLimitReturn)
    )
      return { input: move(agent.usageLimitReturn, agent.usageLimitReturn.reasoningEffort), move: "return" };
    if (failover) return { input: { ...move(failover), leaveUsageLimit: true }, move: "pool-failover" };
    const limited = !this.#usageLimits.mayDrain(agentId);
    const failed = !limited && this.#usageLimits.isFailed(usageLimitOf(agentModelChoice(agent)));
    if (!limited && !failed) return null;
    // A channel task that the limit refused went back to its channel, so the queue can be empty.
    if (!this.#hasWaitingWork(agentId)) return null;
    const next = this.#usageLimitBackup(agentId, failed ? "error" : "limit");
    return next ? { input: { ...move(next), leaveUsageLimit: true }, move: failed ? "provider-error" : null } : null;
  }

  /** Whether work waits for the agent: in its chat, a task, or a channel. */
  #hasWaitingWork(agentId: string): boolean {
    return (
      Boolean(this.#mailbox.nextQueued(agentId)) ||
      this.#mailbox.queuedTaskIds(agentId).some((taskId) => this.#mailbox.nextQueued(agentId, taskId)) ||
      this.channels.ownsWaitingWork(agentId)
    );
  }

  /**
   * The account of a pooled provider that the agent moves to before its next work, or null when it
   * stays. The pick also shows as the pool's account in use.
   */
  #poolMove(agent: AgentSummary): AgentModelChoice | null {
    const choice = agentModelChoice(agent);
    if (!this.#pooled(choice) || this.#keepsPinnedAccount(agent)) return null;
    this.#readPoolWhenStale(choice.provider);
    const current = choice.providerAccountId ?? DEFAULT_PROVIDER_ACCOUNT_ID;
    const pick = this.#poolPick(choice.provider, choice.model, current);
    if (pick !== null) this.#providers.setPoolInUse(choice.provider, pick);
    if (pick === null || pick === current) return null;
    return {
      provider: choice.provider,
      model: choice.model,
      ...(pick === DEFAULT_PROVIDER_ACCOUNT_ID ? {} : { providerAccountId: pick }),
    };
  }

  /** Whether the agent's pooled provider has another account to move to now. */
  #poolBackup(agentId: string): boolean {
    const agent = this.#store.list().find((candidate) => candidate.id === agentId);
    if (!agent) return false;
    const choice = agentModelChoice(agent);
    if (!this.#pooled(choice) || this.#keepsPinnedAccount(agent)) return false;
    const current = choice.providerAccountId ?? DEFAULT_PROVIDER_ACCOUNT_ID;
    const pick = this.#poolPick(choice.provider, choice.model, current);
    return pick !== null && pick !== current;
  }

  /**
   * Whether the agent stays on the account that an agent chose for it: the agent is on it, and it is
   * ready for the model. A limit or a sign-out lets the pool move the agent, and the move ends the pin.
   */
  #keepsPinnedAccount(agent: AgentSummary): boolean {
    const choice = agentModelChoice(agent);
    return (
      agent.pinnedAccountId === (choice.providerAccountId ?? DEFAULT_PROVIDER_ACCOUNT_ID) &&
      this.#usageLimitReady(choice)
    );
  }

  /**
   * The pin of an update, or undefined to keep it. An agent that names an account of a pooled
   * provider pins it, also the provider's own sign-in as "default", and an agent that names null
   * gives the account back to the pool. A person's change of the provider, model or account in the
   * app, which shows the pool as one choice, ends the pin; a change of effort keeps it. Automatic
   * moves keep it too; the store ends it when the agent moves to another account.
   */
  #accountPin(
    input: AgentUpdate,
    move: ModelMove | null,
    initiatingAgentId: string | undefined,
    next: AgentModelChoice | undefined,
  ): string | null | undefined {
    if (move !== null || input.leaveUsageLimit) return undefined;
    if (initiatingAgentId === undefined)
      return input.provider !== undefined || input.model !== undefined || input.providerAccountId !== undefined
        ? null
        : undefined;
    if (input.providerAccountId === undefined) return undefined;
    if (!next || !this.#pooled(next)) return null;
    if (next.providerAccountId) return next.providerAccountId;
    return input.providerAccountId === DEFAULT_PROVIDER_ACCOUNT_ID ? DEFAULT_PROVIDER_ACCOUNT_ID : null;
  }

  /**
   * Whether the pool chooses the account of the agent. An agent that the user put on the Claude API
   * key stays on it: the key is not in the pool.
   */
  #pooled(choice: AgentModelChoice): boolean {
    if (choice.provider === "claude" && choice.providerAccountId === CLAUDE_API_KEY_ACCOUNT_ID) return false;
    return this.#providers.accountPool(choice.provider) !== null;
  }

  /**
   * The account that the provider's pool uses for the model now, or null. Only accounts that are
   * ready for the model and not at a limit or after a provider error count. With no model, as for a
   * pool that no agent uses yet, each account in the pool counts.
   */
  #poolPick(provider: AgentProvider, model: string | null, current: string | null): string | null {
    const members = this.#providers.poolMembers(provider, model ?? "").filter(
      (member) =>
        model === null ||
        this.#usageLimitReady({
          provider,
          model,
          ...(member.accountId === DEFAULT_PROVIDER_ACCOUNT_ID ? {} : { providerAccountId: member.accountId }),
        }),
    );
    return pickPoolAccount(members, current, Date.now() / 1000);
  }

  /** Shows the pool's pick for the model of the provider's first agent in the provider's row. */
  #refreshPoolInUse(provider: AgentProvider): void {
    const pool = this.#providers.accountPool(provider);
    if (!pool) return;
    const model = this.#store.list().find((agent) => agentModelChoice(agent).provider === provider)?.model ?? null;
    this.#providers.setPoolInUse(provider, this.#poolPick(provider, model, pool.inUse));
  }

  /**
   * Reads the usage of the pool's accounts again when the last read is older than the interval of
   * the rail. The work does not wait for the read: the buffer of each window covers a reading that is
   * some minutes old. When the read ends, the agents with work are checked again.
   */
  #readPoolWhenStale(provider: AgentProvider): void {
    const now = Date.now();
    if (this.#poolReading.has(provider) || now - (this.#poolReads.get(provider) ?? 0) < POOL_READ_INTERVAL_MS) return;
    this.#poolReads.set(provider, now);
    this.#poolReading.add(provider);
    Effect.runFork(
      this.#providers.readPoolUsage(provider).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            this.#poolReading.delete(provider);
            this.#refreshPoolInUse(provider);
            for (const agent of this.#store.list())
              if (agentModelChoice(agent).provider === provider && this.#hasWaitingWork(agent.id))
                this.#drain.scheduleDrain(agent.id);
          }),
        ),
        Effect.forkIn(this.#scope, { startImmediately: true }),
      ),
    );
  }

  /** The first ready backup model of an agent set to switch without asking, or undefined. */
  #usageLimitBackup(agentId: string, reason: FailoverReason = "limit"): AgentModelChoice | undefined {
    const agent = this.#store.list().find((candidate) => candidate.id === agentId);
    if (!agent) return undefined;
    // With no backup models of its own, the guardrails' failover takes an agent whose usage limit
    // holds it to the next step of the order. A provider error does not move it.
    if (!agent.backupModels?.automatic) {
      if (reason !== "limit" || agent.usageLimitReturn) return undefined;
      return this.#guardrails?.failoverChoice(agent, { limited: true }) ?? undefined;
    }
    const current = agentModelChoice(agent);
    return agent.backupModels.order.find(
      (choice) => !sameAgentModelChoice(choice, current) && this.#usageLimitReady(choice),
    );
  }

  /** Whether the model is ready, and no usage limit or provider error holds it. */
  #usageLimitReady(choice: AgentModelChoice): boolean {
    const limit = usageLimitOf(choice);
    return this.#modelChoiceReady(choice) && !this.#usageLimits.isLimited(limit) && !this.#usageLimits.isFailed(limit);
  }

  /**
   * Whether the provider is on and signed in, the account is connected, and the model list has the
   * model. The same check as `backupModelOption` in the settings page and the chat card.
   */
  #modelChoiceReady(choice: AgentModelChoice): boolean {
    const accountId = choice.providerAccountId ?? DEFAULT_PROVIDER_ACCOUNT_ID;
    const provider = this.getStatus().providers?.find((status) => status.id === choice.provider);
    const accounts = provider?.accounts;
    return (
      provider !== undefined &&
      provider.off !== true &&
      provider.state === "available" &&
      (accounts === undefined
        ? accountId === DEFAULT_PROVIDER_ACCOUNT_ID
        : accounts.some((account) => account.id === accountId && account.state === "connected")) &&
      this.#endpoints.available().some((model) => model.provider === choice.provider && model.id === choice.model)
    );
  }

  /**
   * True while a provider handover would break a running turn, task, or started delivery. It sees a
   * turn that the database still records too, as the idle check of `#applyAgentUpdate` does, so a
   * queued change waits for that turn and is not dropped as a failure.
   */
  #runtimeHandoverBusy(agentId: string): boolean {
    const threadId = this.#store.list().find((candidate) => candidate.id === agentId)?.threadId;
    return (
      this.#runsTurn(agentId) ||
      this.#mailbox.hasStartedDelivery(agentId) ||
      this.#conversation.workingTaskSnapshots(agentId).length > 0 ||
      (threadId ? this.#store.database.readActiveTurnId(agentId, threadId) !== null : false)
    );
  }

  /** A queued provider change is ready to apply: the agent is idle. */
  #pendingRuntimeDue(agentId: string): boolean {
    const agent = this.#store.list().find((candidate) => candidate.id === agentId);
    return Boolean(agent?.pendingRuntime) && !this.#runtimeHandoverBusy(agentId);
  }

  /** Applies `pendingRuntime` once the agent is idle. True when the agent moved. */
  readonly #followPendingRuntime = Effect.fn("AgentService.followPendingRuntime")(function* (
    this: AgentService,
    agentId: string,
  ) {
    return yield* this.#endpoints
      .runExclusive(() =>
        Effect.gen({ self: this }, function* () {
          const agent = this.#store.list().find((candidate) => candidate.id === agentId);
          const pending = agent?.pendingRuntime;
          if (!pending || this.#runtimeHandoverBusy(agentId)) return false;
          yield* this.#applyAgentUpdate(
            {
              agentId,
              provider: pending.provider,
              model: pending.model,
              reasoningEffort: pending.reasoningEffort,
              providerAccountId: pending.providerAccountId ?? null,
            },
            undefined,
            "next-turn",
          );
          return true;
        }),
      )
      .pipe(
        Effect.catch((failure) =>
          Effect.gen({ self: this }, function* () {
            this.#emitError("pending_runtime_switch_failed", failure, agentId);
            // A change that fails on an idle agent, such as a provider that is now off, would fail again
            // before each turn. The agent stays on its provider, and the header stops showing the change.
            if (this.#runtimeHandoverBusy(agentId)) return false;
            // A pin that the change set for its account ends with it.
            const agent = this.#store.list().find((candidate) => candidate.id === agentId);
            const stalePin =
              agent?.pinnedAccountId !== undefined &&
              agent.pinnedAccountId !== (agent.providerAccountId ?? DEFAULT_PROVIDER_ACCOUNT_ID);
            const cleared = yield* Effect.exit(
              this.#store.updateAgent({
                agentId,
                pendingRuntime: null,
                ...(stalePin ? { pinnedAccountId: null } : {}),
              }),
            );
            if (Exit.isSuccess(cleared)) this.#emit({ type: "agents-changed", agents: this.listAgents() });
            return false;
          }),
        ),
      );
  });

  /**
   * Whether a pool move waits for the agent's background work. The move closes the Claude session, and
   * its background subagents and commands end with it. The pool moves early, while the current account
   * can still run the next turn, so that turn runs there, and the drain after the work tries the move
   * again. An account at a limit or after a provider error cannot run it, so the agent moves.
   */
  #poolMoveWaits(agentId: string): Effect.Effect<boolean> {
    const agent = this.#store.list().find((candidate) => candidate.id === agentId);
    if (!agent || !this.#usageLimits.mayDrain(agentId) || !this.#usageLimitReady(agentModelChoice(agent)))
      return Effect.succeed(false);
    return this.#threads.mainRunsBackgroundWork(agent);
  }

  /** Makes the move of `#usageLimitMove`, if one is due. True when the agent moved. */
  readonly #followUsageLimit = Effect.fn("AgentService.followUsageLimit")(function* (
    this: AgentService,
    agentId: string,
  ) {
    return yield* this.#endpoints
      .runExclusive(() =>
        Effect.gen({ self: this }, function* () {
          const move = this.#usageLimitMove(agentId);
          if (!move) return false;
          if (move.move === "next-turn" && (yield* this.#poolMoveWaits(agentId))) {
            logger.info("A pool move waits: the agent's Claude session still runs background work.", { agentId });
            return false;
          }
          const before = this.#store.list().find((candidate) => candidate.id === agentId);
          yield* this.#applyAgentUpdate(move.input, undefined, move.move);
          if (move.move === "return") this.#guardrails?.returned(agentId);
          if (move.move === "pool-failover" && before)
            this.#guardrails?.failedOver(
              agentId,
              { provider: before.provider, model: before.model },
              { provider: move.input.provider ?? before.provider, model: move.input.model ?? before.model },
            );
          return true;
        }),
      )
      .pipe(
        Effect.catch((failure) =>
          Effect.sync(() => {
            this.#emitError("usage_limit_switch_failed", failure, agentId);
            return false;
          }),
        ),
      );
  });

  /**
   * A note in the agent's chat that it left its model for a usage limit or a provider error, or went back to it. Each
   * channel whose work waits for the agent gets the same note.
   */
  #appendModelSwitchMarker(agent: AgentSummary, reason: ModelSwitchReason): void {
    const model =
      this.#endpoints.available().find((option) => option.provider === agent.provider && option.id === agent.model)
        ?.name ?? agent.model;
    const text = sourceText(MODEL_SWITCH_TEXT[reason], { model });
    const database = this.#store.database;
    try {
      this.channels.noteModelSwitch(agent.id, text, MODEL_SWITCH_ITEM_TYPES[reason]);
    } catch (error) {
      this.#emitError("model_switch_marker_failed", error, agent.id);
    }
    try {
      this.#conversation.withConversationTransaction(agent.id, ({ threadId, snapshot }) => {
        const message: ConversationMessage = {
          id: `model-switch-${randomUUID()}`,
          author: "system",
          source: "system",
          text,
          createdAt: new Date().toISOString(),
          status: "completed",
          itemType: MODEL_SWITCH_ITEM_TYPES[reason],
        };
        snapshot.messages.push(message);
        sortConversationMessages(snapshot.messages);
        snapshot.revision = database.appendConversationMessage({
          agentId: agent.id,
          threadId,
          activeTurnId: snapshot.activeTurnId,
          message,
          eventType: "thread.model-switched",
        });
        return { result: undefined, snapshot };
      });
    } catch (error) {
      // The switch is stored; only its note is lost.
      this.#emitError("model_switch_marker_failed", error, agent.id);
    }
  }

  readonly setAvatar = Effect.fn("AgentService.setAvatar")(function* (
    this: AgentService,
    agentId: string,
    image: AvatarImageInput | null,
  ) {
    const agent = yield* this.#store
      .setAvatar(agentId, image)
      .pipe(Effect.mapError((failure) => new AgentLifecycleFailed({ operation: "set avatar", cause: failure.cause })));
    this.#emit({ type: "agents-changed", agents: this.listAgents() });
    return agent;
  }).bind(this);

  refreshAgentRuntime(agentId: string): Effect.Effect<void, AgentLifecycleFailed> {
    return this.#threads.refreshAgentRuntime(agentId);
  }

  /**
   * Starts a new chat with the agent and keeps the agent. A marker goes into the agent's own thread,
   * and its provider sessions end, so the next turn starts a new session that does not see the
   * messages before the marker. The messages stay visible, and the profile, memories, workspace, and
   * browser do not change.
   */
  readonly clearAgentContext = Effect.fn("AgentService.clearAgentContext")(function* (
    this: AgentService,
    agentId: string,
  ) {
    const threadId = yield* lifecycleStep("clear agent context", () => {
      const agent = this.#conversation.requireKnownAgent(agentId);
      const activeTurn =
        this.#conversation.workingSnapshot(agentId)?.activeTurnId ??
        (agent.threadId ? this.#store.database.readActiveTurnId(agentId, agent.threadId) : null);
      if (activeTurn || this.#mailbox.hasUnfinishedDelivery(agentId) || this.#threads.providerContextBusy(agent)) {
        throw new ContextResetBusyError(sourceText("error.agent.waitBeforeClearContext"));
      }
      const database = this.#store.database;
      const threadId = this.#conversation.withConversationTransaction(agentId, ({ threadId, snapshot }) => {
        const last = snapshot.messages.at(-1);
        if (!last || isContextResetMarker(last)) return { result: threadId, snapshot };
        const message: ConversationMessage = {
          id: `context-reset-${randomUUID()}`,
          author: "system",
          source: "system",
          text: sourceText("status.agent.contextCleared"),
          createdAt: new Date().toISOString(),
          status: "completed",
          itemType: CONTEXT_RESET_ITEM_TYPE,
        };
        snapshot.messages.push(message);
        sortConversationMessages(snapshot.messages);
        snapshot.revision = database.appendConversationMessage({
          agentId,
          threadId,
          activeTurnId: snapshot.activeTurnId,
          message,
          eventType: "thread.context-cleared",
        });
        return { result: threadId, snapshot };
      });
      return threadId;
    });
    yield* this.#threads.endThreadContext(threadId);
  }, Effect.uninterruptible).bind(this);

  /**
   * Compacts the context of the agent's own chat now, below the automatic threshold too. Only for a
   * provider that OpenBot can ask to compact, and only when no turn or queued message needs the session.
   */
  readonly compactAgentContext = Effect.fn("AgentService.compactAgentContext")(function* (
    this: AgentService,
    agentId: string,
  ) {
    const externalThreadId = yield* lifecycleStep("compact agent context", () => {
      const agent = this.#conversation.requireKnownAgent(agentId);
      const activeTurn =
        this.#conversation.workingSnapshot(agentId)?.activeTurnId ??
        (agent.threadId ? this.#store.database.readActiveTurnId(agentId, agent.threadId) : null);
      if (activeTurn || this.#mailbox.hasUnfinishedDelivery(agentId) || this.#threads.providerContextBusy(agent))
        throw new Error(sourceText("error.agent.waitBeforeCompactContext"));
      const session = agent.threadId
        ? this.#store.database.activeProviderSession(agent.threadId, agent.provider)
        : null;
      if (!session || !this.#compaction.reserve(agentId, session.externalSessionId, true))
        throw new Error(sourceText("error.agent.compactContextUnavailable"));
      return session.externalSessionId;
    });
    yield* this.#compaction.request(agentId, externalThreadId);
  }, Effect.uninterruptible).bind(this);

  /**
   * The new chat that the agent asked for with `start_new_chat`. The drain calls it when the agent's
   * own chat has nothing to start. A turn of a task or a compaction can still run; the request then
   * waits for the next drain, unless a turn in the agent's own chat starts first. The user can turn
   * the setting off while the request waits.
   *
   * The new chat closes the Claude session, and the background subagents and commands of that session
   * end with it (upstream da1ebe63f). So the request also waits for them: when the work ends, Claude
   * answers its result in a turn of its own, and the drain after that turn starts the new chat. "New
   * chat" from the user does not wait: a background command such as a dev server can run without end.
   */
  #startRequestedNewChat(agentId: string): Effect.Effect<void> {
    if (!this.#requestedNewChats.has(agentId)) return Effect.void;
    const agent = this.#store.list().find((candidate) => candidate.id === agentId);
    if (!agent || !agentNewChatAllowed(agent, this.#store.agentDefaults())) {
      this.#requestedNewChats.delete(agentId);
      return Effect.void;
    }
    const startNewChat = this.clearAgentContext(agentId).pipe(
      Effect.tap(() =>
        Effect.sync(() => {
          this.#requestedNewChats.delete(agentId);
          logger.info(`Agent ${agentId} started a new chat.`);
        }),
      ),
      Effect.catch((failure) =>
        Effect.sync(() => {
          if (failure.cause instanceof ContextResetBusyError) return;
          this.#requestedNewChats.delete(agentId);
          this.#emitError("agent_new_chat_failed", failure.cause, agentId);
        }),
      ),
    );
    return this.#threads
      .mainRunsBackgroundWork(agent)
      .pipe(Effect.flatMap((background) => (background ? Effect.void : startNewChat)));
  }

  resolveAvatar(agentId: string): { path: string; mimeType: AvatarImageInput["mimeType"]; version: string } | null {
    return this.#store.resolveAvatar(agentId);
  }

  resolveSharedFile(
    inputPath: string,
    options?: { allowDirectory?: boolean },
  ): Effect.Effect<ResolvedSharedFile, AgentLifecycleFailed> {
    // A person opens a shared file of any space, or of the old global shared folder.
    const roots = [this.#store.sharedRoot, ...this.spaces.directories().map((space) => space.sharedDirectory)];
    const [first = this.#store.sharedRoot, ...rest] = roots;
    return rest
      .reduce(
        (attempt, root) => attempt.pipe(Effect.catch(() => resolveSharedFile(root, inputPath, options))),
        resolveSharedFile(first, inputPath, options),
      )
      .pipe(
        Effect.mapError(
          (failure) => new AgentLifecycleFailed({ operation: "resolveSharedFile", cause: failure.cause }),
        ),
      );
  }

  /** A file a remote member asks for. It must be inside the agent's workspace. */
  readonly resolveWorkspaceFile = Effect.fn("AgentService.resolveWorkspaceFile")(function* (
    this: AgentService,
    agentId: string,
    inputPath: string,
  ) {
    const agent = yield* lifecycleStep("find workspace agent", () => this.#agentForFile(agentId));
    return yield* resolveWorkspaceFile(agent, inputPath).pipe(
      Effect.mapError(
        (failure) => new AgentLifecycleFailed({ operation: "resolve workspace file", cause: failure.cause }),
      ),
    );
  }).bind(this);

  /** The local user can open files outside a workspace when access is unrestricted. */
  readonly resolveLocalWorkspaceFile = Effect.fn("AgentService.resolveLocalWorkspaceFile")(function* (
    this: AgentService,
    agentId: string,
    inputPath: string,
  ) {
    const agent = yield* lifecycleStep("find workspace agent", () => this.#agentForFile(agentId));
    return yield* resolveWorkspaceFile(agent, inputPath, {
      allowOutside: !workspaceAccessEnforced(agent),
      fileHistory: this.#turn.fileHistory.paths(agent.id, agent.threadId),
    }).pipe(
      Effect.mapError(
        (failure) => new AgentLifecycleFailed({ operation: "resolve local workspace file", cause: failure.cause }),
      ),
    );
  }).bind(this);

  /** A folder a remote member asks for. It must be inside the agent's workspace. */
  readonly listWorkspaceDirectory = Effect.fn("AgentService.listWorkspaceDirectory")(function* (
    this: AgentService,
    agentId: string,
    inputPath: string,
  ) {
    const agent = yield* lifecycleStep("find workspace agent", () => this.#agentForFile(agentId));
    return yield* listWorkspaceDirectory(agent, inputPath).pipe(
      Effect.mapError(
        (failure) => new AgentLifecycleFailed({ operation: "list workspace directory", cause: failure.cause }),
      ),
    );
  }).bind(this);

  /** The local user can list folders outside a workspace when access is unrestricted. */
  readonly listLocalWorkspaceDirectory = Effect.fn("AgentService.listLocalWorkspaceDirectory")(function* (
    this: AgentService,
    agentId: string,
    inputPath: string,
  ) {
    const agent = yield* lifecycleStep("find workspace agent", () => this.#agentForFile(agentId));
    return yield* listWorkspaceDirectory(agent, inputPath, { allowOutside: !workspaceAccessEnforced(agent) }).pipe(
      Effect.mapError(
        (failure) => new AgentLifecycleFailed({ operation: "list local workspace directory", cause: failure.cause }),
      ),
    );
  }).bind(this);

  #agentForFile(agentId: string): AgentSummary {
    const agent = this.#store.list().find((candidate) => candidate.id === agentId);
    if (!agent) throw new Error(sourceText("error.agent.unknown", { id: agentId }));
    return agent;
  }

  ensureAgentDeletable(agentId: string): Effect.Effect<void, AgentLifecycleFailed> {
    return this.#removal
      .ensureDeletable(agentId)
      .pipe(Effect.mapError((failure) => new AgentLifecycleFailed({ operation: "deleteAgent", cause: failure.cause })));
  }

  deleteAgent(agentId: string): Effect.Effect<void, AgentLifecycleFailed> {
    return this.#removal
      .delete(agentId)
      .pipe(Effect.mapError((failure) => new AgentLifecycleFailed({ operation: "deleteAgent", cause: failure.cause })));
  }

  deleteChannel(channelId: string): Effect.Effect<void, AgentLifecycleFailed> {
    return this.channels
      .deleteChannel(channelId)
      .pipe(
        Effect.mapError((failure) => new AgentLifecycleFailed({ operation: "deleteChannel", cause: failure.cause })),
      );
  }

  /** `heldRoutines`: routines due while a restart waited run once. */

  readonly initialize = Effect.fn("AgentService.initialize")(function* (
    this: AgentService,
    options: { heldRoutines?: RoutineHoldWindow | undefined } = {},
  ) {
    this.#stopping = false;
    yield* this.#store
      .initialize()
      .pipe(
        Effect.mapError(
          (failure) => new AgentLifecycleFailed({ operation: "initialize agent store", cause: failure.cause }),
        ),
      );
    yield* this.#mailbox
      .initialize()
      .pipe(
        Effect.mapError(
          (failure) => new AgentLifecycleFailed({ operation: "initialize mailbox", cause: failure.cause }),
        ),
      );
    // The helper programs of the agents find their space's shared folder in it.
    yield* this.spaces
      .writeIndex()
      .pipe(Effect.catch((failure) => Effect.sync(() => this.#emitError("spaces_index_failed", failure.cause))));
    yield* lifecycleStep("restore channel links", () => {
      this.#mcp.migrateCatalogBridgesToHttp();
      this.#mcp.migrateCatalogSuccessors();
      this.channels.restoreDeliveryLinks();
      this.channels.removeDeletedMembers(new Set(this.#store.list().map((agent) => agent.id)));
    });
    yield* this.#threads
      .reconcileProviderSessionFiles()
      .pipe(
        Effect.mapError(
          (failure) => new AgentLifecycleFailed({ operation: "reconcile provider sessions", cause: failure.cause }),
        ),
      );
    yield* lifecycleStep("recover agent state", () => {
      this.#boot.recoverPersistedTurns();
      this.#boot.reattributeAtelierPrompts();
      this.#hostedSites.restore();
      this.#routines.skipMissed(new Date(), options.heldRoutines);
      this.#channelRoutines.skipMissed(new Date(), options.heldRoutines);
      this.#initialized = true;
      this.#memoryHold.start();
      this.reviews.start();
      this.learning.start();
      Effect.runFork(this.playbooks.sync());
    });
    yield* this.#providers
      .start()
      .pipe(Effect.mapError((error) => new AgentLifecycleFailed({ operation: "start providers", cause: error.cause })));
    yield* lifecycleStep("publish queues", () => {
      for (const agent of this.#store.list()) this.#mailboxSync.emitQueue(agent.id);
    });
    yield* this.#routines
      .resumePendingRuns()
      .pipe(
        Effect.mapError(
          (failure) => new AgentLifecycleFailed({ operation: "resume agent routines", cause: failure.cause }),
        ),
      );
    yield* this.#channelRoutines
      .resumePendingRuns()
      .pipe(
        Effect.mapError(
          (failure) => new AgentLifecycleFailed({ operation: "resume channel routines", cause: failure.cause }),
        ),
      );
    // Before any check can run: a file that earlier releases wrote takes the approval it implies.
    yield* this.eventChecks.adoptLegacyApprovals().pipe(Effect.catchCause(() => Effect.void));
    yield* this.eventChecks.resumePending().pipe(Effect.forkIn(this.#scope));
    yield* lifecycleStep("arm routines", () => {
      this.#channelRoutines.reconcileAll();
      this.#routineTimer.arm();
    });
  }).bind(this);

  setPreferredProvider(
    provider: AgentProvider,
    model: AgentModelId | null = null,
  ): Effect.Effect<void, AgentLifecycleFailed> {
    return this.#providers.setPreferredProvider(provider, this.#initialized, model);
  }

  ensureProvider(provider: AgentProvider): Effect.Effect<void, AgentLifecycleFailed> {
    return this.#providers
      .ensureProvider(provider)
      .pipe(
        Effect.mapError((failure) => new AgentLifecycleFailed({ operation: "ensureProvider", cause: failure.cause })),
      );
  }

  setProviderOn(provider: AgentProvider, on: boolean): Effect.Effect<AgentStatus, AgentLifecycleFailed> {
    // Turning on can activate models, which takes this same lock. Only off holds it.
    const change = () => this.#providers.setProviderOn(provider, on);
    return this.#providerUseChanges
      .withPermit(on ? change() : this.#endpoints.runExclusive(change))
      .pipe(
        Effect.mapError((failure) => new AgentLifecycleFailed({ operation: "setProviderOn", cause: failure.cause })),
      );
  }

  refreshProviders(options: { automatic: boolean }): Effect.Effect<AgentStatus, AgentLifecycleFailed> {
    return this.#providers
      .refreshProviders(options)
      .pipe(
        Effect.mapError((failure) => new AgentLifecycleFailed({ operation: "refreshProviders", cause: failure.cause })),
      );
  }

  refreshProvider(provider: AgentProvider): Effect.Effect<AgentStatus, AgentLifecycleFailed> {
    return this.#providers
      .refreshProvider(provider)
      .pipe(
        Effect.mapError((failure) => new AgentLifecycleFailed({ operation: "refreshProvider", cause: failure.cause })),
      );
  }

  /** See `ProviderRuntime.restartProviderWhenIdle`. */
  restartProvider(provider: AgentProvider): Effect.Effect<AgentStatus, AgentLifecycleFailed> {
    return this.#providers
      .restartProviderWhenIdle(provider)
      .pipe(
        Effect.mapError((failure) => new AgentLifecycleFailed({ operation: "restartProvider", cause: failure.cause })),
      );
  }

  cancelProviderRestart(provider: AgentProvider): AgentStatus {
    return this.#providers.cancelProviderRestart(provider);
  }

  connectProvider(
    provider: AgentProvider,
    openExternal: (url: string) => Promise<void>,
  ): Effect.Effect<AgentStatus, AgentLifecycleFailed> {
    return this.#providers
      .connectProvider(provider, openExternal)
      .pipe(
        Effect.mapError((failure) => new AgentLifecycleFailed({ operation: "connectProvider", cause: failure.cause })),
      );
  }

  /** See `ProviderRuntime.connectProviderAccount`. */
  connectProviderAccount(
    provider: AgentProvider,
    accountId: string | null,
    openExternal: (url: string) => Promise<void>,
  ): Effect.Effect<AgentStatus, AgentLifecycleFailed> {
    return this.#providers
      .connectProviderAccount(provider, accountId, openExternal)
      .pipe(
        Effect.mapError(
          (failure) => new AgentLifecycleFailed({ operation: "connectProviderAccount", cause: failure.cause }),
        ),
      );
  }

  /** See `ProviderRuntime.signInProviderAccountOnHost`. */
  signInProviderAccountOnHost(
    provider: AgentProvider,
    accountId: string | null,
    openPage: (url: string) => Promise<void>,
  ): Effect.Effect<void, AgentLifecycleFailed> {
    return this.#providers
      .signInProviderAccountOnHost(provider, accountId, openPage)
      .pipe(
        Effect.mapError(
          (failure) => new AgentLifecycleFailed({ operation: "signInProviderAccountOnHost", cause: failure.cause }),
        ),
      );
  }

  /** See `ProviderRuntime.cancelProviderAccountSignIn`. */
  cancelProviderAccountSignIn(
    provider: AgentProvider,
    accountId: string,
  ): Effect.Effect<AgentStatus, AgentLifecycleFailed> {
    return this.#providers
      .cancelProviderAccountSignIn(provider, accountId)
      .pipe(
        Effect.mapError(
          (failure) => new AgentLifecycleFailed({ operation: "cancelProviderAccountSignIn", cause: failure.cause }),
        ),
      );
  }

  renameProviderAccount(
    provider: AgentProvider,
    accountId: string,
    label: string | null,
  ): Effect.Effect<AgentStatus, AgentLifecycleFailed> {
    return this.#providers
      .renameProviderAccount(provider, accountId, label)
      .pipe(
        Effect.mapError(
          (failure) => new AgentLifecycleFailed({ operation: "renameProviderAccount", cause: failure.cause }),
        ),
      );
  }

  /** A setting of the providers changed: clients read the status, and with it the settings, again. */
  notifyProviderSettingsChanged(): void {
    this.#emit({ type: "status", status: this.getStatus() });
  }

  /** See `ProviderRuntime.spawnSettingsChanged`. */
  providerSpawnSettingsChanged(provider: AgentProvider): Effect.Effect<AgentStatus, AgentLifecycleFailed> {
    return this.#providers
      .spawnSettingsChanged(provider)
      .pipe(
        Effect.mapError(
          (failure) => new AgentLifecycleFailed({ operation: "providerSpawnSettingsChanged", cause: failure.cause }),
        ),
      );
  }

  /**
   * Turns the pool of a provider's accounts on or off. The provider's agents move to the pool's
   * account before their next work.
   */
  setProviderAccountPool(
    provider: AgentProvider,
    enabled: boolean,
    leftOut: readonly string[],
  ): Effect.Effect<AgentStatus, AgentLifecycleFailed> {
    return this.#providers.setProviderAccountPool(provider, enabled, leftOut).pipe(
      Effect.map(() => {
        this.#poolReads.delete(provider);
        this.#refreshPoolInUse(provider);
        if (enabled) this.#readPoolWhenStale(provider);
        return this.getStatus();
      }),
      Effect.mapError(
        (failure) => new AgentLifecycleFailed({ operation: "setProviderAccountPool", cause: failure.cause }),
      ),
    );
  }

  /** The usage reset credits of each connected account of a provider. An account that has no count is left out. */
  providerUsageResets(provider: AgentProvider): Effect.Effect<ProviderUsageResets[]> {
    return this.#providers.usageResets(provider);
  }

  /** Spends one usage reset credit of an account. A reset ends the usage limit that holds its agents. */
  readonly resetProviderUsage = Effect.fn("AgentService.resetProviderUsage")(function* (
    this: AgentService,
    provider: AgentProvider,
    accountId: string,
  ) {
    const outcome = yield* this.#providers
      .resetUsage(provider, accountId)
      .pipe(
        Effect.mapError(
          (failure) => new AgentLifecycleFailed({ operation: "resetProviderUsage", cause: failure.cause }),
        ),
      );
    // `nothingToReset` says that no limit of the account is spent, so a hold on it is out of date too.
    if (outcome === "reset" || outcome === "nothingToReset")
      yield* this.#usageLimits.accountReset(provider, accountId === DEFAULT_PROVIDER_ACCOUNT_ID ? null : accountId);
    return outcome;
  }).bind(this);

  /**
   * Moves the account's agents to the provider's own sign-in, then removes the account and its
   * credentials. Refused while one of those agents has work, as a provider change is.
   */
  removeProviderAccount(provider: AgentProvider, accountId: string): Effect.Effect<AgentStatus, AgentLifecycleFailed> {
    return this.#endpoints
      .runExclusive(() =>
        Effect.gen({ self: this }, function* () {
          const agents = this.#store
            .list()
            .filter((agent) => providerForAgent(agent) === provider && agentProviderAccount(agent) === accountId);
          yield* lifecycleStep("check provider account", () => {
            if (agents.some((agent) => this.#runsTurn(agent.id) || this.#mailbox.hasUnfinishedDelivery(agent.id)))
              throw new Error(sourceText("error.provider.accountInUse"));
          });
          for (const agent of agents) yield* this.#applyAgentUpdate({ agentId: agent.id, providerAccountId: null });
          // A queued change to the account moves to the provider's own sign-in too, so it does not fail
          // before the next turn. The running turn does not use the account, so it can continue.
          const queued = this.#store
            .list()
            .filter(
              (agent) =>
                agent.pendingRuntime?.provider === provider && agentProviderAccount(agent.pendingRuntime) === accountId,
            );
          for (const agent of queued)
            if (agent.pendingRuntime)
              yield* this.#store.updateAgent({
                agentId: agent.id,
                pendingRuntime: { ...agent.pendingRuntime, providerAccountId: undefined },
              });
          if (queued.length > 0) this.#emit({ type: "agents-changed", agents: this.listAgents() });
          return yield* this.#providers.removeProviderAccount(provider, accountId);
        }),
      )
      .pipe(
        Effect.mapError(
          (failure) => new AgentLifecycleFailed({ operation: "removeProviderAccount", cause: failure.cause }),
        ),
      );
  }

  /** See `ProviderRuntime.signInProviderOnHost`. */
  signInProviderOnHost(
    provider: AgentProvider,
    openPage: (url: string) => Promise<void>,
  ): Effect.Effect<void, AgentLifecycleFailed> {
    return this.#providers
      .signInProviderOnHost(provider, openPage)
      .pipe(
        Effect.mapError(
          (failure) => new AgentLifecycleFailed({ operation: "signInProviderOnHost", cause: failure.cause }),
        ),
      );
  }

  cancelProviderSignIn(provider: AgentProvider): Effect.Effect<AgentStatus, AgentLifecycleFailed> {
    return this.#providers
      .cancelProviderSignIn(provider)
      .pipe(
        Effect.mapError(
          (failure) => new AgentLifecycleFailed({ operation: "cancelProviderSignIn", cause: failure.cause }),
        ),
      );
  }

  startProviderCodeLogin(provider: AgentProvider): Effect.Effect<ProviderCodeLoginStart, AgentLifecycleFailed> {
    return this.#providers
      .startProviderCodeLogin(provider)
      .pipe(
        Effect.mapError(
          (failure) => new AgentLifecycleFailed({ operation: "startProviderCodeLogin", cause: failure.cause }),
        ),
      );
  }

  submitProviderCodeLogin(provider: AgentProvider, code: string): AgentStatus {
    return this.#providers.submitProviderCodeLogin(provider, code);
  }

  cancelProviderCodeLogin(provider: AgentProvider): Effect.Effect<AgentStatus, AgentLifecycleFailed> {
    return this.#providers
      .cancelProviderCodeLogin(provider)
      .pipe(
        Effect.mapError(
          (failure) => new AgentLifecycleFailed({ operation: "cancelProviderCodeLogin", cause: failure.cause }),
        ),
      );
  }

  /**
   * A stored key serves the provider's own sign-in, and Claude's key also its own account, so a new or
   * removed key ends the limits that hold those agents: they were the old credential's. A limit of the
   * new one holds them again at its first refused turn. Claude's own sign-in uses the key only when it
   * has no claude.ai login, so the limits of that plan stay. A saved Claude key gets its account; a
   * removed one takes its account away, and its agents go back to the provider's own sign-in.
   */
  changeProviderCredential(
    provider: AgentProvider,
    change: () => Effect.Effect<void, AgentLifecycleFailed>,
  ): Effect.Effect<AgentStatus, AgentLifecycleFailed> {
    let usedKey = provider !== "claude";
    return this.#providers
      .changeProviderCredential(provider, () =>
        Effect.suspend(() => {
          usedKey ||= this.#providers.ownSignInUsesKey(provider);
          return change();
        }).pipe(toProviderOperationFailed),
      )
      .pipe(
        Effect.tap(() =>
          usedKey || this.#providers.ownSignInUsesKey(provider)
            ? this.#usageLimits.accountReset(provider, null)
            : Effect.void,
        ),
        Effect.mapError(
          (failure) => new AgentLifecycleFailed({ operation: "changeProviderCredential", cause: failure.cause }),
        ),
        Effect.flatMap((status) => (provider === "claude" ? this.#claudeKeyChanged() : Effect.succeed(status))),
      );
  }

  /**
   * `changeProviderCredential` for a removed key. Claude's key account goes first, with the idle check
   * of any removed account, so that a refusal keeps the key: an agent left on the account without its
   * key could not run a turn. The key change refuses while the provider is busy, so that is checked
   * before the account goes too.
   */
  clearProviderCredential(
    provider: AgentProvider,
    clear: () => Effect.Effect<void, AgentLifecycleFailed>,
  ): Effect.Effect<AgentStatus, AgentLifecycleFailed> {
    return Effect.suspend(() => {
      if (provider !== "claude" || !this.#providers.hasProviderAccount(provider, CLAUDE_API_KEY_ACCOUNT_ID))
        return Effect.void;
      if (this.#isProviderBusy(provider))
        return Effect.fail(
          new AgentLifecycleFailed({
            operation: "changeProviderCredential",
            cause: new Error(sourceText("error.provider.cliBusyRetry", { provider: providerLabel(provider) })),
          }),
        );
      return this.removeProviderAccount(provider, CLAUDE_API_KEY_ACCOUNT_ID);
    }).pipe(Effect.andThen(this.changeProviderCredential(provider, clear)));
  }

  readonly #claudeKeyChanged = Effect.fn("AgentService.claudeKeyChanged")(function* (this: AgentService) {
    const status = this.#providers.hasProviderKey("claude")
      ? yield* this.#providers.providerKeyChanged("claude")
      : this.#providers.hasProviderAccount("claude", CLAUDE_API_KEY_ACCOUNT_ID)
        ? yield* this.removeProviderAccount("claude", CLAUDE_API_KEY_ACCOUNT_ID)
        : this.#providers.status();
    // After the removal, so that the released work starts on the provider's own sign-in.
    yield* this.#usageLimits.accountReset("claude", CLAUDE_API_KEY_ACCOUNT_ID);
    return status;
  });

  updateProviderCli(
    provider: AgentProvider,
    install: () => Effect.Effect<string, AgentLifecycleFailed>,
    signal: AbortSignal,
    onWait: () => void,
  ): Effect.Effect<AgentStatus, AgentLifecycleFailed> {
    return this.#providers
      .updateProviderCli(provider, () => install().pipe(toProviderOperationFailed), signal, onWait)
      .pipe(
        Effect.mapError(
          (failure) => new AgentLifecycleFailed({ operation: "updateProviderCli", cause: failure.cause }),
        ),
      );
  }

  /** Restarts OpenCode so a saved or removed endpoint reaches it. Reports why, if it did not. */
  reloadOpenCodeConfig(): Effect.Effect<CustomProviderRestart, AgentLifecycleFailed> {
    return this.#providers.reloadOpenCodeConfig();
  }

  /** Replaces the custom agents' router so a saved or removed agent reaches it. Reports why, if it did not. */
  reloadCustomAgents(): Effect.Effect<CustomProviderRestart, AgentLifecycleFailed> {
    return this.#providers
      .reloadCustomAgents()
      .pipe(
        Effect.mapError(
          (failure) => new AgentLifecycleFailed({ operation: "reloadCustomAgents", cause: failure.cause }),
        ),
      );
  }

  withCustomAgentRuntimeRemoval<T>(
    _customAgentIds: readonly string[],
    operation: () => Effect.Effect<T, AgentLifecycleFailed>,
  ): Effect.Effect<T, AgentLifecycleFailed> {
    return this.#providers
      .withCustomAgentRuntimeRemoval(() => operation().pipe(toProviderOperationFailed))
      .pipe(
        Effect.mapError(
          (failure) => new AgentLifecycleFailed({ operation: "removeCustomAgentRuntime", cause: failure.cause }),
        ),
      );
  }

  /** See `ProviderRuntime.customAgentUsage`. */
  customAgentUsage() {
    return this.#providers.customAgentUsage();
  }

  /** See `CustomEndpoints.saveCustomAgent`. */
  saveCustomAgent<T>(persist: () => Effect.Effect<T, AgentLifecycleFailed>): Effect.Effect<T, AgentLifecycleFailed> {
    return this.#endpoints
      .saveCustomAgent(() => persist().pipe(toEndpointChangeFailed))
      .pipe(
        Effect.mapError((failure) => new AgentLifecycleFailed({ operation: "saveCustomAgent", cause: failure.cause })),
      );
  }

  /** See `CustomEndpoints.removeCustomAgent`: the agents on it move to another provider first. */
  removeCustomAgent<T>(
    customAgentId: string,
    persist: () => Effect.Effect<T, AgentLifecycleFailed>,
  ): Effect.Effect<T, AgentLifecycleFailed> {
    return this.#endpoints
      .removeCustomAgent(customAgentId, () => persist().pipe(toEndpointChangeFailed))
      .pipe(
        Effect.mapError(
          (failure) => new AgentLifecycleFailed({ operation: "removeCustomAgent", cause: failure.cause }),
        ),
      );
  }

  /** See `CustomEndpoints.save`: the exclusion of the id being saved and the caller's file write. */
  saveCustomProvider<T>(
    providerId: string,
    persist: () => Effect.Effect<T, AgentLifecycleFailed>,
  ): Effect.Effect<T, AgentLifecycleFailed> {
    return this.#endpoints
      .save(providerId, () => persist().pipe(toEndpointChangeFailed))
      .pipe(
        Effect.mapError(
          (failure) => new AgentLifecycleFailed({ operation: "saveCustomProvider", cause: failure.cause }),
        ),
      );
  }

  /** See `CustomEndpoints.update`: the agents on removed models, the exclusion, and the file write. */
  updateCustomProvider<T>(
    providerId: string,
    removedModelIds: readonly string[],
    persist: () => Effect.Effect<T, AgentLifecycleFailed>,
  ): Effect.Effect<T, AgentLifecycleFailed> {
    return this.#endpoints
      .update(providerId, removedModelIds, () => persist().pipe(toEndpointChangeFailed))
      .pipe(
        Effect.mapError(
          (failure) => new AgentLifecycleFailed({ operation: "updateCustomProvider", cause: failure.cause }),
        ),
      );
  }

  /** See `CustomEndpoints.remove`: the exclusion, the agents that were on it, and the file write. */
  removeCustomProvider<T>(
    providerId: string,
    persist: () => Effect.Effect<T, AgentLifecycleFailed>,
  ): Effect.Effect<T, AgentLifecycleFailed> {
    return this.#endpoints
      .remove(providerId, () => persist().pipe(toEndpointChangeFailed))
      .pipe(
        Effect.mapError(
          (failure) => new AgentLifecycleFailed({ operation: "removeCustomProvider", cause: failure.cause }),
        ),
      );
  }

  /**
   * True while the CLI runs a turn for this agent. A channel turn runs on a thread of its own, so the
   * agent's own conversation holds no turn id while the CLI works. `workingSnapshot` reads the
   * execution threads as well.
   *
   * A compaction is a provider turn as well, and it holds no active turn id: its `turn/started`
   * belongs to the compaction, not to the agent, so `claimTurn` takes it away. Only its own guard
   * reports the turn the CLI is running.
   */
  #isProviderBusy(provider: AgentProvider): boolean {
    return (
      this.#profileClients.usesProvider(provider) ||
      this.#gateClients.usesProvider(provider) ||
      this.#backgroundClients.usesProvider(provider) ||
      this.#drain.hasStartingDeliveries(provider) ||
      this.#store.list().some((agent) => providerForAgent(agent) === provider && this.#runsTurn(agent.id))
    );
  }

  /** `#isProviderBusy` without this agent: another agent's turn runs, or its delivery starts. */
  #isProviderBusyApartFrom(provider: AgentProvider, agentId: string): boolean {
    return (
      this.#profileClients.usesProvider(provider) ||
      this.#gateClients.usesProvider(provider) ||
      this.#backgroundClients.usesProvider(provider) ||
      this.#store
        .list()
        .some(
          (agent) =>
            agent.id !== agentId &&
            providerForAgent(agent) === provider &&
            (this.#runsTurn(agent.id) || this.#mailbox.startingDeliveriesForAgent(agent.id).length > 0),
        )
    );
  }

  #runsTurn(agentId: string): boolean {
    return this.#conversation.anyWorkingSnapshot(agentId) != null || !this.#compaction.mayDrain(agentId);
  }

  /** Whether this provider reports a CLI that is installed, current, and signed in. */
  #providerAvailable(provider: AgentProvider): boolean {
    return (
      this.getStatus().providers?.some((candidate) => candidate.id === provider && candidate.state === "available") ??
      false
    );
  }

  readonly stop = Effect.fn("AgentService.stop")(function* (this: AgentService) {
    this.#stopping = true;
    this.#guardrails?.dispose();
    if (this.#deployDrainTimer) clearTimeout(this.#deployDrainTimer);
    this.#deployDrainTimer = null;
    const channelStop = yield* Effect.forkChild(
      this.channels
        .stop()
        .pipe(
          Effect.mapError((failure) => new AgentLifecycleFailed({ operation: "stop channels", cause: failure.cause })),
        ),
      { startImmediately: true },
    );
    this.#initialized = false;
    this.#routineTimer.dispose();
    yield* this.#memoryHold.dispose();
    this.#hostedSites.dispose();
    yield* this.workspace.stop();
    this.#compaction.dispose();
    this.#deltas.dispose();
    this.#conversation.dispose();
    this.#threads.dispose();
    yield* this.#memoryReview.dispose();
    this.reviews.dispose();
    this.learning.dispose();
    this.playbooks.dispose();
    this.#memories.clearPending();
    this.#tables?.dispose();
    this.#attention.clearPrompts();
    this.#attention.clearBrowserTakeovers();
    this.#attention.clearApprovals();
    const clients = [
      ...(yield* this.#providers.dispose()),
      ...this.#profileClients.release(),
      ...this.#gateClients.release(),
      ...this.#backgroundClients.release(),
    ];
    for (const [agentId, snapshot] of this.#conversation.activeSnapshots()) {
      if (!snapshot.activeTurnId) continue;
      const agent = this.#store.list().find((item) => item.id === agentId);
      const session = agent && snapshot.threadId ? this.#runningSession(agent, snapshot.threadId) : undefined;
      if (session) this.#images.interrupt(agentId, session, snapshot.activeTurnId);
    }
    yield* this.#turn.dispose();
    yield* this.#usageLimits.dispose();
    this.#drain.dispose();
    this.#queue.dispose();
    this.#browser.clearControls();
    yield* Effect.forEach(clients, (client) => client.stop().pipe(Effect.catch(() => Effect.void)), {
      concurrency: "unbounded",
      discard: true,
    });
    yield* this.#warmGenerations.dispose();
    yield* this.#gateGenerations.dispose();
    yield* Fiber.join(channelStop);
    // After the clients: a provider that still runs would see its MCP servers fail.
    yield* this.#mcp.close();
    yield* settleLifecycleTasks("finish drain", this.#drain.pendingTasks());
    yield* settleLifecycleTasks("finish image requests", this.#images.pendingOperations());
    yield* this.#images.dispose();
    yield* settleLifecycleTasks("finish attachment commands", this.#attachments.pendingCommands());
    this.#attachments.dispose();
    yield* this.#browserUploads
      .dispose()
      .pipe(
        Effect.mapError(
          (failure) => new AgentLifecycleFailed({ operation: "stop browser uploads", cause: failure.cause }),
        ),
      );
    yield* Scope.close(this.#scope, Exit.void);
    this.#scope = Scope.makeUnsafe();
    this.#providers.markStopped();
  }).bind(this);

  readConversation(agentId: string): Effect.Effect<ConversationSnapshot, AgentLifecycleFailed> {
    return this.#reader
      .read(agentId)
      .pipe(
        Effect.mapError((failure) => new AgentLifecycleFailed({ operation: "readConversation", cause: failure.cause })),
      );
  }

  readConversationFor(
    agentId: string,
    memberId: string,
  ): Effect.Effect<ConversationWithReadState, AgentLifecycleFailed> {
    return this.#reader
      .readFor(agentId, memberId)
      .pipe(
        Effect.mapError(
          (failure) => new AgentLifecycleFailed({ operation: "readConversationFor", cause: failure.cause }),
        ),
      );
  }

  readConversationPageFor(
    agentId: string,
    memberId: string,
    anchor?: ConversationPageAnchor,
    limit?: number,
    options?: ConversationMarkerExclusions,
  ): Effect.Effect<ConversationPage, AgentLifecycleFailed> {
    return this.#reader
      .readPageFor(agentId, memberId, anchor, limit, options)
      .pipe(
        Effect.mapError(
          (failure) => new AgentLifecycleFailed({ operation: "readConversationPageFor", cause: failure.cause }),
        ),
      );
  }

  searchConversationMessages(query: string, agentId?: string, cursor?: string, limit?: number): ConversationSearchPage {
    return this.#reader.search(query, agentId, cursor, limit);
  }

  searchConversationFiles(query: string, cursor?: string, limit?: number): ConversationFileSearchPage {
    return this.#reader.searchFiles(query, cursor, limit);
  }

  listConversationReads(
    memberId: string,
    options?: ConversationMarkerExclusions,
  ): Record<string, ConversationReadState> {
    return this.#reader.listReads(memberId, options);
  }

  /**
   * `listConversationReads`, with the read states computed by a database read worker when one runs, so
   * a client's read does not hold the main thread. The synchronous form stays for callers that cannot
   * wait, such as the live activity view.
   */
  listConversationReadsOffMain(
    memberId: string,
    options?: ConversationMarkerExclusions,
  ): Effect.Effect<Record<string, ConversationReadState>, AgentLifecycleFailed> {
    return this.#reader
      .listReadsOffMain(memberId, options)
      .pipe(
        Effect.mapError(
          (failure) => new AgentLifecycleFailed({ operation: "listConversationReads", cause: failure.cause }),
        ),
      );
  }

  /**
   * A page of `readConversationPageFor`, read and encoded by a database read worker as the body of
   * a Team API response. Null when the caller must read and encode it on the main thread; `tooLarge`
   * when even one message is larger than `maxBytes`.
   */
  readConversationPageResponseFor(
    agentId: string,
    memberId: string,
    anchor: ConversationPageAnchor,
    limit: number,
    options: ConversationMarkerExclusions,
    route: EncodedResponseRoute,
    maxBytes: number,
  ): Effect.Effect<{ body: string } | { tooLarge: true } | null, AgentLifecycleFailed> {
    return this.#reader
      .readPageResponseFor(agentId, memberId, anchor, limit, options, route, maxBytes)
      .pipe(
        Effect.mapError(
          (failure) => new AgentLifecycleFailed({ operation: "readConversationPageFor", cause: failure.cause }),
        ),
      );
  }

  /** `searchConversationMessages`, read by a database read worker when one runs. */
  searchConversationMessagesOffMain(
    query: string,
    agentId?: string,
    cursor?: string,
    limit?: number,
  ): Effect.Effect<ConversationSearchPage, AgentLifecycleFailed> {
    return this.#reader
      .searchOffMain(query, agentId, cursor, limit)
      .pipe(
        Effect.mapError(
          (failure) => new AgentLifecycleFailed({ operation: "searchConversationMessages", cause: failure.cause }),
        ),
      );
  }

  /** `searchConversationFiles`, read by a database read worker when one runs. */
  searchConversationFilesOffMain(
    query: string,
    cursor?: string,
    limit?: number,
  ): Effect.Effect<ConversationFileSearchPage, AgentLifecycleFailed> {
    return this.#reader
      .searchFilesOffMain(query, cursor, limit)
      .pipe(
        Effect.mapError(
          (failure) => new AgentLifecycleFailed({ operation: "searchConversationFiles", cause: failure.cause }),
        ),
      );
  }

  adoptConversationReads(sourceMemberId: string, targetMemberId: string): void {
    this.#reader.adoptReads(sourceMemberId, targetMemberId);
  }

  markConversationRead(
    agentId: string,
    memberId: string,
    throughMessageId: string | null,
    options?: ConversationMarkerExclusions,
  ): Effect.Effect<ConversationReadState, AgentLifecycleFailed> {
    return this.#reader
      .markRead(agentId, memberId, throughMessageId, options)
      .pipe(
        Effect.mapError(
          (failure) => new AgentLifecycleFailed({ operation: "markConversationRead", cause: failure.cause }),
        ),
      );
  }

  markConversationUnread(
    agentId: string,
    memberId: string,
  ): Effect.Effect<ConversationReadState, AgentLifecycleFailed> {
    return this.#reader
      .markUnread(agentId, memberId)
      .pipe(
        Effect.mapError(
          (failure) => new AgentLifecycleFailed({ operation: "markConversationUnread", cause: failure.cause }),
        ),
      );
  }

  prepareAttachments(paths: string[]): Effect.Effect<DraftAttachment[], AgentLifecycleFailed> {
    return this.#mailbox
      .prepareAttachments(paths)
      .pipe(
        Effect.mapError(
          (failure) => new AgentLifecycleFailed({ operation: "prepareAttachments", cause: failure.cause }),
        ),
      );
  }

  prepareImportedAttachments(
    paths: string[],
    data: AttachmentDataInput[],
  ): Effect.Effect<DraftAttachment[], AgentLifecycleFailed> {
    return this.#mailbox
      .prepareImportedAttachments(paths, data)
      .pipe(
        Effect.mapError(
          (failure) => new AgentLifecycleFailed({ operation: "prepareImportedAttachments", cause: failure.cause }),
        ),
      );
  }

  /** Keeps the Opus/WebM recording of a spoken message as a draft, for the message to replay. */
  prepareVoiceRecording(audio: Uint8Array): Effect.Effect<DraftAttachment[], AgentLifecycleFailed> {
    return this.#mailbox
      .prepareImportedAttachments([], [{ name: "voice.webm", mimeType: "audio/webm", bytes: audio }], {
        voiceRecording: true,
      })
      .pipe(
        Effect.mapError(
          (failure) => new AgentLifecycleFailed({ operation: "prepareVoiceRecording", cause: failure.cause }),
        ),
      );
  }

  discardDraftAttachment(id: string): Effect.Effect<void, AgentLifecycleFailed> {
    return this.#mailbox
      .discardDraft(id)
      .pipe(
        Effect.mapError(
          (failure) => new AgentLifecycleFailed({ operation: "discardDraftAttachment", cause: failure.cause }),
        ),
      );
  }

  listQueue(agentId: string): QueueSnapshot {
    return this.#mailboxSync.queueSnapshot(agentId);
  }

  listWaits(agentId: string): AgentWaitsSnapshot {
    return this.#waits.list(agentId);
  }

  /** The user cancels an open wait. */
  cancelWait(agentId: string, waitId: string): void {
    this.#waits.cancel(agentId, waitId);
  }

  listTasks(agentId: string): AgentTasksSnapshot {
    return this.#tasks.snapshot(agentId);
  }

  /** The conversation of one task, for its panel. */
  readTask(agentId: string, taskId: string): ConversationSnapshot {
    return structuredClone(this.#tasks.read(agentId, taskId));
  }

  /** Starts a task of the agent with its first message. The task runs beside the agent's own chat. */
  readonly startTask = Effect.fn("AgentService.startTask")(function* (
    this: AgentService,
    input: StartAgentTaskInput,
    sender?: ConversationMessageSender,
    timezone?: string,
  ): Effect.fn.Return<AgentTask, AgentLifecycleFailed> {
    const task = yield* lifecycleStep("start task", () => {
      if (!this.listAgents().some((agent) => agent.id === input.agentId))
        throw new Error(sourceText("error.agent.unknown", { id: input.agentId }));
      this.#requireNotHidden(input.agentId);
      return this.#tasks.create(input.agentId, input.text, "user");
    });
    this.#tasks.changed(task.agentId);
    yield* this.sendMessage(
      {
        agentId: task.agentId,
        taskId: task.taskId,
        text: input.text,
        ...(input.attachmentDraftIds ? { attachmentDraftIds: input.attachmentDraftIds } : {}),
        ...(input.clientMessageId ? { clientMessageId: input.clientMessageId } : {}),
      },
      sender,
      timezone,
    ).pipe(
      // A task without its first message is no use: it goes, and the user can send again.
      Effect.tapError(() =>
        Effect.sync(() => {
          this.#tasks.discard(task);
          this.#tasks.changed(task.agentId);
        }),
      ),
    );
    return this.#tasks.publicTask(task);
  }).bind(this);

  /** Moves a message that waits in the agent's own queue into a new task, so it starts beside the chat. */
  readonly runQueuedMessageAsTask = Effect.fn("AgentService.runQueuedMessageAsTask")(function* (
    this: AgentService,
    input: RunQueuedMessageAsTaskInput,
  ): Effect.fn.Return<AgentTask, AgentLifecycleFailed> {
    const context = yield* lifecycleStep("find queued message", () => {
      if (this.channels.store.assignmentForDelivery(input.deliveryId))
        throw new Error(sourceText("error.backend.useChannelTaskControls"));
      const found = this.#mailbox.getDelivery(input.deliveryId);
      if (!found || found.delivery.recipientAgentId !== input.agentId || found.delivery.status !== "queued")
        throw new Error(sourceText("error.backend.queuedMessageUnavailable"));
      return found;
    });
    const task = yield* lifecycleStep("create task", () =>
      this.#tasks.create(input.agentId, context.delivery.text, "user"),
    );
    yield* this.#mailbox.moveToTask(input.agentId, input.deliveryId, task.taskId).pipe(
      Effect.mapError(
        (failure) => new AgentLifecycleFailed({ operation: "move queued message", cause: failure.cause }),
      ),
      Effect.tapError(() => Effect.sync(() => this.#tasks.discard(task))),
    );
    // The message leaves the agent's own chat, where it showed as queued.
    const agent = this.#store.list().find((candidate) => candidate.id === input.agentId);
    if (agent) {
      const snapshot = this.#conversation.ensureSnapshot(agent.id, agent.threadId);
      snapshot.messages = snapshot.messages.filter((message) => message.id !== input.deliveryId);
      this.#conversation.emitConversation(snapshot, "queue.message-moved-to-task", { deliveryId: input.deliveryId });
    }
    this.#mailboxSync.emitQueue(input.agentId);
    this.#tasks.changed(input.agentId);
    this.#drain.scheduleDrain(input.agentId);
    return this.#tasks.publicTask(task);
  }).bind(this);

  /** Stops the task's running turn and cancels its queued messages. The task stays open. */
  readonly stopTask = Effect.fn("AgentService.stopTask")(function* (
    this: AgentService,
    input: AgentTaskInput,
  ): Effect.fn.Return<void, AgentLifecycleFailed> {
    const task = yield* lifecycleStep("find task", () => this.#tasks.require(input.agentId, input.taskId));
    for (const message of this.#mailbox.queuedTaskMessages(task.agentId, task.taskId))
      yield* this.cancelQueuedMessage(task.agentId, message.deliveryId);
    const turnId = this.#conversation.loadedExecutionSnapshot(task.threadId)?.activeTurnId;
    if (turnId) {
      this.#tasks.markStopped(task.taskId, turnId);
      yield* this.#interruptTurn(task.agentId, turnId, task.threadId);
    }
    this.#tasks.changed(task.agentId);
  }).bind(this);

  /** Stops the task and closes it. A closed task takes no message until it opens again. */
  readonly closeTask = Effect.fn("AgentService.closeTask")(function* (
    this: AgentService,
    input: AgentTaskInput,
  ): Effect.fn.Return<void, AgentLifecycleFailed> {
    yield* this.stopTask(input);
    const task = yield* lifecycleStep("find task", () => {
      const found = this.#tasks.require(input.agentId, input.taskId);
      // A turn that starts or ends after the Stop still counts toward the limits of its open task.
      if (this.#mailbox.taskBusy(found.agentId, found.taskId))
        throw new Error(sourceText("error.backend.taskStillRunning"));
      return found;
    });
    this.#tasks.close(task);
    // A task lane that waited for a free task can start now.
    this.#drain.scheduleDrain(task.agentId);
  }).bind(this);

  reopenTask(input: AgentTaskInput): void {
    this.#tasks.reopen(this.#tasks.require(input.agentId, input.taskId));
    this.#drain.scheduleDrain(input.agentId);
  }

  acknowledgeFailedTurn(agentId: string, turnId: string): void {
    this.#turn.acknowledgeFailedTurn(agentId, turnId);
  }

  /**
   * A person changes only their own queued message. A teammate's message, a Motion note, a note from
   * Atelier or a mail waits in the same queue, but only its sender may change it
   * (`isOwnQueuedMessage`). A delivery that is gone passes, so the operation reports it as before.
   */
  #ownQueuedMessage(agentId: string, deliveryId: string, operation: string): Effect.Effect<void, AgentLifecycleFailed> {
    const delivery = this.listQueue(agentId).deliveries.find((item) => item.id === deliveryId);
    return delivery && !isOwnQueuedMessage(delivery)
      ? Effect.fail(new AgentLifecycleFailed({ operation, cause: new Error(sourceText("error.backend.queueNotOwn")) }))
      : Effect.void;
  }

  /** Cancels a queued message for the person who asks: only one of their own (`#ownQueuedMessage`). */
  cancelOwnQueuedMessage(agentId: string, deliveryId: string): Effect.Effect<void, AgentLifecycleFailed> {
    return this.#ownQueuedMessage(agentId, deliveryId, "cancelQueuedMessage").pipe(
      Effect.andThen(() => this.cancelQueuedMessage(agentId, deliveryId)),
    );
  }

  cancelQueuedMessage(agentId: string, deliveryId: string): Effect.Effect<void, AgentLifecycleFailed> {
    return this.#queue
      .cancel(agentId, deliveryId)
      .pipe(
        Effect.mapError(
          (failure) => new AgentLifecycleFailed({ operation: "cancelQueuedMessage", cause: failure.cause }),
        ),
      );
  }

  /**
   * Gives a channel task that a spent plan holds back to its channel, so its assignment does not
   * reserve the host until the reset. A task of a channel routine set to skip is dropped instead.
   */
  #requeueChannelDelivery(deliveryId: string, continueWork = false): Effect.Effect<boolean> {
    return this.channels.requeueForLimit(deliveryId, continueWork);
  }

  /**
   * What a spent plan does to the queues it now holds. A channel task goes back to its channel, and
   * a wake lets each channel drop the queued tasks of routines set to skip. A routine set to skip
   * leaves the agent's queue too, because its result is no use when late; cancelling the delivery
   * settles the run.
   */
  readonly #settleHeldQueues = Effect.fn("AgentService.settleHeldQueues")(function* (
    this: AgentService,
    agentIds: readonly string[],
  ) {
    const failed = (failure: { readonly cause: unknown }) =>
      new AgentLifecycleFailed({ operation: "settleHeldQueues", cause: failure.cause });
    yield* this.channels.wake().pipe(Effect.mapError(failed));
    for (const agentId of agentIds) {
      for (const deliveryId of this.#mailbox.queuedDeliveryIds(agentId)) {
        if (
          !this.channels.store.assignmentForDelivery(deliveryId) ||
          !(yield* this.#requeueChannelDelivery(deliveryId))
        )
          continue;
        yield* this.#mailbox.cancel(agentId, deliveryId).pipe(Effect.mapError(failed));
        this.#mailboxSync.emitQueue(agentId);
      }
      const skipped = new Set(
        this.#routines
          .listRecordsFor(agentId)
          .filter((routine) => routine.limitPolicy === "skip")
          .map((routine) => routine.id),
      );
      if (skipped.size === 0) continue;
      for (const delivery of this.listQueue(agentId).deliveries) {
        if (delivery.status !== "queued" || delivery.sender.kind !== "routine") continue;
        if (skipped.has(delivery.sender.routineId))
          yield* this.#queue.cancel(agentId, delivery.id).pipe(Effect.mapError(failed));
      }
    }
  });

  /** A saved edit is the editor's text, so `sender` becomes the sender of the message. */
  editQueuedMessage(
    agentId: string,
    input: QueueEditRequest,
    sender?: ConversationMessageSender,
  ): Effect.Effect<QueueSnapshot, AgentLifecycleFailed> {
    return this.#ownQueuedMessage(agentId, input.deliveryId, "editQueuedMessage")
      .pipe(Effect.andThen(() => this.#queue.edit(agentId, input, sender)))
      .pipe(
        Effect.mapError(
          (failure) => new AgentLifecycleFailed({ operation: "editQueuedMessage", cause: failure.cause }),
        ),
      );
  }

  updateQueuedMessage(
    input: UpdateQueuedMessageInput,
    sender?: ConversationMessageSender,
  ): Effect.Effect<void, AgentLifecycleFailed> {
    return this.#ownQueuedMessage(input.agentId, input.deliveryId, "updateQueuedMessage")
      .pipe(Effect.andThen(() => this.#queue.update(input, sender)))
      .pipe(
        Effect.mapError(
          (failure) => new AgentLifecycleFailed({ operation: "updateQueuedMessage", cause: failure.cause }),
        ),
      );
  }

  reorderQueue(input: ReorderQueueInput): Effect.Effect<void, AgentLifecycleFailed> {
    return this.#queue
      .reorder(input)
      .pipe(
        Effect.mapError((failure) => new AgentLifecycleFailed({ operation: "reorderQueue", cause: failure.cause })),
      );
  }

  steerQueuedMessage(input: SteerQueuedMessageInput): Effect.Effect<void, AgentLifecycleFailed> {
    // A steer gives a queued message to the running turn. The queue of a hidden agent waits.
    if (this.#store.isHidden(input.agentId))
      return Effect.fail(
        new AgentLifecycleFailed({
          operation: "steerQueuedMessage",
          cause: new Error(sourceText("error.backend.recipientHidden")),
        }),
      );
    return this.#ownQueuedMessage(input.agentId, input.deliveryId, "steerQueuedMessage")
      .pipe(Effect.andThen(() => this.#queue.steer(input)))
      .pipe(
        Effect.mapError(
          (failure) => new AgentLifecycleFailed({ operation: "steerQueuedMessage", cause: failure.cause }),
        ),
      );
  }

  /**
   * `sender` is the person the host saw send it. It is not part of `SendMessageInput`: the caller of
   * that input, a renderer or a Team API body, never names who it is. `timezone` is the zone of a
   * Team API member's client, when it sent one.
   *
   * A `clientMessageId` the same sender used for this agent within a day returns the first receipt. The
   * key is a hash, so it fits the identifier bound whatever the ids are, and has no `:`-separated
   * turn id for the mailbox to read.
   */
  /**
   * The turn limits of this host changed. A higher limit can start a waiting turn now; a lower one
   * stops no running turn, and the next turn waits.
   */
  turnLimitsChanged(): void {
    for (const agent of this.#store.list()) {
      this.#tasks.changed(agent.id);
      this.#drain.scheduleDrain(agent.id);
    }
    this.#drain.retrySlotWaiters();
  }

  /** See `#restartInterruptedDeliveryIds`. */
  restartInterruptedDeliveryIds(): ReadonlySet<string> {
    return this.#restartInterruptedDeliveryIds;
  }

  readonly sendMessage = Effect.fn("AgentService.sendMessage")(function* (
    this: AgentService,
    sent: SendMessageInput,
    sender?: ConversationMessageSender,
    timezone?: string,
    /** Sends the text as a note from OpenBot itself, not the person: the chat shows a marker. */
    notice?: SystemNoticeKind,
    /** A `motion-event` note that needs no action now: it waits for the agent's next turn. */
    fyi?: boolean,
  ): Effect.fn.Return<QueuedMessageReceipt, AgentLifecycleFailed> {
    // A notice has no person behind it.
    const person = notice ? undefined : sender;
    // The message boxes hide a pasted key before they send; a task reply, a routine flow, the phone
    // app and an older client do not. The thread stores what this passes on, and the agent reads it.
    const input = notice ? sent : { ...sent, text: hideChannelSecrets(sent.text, "person") };
    if (!input.clientMessageId)
      return yield* this.#sendUserMessage(input, person, timezone, undefined, undefined, notice, fyi);
    const idempotencyKey = `user-send:${createHash("sha256")
      .update(JSON.stringify([person?.id ?? null, input.agentId, input.clientMessageId]))
      .digest("hex")}`;
    // Every user message adds a key, and the map is persisted whole, so keys older than the window go.
    this.#mailbox.forgetIdempotencyKeys("user-send:", new Date(Date.now() - USER_SEND_RETRY_WINDOW_MS));
    const stored = this.#mailbox.receiptForKey(idempotencyKey);
    if (stored) return stored;
    const pending = this.#pendingUserSends.get(idempotencyKey);
    if (pending) return yield* Deferred.await(pending);
    const send = Deferred.makeUnsafe<QueuedMessageReceipt, AgentLifecycleFailed>();
    this.#pendingUserSends.set(idempotencyKey, send);
    return yield* this.#sendUserMessage(input, person, timezone, idempotencyKey, undefined, notice, fyi).pipe(
      Effect.onExit((exit) => Deferred.done(send, exit)),
      Effect.ensuring(Effect.sync(() => this.#pendingUserSends.delete(idempotencyKey))),
    );
  }).bind(this);

  readonly #sendUserMessage = Effect.fn("AgentService.sendUserMessage")(function* (
    this: AgentService,
    input: SendMessageInput,
    sender: ConversationMessageSender | undefined,
    timezone: string | undefined,
    idempotencyKey?: string,
    fromAgentId?: string,
    notice?: SystemNoticeKind,
    fyi?: boolean,
  ) {
    const validateRecipient = yield* lifecycleStep("prepare message delivery", () =>
      this.#mailbox.prepareDelivery([input.agentId]),
    );
    if (this.#duplication.isPending(input.agentId))
      return yield* new AgentLifecycleFailed({
        operation: "send message",
        cause: new Error(sourceText("error.agent.unknown", { id: input.agentId })),
      });
    yield* lifecycleStep("send message", () => this.#requireNotHidden(input.agentId));
    const agent = yield* this.#store
      .getOrCreate(input.agentId)
      .pipe(
        Effect.mapError(
          (failure) => new AgentLifecycleFailed({ operation: "load message agent", cause: failure.cause }),
        ),
      );
    yield* this.#providers
      .ensureProvider(providerForAgent(agent))
      .pipe(
        Effect.mapError(
          (failure) => new AgentLifecycleFailed({ operation: "ensure message provider", cause: failure.cause }),
        ),
      );
    yield* lifecycleStep("validate message recipient", () => {
      validateRecipient();
      // The provider start can wait, and the user can hide the agent in that time.
      this.#requireNotHidden(input.agentId);
    });
    // A message to a task runs in the task's own thread and lane, beside the agent's own chat.
    const taskId = input.taskId;
    const task = taskId
      ? yield* lifecycleStep("find message task", () => this.#tasks.requireOpen(agent.id, taskId))
      : null;
    const receipt = yield* this.#mailbox
      .enqueue({
        // An agent that creates this one sends the first task as a teammate request.
        sender: fromAgentId ? { kind: "agent", agentId: fromAgentId } : { kind: "user" },
        ...(sender && !fromAgentId ? { senderMember: sender } : {}),
        ...(notice && !fromAgentId ? { notice } : {}),
        ...(fyi && notice === "motion-event" && !fromAgentId ? { fyi: true } : {}),
        ...(task ? { taskId: task.taskId } : {}),
        recipientAgentIds: [agent.id],
        text: input.text,
        draftIds: input.attachmentDraftIds ?? [],
        ...(input.voiceRecordingDraftId ? { voiceRecordingDraftId: input.voiceRecordingDraftId } : {}),
        // A reply names a message of the agent's own chat, which a task does not show.
        replyToMessageId: task ? null : (input.replyToMessageId ?? null),
        ...(idempotencyKey ? { idempotencyKey } : {}),
      })
      .pipe(
        Effect.mapError((failure) => new AgentLifecycleFailed({ operation: "enqueue message", cause: failure.cause })),
      );
    const [queued] = receipt.deliveries;
    const delivery = queued ? this.#mailbox.getDelivery(queued.id) : null;
    if (!delivery)
      return yield* new AgentLifecycleFailed({
        operation: "send message",
        cause: new Error(sourceText("error.agent.queuedMessageCreateFailed")),
      });
    // The task can close while the message is stored, and a closed task shows no queue to cancel it.
    if (task && this.#tasks.threadId(task.taskId) === null) {
      yield* this.cancelQueuedMessage(agent.id, delivery.delivery.id);
      return yield* new AgentLifecycleFailed({
        operation: "send message",
        cause: new Error(sourceText("error.backend.taskClosed")),
      });
    }
    if (timezone !== undefined) this.#routines.noteDeliveryTimezone(delivery.delivery.id, timezone);
    const snapshot = this.#conversation.ensureSnapshot(agent.id, task?.threadId ?? agent.threadId);
    // A task message shows in the task's row until its turn starts, not in the agent's own chat.
    if (!task) this.#mailboxSync.syncMailboxMessages(snapshot);
    // A notice is not a message of the chat, so the preview keeps the last one.
    if (!task && !notice)
      yield* this.#store
        .updatePreview(
          agent.id,
          displayMessageReferences(
            delivery.delivery.text,
            delivery.delivery.attachments,
            agentNamesById(this.#store.list()),
            { fileHeadings: false },
          ) || delivery.delivery.attachments.map((item) => item.name).join(", "),
        )
        .pipe(
          // The message is already queued: a failed preview write must not leave it without a drain,
          // and a retry with the same id returns the stored receipt without one.
          Effect.catch((failure) =>
            Effect.sync(() => this.#emitError("message_preview_failed", failure.cause, agent.id)),
          ),
        );
    const steerTurnId = this.#steerTurnId(
      agent,
      snapshot.activeTurnId,
      task ? this.#tasks.stoppedTurn(task.taskId) : this.#stoppedTurns.get(agent.id),
    );
    const steers = steerTurnId !== null && agentProviderDescriptor(providerForAgent(agent)).steer === "native";
    // A routine run's own session ends with the run, so a chat message waits for the next turn.
    const routineRuns = !task && this.#conversation.routineSession(agent.id) !== undefined;
    if (steerTurnId && !steers) yield* this.#markSteerFallback(agent.id, delivery.delivery.id, "provider-unsupported");
    else if (steerTurnId && routineRuns) yield* this.#markSteerFallback(agent.id, delivery.delivery.id, "steer-failed");
    if (!task) {
      this.#emit({ type: "agents-changed", agents: this.listAgents() });
      this.#conversation.emitConversation(snapshot);
    }
    this.#mailboxSync.emitQueue(agent.id);
    // Not awaited: the message is already queued, and the sender is answered without the wait for
    // the provider.
    if (steerTurnId && steers && !routineRuns)
      yield* this.#steerSentMessage(agent, snapshot.threadId ?? agent.threadId, delivery.delivery.id, steerTurnId).pipe(
        Effect.forkIn(this.#scope),
      );
    this.#drain.scheduleDrain(agent.id);
    return receipt;
  }, Effect.uninterruptible).bind(this);

  /**
   * Takes a message the user sent while the agent works into the running turn. The message is
   * queued before this runs, so a refusal leaves it there: it says why on its row and starts when
   * the turn ends. Only a provider that reads a message at its next step is asked; the ACP ones can
   * hold a second prompt until the turn ends, which is a queue the user cannot see.
   */
  readonly #steerSentMessage = Effect.fn("AgentService.steerSentMessage")(function* (
    this: AgentService,
    agent: AgentSummary,
    threadId: string | null,
    deliveryId: string,
    turnId: string,
  ) {
    yield* this.#queue.steer({ agentId: agent.id, deliveryId, expectedTurnId: turnId }).pipe(
      Effect.catch((failure) =>
        Effect.gen({ self: this }, function* () {
          logger.warn("A message sent to steer the running turn waits in the queue.", {
            agentId: agent.id,
            error: failure.cause,
          });
          // When the turn ended in between, the message starts as the next turn or waits behind it
          // like any other, which is no fallback worth naming.
          if (this.#conversation.ensureSnapshot(agent.id, threadId).activeTurnId !== turnId) return;
          yield* this.#markSteerFallback(agent.id, deliveryId, "steer-failed");
          this.#mailboxSync.emitQueue(agent.id);
        }),
      ),
    );
  });

  /**
   * The turn that a new message may join: the running one, when the agent steers by default. A turn
   * the user stopped is ending, and a message steered into it would end with it.
   */
  #steerTurnId(
    agent: AgentSummary,
    activeTurnId: string | null,
    stoppedTurnId: string | null | undefined,
  ): string | null {
    // A turn that answers a Discord message posts its answer there: another message waits for its own turn.
    return activeTurnId &&
      activeTurnId !== stoppedTurnId &&
      !this.messaging.answersExternalMessage(activeTurnId) &&
      (agent.busyMessageMode ?? this.#busyMessageMode()) === "steer"
      ? activeTurnId
      : null;
  }

  /**
   * A message from another agent joins the running turn of a busy agent, as a message from the user
   * does, under the same preference. It is queued already, so a refusal leaves it there with its
   * reason on the row. The sender is answered without the wait for the provider.
   */
  readonly #steerAgentMessage = Effect.fn("AgentService.steerAgentMessage")(function* (
    this: AgentService,
    agentId: string,
    deliveryId: string,
  ) {
    const agent = this.#store.list().find((candidate) => candidate.id === agentId);
    if (!agent || this.#mailbox.getDelivery(deliveryId)?.delivery.status !== "queued") return;
    // A message to a task waits for its own lane; only the agent's own chat takes a steered message.
    if (this.#mailbox.taskIdForDelivery(deliveryId)) return;
    const turnId = this.#steerTurnId(
      agent,
      this.#conversation.ensureSnapshot(agent.id, agent.threadId).activeTurnId,
      this.#stoppedTurns.get(agent.id),
    );
    if (!turnId) return;
    if (agentProviderDescriptor(providerForAgent(agent)).steer !== "native") {
      yield* this.#markSteerFallback(agent.id, deliveryId, "provider-unsupported");
      this.#mailboxSync.emitQueue(agent.id);
      return;
    }
    // A routine run's own session ends with the run, so the message waits for the next turn.
    if (this.#conversation.routineSession(agent.id) !== undefined) {
      yield* this.#markSteerFallback(agent.id, deliveryId, "steer-failed");
      this.#mailboxSync.emitQueue(agent.id);
      return;
    }
    yield* this.#steerSentMessage(agent, agent.threadId, deliveryId, turnId).pipe(Effect.forkIn(this.#scope));
  });

  /** The reason is a label on the queue row, so a failed write leaves the message queued without it. */
  #markSteerFallback(agentId: string, deliveryId: string, reason: QueueSteerFallback): Effect.Effect<void> {
    return this.#mailbox
      .markSteerFallback(deliveryId, reason)
      .pipe(
        Effect.catch((failure) =>
          Effect.sync(() =>
            logger.warn("Could not record why a message waits in the queue.", { agentId, error: failure.cause }),
          ),
        ),
      );
  }

  readonly setMessageReaction = Effect.fn("AgentService.setMessageReaction")(function* (
    this: AgentService,
    input: SetMessageReactionInput,
  ) {
    const agent = yield* this.#store
      .existing(input.agentId)
      .pipe(
        Effect.mapError(
          (failure) => new AgentLifecycleFailed({ operation: "load reaction agent", cause: failure.cause }),
        ),
      );
    const snapshot = this.#conversation.ensureSnapshot(agent.id, agent.threadId);
    if (!snapshot.messages.some((message) => message.id === input.messageId)) {
      const [message] = this.#store.database.readConversationMessages(agent.id, agent.threadId, [input.messageId]);
      if (message) snapshot.messages.push(message);
    }
    if (!snapshot.messages.some((message) => message.id === input.messageId)) {
      return yield* new AgentLifecycleFailed({
        operation: "set message reaction",
        cause: new Error(sourceText("error.agent.messageUnavailable")),
      });
    }
    yield* this.#mailbox
      .setReaction(agent.id, input.messageId, { kind: "user" }, input.emoji)
      .pipe(
        Effect.mapError(
          (failure) => new AgentLifecycleFailed({ operation: "set message reaction", cause: failure.cause }),
        ),
      );
    this.#mailboxSync.syncMailboxMessages(snapshot);
    this.#conversation.emitConversation(snapshot);
  }, Effect.uninterruptible).bind(this);

  /** The channel, task or messaging thread of a delivery, or null for the agent's own chat. */
  #deliveryThreadId(deliveryId: string): string | null {
    const assignment = this.channels.store.assignmentForDelivery(deliveryId);
    return assignment
      ? this.channels.store.context(assignment.channelId, assignment.agentId).threadId
      : (this.#tasks.threadForDelivery(deliveryId) ?? this.messaging.threadForDelivery(deliveryId));
  }

  interrupt(agentId: string, turnId: string, executionThreadId?: string): Effect.Effect<void, AgentLifecycleFailed> {
    return Effect.suspend(() => {
      if (!executionThreadId) this.#stoppedTurns.set(agentId, turnId);
      return this.#interruptTurn(agentId, turnId, executionThreadId);
    }).pipe(Effect.asVoid);
  }

  /**
   * `mayStop` is for `interrupt_agent`, whose checks run before the await below. In that time the
   * turn can end, and the next one, which another sender can own, starts: ACP and Claude stop
   * whatever turn runs, not `turnId`. Or the user can steer a message into the turn. So the turn
   * must still run, and `mayStop` is asked again, just before the stop is sent. `false` means no
   * stop was sent.
   */

  readonly #interruptTurn = Effect.fn("AgentService.interruptTurn")(function* (
    this: AgentService,
    agentId: string,
    turnId: string,
    executionThreadId?: string,
    mayStop?: () => boolean,
  ) {
    const agent = yield* this.#store
      .existing(agentId)
      .pipe(
        Effect.mapError(
          (failure) => new AgentLifecycleFailed({ operation: "load interrupted agent", cause: failure.cause }),
        ),
      );
    // No provider runs a turn whose end failed part way or whose provider exited, so it has nothing to
    // stop. The Stop then settles what OpenBot still holds for the turn, and the queue frees (#2214).
    // A turn that the drain started can wait for its `turn/started` with a snapshot already on it:
    // that turn is live, and only the provider can stop it. A turn whose normal end runs settles itself.
    if (!mayStop && this.#turn.turnStartedAt(turnId) === null && !this.#turn.isCompleting(turnId)) {
      const owner = this.#conversation.snapshotWithTurn(agentId, turnId);
      if (!owner || this.#turn.hasEnded(turnId)) {
        const deliveries = yield* lifecycleStep("find interrupted deliveries", () =>
          this.#mailbox.findDeliveriesByTurn(agentId, turnId),
        );
        if (owner || deliveries.length > 0) {
          const firstDelivery = deliveries[0]?.delivery.id;
          const threadId =
            executionThreadId ?? owner?.threadId ?? (firstDelivery ? this.#deliveryThreadId(firstDelivery) : null);
          yield* this.#turn.settleOrphanedTurn(agentId, threadId, turnId, "interrupted");
          return true;
        }
      }
    }
    const client = yield* lifecycleStep("find interrupt provider", () =>
      this.#providers.requireReadyClientForAgent(agent),
    );
    const snapshot = [...this.#conversation.activeSnapshots()].find(
      ([id, snapshot]) => id === agentId && snapshot.activeTurnId === turnId,
    )?.[1];
    if (mayStop && (!snapshot || !mayStop())) return false;
    // A Stop for a turn that already ended must not reach the next turn: ACP and Claude stop the
    // running turn, whatever `turnId` says. A channel thread is not in these snapshots.
    if (!executionThreadId && !snapshot) return false;
    const targetThreadId = executionThreadId ?? snapshot?.threadId;
    const session = this.#runningSession(agent, targetThreadId);
    if (!session) return false;
    this.#images.interrupt(agentId, session, turnId);
    const response = yield* client
      .request("turn/interrupt", { threadId: session, turnId }, decodeRecordResponse)
      .pipe(
        Effect.mapError((failure) => new AgentLifecycleFailed({ operation: "interrupt turn", cause: failure.cause })),
      );
    // The provider does not run this turn, and only the chat still names it: a user Stop ends it.
    if (!mayStop && response.turnActive === false && this.#turnRunsOnlyInSnapshot(agentId, turnId)) {
      logger.warn("Stop found a chat turn that its provider does not run. It ends as interrupted.", {
        agentId,
        turnId,
      });
      yield* this.#turn.settleOrphanedTurn(agentId, targetThreadId ?? null, turnId, "interrupted");
    }
    return true;
  }, Effect.uninterruptible);

  /**
   * No running, completing or ended record of the turn: a `turn/completed` on its way keeps the
   * running record, so Stop does not end that turn twice.
   */
  #turnRunsOnlyInSnapshot(agentId: string, turnId: string): boolean {
    return (
      this.#turn.turnStartedAt(turnId) === null &&
      !this.#turn.isCompleting(turnId) &&
      !this.#turn.hasEnded(turnId) &&
      this.#conversation.snapshotWithTurn(agentId, turnId) !== undefined
    );
  }

  /**
   * The provider session that runs the turn of this thread: a routine run's own session while one
   * runs in the agent's chat, else the thread's active session. No thread means the agent's chat.
   */
  #runningSession(agent: AgentSummary, threadId: string | null | undefined): string | undefined {
    const publicThreadId = threadId ?? agent.threadId;
    if (!publicThreadId) return undefined;
    return (
      (publicThreadId === agent.threadId ? this.#conversation.routineSession(agent.id) : undefined) ??
      this.#store.database.activeProviderSession(publicThreadId, agent.provider)?.externalSessionId
    );
  }

  readonly interruptAll = Effect.fn("AgentService.interruptAll")(function* (this: AgentService) {
    if (!this.#providers.isReady()) return;
    const requests: Effect.Effect<unknown>[] = [];
    for (const [agentId, snapshot] of this.#conversation.activeSnapshots()) {
      const turnId = snapshot.activeTurnId;
      if (!snapshot.threadId || !turnId) continue;
      const agent = this.#store.list().find((candidate) => candidate.id === agentId);
      const client = agent ? this.#providers.clientForAgent(agent) : null;
      const session = agent ? this.#runningSession(agent, snapshot.threadId) : undefined;
      if (!client || !session) continue;
      this.#images.interrupt(agentId, session, turnId);
      requests.push(
        client
          .request(
            "turn/interrupt",
            {
              threadId: session,
              turnId,
            },
            decodeRecordResponse,
          )
          .pipe(
            Effect.mapError(
              (failure) => new AgentLifecycleFailed({ operation: "interrupt active turn", cause: failure.cause }),
            ),
          )
          .pipe(
            Effect.catch((failure) => Effect.sync(() => this.#emitError("interrupt_failed", failure.cause, agentId))),
          ),
      );
    }
    yield* Effect.all(requests, { concurrency: "unbounded", discard: true });
  }, Effect.uninterruptible).bind(this);

  /** `responder` is absent for the person at this computer; the Team API gives the member who answers. */
  respondToPrompt(input: RespondToPromptInput, responder?: PromptResponder): Effect.Effect<void, AgentLifecycleFailed> {
    return this.#attention
      .respondToPrompt(input, responder)
      .pipe(
        Effect.mapError((failure) => new AgentLifecycleFailed({ operation: "respondToPrompt", cause: failure.cause })),
      );
  }

  /** `responder` is absent for the person at this computer; the Team API gives the member who answers. */
  respondToApproval(
    input: RespondToApprovalInput,
    responder?: ApprovalResponder,
  ): Effect.Effect<void, AgentLifecycleFailed> {
    return this.#attention
      .respondToApproval(input, responder)
      .pipe(
        Effect.mapError(
          (failure) => new AgentLifecycleFailed({ operation: "respondToApproval", cause: failure.cause }),
        ),
      );
  }

  respondToBrowserSecret(input: LocalBrowserSecretResponse): Effect.Effect<void, AgentLifecycleFailed> {
    return this.#attention
      .respondToBrowserSecret(input)
      .pipe(
        Effect.mapError(
          (failure) => new AgentLifecycleFailed({ operation: "respondToBrowserSecret", cause: failure.cause }),
        ),
      );
  }

  respondToBrowserTakeover(input: RespondToBrowserTakeoverInput): Effect.Effect<void, AgentLifecycleFailed> {
    return this.#attention
      .respondToBrowserTakeover(input)
      .pipe(
        Effect.mapError(
          (failure) => new AgentLifecycleFailed({ operation: "respondToBrowserTakeover", cause: failure.cause }),
        ),
      );
  }

  #emitError(code: string, error: unknown, agentId?: string, context?: FailureContext): void {
    this.emit("failure", {
      ...context,
      code,
      ...(agentId !== undefined ? { agentId } : {}),
      causeCode: context?.causeCode ?? classifyFailure(error),
    });
    this.#emit({
      type: "error",
      ...(agentId !== undefined ? { agentId } : {}),
      code,
      // Redacted, because every error from a provider CLI arrives here on its way to the renderer
      // and the log, and a CLI quotes what it was given: a failure against a custom endpoint can
      // carry that endpoint's API key or a header value.
      message: this.#mcp.redact(error instanceof Error ? error.message : String(error)),
      ...(context?.provider ? { provider: context.provider } : {}),
      ...(context?.model ? { model: context.model } : {}),
    });
  }

  #emitRuntimeSnapshot(): void {
    this.#emit({ type: "runtime-snapshot", snapshot: this.getRuntimeSnapshot() });
  }

  /**
   * Sends the whole list of requests that wait for the user after an event that can change it, when
   * it changed. It goes past the channel and task routing, as the escalations do: it is every agent's.
   */
  #observeAttention(event: AgentEvent): void {
    if (!ATTENTION_LIST_EVENTS.has(event.type)) return;
    const items = this.#attentionList();
    const encoded = JSON.stringify(items);
    if (encoded === this.#attentionEncoded) return;
    this.#attentionEncoded = encoded;
    this.emit("event", { type: "agent-attention-changed", items });
  }

  #emit(event: AgentEvent): void {
    recordAgentRestartActivity(event);
    // The account in use is not saved: a new reading, as at start, sets it again.
    if (event.type === "usage-changed") for (const provider of AGENT_PROVIDERS) this.#refreshPoolInUse(provider);
    // Before the event: a client learns who delegated a request before the request arrives.
    this.#escalations?.observe(event);
    this.#observeAttention(event);
    this.#modelPolicy.observe(event);
    this.#guardrails?.observe(event);
    if (event.type === "agents-changed") this.playbooks.scheduleSync();
    // Before the channels and the tasks take theirs: the fleet follows the turns of channel threads too.
    this.workspace?.observe(event);
    if (this.channels?.event(event) || this.messaging?.event(event, this.#scope) || this.#tasks?.event(event)) return;
    this.emit("event", event);
  }

  /** Removes live provider state for an execution thread before its durable rows are deleted. */

  readonly #forgetExecutionThread = Effect.fn("AgentService.forgetExecutionThread")(function* (
    this: AgentService,
    threadId: string,
  ) {
    const sessions = yield* lifecycleStep("list execution sessions", () =>
      this.#store.database.listProviderSessions(threadId),
    );
    for (const session of sessions)
      yield* this.#threads
        .deleteProviderSessionFiles(session.externalSessionId, session.id)
        .pipe(
          Effect.mapError(
            (failure) =>
              new AgentLifecycleFailed({ operation: "delete execution session files", cause: failure.cause }),
          ),
        );
    for (const session of sessions) {
      this.#conversation.unbindThread(session.externalSessionId);
      this.#conversation.unloadThread(session.externalSessionId);
      this.#compaction.endThread(session.externalSessionId);
    }
    this.#conversation.forgetExecutionThread(threadId);
  }, Effect.uninterruptible);
}

export class AgentLifecycleFailed extends Schema.TaggedError<AgentLifecycleFailed>()("AgentLifecycleFailed", {
  operation: Schema.String,
  cause: Schema.Defect(),
}) {}

/** How often a pool reads the usage of its accounts again while its agents work: the interval of the rail. */
const POOL_READ_INTERVAL_MS = 4 * 60_000;

/** Why `#usageLimitMove` changes an agent's model, when it is not the switch for a usage limit. */
type ModelMove = "return" | "provider-error" | "next-turn" | "pool-failover";

/** The fields of an update that a queued `pendingRuntime` holds. */
const RUNTIME_UPDATE_KEYS: ReadonlySet<string> = new Set([
  "agentId",
  "provider",
  "model",
  "reasoningEffort",
  "providerAccountId",
  "leaveUsageLimit",
]);

const MODEL_SWITCH_TEXT = {
  "usage-limit": "status.agent.modelSwitchedForLimit",
  "usage-limit-ended": "status.agent.modelReturnedAfterLimit",
  "provider-error": "status.agent.modelSwitchedForError",
  "provider-error-ended": "status.agent.modelReturnedAfterError",
} as const;

function agentModelChoice(agent: AgentSummary): AgentModelChoice {
  return {
    provider: agent.provider,
    model: agent.model,
    ...(agent.providerAccountId ? { providerAccountId: agent.providerAccountId } : {}),
  };
}

function usageLimitOf(choice: AgentModelChoice): UsageLimitKey {
  return { provider: choice.provider, accountId: agentProviderAccount(choice), model: choice.model };
}

function sameUsageLimit(choice: AgentModelChoice, limit: UsageLimitKey): boolean {
  const own = usageLimitOf(choice);
  return own.provider === limit.provider && own.accountId === limit.accountId && own.model === limit.model;
}

function lifecycleStep<A>(operation: string, run: () => A): Effect.Effect<A, AgentLifecycleFailed> {
  return Effect.try({ try: run, catch: (cause) => new AgentLifecycleFailed({ operation, cause }) });
}

/** These tasks already run; stopping the service joins them without starting new work. */
function settleLifecycleTasks<A>(
  operation: string,
  tasks: readonly Effect.Effect<A, { readonly cause: unknown }>[],
): Effect.Effect<void> {
  return Effect.forEach(
    tasks,
    (task) =>
      task
        .pipe(Effect.mapError((failure) => new AgentLifecycleFailed({ operation: operation, cause: failure.cause })))
        .pipe(Effect.result),
    {
      concurrency: "unbounded",
      discard: true,
    },
  );
}
