import { execFile, spawn } from "node:child_process";
import { randomUUID, type UUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import {
  type CanUseTool,
  createSdkMcpServer,
  type HookCallbackMatcher,
  type ModelInfo,
  type Options,
  type PermissionResult,
  query,
  type SDKUserMessage,
  type SessionMessage,
  type Settings,
  type SpawnedProcess,
  type SpawnOptions,
  tool,
} from "@anthropic-ai/claude-agent-sdk";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { INPUT_LIMITS } from "@openbot/contracts/input-limits";
import { type AgentContextCategoryUsage, defaultProviderModel } from "@openbot/contracts/ipc";
import { type DynamicRecord, isDynamicRecord, isNumber, isOneOf, isString } from "@openbot/contracts/runtime-values";
import { sourceText } from "@openbot/i18n/source";
import { createOpenBotLogger } from "@openbot/logging";
import { Deferred, Effect, Exit, Fiber, Scope } from "effect";
import {
  isTurnContextBlock,
  type MemoryContext,
  memoryContextUpdate,
  type SectionTeammates,
  sectionTeammatesUpdate,
} from "./agent/developer-instructions";
import {
  type ClaudePlanState,
  foldClaudePlanCall,
  foldClaudePlanResult,
  newClaudePlanState,
  PLAN_UPDATED_METHOD,
  type PlanUpdateStep,
  startClaudePlanTurn,
} from "./agent/plan-updates";
import { isBalanceDiagnostic, isPlanLimitDiagnostic } from "./agent/provider-diagnostics";
import {
  type ClaudeSubagentState,
  endClaudeSubagentTurn,
  foldClaudeSubagentCall,
  foldClaudeSubagentMessage,
  foldClaudeSubagentResult,
  foldClaudeTaskMessage,
  newClaudeSubagentState,
  SUBAGENTS_UPDATED_METHOD,
  type SubagentChange,
  stopClaudeSubagents,
} from "./agent/subagent-updates";
import { claudeBridgedToolName, VISIBLE_TOOL_DEFINITIONS } from "./agent/tool-catalog";
import { USAGE_LIMIT_METHOD } from "./agent/usage-limit-gate";
import {
  type AgentProvider,
  MissingClaudeSessionError,
  ProviderTurnActiveError,
  RequestTimeoutError,
} from "./agent-client";
import { agentInheritedEnvironment } from "./agent-inherited-environment";
import {
  type AgentJail,
  type AgentJailPlan,
  AgentJailUnavailableError,
  seedClaudeGlobalConfig,
  spawnJailed,
} from "./agent-jail";
import { claudeContextCategories } from "./claude-context-categories";
import {
  type ClaudeHistoryOptions,
  claudeHistoryFromMessages,
  claudeHistoryReader,
  claudeTranscriptExists,
} from "./claude-history";
import {
  CLAUDE_WORKSPACE_MANAGED_SETTINGS,
  claudeHomeSkillPlugin,
  claudeWorkspaceHooks,
  claudeWorkspaceSandbox,
  claudeWorkspaceSkillPlugin,
  claudeWriteOutsideRoots,
} from "./claude-workspace-sandbox";
import {
  type ClaudeCliInfo,
  claudeTakesPromptSnapshotFlag,
  cliLaunchPath,
  cliPathEnvironment,
  cliSpawnTarget,
} from "./cli";
import {
  isClaudeCompactionSummary,
  isClaudeInterruptMarker,
  isClaudeLocalCommand,
  isClaudeTaskNotification,
} from "./conversation-snapshots";
import { runCauseEffect } from "./effect-boundary";
import { untrustedNote } from "./guardrails/injection-guard";
import {
  guardedClaudeToolUse,
  toolCommand,
  toolInputDigest,
  toolResultFields,
  untrustedClaudeResult,
} from "./guardrails/tool-fingerprint";
import { skillFolderNames } from "./home-skills";
import { IdleThreadPool } from "./idle-thread-pool";
import {
  agentMcpServers,
  type ClaudeMcpServer,
  claudeMcpServers,
  computerUseParam,
  type McpDropReporter,
  type McpEndpointSource,
  type McpServerSource,
  type McpToolRuntimeSource,
  usableMcpServers,
} from "./mcp-provider-shapes";
import { normalizeSendMessageArguments } from "./openbot-tools";
import { PendingServerRequests } from "./pending-server-requests";
import { readTaskLimit, type TaskLimitState, taskLimitReachedSince } from "./process-limit";
import {
  type AccountRateLimitsReadResult,
  type AccountRateLimitWindowResult,
  type AccountReadResult,
  type AppServerNotification,
  type AppServerRequest,
  CLAUDE_API_KEY_ACCOUNT_TYPE,
  getString,
  isRecord,
  type RequestId,
  type ResponseDecoder,
  type RpcError,
  type ThreadItem,
  type ThreadResponse,
  type TurnResponse,
} from "./protocol";
import {
  type ProviderClientOperationError,
  providerCall,
  providerFailure,
  providerResult,
  providerSync,
  requiredString,
  toProviderClientOperationError,
} from "./provider-client-effects";
import type { ReadProviderHistory } from "./provider-history";
import { classifyToolUse, TRUST_CHECK_METHOD } from "./trust/trust-classifier";

const execFileAsync = promisify(execFile);
const CLAUDE_EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
type ClaudeEffort = (typeof CLAUDE_EFFORTS)[number];
/**
 * Claude's own scheduling: session crons, the `/loop` wake-ups, and the `schedule` skill, alias
 * `routines`, that makes claude.ai cloud agents. A routine request matched that skill, and the
 * routine ran outside OpenBot, where the user cannot see or stop it. Scheduled work belongs to the
 * OpenBot routine tools. A deny rule takes the tools out of the model's context; the CLI still lists
 * the two skills, but the rule refuses their call.
 */
const CLAUDE_NATIVE_SCHEDULING = [
  "CronCreate",
  "CronDelete",
  "CronList",
  "ScheduleWakeup",
  "RemoteTrigger",
  "Skill(schedule)",
  "Skill(loop)",
];

/**
 * Claude tools that duplicate an OpenBot feature or serve only the Claude Code app, which OpenBot does
 * not show. `ListAgents` finds the user's other Claude sessions past the teammate rules, `Workflow`
 * runs a background agent fleet, and the rest drive Claude Code's own review panel, design sync, phone
 * notifications and status line. Their schemas and agent listings cost about 2.5k tokens in each request.
 */
const CLAUDE_UNSHOWN_TOOLS = [
  "ListAgents",
  "Workflow",
  "Skill(workflow-authoring)",
  "ReportFindings",
  "DesignSync",
  "PushNotification",
  "Agent(statusline-setup)",
  "Agent(claude-code-guide)",
  "Agent(claude)",
];
/** Bundled skills that cannot work in OpenBot or are about Claude Code itself: they are off. */
const CLAUDE_UNFIT_SKILLS = [
  "deep-research",
  "design",
  "design-sync",
  "doctor",
  "fewer-permission-prompts",
  "keybindings-help",
  "loop",
  "plugin-authoring",
  "schedule",
  "send-to-project",
  "update-config",
  "workflow-authoring",
];
/** Bundled coding skills that stay usable, listed by name only: their descriptions cost about 1k tokens. */
const CLAUDE_NAME_ONLY_SKILLS = [
  "batch",
  "claude-api",
  "code-review",
  "dataviz",
  "debug",
  "init",
  "run",
  "run-skill-generator",
  "security-review",
  "simplify",
  "verify",
];
/** The keys of the user's Claude settings that sign in, which stay when the user's setup is off. */
const CLAUDE_SIGN_IN_KEYS = [
  "apiKeyHelper",
  "proxyAuthHelper",
  "awsCredentialExport",
  "awsAuthRefresh",
  "gcpAuthRefresh",
  "forceLoginMethod",
  "forceLoginOrgUUID",
] as const;

/**
 * What the user's own `settings.json` gives a turn when the user's Claude Code setup is off: only its
 * sign-in keys and its text `env` values, so a gateway, an API key helper or a proxy still works.
 * Hooks, plugins, the output style and the other keys stay off.
 */
export function claudeSignInSettings(userSettings: unknown, overridden: ReadonlySet<string> = new Set()): Settings {
  if (!isDynamicRecord(userSettings)) return {};
  const env = isDynamicRecord(userSettings.env)
    ? Object.fromEntries(
        Object.entries(userSettings.env).filter(
          (entry): entry is [string, string] => isString(entry[1]) && !overridden.has(entry[0]),
        ),
      )
    : {};
  const settings: Settings = Object.fromEntries(
    CLAUDE_SIGN_IN_KEYS.filter((key) => userSettings[key] !== undefined).map((key) => [key, userSettings[key]]),
  );
  return Object.keys(env).length > 0 ? { ...settings, env } : settings;
}

/** The only tools of a generation without tools that may read the web (a wide research item). */
const WEB_RESEARCH_TOOLS = ["WebSearch", "WebFetch"];

export interface ClaudeAgentQueryConfig {
  developerInstructions: string;
  profileGeneration?: boolean;
  /** With `profileGeneration`: the generation may search and read the web, and use nothing else. */
  webResearch?: boolean;
  workspaceOnly?: boolean;
  /** Whether the agent loads the user's own Claude Code setup from `~/.claude`. Off by default. */
  userSetup?: boolean;
  /** Skill folder names that the user or the workspace has: an override never hides the user's own skill. */
  ownSkills?: ReadonlySet<string>;
  /** Whether the user's settings already choose a commit attribution: then OpenBot leaves it. */
  ownAttribution?: boolean;
  /** The Claude config folder of the agent's account, which holds the user-level CLAUDE.md. */
  configDirectory?: string;
}

/**
 * Names Atelier to Claude. Without `CLAUDE_CODE_ENTRYPOINT` the SDK labels each request `sdk-ts`, and
 * Claude's 5-hour window counts `sdk-*` requests about twice as heavily (anthropics/claude-code#97074).
 * With a label other than `sdk-*`, the CLI turns on the claude.ai Artifact tools for accounts that
 * have Artifacts. They publish pages to the user's claude.ai account, outside Atelier, and their
 * schemas cost about 13k tokens in each request. `CLAUDE_CODE_ARTIFACT=0` keeps them off.
 */
const OPENBOT_CLAUDE_CLIENT = {
  CLAUDE_AGENT_SDK_CLIENT_APP: "openbot/0.1.0",
  CLAUDE_CODE_ARTIFACT: "0",
  CLAUDE_CODE_ENTRYPOINT: "openbot",
};

/**
 * The client labels for a CLI environment. Anthropic bills a request with a label other than `sdk-*`
 * as Claude Code, and promotional API credit can leave Claude Code out: a key with such credit got
 * "Credit balance is too low" with `openbot`, and an answer with `sdk-ts`. An API key has no 5-hour
 * window, so a request with a key keeps the SDK label. A label that the server's provider variables
 * set stays.
 */
export function withClaudeClientLabels(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const labelled: NodeJS.ProcessEnv = { ...OPENBOT_CLAUDE_CLIENT, ...environment };
  return labelled.ANTHROPIC_API_KEY && labelled.CLAUDE_CODE_ENTRYPOINT === OPENBOT_CLAUDE_CLIENT.CLAUDE_CODE_ENTRYPOINT
    ? { ...labelled, CLAUDE_CODE_ENTRYPOINT: "sdk-ts" }
    : labelled;
}

/**
 * The options of an agent query that set what the model gets before the conversation: the system
 * prompt, the tools and skills that are off, the setting sources and the flag settings.
 * `scripts/claude-prompt-tokens-bench.ts` measures a request with these options.
 */
export function claudeAgentQueryOptions(config: ClaudeAgentQueryConfig) {
  const user: NonNullable<Options["settingSources"]> = config.userSetup ? ["user"] : [];
  const ownSkills = config.ownSkills ?? new Set<string>();
  const overrides: Array<[string, "off" | "name-only"]> = [
    ...CLAUDE_UNFIT_SKILLS.map((skill): [string, "off"] => [skill, "off"]),
    ...CLAUDE_NAME_ONLY_SKILLS.map((skill): [string, "name-only"] => [skill, "name-only"]),
  ];
  const settings: Settings = {
    // OpenBot is not a co-author of the agent's commits; a user's own attribution still applies.
    ...(config.ownAttribution ? {} : { attribution: { commit: "", pr: "" } }),
    disableRemoteControl: true,
    skillOverrides: Object.fromEntries(overrides.filter(([skill]) => !ownSkills.has(skill))),
    // Without the user's setup, a workspace under the home folder still loaded `~/.claude/CLAUDE.md` and
    // its rules as project files, on each turn.
    ...(config.userSetup || config.workspaceOnly
      ? {}
      : { claudeMdExcludes: claudeHomeMemoryFiles(config.configDirectory) }),
  };
  return {
    // A call without tools, such as a title, a channel summary, a routing turn or a side question, gets
    // only OpenBot's instructions: the `claude_code` preset adds about 2.3k tokens of coding rules for
    // an agent with tools, which such a call never uses.
    systemPrompt: config.profileGeneration
      ? config.developerInstructions
      : { type: "preset", preset: "claude_code", append: config.developerInstructions },
    ...(config.profileGeneration
      ? { tools: config.webResearch ? WEB_RESEARCH_TOOLS : [] }
      : { disallowedTools: [...CLAUDE_NATIVE_SCHEDULING, ...CLAUDE_UNSHOWN_TOOLS] }),
    settingSources: config.profileGeneration ? [] : config.workspaceOnly ? user : [...user, "project", "local"],
    strictMcpConfig: true,
    settings: config.profileGeneration ? ({} satisfies Settings) : settings,
    env: {
      ...OPENBOT_CLAUDE_CLIENT,
      // Without a terminal, the CLI gives the newer models no TodoWrite or task tools, so the
      // agent has no plan for OpenBot to show as a task list.
      CLAUDE_CODE_ENABLE_TODO_TOOLS: "1",
      // OpenBot memory is the agent's memory, shown and edited in the app. Claude's auto memory kept a
      // second store under `~/.claude/projects` that the app cannot see, and its rules took about 2k
      // tokens of each request's system prompt. The files stay on disk.
      CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
    },
  } satisfies Options;
}

interface ClientEvents {
  notification: [notification: AppServerNotification];
  request: [request: AppServerRequest];
  exit: [error: Error];
  diagnostic: [message: string];
}

interface ThreadConfig {
  mcpChatId?: string;
  cwd: string;
  model?: string | undefined;
  effort?: string | undefined;
  developerInstructions: string;
  additionalDirectories: string[];
  persistSession: boolean;
  profileGeneration: boolean;
  /** With `profileGeneration`: only the web search and fetch tools. */
  webResearch?: boolean;
  /** Part of the config so that a change restarts the query with the new servers. */
  computerUse: boolean;
  /**
   * Workspace only: Bash runs in the Claude sandbox, a file write outside the roots asks the user, and
   * the project settings do not load. See `claude-workspace-sandbox.ts`.
   */
  workspaceOnly: boolean;
  /** The agent whose session this is, on a server that jails its process. See `agent-jail.ts`. */
  jailAgentId?: string;
  /** The workspaces of the agent's teammates in its space, which its jail reads. */
  jailReadRoots?: string[];
}

interface ActiveTurn {
  id: string;
  itemId: string;
  reasoningItemId: string;
  /** Text held back from the reader until a step boundary or the end of the turn classifies it. */
  text: string;
  /** Every assistant character this turn has produced, which is what a repeat is measured against. */
  seenText: string;
  /** What the narration already took, which the answer can no longer be rewritten over. */
  publishedText: string;
  /** The segment published last, which a message contradicting it can still put right. */
  lastNarration: { id: string; text: string } | null;
  narrationCount: number;
  thinking: string;
  thinkingStarted: boolean;
  thinkingStreamId: string | null;
  assistantMessages: Map<string, string>;
  thinkingMessages: Map<string, string>;
  toolCalls: Map<string, string>;
  /** The shell command of each running Bash call, so its result can be judged as web content. */
  toolCommands: Map<string, string>;
  /**
   * Set when Claude refuses the turn for a spent plan window. The refusal arrives as an assistant
   * message that only states the limit, so its text is held here and not published as the answer.
   */
  usageLimit: { resetsAt: number | null; text: string | null } | null;
  /** The CLI started this turn itself, with no message from OpenBot, such as after a background task ended. */
  unprompted: boolean;
  /** When the CLI last sent a message for this turn, or OpenBot last answered one of its requests. */
  lastActivityAt: number;
  /** Requests of this turn that OpenBot answers, such as an OpenBot tool or a question to the user. The stall limit waits. */
  hostRequests: number;
  /** The user stopped the turn. Its stop ends it as interrupted, never as a stall. */
  stopRequested: boolean;
}

interface ThreadRuntime {
  id: string;
  usageCounterId: string;
  usageCost: number;
  /**
   * The process resumed a saved session and has not reported usage yet. The CLI restores the saved
   * cumulative `modelUsage`, so the first report also carries the turn's own requests.
   */
  resumedUsage: boolean;
  /** The usage of each API request since the last result, by message id. */
  requestUsage: Map<string, { model: string; usage: unknown }>;
  contextRequest: number;
  compacting: boolean;
  config: ThreadConfig;
  /** The effort the `claude` process runs with; undefined when the model takes no effort setting. */
  appliedEffort: string | undefined;
  input: AsyncMessageQueue;
  query: ClaudeQuery;
  activeTurn: ActiveTurn | null;
  consume: Fiber.Fiber<void, ProviderClientOperationError> | null;
  idleRelease: ReturnType<typeof setTimeout> | null;
  idleSince: number;
  /** The plan Claude keeps with its todo and task tools, which OpenBot shows as a task list. */
  plan: ClaudePlanState;
  /** The subagents of the `Agent` tool, which can outlive their turn when they run in the background. */
  subagents: ClaudeSubagentState;
  /** Background subagents and commands that outlive their turn. Stopping the process ends them (#1870). */
  backgroundTasks: number;
  /**
   * The background work ended while no turn ran, and the CLI starts a turn of its own to answer its
   * result. Until that turn begins, closing the query loses the result (upstream da1ebe63f).
   */
  awaitsResultTurn: boolean;
  /** The cgroup task limit when the process started, to tell whether a crash came from that limit. */
  taskLimit: TaskLimitState | null;
  /** The MCP config file of this start, removed once the CLI has read it (`writeClaudeMcpConfig`). */
  mcpConfigFile: string | null;
}

/**
 * How long a thread with no turn keeps its `claude` process. Each process holds hundreds of MB with
 * its MCP servers, and the SDK resumes the same session from disk, so an idle thread costs only a
 * slower first message when the user comes back.
 */
const CLAUDE_THREAD_IDLE_RELEASE_MS = 5 * 60_000;

/** The start slot of the last Claude process; each start waits for the one before it, then one macrotask. */
let lastProcessStart: Promise<void> = Promise.resolve();

/** Resolves in a later turn of the event loop than the start before it. */
function nextProcessStart(): Promise<void> {
  const slot = lastProcessStart.then(() => new Promise<void>((resolve) => setImmediate(resolve)));
  lastProcessStart = slot;
  return slot;
}

/**
 * How many idle threads keep their `claude` process before the timeout. A user who runs one turn on
 * each of five agents otherwise holds five processes of about 140 MB each for five minutes.
 */
const CLAUDE_IDLE_THREAD_LIMIT = 1;

/**
 * How long a turn can send nothing, with no tool call or compaction open, before OpenBot ends it. A
 * CLI that stopped answering held its turn and the agent's queue for hours, until the user pressed
 * Stop. Longer than the CLI's own request timeout, so its own retry goes first.
 */
const CLAUDE_TURN_STALL_MS = 15 * 60_000;

/**
 * The same limit while a tool call or a compaction is open. A foreground command or an MCP tool can
 * run long with no output, so only a wait far longer than those ends the turn.
 */
const CLAUDE_TOOL_STALL_MS = 60 * 60_000;

/** How often a thread checks its turn against the stall limits. */
const CLAUDE_STALL_CHECK_MS = 60_000;

/**
 * How long a stopped turn can run on before its query closes. The stall limit skips a stopped turn,
 * so a CLI that does not end the turn after the stop otherwise held the agent's queue until a restart,
 * while Stop and `interrupt_agent` reported success.
 */
const CLAUDE_STOP_CONFIRM_MS = 10_000;

interface ClaudeStreamMessage {
  type: string;
  parent_tool_use_id?: string | null;
  event?: unknown;
  message?: unknown;
  uuid?: string;
  session_id?: string;
  subtype?: string;
  result?: string;
  errors?: string[];
  terminal_reason?: string;
  modelUsage?: unknown;
  status?: unknown;
  compact_result?: unknown;
  compact_metadata?: unknown;
  context_usage?: unknown;
  total_cost_usd?: number;
  /** The structured result of the tool a `user` message answers, such as the task a `TaskCreate` made. */
  tool_use_result?: unknown;
  is_error?: boolean;
  /** The HTTP status of the API error that ended the turn, such as 429 or 529. An older CLI does not send it. */
  api_error_status?: number | null;
  /** Why an assistant message is a refusal, such as `rate_limit`. */
  error?: string;
  rate_limit_info?: unknown;
  /** `background_tasks_changed`: every live background task. */
  tasks?: unknown;
}

interface ClaudeQuery extends AsyncIterable<ClaudeStreamMessage> {
  interrupt(): Promise<unknown>;
  supportedModels(): Promise<ModelInfo[]>;
  getContextUsage?(options: { detail: "summary" }): Promise<unknown>;
  setModel(model?: string): Promise<void>;
  applyFlagSettings(settings: { effortLevel?: ClaudeEffort | null }): Promise<void>;
  usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET?(options?: { skipBehaviors?: boolean }): Promise<unknown>;
  close(): void;
}

type QueryFactory = (params: Parameters<typeof query>[0]) => ClaudeQuery;
type SessionHistoryReader = (sessionId: string, options?: { dir?: string }) => Promise<SessionMessage[]>;
type ClaudeEffortCapability = { supported: ClaudeEffort[]; defaultEffort: ClaudeEffort } | null;

const queryLogger = createOpenBotLogger("claude-query");

export class ClaudeAgentClient extends EventEmitter<ClientEvents> {
  readonly contextCompaction = "native";
  #queryRestarts = 0;
  readonly provider: AgentProvider = "claude";
  readonly #cli: ClaudeCliInfo;
  readonly #sdkLaunch: ClaudeSdkLaunch;
  readonly #createQuery: QueryFactory;
  readonly #readSessionMessages: SessionHistoryReader | undefined;
  readonly #requestTimeoutMs: number;
  readonly #mcpServers: McpServerSource;
  readonly #reportMcpDrops: McpDropReporter | undefined;
  readonly #mcpToolRuntimes: McpToolRuntimeSource | undefined;
  readonly #mcpEndpoint: McpEndpointSource | undefined;
  /** Where a Workspace only query keeps its skill plugin. Without it, such a query has no workspace skills. */
  readonly #stateDirectory: string | undefined;
  /** Read at each session start, so a GitHub connection made while OpenBot runs reaches the next session. */
  readonly #agentEnvironment: ((inherited?: NodeJS.ProcessEnv) => Readonly<Record<string, string>>) | undefined;
  /**
   * The saved Anthropic API key, for the provider's own sign-in only. The CLI uses `ANTHROPIC_API_KEY`
   * before a claude.ai account, so this client gives the key only when the folder has no such
   * account: the key then serves the agents that the user did not move to another account.
   */
  readonly #fallbackApiKey: (() => string | null) | undefined;
  /** Whether agents load the user's own Claude Code setup. Read at each session start. */
  readonly #userSetup: () => boolean;
  /** The jail of an agent's process on a Linux server, absent elsewhere. See `agent-jail.ts`. */
  readonly #jail: AgentJail | undefined;
  /** Whether the last account read found no claude.ai account and signed in with the key. */
  #onApiKey = false;
  readonly readHistory: ReadProviderHistory;
  /** Threads whose process was closed for being idle keep the config that resumes them. */
  readonly #threads = new IdleThreadPool<ThreadRuntime, ThreadConfig>({
    scope: () => this.#scope,
    releaseAfterMs: CLAUDE_THREAD_IDLE_RELEASE_MS,
    idleLimit: CLAUDE_IDLE_THREAD_LIMIT,
    // A session that is not persisted has nothing on disk to resume from.
    canRelease: (runtime) => runtime.config.persistSession && runtime.backgroundTasks === 0,
    snapshot: (runtime) => runtime.config,
    dispose: (runtime) => this.#closeRuntime(runtime),
    reopen: (threadId, config) => this.#startThread(threadId, config, true),
  });
  readonly #serverRequests = new PendingServerRequests((request) => this.emit("request", request));
  readonly #modelEffortCapabilities = new Map<string, ClaudeEffortCapability>();
  readonly #modelSdkValues = new Map<string, string>();
  /**
   * Each thread's essential memories: the latest that OpenBot gave, and the last that a turn sent.
   * They go with the turns, not in the system prompt, so a memory change keeps the cached prefix
   * and restarts no query. Kept by thread, not by query: a restarted or reopened query resumes a
   * conversation that already holds the memories it was sent.
   */
  readonly #memoryContexts = new Map<string, { current: MemoryContext; delivered: MemoryContext | null }>();
  /** The same for the section-mates. `undefined` as `delivered`: the context can hold any earlier list. */
  readonly #teammates = new Map<
    string,
    { current: SectionTeammates | null; delivered: SectionTeammates | null | undefined }
  >();
  /** Resumes of one thread run one after another: two at once would leave a query nobody closes. */
  readonly #threadResumes = new Map<string, Deferred.Deferred<void, ProviderClientOperationError>>();
  #running = false;
  #scope = Scope.makeUnsafe();
  /** The weekly window that the last account-wide usage reading showed. A live event for another one is not forwarded. */
  #weeklyLimitKey = "seven_day";

  constructor(
    cli: ClaudeCliInfo,
    createQuery: QueryFactory = query,
    readSessionMessages?: SessionHistoryReader,
    requestTimeoutMs = 30_000,
    mcpServers: McpServerSource = () => [],
    reportMcpDrops?: McpDropReporter,
    mcpToolRuntimes?: McpToolRuntimeSource,
    mcpEndpoint?: McpEndpointSource,
    stateDirectory?: string,
    agentEnvironment?: (inherited?: NodeJS.ProcessEnv) => Readonly<Record<string, string>>,
    historyIndexDirectory?: string,
    fallbackApiKey?: () => string | null,
    userSetup: () => boolean = () => false,
    jail?: AgentJail,
  ) {
    super();
    this.#userSetup = userSetup;
    this.#jail = jail;
    this.#cli = cli;
    this.#sdkLaunch = claudeSdkLaunch(cli.executable);
    this.#createQuery = createQuery;
    this.#readSessionMessages = readSessionMessages;
    this.#requestTimeoutMs = requestTimeoutMs;
    this.#mcpServers = mcpServers;
    this.#reportMcpDrops = reportMcpDrops;
    this.#mcpToolRuntimes = mcpToolRuntimes;
    this.#mcpEndpoint = mcpEndpoint;
    this.#stateDirectory = stateDirectory;
    this.#agentEnvironment = agentEnvironment;
    this.#fallbackApiKey = fallbackApiKey;
    const historyEnvironment = agentEnvironment?.();
    const resolvedHistoryIndexDirectory = historyIndexDirectory ?? stateDirectory;
    const historyOptions: ClaudeHistoryOptions = {
      ...(historyEnvironment?.CLAUDE_CONFIG_DIR === undefined
        ? {}
        : { configDirectory: historyEnvironment.CLAUDE_CONFIG_DIR }),
      ...(historyEnvironment?.CLAUDE_CODE_PROJECT_DIR_NAME === undefined
        ? {}
        : { projectDirectoryName: historyEnvironment.CLAUDE_CODE_PROJECT_DIR_NAME }),
      ...(resolvedHistoryIndexDirectory === undefined ? {} : { indexDirectory: resolvedHistoryIndexDirectory }),
    };
    this.readHistory = readSessionMessages
      ? claudeHistoryFromMessages(readSessionMessages)
      : claudeHistoryReader(historyOptions);
  }

  get running(): boolean {
    return this.#running;
  }

  start(): void {
    if (this.#running) return;
    if (this.#scope.state._tag === "Closed") this.#scope = Scope.makeUnsafe();
    this.#running = true;
  }

  readonly stop = Effect.fn("ClaudeAgentClient.stop")(function* (
    this: ClaudeAgentClient,
  ): Effect.fn.Return<void, ProviderClientOperationError> {
    this.#running = false;
    const runtimes = this.#threads.clear();
    for (const runtime of runtimes) {
      runtime.input.close();
      runtime.query.close();
    }
    yield* Effect.forEach(
      runtimes,
      (runtime) => (runtime.consume ? Fiber.join(runtime.consume).pipe(Effect.ignore) : Effect.void),
      { concurrency: "unbounded", discard: true },
    );
    yield* Scope.close(this.#scope, Exit.void);
    this.#serverRequests.rejectAll("Claude session stopped.");
  });

  releaseIdleThreads(): Effect.Effect<void, ProviderClientOperationError> {
    return this.#threads.releaseIdle();
  }

  /** Background subagents run in this process after their turn ends, so it stays while any runs. */
  canReleaseProcess(): boolean {
    return [...this.#threads.ids()].every((id) => !this.#threads.get(id)?.backgroundTasks);
  }

  /**
   * A background subagent or command of this thread ends when its query closes, and so does the turn
   * that the CLI starts by itself to answer the result of work that ended.
   */
  holdsBackgroundWork(threadId: string): Effect.Effect<boolean, ProviderClientOperationError> {
    return Effect.sync(() => {
      const thread = this.#threads.get(threadId);
      return thread !== undefined && (thread.backgroundTasks > 0 || thread.awaitsResultTurn);
    });
  }

  /**
   * Closes one thread runtime and keeps the rest of the client. The SDK query owns the MCP servers
   * of that thread, so the close is what ends those child processes. The caller releases an idle
   * thread: a turn that still runs would end with the query that carries it.
   */
  readonly releaseThread = Effect.fn("ClaudeAgentClient.releaseThread")(function* (
    this: ClaudeAgentClient,
    threadId: string,
    resumes = false,
  ): Effect.fn.Return<void, ProviderClientOperationError> {
    this.#threads.forget(threadId);
    // `--resume` opens the same conversation, which holds the memories and section-mates that its
    // turns were sent. Before, they went again with the next turn after each runtime reload, such as
    // an MCP server or skill change.
    if (!resumes) {
      this.#memoryContexts.delete(threadId);
      this.#teammates.delete(threadId);
    }
    const runtime = this.#threads.get(threadId);
    if (!runtime) return;
    yield* this.#threads.close(runtime).pipe(toProviderClientOperationError);
  });

  readonly #closeRuntime = Effect.fn("ClaudeAgentClient.closeRuntime")(function* (
    this: ClaudeAgentClient,
    runtime: ThreadRuntime,
  ): Effect.fn.Return<void, ProviderClientOperationError> {
    runtime.input.close();
    runtime.query.close();
    // A background subagent ends with the process (#1870).
    for (const change of stopClaudeSubagents(runtime.subagents, new Date().toISOString()))
      this.#emitSubagents(runtime, change);
    // The consumer rejects when the query ends in the middle of a turn. The runtime is already gone
    // from the map, so there is nothing left to report it against.
    if (runtime.consume) yield* Fiber.join(runtime.consume).pipe(Effect.ignore);
  });

  readonly request = Effect.fn("ClaudeAgentClient.request")(function* <T>(
    this: ClaudeAgentClient,
    method: string,
    params: unknown,
    decoder: ResponseDecoder<T>,
    timeoutMs?: number,
  ): Effect.fn.Return<T, ProviderClientOperationError> {
    if (!this.#running) return yield* providerFailure(new Error("Claude Agent SDK is not running."));

    switch (method) {
      case "initialize":
        return yield* providerSync(() => decoder({}));
      case "account/read": {
        const response = yield* this.#readAccountEffect();
        return yield* providerSync(() => decoder(response));
      }
      case "account/rateLimits/read": {
        const response = yield* this.#readUsageEffect(getString(params, "model"), timeoutMs ?? this.#requestTimeoutMs);
        return yield* providerSync(() => decoder(response));
      }
      case "model/list": {
        const response = { data: yield* this.#listModelsEffect(timeoutMs) };
        return yield* providerSync(() => decoder(response));
      }
      case "plugin/list":
        return yield* providerSync(() => decoder({ marketplaces: [] }));
      case "thread/start": {
        const threadId = randomUUID();
        yield* this.#startThread(threadId, readThreadConfig(params), false);
        this.#setTurnContext(threadId, params, false);
        return yield* providerSync(() => decoder({ thread: { id: threadId } }));
      }
      case "thread/resume": {
        const threadId = yield* providerSync(() => requiredString(params, "threadId"));
        // Claude names its sessions with UUIDs. Another ID came from another provider, and every
        // turn with it in `--resume` would fail, so the caller opens a new session instead (#2475).
        if (!isUuid(threadId)) return yield* providerFailure(new MissingClaudeSessionError(threadId));
        const config = readThreadConfig(params);
        this.#setTurnContext(threadId, params, true);
        const previous = this.#threadResumes.get(threadId);
        const completion = Deferred.makeUnsafe<void, ProviderClientOperationError>();
        this.#threadResumes.set(threadId, completion);
        yield* Effect.gen({ self: this }, function* () {
          if (previous) yield* Deferred.await(previous).pipe(Effect.ignore);
          const exit = yield* Effect.exit(this.#resumeThread(threadId, config));
          yield* Deferred.done(completion, exit);
          if (this.#threadResumes.get(threadId) === completion) this.#threadResumes.delete(threadId);
          yield* exit;
        }).pipe(Effect.uninterruptible);
        return yield* providerSync(() => decoder({ thread: { id: threadId } }));
      }
      case "thread/read": {
        const response = yield* this.#readThreadEffect(requiredString(params, "threadId"));
        return yield* providerSync(() => decoder(response));
      }
      case "turn/start": {
        const response = yield* this.#startTurnEffect(params);
        return yield* providerSync(() => decoder(response));
      }
      case "turn/steer": {
        const response = yield* this.#steerTurnEffect(params);
        return yield* providerSync(() => decoder(response));
      }
      case "turn/interrupt": {
        const threadId = yield* providerSync(() => requiredString(params, "threadId"));
        // A turn that this adapter does not run has ended here: it makes the turn ids. The answer says
        // so, and a user Stop then ends a chat turn that only the snapshot still holds.
        const turnId = getString(params, "turnId");
        const notRunning = turnId === null ? {} : { turnActive: false };
        // A released thread has no turn to stop.
        if (this.#threads.isReleased(threadId)) return yield* providerSync(() => decoder(notRunning));
        const runtime = yield* providerSync(() => this.#requireThread(threadId));
        const turn = runtime.activeTurn;
        if (turn) turn.stopRequested = true;
        const stopped = turn && turn.id === turnId ? turn : null;
        if (stopped) yield* Effect.forkIn(this.#closeIfStopIgnored(runtime, stopped), this.#scope);
        yield* providerCall(() => runtime.query.interrupt()).pipe(
          // The close of a CLI that did not answer the stop rejects the stop request, but the close ends the turn.
          Effect.catch((failure) =>
            (stopped && (this.#threads.get(runtime.id) !== runtime || runtime.activeTurn !== stopped)) ||
            (!stopped && turnId !== null)
              ? Effect.void
              : Effect.fail(failure),
          ),
        );
        return yield* providerSync(() => decoder(stopped ? {} : notRunning));
      }
      case "thread/compact/start": {
        // Claude Code manages its own context compaction. With instructions, OpenBot asks for one
        // now: the CLI runs `/compact` as a turn of its own, which `claimTurn` takes.
        const instructions = getString(params, "instructions");
        if (!instructions) return yield* providerSync(() => decoder({}));
        const threadId = yield* providerSync(() => requiredString(params, "threadId"));
        const response = yield* this.#startTurnEffect({
          threadId,
          input: [{ type: "text", text: `/compact ${instructions}` }],
        });
        return yield* providerSync(() => decoder(response));
      }
      default:
        return yield* providerFailure(new Error(`Claude adapter does not implement ${method}.`));
    }
  });

  notify(): void {
    // Claude Agent SDK has no initialize notification.
  }

  respond(id: RequestId, result: unknown): void {
    this.#serverRequests.resolve(id, result);
  }

  respondError(id: RequestId, error: RpcError): void {
    this.#serverRequests.reject(id, error);
  }

  /**
   * A model list or a usage read runs no tools, so it starts none of the user's MCP servers. Each
   * server is a process of its own (`npx chrome-devtools-mcp` is about 480 MB), and these reads run
   * at every start and on every usage refresh.
   */
  #probeOptions(): Options {
    return {
      cwd: process.cwd(),
      ...this.#sdkLaunch,
      settingSources: ["user", "project", "local"],
      mcpServers: {},
      strictMcpConfig: true,
      persistSession: false,
      env: withClaudeClientLabels({
        ...claudeEnvironment(this.#cli),
        ...OPENBOT_CLAUDE_CLIENT,
        ...this.#environment(this.#onApiKey),
      }),
    };
  }

  readonly #listModelsEffect = Effect.fn("ClaudeAgentClient.listModels")(function* (
    this: ClaudeAgentClient,
    timeoutMs?: number,
  ): Effect.fn.Return<unknown[], ProviderClientOperationError> {
    const input = new AsyncMessageQueue();
    const claudeQuery = yield* providerSync(() =>
      this.#createQuery({
        prompt: input,
        options: this.#probeOptions(),
      }),
    );
    return yield* Effect.gen({ self: this }, function* () {
      const discovery = providerCall(() => claudeQuery.supportedModels());
      const discovered = yield* timeoutMs === undefined
        ? discovery
        : discovery.pipe(
            Effect.timeoutOrElse({
              duration: timeoutMs,
              orElse: () => Effect.fail(providerFailure(new RequestTimeoutError("Claude", "model/list"))),
            }),
          );
      const models = new Map<string, (typeof discovered)[number]>();
      for (const model of discovered) {
        const id = model.resolvedModel?.trim() || model.value.trim();
        if (!id || models.has(id)) continue;
        models.set(id, model);
      }
      const effortCapabilities = new Map<string, ClaudeEffortCapability>();
      const sdkValues = new Map<string, string>();
      const result = [...models.entries()].map(([id, model]) => {
        const discoveredReasoningEfforts = [
          ...new Set((model.supportedEffortLevels ?? []).filter((effort) => isOneOf(CLAUDE_EFFORTS, effort))),
        ];
        const supportedReasoningEfforts =
          discoveredReasoningEfforts.length > 0 ? discoveredReasoningEfforts : ["medium" as const];
        const defaultReasoningEffort = supportedReasoningEfforts.includes("high")
          ? "high"
          : (supportedReasoningEfforts[0] ?? "medium");
        effortCapabilities.set(
          id,
          model.supportsEffort === false
            ? null
            : { supported: supportedReasoningEfforts, defaultEffort: defaultReasoningEffort },
        );
        sdkValues.set(id, model.value.trim() || id);
        return {
          model: id,
          displayName: model.displayName,
          defaultReasoningEffort,
          supportedReasoningEfforts: supportedReasoningEfforts.map((reasoningEffort) => ({ reasoningEffort })),
        };
      });
      this.#modelEffortCapabilities.clear();
      this.#modelSdkValues.clear();
      for (const [id, capability] of effortCapabilities) this.#modelEffortCapabilities.set(id, capability);
      for (const [id, value] of sdkValues) this.#modelSdkValues.set(id, value);
      return yield* providerSync(() => result);
    }).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          input.close();
          claudeQuery.close();
        }),
      ),
    );
  });

  readonly #readUsageEffect = Effect.fn("ClaudeAgentClient.readUsage")(function* (
    this: ClaudeAgentClient,
    model: string | null,
    timeoutMs: number,
  ): Effect.fn.Return<AccountRateLimitsReadResult, ProviderClientOperationError> {
    const input = new AsyncMessageQueue();
    const claudeQuery = yield* providerSync(() =>
      this.#createQuery({
        prompt: input,
        options: this.#probeOptions(),
      }),
    );
    return yield* Effect.gen({ self: this }, function* () {
      const readUsage = claudeQuery.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET;
      if (!readUsage) return { rateLimits: null, rateLimitsByLimitId: null };
      // Without `skipBehaviors` the CLI also reads every transcript, which times out on a long history.
      const usage = yield* providerCall(() => readUsage.call(claudeQuery, { skipBehaviors: true })).pipe(
        Effect.timeoutOrElse({
          duration: timeoutMs,
          orElse: () => Effect.fail(providerFailure(new RequestTimeoutError("Claude", "account/rateLimits/read"))),
        }),
      );
      if (model === defaultProviderModel("claude") && isDynamicRecord(usage) && isDynamicRecord(usage.rate_limits))
        this.#weeklyLimitKey = claudeWeeklyKey(usage.rate_limits, model);
      return yield* providerSync(() => claudeRateLimits(usage, model));
    }).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          input.close();
          claudeQuery.close();
        }),
      ),
    );
  });

  readonly #readAccountEffect = Effect.fn("ClaudeAgentClient.readAccount")(function* (
    this: ClaudeAgentClient,
  ): Effect.fn.Return<AccountReadResult, ProviderClientOperationError> {
    let status = yield* this.#readAuthStatusEffect(false);
    const onApiKey = status.loggedIn !== true && Boolean(this.#fallbackApiKey?.());
    if (onApiKey) status = yield* this.#readAuthStatusEffect(true);
    this.#onApiKey = onApiKey && status.loggedIn === true;
    if (status.loggedIn !== true) return { account: null, requiresOpenaiAuth: false };
    return {
      account: {
        type: this.#onApiKey ? CLAUDE_API_KEY_ACCOUNT_TYPE : "claude",
        email: isString(status.email) ? status.email : null,
        planType: isString(status.subscriptionType) ? status.subscriptionType : null,
      },
      requiresOpenaiAuth: false,
    };
  });

  /**
   * `claude auth status` exits 1 when signed out and still prints its status. Only a status says
   * signed out: a timeout, a failed spawn or unreadable output throws, so an account refresh keeps
   * the working client instead of stopping it as signed out.
   */

  readonly #readAuthStatusEffect = Effect.fn("ClaudeAgentClient.readAuthStatus")(function* (
    this: ClaudeAgentClient,
    withApiKey: boolean,
  ): Effect.fn.Return<DynamicRecord, ProviderClientOperationError> {
    let stdout: unknown;
    let failure: unknown = null;
    const target = cliSpawnTarget(this.#cli.executable, ["auth", "status", "--json"]);
    try {
      ({ stdout } = providerResult(
        yield* Effect.result(
          providerCall(() =>
            execFileAsync(target.command, target.args, {
              timeout: 5_000,
              maxBuffer: 64 * 1024,
              windowsVerbatimArguments: target.windowsVerbatimArguments,
              // The agent environment carries the account's `CLAUDE_CONFIG_DIR`, so this reads that account.
              env: { ...claudeEnvironment(this.#cli), ...this.#environment(withApiKey) },
            }),
          ),
        ),
      ));
    } catch (error) {
      failure = error;
      stdout = isRecord(error) ? error.stdout : undefined;
    }
    const status = parseAuthStatus(stdout);
    if (status && (failure === null || status.loggedIn === false)) return yield* providerSync(() => status);
    // `execFile` marks a child it stopped at its timeout: a busy computer, not a failed check.
    if (isDynamicRecord(failure) && failure.killed === true)
      return yield* providerFailure(new RequestTimeoutError("Claude", "account/read"));
    return yield* providerFailure(failure ?? new Error("Claude returned an unreadable sign-in status."));
  });

  /** The agent environment, with the saved key when `withApiKey`. */
  #environment(withApiKey: boolean): Readonly<Record<string, string>> {
    const key = withApiKey ? this.#fallbackApiKey?.() : null;
    return { ...this.#agentEnvironment?.(), ...(key ? { ANTHROPIC_API_KEY: key } : {}) };
  }

  /**
   * The jail of an agent's process, or null for a process that runs as before: a start that is not
   * an agent's session (a title, a profile), a provider the server does not jail, or a server that
   * cannot make the jail. The default account gets `CLAUDE_CONFIG_DIR` so that the CLI keeps its
   * global config in the config folder, inside the jail, and never in the real home.
   */
  readonly #jailPlan = Effect.fn("ClaudeAgentClient.jailPlan")(function* (
    this: ClaudeAgentClient,
    config: ThreadConfig,
    environment: NodeJS.ProcessEnv,
    files: { readFiles: string[]; linkFolders: string[]; commands: string[] },
  ) {
    const jail = this.#jail;
    const agentId = config.jailAgentId;
    if (!jail || !agentId || !jail.jails(this.provider)) return null;
    const home = homedir();
    const providerHome = environment.CLAUDE_CONFIG_DIR ?? join(home, ".claude");
    if (!environment.CLAUDE_CONFIG_DIR) yield* providerCall(() => seedClaudeGlobalConfig(home, providerHome));
    const plan: AgentJailPlan | null = yield* providerCall(() =>
      jail.prepare({
        agentId,
        cwd: config.cwd,
        writableRoots: config.additionalDirectories,
        readRoots: config.jailReadRoots ?? [],
        providerHome,
        executable: this.#sdkLaunch.pathToClaudeCodeExecutable ?? this.#cli.executable,
        ...files,
        environment: { ...environment, CLAUDE_CONFIG_DIR: providerHome },
      }),
    ).pipe(
      Effect.mapError((error) =>
        error.cause instanceof AgentJailUnavailableError
          ? providerFailure(new Error(sourceText("error.agent.jailUnavailable"), { cause: error.cause }))
          : error,
      ),
    );
    return plan;
  });

  #setTurnContext(threadId: string, params: unknown, resume: boolean): void {
    const current = readMemoryContext(params);
    if (current) {
      const memory = this.#memoryContexts.get(threadId);
      if (memory) memory.current = current;
      else this.#memoryContexts.set(threadId, { current, delivered: null });
    }
    if (!isRecord(params) || !("sectionTeammates" in params)) return;
    const section = readSectionTeammates(params.sectionTeammates);
    const teammates = this.#teammates.get(threadId);
    if (teammates) teammates.current = section;
    // A new conversation holds no list, so no section needs no block.
    else this.#teammates.set(threadId, { current: section, delivered: resume ? undefined : null });
  }

  readonly #resumeThread = Effect.fn("ClaudeAgentClient.resumeThread")(function* (
    this: ClaudeAgentClient,
    threadId: string,
    config: ThreadConfig,
  ): Effect.fn.Return<void, ProviderClientOperationError> {
    // A turn can open a released thread again at each await here: that query is the one to
    // compare, not a second one, so the check runs again until this resume opens the thread.
    for (;;) {
      yield* this.#threads.opened(threadId);
      const current = this.#threads.get(threadId);
      if (current && threadConfigKey(current.config, true) === threadConfigKey(config, true)) return;
      if (current) {
        if (current.activeTurn) return yield* providerFailure(new Error(sourceText("error.provider.claudeTurnActive")));
        // Keep the applied model/effort until the live setters succeed at the next turn.
        if (threadConfigKey(current.config, false) === threadConfigKey(config, false)) return;
        queryLogger.info("Restarting a Claude query.", {
          reason: "configuration-change",
          count: ++this.#queryRestarts,
        });
        yield* this.#threads.close(current).pipe(toProviderClientOperationError);
        continue;
      }
      if (
        yield* this.#threads
          .opening(threadId, () => this.#startThread(threadId, config, true))
          .pipe(toProviderClientOperationError)
      )
        return;
    }
  });

  readonly #startThread = Effect.fn("ClaudeAgentClient.startThread")(function* (
    this: ClaudeAgentClient,
    threadId: string,
    config: ThreadConfig,
    resume: boolean,
  ): Effect.fn.Return<void, ProviderClientOperationError> {
    // A process that ended before its first record, such as one that crashed at once, left no
    // transcript, and every `--resume` of it would fail. The caller opens a new session instead and
    // hands it the chat's history.
    if (resume && config.persistSession) {
      const found = yield* Effect.promise(() =>
        claudeTranscriptExists(threadId, config.cwd, this.#agentEnvironment?.()).catch(() => true),
      );
      if (!found) return yield* providerFailure(new MissingClaudeSessionError(threadId));
    }
    const input = new AsyncMessageQueue();
    const appliedEffort = this.#resolveEffort(config.model, config.effort);
    /** Tool uses that the trust hook answered with `ask`, so the permission prompt waits for the owner. */
    const trustAsks = new Set<string>();
    const trustHooks: HookCallbackMatcher = {
      matcher: "Bash|mcp__.*",
      // The check answers at once; a wait for the owner happens in the permission prompt.
      timeout: 120,
      hooks: [
        async (hookInput) => {
          if (hookInput.hook_event_name !== "PreToolUse" || config.profileGeneration) return {};
          // A high-impact call that the trust policy does not govern still goes to the host: the
          // guardrails check it when the turn read untrusted content.
          if (
            !classifyToolUse(hookInput.tool_name, hookInput.tool_input, config.cwd) &&
            !guardedClaudeToolUse(hookInput.tool_name, hookInput.tool_input)
          )
            return {};
          const answer = await runCauseEffect(
            this.#trustCheck(threadId, hookInput.tool_name, hookInput.tool_input, "check"),
          ).catch(() => ({
            decision: "deny" as const,
            reason: "Atelier could not check the trust policy for this action. Try again in a moment.",
          }));
          if (answer.decision === "allow") return {};
          if (answer.decision === "ask") trustAsks.add(hookInput.tool_use_id);
          return {
            hookSpecificOutput: {
              hookEventName: "PreToolUse",
              permissionDecision: answer.decision,
              permissionDecisionReason: answer.reason ?? "The trust policy asks the owner first.",
            },
          };
        },
      ],
    };
    /**
     * Marks a result from the web, a browser or an email as untrusted data in the agent's context, once
     * per source in each turn: a browser loop of hundreds of steps gets the note once.
     */
    const untrustedNoted = new Map<string, string>();
    const untrustedHooks: HookCallbackMatcher = {
      matcher: "WebFetch|WebSearch|Bash|mcp__.*",
      hooks: [
        async (hookInput) => {
          if (hookInput.hook_event_name !== "PostToolUse" || config.profileGeneration) return {};
          const source = untrustedClaudeResult(hookInput.tool_name, hookInput.tool_input);
          if (!source) return {};
          const turnId = this.#threads.get(threadId)?.activeTurn?.id ?? "";
          if (untrustedNoted.get(source) === turnId) return {};
          untrustedNoted.set(source, turnId);
          return { hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: untrustedNote(source) } };
        },
      ],
    };
    const canUseTool: CanUseTool = (toolName, toolInput, options) =>
      runCauseEffect(
        Effect.gen({ self: this }, function* () {
          if (config.profileGeneration)
            return config.webResearch && WEB_RESEARCH_TOOLS.includes(toolName)
              ? { behavior: "allow", updatedInput: toolInput }
              : { behavior: "deny", message: "Profile generation has no tools." };
          if (config.workspaceOnly) {
            const outside = yield* claudeWriteOutsideRoots(
              toolName,
              toolInput,
              config.cwd,
              config.additionalDirectories,
            );
            if (outside)
              return yield* this.#requestWriteApprovalEffect(
                threadId,
                outside,
                toolInput,
                options.toolUseID ?? randomUUID(),
              );
          }
          // The trust hook asked first: the owner's approval card answers this tool use.
          const toolUseId = options.toolUseID;
          // Without an id, a classified tool use asks the gate again; an allowed one answers at once.
          if (toolUseId ? trustAsks.delete(toolUseId) : classifyToolUse(toolName, toolInput, config.cwd) !== null) {
            const answer = yield* this.#trustCheck(threadId, toolName, toolInput, "approve");
            if (answer.decision !== "allow")
              return { behavior: "deny", message: answer.reason ?? "The trust policy did not allow this action." };
          }
          if (toolName !== "AskUserQuestion") {
            return yield* providerCall(
              () => ({ behavior: "allow", updatedInput: toolInput }) satisfies PermissionResult,
            );
          }
          return yield* this.#requestUserInputEffect(threadId, toolInput, options.toolUseID ?? randomUUID());
        }),
      );
    // OpenBot's own servers spread last: Claude keys this record by name, so a user configuration
    // that reached one of those names would take the agent's own tools away. Profile generation
    // asks one question and must not act, so it gets neither set.
    const handoff = config.profileGeneration
      ? null
      : claudeMcpServers(
          yield* usableMcpServers(
            agentMcpServers(this.#mcpServers(config.mcpChatId), config.computerUse),
            this.#mcpToolRuntimes?.(),
            this.#mcpEndpoint,
          ).pipe(toProviderClientOperationError),
        );
    const stateDirectory = this.#stateDirectory;
    const userSetup = !config.profileGeneration && this.#userSetup();
    const configDirectory =
      this.#agentEnvironment?.().CLAUDE_CONFIG_DIR ?? process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude");
    const userSettings = yield* readClaudeSettingsFile(join(configDirectory, "settings.json"));
    const projectSettings =
      config.workspaceOnly || config.profileGeneration
        ? []
        : yield* Effect.forEach(
            [join(config.cwd, ".claude", "settings.json"), join(config.cwd, ".claude", "settings.local.json")],
            readClaudeSettingsFile,
          );
    const ownSettings = [...(userSetup ? [userSettings] : []), ...projectSettings];
    const ownSkills = new Set([
      ...(userSetup ? yield* skillFolderNames(join(configDirectory, "skills")) : []),
      ...(yield* skillFolderNames(join(config.cwd, ".claude", "skills"))),
    ]);
    for (const file of ownSettings)
      if (isDynamicRecord(file.skillOverrides))
        for (const skill of Object.keys(file.skillOverrides)) ownSkills.add(skill);
    const queryOptions = claudeAgentQueryOptions({
      ...config,
      userSetup,
      ownSkills,
      ownAttribution: ownSettings.some((file) => "attribution" in file || "includeCoAuthoredBy" in file),
      configDirectory,
    });
    const skillPlugin =
      config.workspaceOnly && stateDirectory ? yield* claudeWorkspaceSkillPlugin(stateDirectory, config.cwd) : null;
    const homeSkillPlugin =
      stateDirectory && userSetup
        ? yield* claudeHomeSkillPlugin(stateDirectory, configDirectory, config.cwd).pipe(
            // The home skills are an addition: a state folder that cannot hold the links must not stop the session.
            Effect.catch((error) =>
              Effect.sync(() => {
                queryLogger.warn("Claude starts without the skills in ~/.agents/skills.", { error: error.cause });
                return null;
              }),
            ),
          )
        : null;
    const plugins = [skillPlugin, homeSkillPlugin].filter((plugin) => plugin !== null);
    const launchPath = yield* cliLaunchPath(this.#cli.executable, this.#cli.source);
    // Creating the query starts the CLI process on the main thread (10 to 300 ms each on a server).
    // After a restart or at a routine minute many threads start at once; one start per turn of the
    // event loop lets the requests and events between them run. The order of the starts stays.
    yield* Effect.promise(nextProcessStart);
    // `stop()` may have run during the await: a query created now would outlive the client.
    if (!this.#running) return yield* providerFailure(new Error("Claude Agent SDK is not running."));
    if (handoff) this.#reportMcpDrops?.(this.provider, handoff.dropped);
    // The user's servers can carry tokens in headers and env. The SDK would put them in `--mcp-config`
    // on the command line, which every process of this user reads in /proc; a 0600 file that goes
    // away once the CLI has read it leaves them only in the CLI's memory.
    const mcpConfigFile =
      handoff && stateDirectory && Object.keys(handoff.servers).length > 0
        ? yield* writeClaudeMcpConfig(stateDirectory, threadId, handoff.servers).pipe(
            Effect.catch((error) =>
              Effect.sync(() => {
                queryLogger.warn("Claude gets its MCP servers on the command line: the config file failed.", {
                  error: error.cause,
                });
                return null;
              }),
            ),
          )
        : null;
    const mcpServers = handoff
      ? { ...(mcpConfigFile ? {} : handoff.servers), ...this.#createOpenBotServers(threadId) }
      : {};
    const nodeOptions = this.#agentEnvironment?.().NODE_OPTIONS;
    // The SDK deletes NODE_OPTIONS from the environment of the CLI. On a server the agent environment
    // has the CPU limit module there (`agentProcessEnvironment`), so it goes into the flag settings,
    // whose `env` the CLI gives to the Bash tool and its hooks.
    // The `env` of a settings file wins over the process environment in the CLI. A name that the agent
    // environment sets, such as a provider variable of this server, is left out, so that value applies.
    const signInSettings =
      userSetup || config.profileGeneration
        ? {}
        : claudeSignInSettings(userSettings, new Set(Object.keys(this.#agentEnvironment?.() ?? {})));
    const flagSettings: Settings = {
      ...signInSettings,
      ...queryOptions.settings,
      ...(signInSettings.env || nodeOptions
        ? { env: { ...signInSettings.env, ...(nodeOptions ? { NODE_OPTIONS: nodeOptions } : {}) } }
        : {}),
    };
    // The sign-in settings can hold keys, such as ANTHROPIC_AUTH_TOKEN: an inline `--settings` value
    // would show them in `ps`, so they go in a 0600 file of the state folder.
    const settings =
      Object.keys(signInSettings).length > 0 && stateDirectory
        ? yield* writeClaudeFlagSettings(stateDirectory, threadId, flagSettings).pipe(
            Effect.catch((error) =>
              Effect.sync(() => {
                queryLogger.warn("Claude starts without the sign-in settings of its settings file.", {
                  error: error.cause,
                });
                return { ...queryOptions.settings, ...(nodeOptions ? { env: { NODE_OPTIONS: nodeOptions } } : {}) };
              }),
            ),
          )
        : Object.keys(signInSettings).length > 0
          ? { ...queryOptions.settings, ...(nodeOptions ? { env: { NODE_OPTIONS: nodeOptions } } : {}) }
          : flagSettings;
    const environment = withClaudeClientLabels({
      ...claudeEnvironment(this.#cli),
      // The login shell's `PATH`, so the Bash tool and hooks find Homebrew and `~/.local/bin`
      // tools when Finder starts OpenBot. An `env.PATH` in the Claude settings still wins.
      ...(launchPath ? { PATH: launchPath } : {}),
      // Subagents (the Task tool) run on Sonnet unless this server's variables name another
      // model: an Opus lead's subagents on Opus cost twice as much for work that needs less.
      ...(process.env.CLAUDE_CODE_SUBAGENT_MODEL ? {} : { CLAUDE_CODE_SUBAGENT_MODEL: CLAUDE_SUBAGENT_MODEL }),
      ...queryOptions.env,
      // Last: the agent environment ends with the provider variables of this server, which an
      // admin sets, so they win over OpenBot's own values of the same name.
      ...this.#environment(this.#onApiKey),
    });
    const jail = yield* this.#jailPlan(config, environment, {
      readFiles: [mcpConfigFile, typeof settings === "string" ? settings : null].filter((file) => file !== null),
      linkFolders: plugins.map((plugin) => plugin.path),
      commands: handoff
        ? Object.values(handoff.servers).flatMap((server) => (server.type === "stdio" ? [server.command] : []))
        : [],
    }).pipe(
      Effect.tapError(() =>
        Effect.sync(() => {
          if (mcpConfigFile) void rm(mcpConfigFile, { force: true }).catch(() => undefined);
        }),
      ),
    );
    // The plan reads the disk: `stop()` may have run meanwhile, as above.
    if (jail && !this.#running) {
      if (mcpConfigFile) void rm(mcpConfigFile, { force: true }).catch(() => undefined);
      return yield* providerFailure(new Error("Claude Agent SDK is not running."));
    }
    const taskLimit = readTaskLimit();
    const claudeQuery = yield* providerSync(() =>
      this.#createQuery({
        prompt: input,
        options: {
          cwd: config.cwd,
          ...this.#sdkLaunch,
          // The jailed process starts through the launcher, which then starts the CLI. See `agent-jail.ts`.
          ...(jail ? { spawnClaudeCodeProcess: (options: SpawnOptions) => spawnJailed(jail, options) } : {}),
          ...(config.model ? { model: this.#sdkModel(config.model) } : {}),
          ...(appliedEffort ? { effort: appliedEffort } : {}),
          ...(resume ? { resume: threadId } : { sessionId: threadId }),
          ...queryOptions,
          settings,
          // The developer instructions carry the profile and the memories, and `thread/resume` above
          // restarts the query when they change. A recorded prompt would be sent instead of them on
          // every later request and resume, so the agent kept an edited profile's old text. The CLI
          // flag, not the SDK's `systemPromptSnapshot` option: the CLI records by default and ignores
          // that option.
          extraArgs: {
            ...(claudeTakesPromptSnapshotFlag(this.#cli.version) ? { "system-prompt-snapshot": "off" } : {}),
            // The CLI merges this file with the SDK's own `--mcp-config` of the in-process server.
            ...(mcpConfigFile ? { "mcp-config": mcpConfigFile } : {}),
          },
          // The MCP panel is the only door. Without this, Claude merges project `.mcp.json`, user
          // settings, plugin and agent-frontmatter servers into the record above, so two computers
          // with the same OpenBot settings give their agents different tools and "which servers does
          // my agent have" has no answer. The flag takes away MCP and nothing else, so permissions and
          // hooks still load from those files. Workspace only loads the user settings alone: see
          // `claude-workspace-sandbox.ts`.
          strictMcpConfig: true,
          permissionMode: "default",
          includePartialMessages: true,
          persistSession: config.persistSession,
          additionalDirectories: config.additionalDirectories,
          canUseTool,
          ...(config.workspaceOnly
            ? {
                sandbox: claudeWorkspaceSandbox(config.additionalDirectories),
                hooks: {
                  PreToolUse: [
                    ...(claudeWorkspaceHooks(config.cwd, config.additionalDirectories).PreToolUse ?? []),
                    trustHooks,
                  ],
                  PostToolUse: [untrustedHooks],
                },
                managedSettings: CLAUDE_WORKSPACE_MANAGED_SETTINGS,
              }
            : { hooks: { PreToolUse: [trustHooks], PostToolUse: [untrustedHooks] } }),
          ...(plugins.length ? { plugins } : {}),
          mcpServers,
          env: jail?.environment ?? environment,
        },
      }),
    );
    const runtime: ThreadRuntime = {
      id: threadId,
      usageCounterId: randomUUID(),
      usageCost: 0,
      resumedUsage: resume,
      requestUsage: new Map(),
      contextRequest: 0,
      compacting: false,
      config,
      appliedEffort,
      input,
      query: claudeQuery,
      activeTurn: null,
      consume: null,
      idleRelease: null,
      idleSince: 0,
      plan: newClaudePlanState(),
      subagents: newClaudeSubagentState(),
      backgroundTasks: 0,
      awaitsResultTurn: false,
      taskLimit,
      mcpConfigFile,
    };
    runtime.consume = yield* Effect.forkIn(this.#consume(runtime), this.#scope, { startImmediately: true });
    this.#threads.add(runtime);
    yield* Effect.forkIn(this.#watchStall(runtime), this.#scope);
  });

  /**
   * Ends the turn of a CLI that sends nothing past the stall limit. The wait for OpenBot, such as an
   * OpenBot tool or a question to the user, does not count, nor does the time the computer sleeps.
   * The turn fails with a notice, so the agent's queue goes on, and the process closes as after a
   * crash: the next turn opens the same session again.
   */
  readonly #watchStall = Effect.fn("ClaudeAgentClient.watchStall")(function* (
    this: ClaudeAgentClient,
    runtime: ThreadRuntime,
  ) {
    while (this.#running && this.#threads.get(runtime.id) === runtime) {
      const before = Date.now();
      yield* Effect.sleep(CLAUDE_STALL_CHECK_MS);
      const turn = runtime.activeTurn;
      if (!turn || this.#threads.get(runtime.id) !== runtime) continue;
      // A timer does not run while the computer sleeps, but the clock does.
      const asleep = Date.now() - before - CLAUDE_STALL_CHECK_MS;
      if (asleep > CLAUDE_STALL_CHECK_MS) turn.lastActivityAt = Math.min(Date.now(), turn.lastActivityAt + asleep);
      const silentFor = Date.now() - turn.lastActivityAt;
      const limit = turn.toolCalls.size > 0 || runtime.compacting ? CLAUDE_TOOL_STALL_MS : CLAUDE_TURN_STALL_MS;
      if (turn.hostRequests > 0 || turn.stopRequested || silentFor < limit) continue;
      queryLogger.warn("Ended a Claude turn that sent nothing past the stall limit.", {
        threadId: runtime.id,
        silentForMinutes: Math.floor(silentFor / 60_000),
        openToolCalls: turn.toolCalls.size,
      });
      yield* this.#endTurnAndClose(
        runtime,
        turn,
        "failed",
        sourceText("error.agent.turnStalled", { provider: "Claude" }),
      );
      return;
    }
  });

  /**
   * Closes the query of a stopped turn that still runs after `CLAUDE_STOP_CONFIRM_MS`, and ends the
   * turn as interrupted. The next turn opens the same session again.
   */
  readonly #closeIfStopIgnored = Effect.fn("ClaudeAgentClient.closeIfStopIgnored")(function* (
    this: ClaudeAgentClient,
    runtime: ThreadRuntime,
    turn: ActiveTurn,
  ) {
    yield* Effect.sleep(CLAUDE_STOP_CONFIRM_MS);
    if (runtime.activeTurn !== turn || this.#threads.get(runtime.id) !== runtime) return;
    queryLogger.warn("Closed a Claude query that did not end its turn after a stop.", {
      threadId: runtime.id,
      waitedMs: CLAUDE_STOP_CONFIRM_MS,
    });
    yield* this.#endTurnAndClose(runtime, turn, "interrupted", null);
  });

  /**
   * Ends a turn that the CLI does not end, and closes the process as after a crash: the next turn
   * opens the same session again.
   */
  readonly #endTurnAndClose = Effect.fn("ClaudeAgentClient.endTurnAndClose")(function* (
    this: ClaudeAgentClient,
    runtime: ThreadRuntime,
    turn: ActiveTurn,
    status: "failed" | "interrupted",
    message: string | null,
  ) {
    for (const [toolCallId, name] of turn.toolCalls) this.#emitToolCall(runtime, toolCallId, name, true);
    turn.toolCalls.clear();
    yield* this.#completeTurn(runtime, status, message);
    // A session that is not saved cannot open again, so its thread goes with the process.
    this.#threads.lose(runtime, runtime.config.persistSession);
    runtime.input.close();
    try {
      runtime.query.close();
    } catch {
      // The process is already gone.
    }
    for (const change of stopClaudeSubagents(runtime.subagents, new Date().toISOString()))
      this.#emitSubagents(runtime, change);
  });

  /** Runs a request that OpenBot answers. The stall limit waits for it and counts again from its answer. */
  #awaitHost<A, E, R>(threadId: string, request: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> {
    return Effect.acquireUseRelease(
      Effect.sync(() => {
        const turn = this.#threads.get(threadId)?.activeTurn ?? null;
        if (turn) turn.hostRequests += 1;
        return turn;
      }),
      () => request,
      (turn) =>
        Effect.sync(() => {
          if (!turn) return;
          turn.hostRequests -= 1;
          turn.lastActivityAt = Date.now();
        }),
    );
  }

  readonly #startTurnEffect = Effect.fn("ClaudeAgentClient.startTurn")(function* (
    this: ClaudeAgentClient,
    params: unknown,
  ): Effect.fn.Return<TurnResponse, ProviderClientOperationError> {
    const threadId = yield* providerSync(() => requiredString(params, "threadId"));
    return yield* this.#threads
      .startTurn(threadId, () => this.#openTurn(threadId, params))
      .pipe(toProviderClientOperationError);
  });

  readonly #openTurn = Effect.fn("ClaudeAgentClient.openTurn")(function* (
    this: ClaudeAgentClient,
    threadId: string,
    params: unknown,
    reopened = false,
  ): Effect.fn.Return<TurnResponse, ProviderClientOperationError> {
    yield* this.#threads.wake(threadId).pipe(toProviderClientOperationError);
    const runtime = yield* providerSync(() => this.#requireThread(threadId));
    if (runtime.activeTurn) return yield* providerFailure(this.#turnActiveError(runtime.activeTurn));
    runtime.contextRequest += 1;

    const requestedModel = getString(params, "model");
    const modelChanged = Boolean(requestedModel && requestedModel !== runtime.config.model);
    if (requestedModel && modelChanged) {
      yield* providerCall(() => runtime.query.setModel(this.#sdkModel(requestedModel)));
      runtime.config.model = requestedModel;
    }
    const requestedEffort = getString(params, "effort");
    const selectedEffort = requestedEffort ?? runtime.config.effort;
    const appliedEffort = this.#resolveEffort(runtime.config.model, selectedEffort);
    if (!appliedEffort) {
      if (runtime.appliedEffort !== undefined)
        yield* providerCall(() => runtime.query.applyFlagSettings({ effortLevel: null }));
      runtime.appliedEffort = undefined;
    } else if (modelChanged || appliedEffort !== runtime.appliedEffort) {
      yield* providerCall(() => runtime.query.applyFlagSettings({ effortLevel: appliedEffort }));
      runtime.appliedEffort = appliedEffort;
    }
    if (requestedEffort) runtime.config.effort = requestedEffort;

    const clientId = getString(params, "clientUserMessageId");
    const requestedTurnId = getString(params, "clientTurnId") ?? clientId;
    const turnId = requestedTurnId && isUuid(requestedTurnId) ? requestedTurnId : randomUUID();
    const text = readInputText(params);
    // The process can end while the model or effort changes above. Its thread then opens again, once,
    // rather than taking a turn that no process would answer.
    if (this.#threads.get(threadId) !== runtime) {
      if (reopened) return yield* providerFailure(new Error("The Claude process of this thread ended."));
      return yield* this.#openTurn(threadId, params, true);
    }
    // The CLI can start a turn of its own while the model or effort changes above.
    if (runtime.activeTurn) return yield* providerFailure(this.#turnActiveError(runtime.activeTurn));
    // A crash is compared with the task limit at the start of its turn, not at a start hours ago.
    runtime.taskLimit = readTaskLimit();
    // Only now: a model or effort change that fails above leaves the idle timer armed, so the
    // pool can still release the thread.
    this.#beginTurn(runtime, turnId, false);
    // Blocks of their own, so that history readers can tell them from the text of the turn. A slash
    // command gets none: the CLI can drop the blocks before it, and `/clear` empties the context,
    // so the next turn sends the full blocks.
    const memory = this.#memoryContexts.get(threadId);
    const teammates = this.#teammates.get(threadId);
    const command = text.startsWith("/");
    const context = command
      ? []
      : [
          memory ? memoryContextUpdate(memory.delivered, memory.current) : null,
          teammates ? sectionTeammatesUpdate(teammates.delivered, teammates.current) : null,
        ].filter((block): block is string => block !== null);
    runtime.input.push({
      type: "user",
      message: {
        role: "user",
        content:
          context.length > 0
            ? [...context.map((block) => ({ type: "text" as const, text: block })), { type: "text", text }]
            : text,
      },
      parent_tool_use_id: null,
      uuid: turnId,
      session_id: threadId,
    });
    if (memory) memory.delivered = command ? null : memory.current;
    if (teammates) teammates.delivered = command ? undefined : teammates.current;
    return { turn: { id: turnId, status: "inProgress" } };
  });

  /** A turn of the CLI's own ends with its own result, so the message waits for it rather than joining it. */
  #turnActiveError(turn: ActiveTurn): Error {
    return turn.unprompted
      ? new ProviderTurnActiveError("Claude")
      : new Error("The Claude thread already has an active turn.");
  }

  #beginTurn(runtime: ThreadRuntime, turnId: string, unprompted: boolean): ActiveTurn {
    const turn: ActiveTurn = {
      id: turnId,
      itemId: `${turnId}:assistant`,
      reasoningItemId: `${turnId}:reasoning`,
      text: "",
      seenText: "",
      publishedText: "",
      lastNarration: null,
      narrationCount: 0,
      thinking: "",
      thinkingStarted: false,
      thinkingStreamId: null,
      assistantMessages: new Map<string, string>(),
      thinkingMessages: new Map<string, string>(),
      toolCalls: new Map<string, string>(),
      toolCommands: new Map<string, string>(),
      usageLimit: null,
      unprompted,
      lastActivityAt: Date.now(),
      hostRequests: 0,
      stopRequested: false,
    };
    runtime.activeTurn = turn;
    runtime.awaitsResultTurn = false;
    startClaudePlanTurn(runtime.plan);
    this.#threads.holdForTurn(runtime);
    this.emit("notification", {
      method: "turn/started",
      // `unprompted` tells the lifecycle that no delivery started this turn.
      params: {
        threadId: runtime.id,
        turn: { id: turnId, status: "inProgress" },
        ...(unprompted ? { unprompted } : {}),
      },
    });
    return turn;
  }

  /**
   * The turn that main-agent output belongs to. In stream mode the CLI starts a turn of its own when
   * a background subagent or command ends, and the answer of that turn is shown like any other.
   */
  #outputTurn(runtime: ThreadRuntime): ActiveTurn {
    return runtime.activeTurn ?? this.#beginTurn(runtime, randomUUID(), true);
  }

  readonly #steerTurnEffect = Effect.fn("ClaudeAgentClient.steerTurn")(function* (
    this: ClaudeAgentClient,
    params: unknown,
  ): Effect.fn.Return<{ turnId: string }, ProviderClientOperationError> {
    const threadId = yield* providerSync(() => requiredString(params, "threadId"));
    const runtime = yield* providerSync(() => this.#requireThread(threadId));
    const expectedTurnId = yield* providerSync(() => requiredString(params, "expectedTurnId"));
    if (!runtime.activeTurn || runtime.activeTurn.id !== expectedTurnId) {
      return yield* providerFailure(new Error("The active Claude turn changed before steering was accepted."));
    }
    const clientId = getString(params, "clientUserMessageId");
    const messageId = clientId && isUuid(clientId) ? clientId : randomUUID();
    runtime.input.push({
      type: "user",
      message: { role: "user", content: readInputText(params) },
      parent_tool_use_id: null,
      uuid: messageId,
      session_id: threadId,
    });
    return { turnId: runtime.activeTurn.id };
  });

  readonly #consume = Effect.fn("ClaudeAgentClient.consume")(function* (
    this: ClaudeAgentClient,
    runtime: ThreadRuntime,
  ): Effect.fn.Return<void, ProviderClientOperationError> {
    try {
      let complete = false;
      providerResult(
        yield* Effect.result(
          Effect.acquireUseRelease(
            providerSync(() => runtime.query[Symbol.asyncIterator]()),
            (iterator) =>
              Effect.gen({ self: this }, function* () {
                for (;;) {
                  const next = yield* providerCall(() => iterator.next());
                  // The CLI read its MCP config before it said anything.
                  removeMcpConfigFile(runtime);
                  if (next.done) {
                    complete = true;
                    break;
                  }
                  yield* this.#handleMessage(runtime, next.value);
                }
              }),
            (iterator) => (complete ? Effect.void : providerCall(() => iterator.return?.()).pipe(Effect.asVoid)),
          ),
        ),
      );
      removeMcpConfigFile(runtime);
      if (this.#running && this.#threads.get(runtime.id) === runtime) {
        const error = new Error("Claude session stream ended unexpectedly.");
        if (runtime.activeTurn) yield* this.#completeTurn(runtime, "failed", error);
        this.#loseThread(runtime, error);
      }
    } catch (error) {
      if (!this.#running || this.#threads.get(runtime.id) !== runtime) return;
      const cause = error instanceof Error ? error : new Error(String(error));
      const failure = processLimitFailure(runtime.taskLimit, cause) ?? cause;
      const activeTurn = runtime.activeTurn;
      if (activeTurn) yield* this.#completeTurn(runtime, "failed", failure);
      this.#loseThread(runtime, cause);
    }
  });

  /**
   * One thread's process ended by itself, such as with a crash. Each thread has its own process, so
   * the others go on: an exit of the whole client would stop every agent's turn on this provider.
   * The thread's next turn opens it again from its session.
   */
  #loseThread(runtime: ThreadRuntime, error: Error): void {
    removeMcpConfigFile(runtime);
    this.#threads.lose(runtime, runtime.config.persistSession);
    runtime.input.close();
    try {
      runtime.query.close();
    } catch {
      // The process is already gone.
    }
    for (const change of stopClaudeSubagents(runtime.subagents, new Date().toISOString()))
      this.#emitSubagents(runtime, change);
    const taskLimit = readTaskLimit();
    queryLogger.warn("A Claude process ended by itself. Its thread opens again at its next turn.", {
      message: error.message,
      ...(taskLimit ? { tasks: taskLimit.current, taskLimit: taskLimit.max, tasksRefused: taskLimit.refused } : {}),
    });
  }

  readonly #handleMessage = Effect.fn("ClaudeAgentClient.handleMessage")(function* (
    this: ClaudeAgentClient,
    runtime: ThreadRuntime,
    message: ClaudeStreamMessage,
  ) {
    if (runtime.activeTurn) runtime.activeTurn.lastActivityAt = Date.now();
    if (message.type === "assistant") {
      // Each content block repeats its request's message; the last copy has the final count.
      const id = getString(message.message, "id");
      const model = getString(message.message, "model");
      // Only the first usage report of a resumed process needs the requests of its turn.
      if (runtime.resumedUsage && id && model && isRecord(message.message))
        runtime.requestUsage.set(id, { model, usage: message.message.usage });
    }
    if (message.type === "system" && message.subtype === "status") {
      const status =
        message.status === "compacting"
          ? "running"
          : message.compact_result === "success"
            ? "completed"
            : message.compact_result === "failed"
              ? "failed"
              : null;
      if (status) runtime.compacting = status === "running";
      if (status)
        this.emit("notification", { method: "openbot/context-compaction", params: { threadId: runtime.id, status } });
      return;
    }
    if (message.type === "system" && message.subtype === "background_tasks_changed") {
      const before = runtime.backgroundTasks;
      runtime.backgroundTasks = Array.isArray(message.tasks)
        ? message.tasks.filter((task) => !(isRecord(task) && task.ambient === true)).length
        : 0;
      // The level can arrive after the turn that started the work ended, so it holds or frees the idle timer.
      if (!runtime.activeTurn) {
        if (before === 0 && runtime.backgroundTasks > 0) this.#threads.holdForTurn(runtime);
        else if (before > 0 && runtime.backgroundTasks === 0) {
          runtime.awaitsResultTurn = true;
          yield* this.#threads.markIdle(runtime);
        }
      }
      return;
    }
    if (message.type === "system" && message.subtype?.startsWith("task_")) {
      this.#emitSubagents(runtime, foldClaudeTaskMessage(runtime.subagents, message, new Date().toISOString()));
      return;
    }
    if (message.type === "system" && message.subtype === "compact_boundary") {
      runtime.compacting = false;
      // The summary can leave the context blocks out, so the next turn sends the full blocks again.
      const memory = this.#memoryContexts.get(runtime.id);
      if (memory) memory.delivered = null;
      const teammates = this.#teammates.get(runtime.id);
      if (teammates) teammates.delivered = undefined;
      // Claude's post_tokens counts messages only, not the full context.
      this.emit("notification", {
        method: "openbot/context-compaction",
        params: {
          threadId: runtime.id,
          status: "completed",
        },
      });
      return;
    }
    if (message.context_usage && !message.parent_tool_use_id && isRecord(message.context_usage)) {
      this.#emitContextUsage(runtime, message.context_usage.total_tokens, message.context_usage.raw_max_tokens);
    }
    if (message.type === "rate_limit_event") {
      const info = message.rate_limit_info;
      if (!isDynamicRecord(info)) return;
      const turn = runtime.activeTurn;
      if (turn && info.status === "rejected") {
        turn.usageLimit = { resetsAt: claudeResetSeconds(info.resetsAt), text: turn.usageLimit?.text ?? null };
      }
      // The plan rings follow the turn, as with Codex, instead of waiting for the next reading.
      const windows = claudePushedWindows(info, this.#weeklyLimitKey);
      if (windows)
        this.emit("notification", {
          method: "account/rateLimits/updated",
          params: { rateLimits: { limitId: "claude", ...windows } },
        });
      return;
    }

    if (message.type === "stream_event" && message.parent_tool_use_id === null) {
      const event = message.event;
      const delta = isRecord(event) ? event.delta : null;
      if (event && isRecord(event) && event.type === "content_block_delta" && isRecord(delta)) {
        if (delta.type === "text_delta" && isString(delta.text)) {
          this.#outputTurn(runtime);
          this.#bufferText(runtime, delta.text);
        } else if (delta.type === "thinking_delta" && isString(delta.thinking)) {
          this.#outputTurn(runtime);
          this.#appendThinkingDelta(runtime, delta.thinking, message.uuid);
        }
      }
      return;
    }

    if (message.type === "assistant" && message.parent_tool_use_id && message.uuid) {
      this.#emitSubagents(
        runtime,
        foldClaudeSubagentMessage(runtime.subagents, message.parent_tool_use_id, message.uuid, message.message),
      );
      return;
    }
    if (message.type === "assistant") {
      if (message.parent_tool_use_id !== null || !message.uuid) return;
      const turn = this.#outputTurn(runtime);
      const text = messageText(message.message);
      if (message.error === "rate_limit") {
        // A spent balance does not reset, so it is not held: the turn fails with its own text.
        if (isBalanceDiagnostic(text)) turn.usageLimit = null;
        else if (turn.usageLimit || isPlanLimitDiagnostic(text)) {
          turn.usageLimit = { resetsAt: turn.usageLimit?.resetsAt ?? null, text: text || null };
          return;
        }
      }
      // The CLI's own report of a failed request, such as "Invalid API key · Please run /login", is not
      // an answer. The result after it carries the same text and fails the turn.
      if (message.error && message.error !== "max_output_tokens") return;
      const thinking = messageThinking(message.message);
      /* The deltas never announced this block, so its own order is all there is to say what came
         before it. Text the message placed there is narration, and only that much may go. */
      if (thinking && message.uuid !== turn.thinkingStreamId) {
        const before = textBeforeThinking(message.message);
        if (before) {
          turn.assistantMessages.set(message.uuid, before);
          const upToBoundary = [...turn.assistantMessages.values()].join("");
          this.#reconcileText(runtime, upToBoundary);
          this.#flushNarration(runtime);
        }
      }
      if (thinking) {
        turn.thinkingMessages.set(message.uuid, thinking);
        const completeThinking = [...turn.thinkingMessages.values()].join("\n");
        if (completeThinking.startsWith(turn.thinking)) {
          this.#appendThinkingDelta(runtime, completeThinking.slice(turn.thinking.length));
        }
      }
      /* Hold this message's own text first. Claude can omit the stream deltas and send one message
         carrying the narration together with the call it introduces, and a flush that ran before
         the text was held would see an empty buffer and leave that narration for the answer. */
      if (text) {
        turn.assistantMessages.set(message.uuid, text);
        this.#reconcileText(runtime, [...turn.assistantMessages.values()].join(""));
      }
      const toolCalls = messageToolCalls(message.message);
      // A tool call closes the step, which makes the text before it narration rather than an answer.
      if (toolCalls.length > 0) this.#flushNarration(runtime);
      for (const toolCall of toolCalls) {
        if (turn.toolCalls.has(toolCall.id)) continue;
        const name = claudeBridgedToolName(toolCall.name, toolCall.input);
        turn.toolCalls.set(toolCall.id, name);
        const command = toolCommand(toolCall.input);
        if (command !== null) turn.toolCommands.set(toolCall.id, command);
        this.#emitToolCall(runtime, toolCall.id, name, false, toolCall.input);
        const plan = foldClaudePlanCall(runtime.plan, toolCall);
        if (plan) this.#emitPlan(runtime, plan);
        this.#emitSubagents(
          runtime,
          foldClaudeSubagentCall(runtime.subagents, turn.id, toolCall, new Date().toISOString()),
        );
      }
      return;
    }

    if (message.type === "user") {
      const turn = runtime.activeTurn;
      if (!turn) return;
      for (const { id: toolCallId, text, isError } of messageToolResults(message.message)) {
        // A subagent's task ids are its own, so only the main agent's results name a plan task.
        if (!message.parent_tool_use_id) {
          foldClaudePlanResult(runtime.plan, toolCallId, message.tool_use_result, text);
          this.#emitSubagents(
            runtime,
            foldClaudeSubagentResult(
              runtime.subagents,
              toolCallId,
              message.tool_use_result,
              isError,
              text,
              new Date().toISOString(),
            ),
          );
        }
        const name = turn.toolCalls.get(toolCallId);
        if (!name) continue;
        turn.toolCalls.delete(toolCallId);
        const command = turn.toolCommands.get(toolCallId) ?? null;
        turn.toolCommands.delete(toolCallId);
        // A failed result carries the tool's own error text, which the activity line and the log show.
        this.#emitToolCall(runtime, toolCallId, name, true, undefined, isError, isError ? text : undefined, {
          text,
          command,
        });
      }
      return;
    }

    if (message.type !== "result") return;
    if (
      message.subtype === "success" &&
      message.total_cost_usd !== undefined &&
      message.total_cost_usd < runtime.usageCost
    )
      runtime.usageCounterId = randomUUID();
    if (message.subtype === "success" || (message.total_cost_usd ?? 0) > runtime.usageCost)
      runtime.usageCost = message.total_cost_usd ?? runtime.usageCost;
    if (runtime.activeTurn && message.modelUsage) {
      this.emit("notification", {
        method: "openbot/usage",
        params: {
          threadId: runtime.id,
          turnId: runtime.activeTurn.id,
          counterId: runtime.usageCounterId,
          modelUsage: message.modelUsage,
          ...(runtime.resumedUsage ? { turnModelUsage: claudeTurnModelUsage(runtime.requestUsage.values()) } : {}),
        },
      });
      runtime.resumedUsage = false;
      runtime.requestUsage.clear();
    }
    const fallback = message.subtype === "success" ? message.result : "";
    const errors = message.errors ?? [];
    const interrupted =
      message.terminal_reason === "aborted_streaming" ||
      message.terminal_reason === "aborted_tools" ||
      errors.some((error) => /interrupt|abort/i.test(error));
    // "success" with `is_error` is a turn that ended on an API error, and `result` holds its text.
    const apiError = message.subtype === "success" && message.is_error === true;
    const turn = runtime.activeTurn;
    if (turn) {
      for (const [toolCallId, name] of turn.toolCalls) {
        this.#emitToolCall(runtime, toolCallId, name, true);
      }
      turn.toolCalls.clear();
      // A rejected window alone is not a failure: the request can still run on overage. Only the
      // refusal message, or a request that then failed with a rate-limit error, ends the turn on the
      // limit. Another API error, such as a 529 overload, stays a provider error (#10486). An older CLI
      // sends no status, so its API error still counts.
      const limit = turn.usageLimit;
      const limitError = apiError && (message.api_error_status == null || message.api_error_status === 429);
      if (
        limit &&
        !interrupted &&
        (limit.text !== null || limitError) &&
        !isBalanceDiagnostic(limit.text ?? `${errors.join("\n")}\n${fallback}`)
      ) {
        this.emit("notification", {
          method: USAGE_LIMIT_METHOD,
          params: { threadId: runtime.id, turnId: turn.id, resetsAt: limit.resetsAt },
        });
        this.#reconcileText(runtime, [...turn.assistantMessages.values()].join(""));
        yield* this.#completeTurn(
          runtime,
          "failed",
          limit.text ?? (errors.join("\n") || fallback || sourceText("error.provider.usageLimitReached")),
        );
        return;
      }
      this.#reconcileText(runtime, [...turn.assistantMessages.values()].join(""));
      if (!turn.seenText && fallback && !apiError) this.#bufferText(runtime, fallback);
    }
    const status = interrupted ? "interrupted" : message.subtype === "success" && !apiError ? "completed" : "failed";
    yield* this.#completeTurn(runtime, status, errors.length > 0 ? errors.join("\n") : apiError ? fallback : null);
    // A local SDK control request reads context; it does not send a user turn or call a model.
    // Run outside the stream consumer so the result cannot block the queue or the SDK reader.
    const contextRequest = ++runtime.contextRequest;
    if (runtime.query.getContextUsage)
      yield* Effect.forkIn(
        providerCall(() => runtime.query.getContextUsage?.({ detail: "summary" })).pipe(
          Effect.timeout("2 seconds"),
          Effect.tap((usage) =>
            Effect.sync(() => {
              if (
                this.#threads.get(runtime.id) !== runtime ||
                runtime.contextRequest !== contextRequest ||
                runtime.activeTurn ||
                !isRecord(usage)
              )
                return;
              this.#emitContextUsage(runtime, usage.totalTokens, usage.rawMaxTokens, claudeContextCategories(usage));
            }),
          ),
          Effect.ignore,
        ),
        this.#scope,
      );
  });

  #emitContextUsage(
    runtime: ThreadRuntime,
    used: unknown,
    window: unknown,
    categories?: AgentContextCategoryUsage[],
  ): void {
    if (
      typeof used !== "number" ||
      !Number.isFinite(used) ||
      used < 0 ||
      typeof window !== "number" ||
      !Number.isFinite(window) ||
      window <= 0
    )
      return;
    this.emit("notification", {
      method: "thread/tokenUsage/updated",
      params: {
        threadId: runtime.id,
        tokenUsage: {
          last: { totalTokens: used },
          modelContextWindow: window,
          estimated: true,
          ...(categories ? { categories } : {}),
        },
      },
    });
  }

  /** `failed` is the tool result's `is_error`, such as a shell command with a non-zero exit. */
  #emitToolCall(
    runtime: ThreadRuntime,
    id: string,
    name: string,
    completed: boolean,
    input?: unknown,
    failed = false,
    failure?: string,
    result?: { text: string; command: string | null },
  ): void {
    const turn = runtime.activeTurn;
    if (!turn) return;
    // A bridged call holds the tool's own arguments in `arguments`. `name` is already the bridged tool's
    // (`claudeBridgedToolName`), so a bridged send_message arrives as mcp__openbot__send_message.
    const bridged = isRecord(input) && isString(input.name) && "arguments" in input;
    const message = name === "mcp__openbot__send_message" ? (bridged ? input.arguments : input) : undefined;
    const recipientAgentIds = isRecord(message) ? normalizeSendMessageArguments(message).recipientAgentIds : undefined;
    const recipients = Array.isArray(recipientAgentIds) ? { recipientAgentIds } : null;
    this.emit("notification", {
      method: completed ? "item/completed" : "item/started",
      params: {
        threadId: runtime.id,
        turnId: turn.id,
        filePaths:
          ["Read", "Write", "Edit", "MultiEdit"].includes(name) &&
          isRecord(input) &&
          typeof input.file_path === "string"
            ? [input.file_path]
            : undefined,
        item: {
          id,
          type: "toolCall",
          name,
          status: completed ? (failed ? "failed" : "completed") : "in_progress",
          // The skill that a `Skill` call loads, for the turn's activity line.
          ...(name === "Skill" && isRecord(input) && typeof input.skill === "string"
            ? { skill: input.skill.slice(0, INPUT_LIMITS.identifier) }
            : {}),
          // The step trail names the file of a file tool, as it does for Codex file changes.
          ...(["Read", "Write", "Edit", "MultiEdit", "NotebookEdit"].includes(name) && isRecord(input)
            ? fileToolArguments(input)
            : {}),
          // The turn trace shows the command and the recipients; it redacts the command.
          ...(name === "Bash" && isRecord(input) && typeof input.command === "string"
            ? { command: input.command.slice(0, INPUT_LIMITS.messageText) }
            : {}),
          ...(recipients === null
            ? {}
            : { arguments: bridged ? { name: "openbot.send_message", arguments: recipients } : recipients }),
          ...(failed && failure ? { error: failure } : {}),
          // The guardrails count repeated calls and read untrusted results; nothing stores these.
          ...(!completed && input !== undefined ? { inputDigest: toolInputDigest(name, input) } : {}),
          ...(result ? toolResultFields(name, result.command, result.text) : {}),
        },
      },
    });
  }

  /* Not tied to the active turn: a background subagent reports after its turn ended. */
  #emitSubagents(runtime: ThreadRuntime, change: SubagentChange | null): void {
    if (!change) return;
    this.emit("notification", {
      method: SUBAGENTS_UPDATED_METHOD,
      params: { threadId: runtime.id, turnId: change.turnId, subagents: change.subagents },
    });
  }

  #emitPlan(runtime: ThreadRuntime, plan: PlanUpdateStep[]): void {
    const turn = runtime.activeTurn;
    if (!turn) return;
    this.emit("notification", {
      method: PLAN_UPDATED_METHOD,
      params: { threadId: runtime.id, turnId: turn.id, explanation: null, plan },
    });
  }

  /* Claude streams reasoning as its own content block; the app-server vocabulary carries it as a
     separate agentMessage item whose `commentary` phase becomes the thinking disclosure. */
  #appendThinkingDelta(runtime: ThreadRuntime, delta: string, streamId?: string): void {
    const turn = runtime.activeTurn;
    if (!turn || !delta) return;
    /* A thinking block beginning closes the step. Filling in the rest of one that already began
       does not, and a message carries that backfill with no stream of its own: flushing there
       would publish text the turn holds for its answer as narration and end with no answer. */
    if (streamId !== undefined && streamId !== turn.thinkingStreamId) this.#flushNarration(runtime);
    if (!turn.thinkingStarted) {
      turn.thinkingStarted = true;
      this.emit("notification", {
        method: "item/started",
        params: {
          threadId: runtime.id,
          turnId: turn.id,
          item: { id: turn.reasoningItemId, type: "agentMessage", phase: "commentary" },
        },
      });
    }
    const nextDelta = streamId && turn.thinkingStreamId && streamId !== turn.thinkingStreamId ? `\n${delta}` : delta;
    if (streamId) turn.thinkingStreamId = streamId;
    turn.thinking += nextDelta;
    this.emit("notification", {
      method: "item/agentMessage/delta",
      params: {
        threadId: runtime.id,
        turnId: turn.id,
        itemId: turn.reasoningItemId,
        delta: nextDelta,
      },
    });
  }

  /* Claude cannot say which text is its answer while the text arrives: the narration before a tool
     call reads the same as the reply that ends the turn. Hold it here instead of streaming it into
     the answer item, where every word of it drew a chat bubble that the end of the turn rewrote. */
  #bufferText(runtime: ThreadRuntime, delta: string): void {
    const turn = runtime.activeTurn;
    if (!turn || !delta) return;
    turn.text += delta;
    turn.seenText += delta;
  }

  /**
   * Let the complete assistant messages correct what the stream delivered.
   *
   * A delta can go missing, and the complete messages are the ones Claude stands behind. They can
   * only rewrite what no step boundary has published yet, so this has to run before every flush
   * while the current step can still be corrected: publishing a stale step would strand every
   * later comparison behind text Claude never sent, and the answer would be dropped with it.
   */
  #reconcileText(runtime: ThreadRuntime, completeText: string): void {
    const turn = runtime.activeTurn;
    if (!turn) return;
    if (completeText.startsWith(turn.seenText)) {
      this.#bufferText(runtime, completeText.slice(turn.seenText.length));
      return;
    }
    if (completeText.length === 0) return;
    if (completeText.startsWith(turn.publishedText)) {
      turn.text = completeText.slice(turn.publishedText.length);
      turn.seenText = completeText;
      return;
    }
    this.#correctNarration(runtime, completeText);
  }

  /**
   * Put right the narration a boundary published before any message stood behind it.
   *
   * Thinking closes a step while the message carrying the text is still arriving, so the only text
   * there is to publish is what the deltas gave. When the message then disagrees, the published
   * segment is republished under its own ID rather than left to strand every later comparison
   * behind words Claude never sent. Text already held for the answer is not taken into it.
   */
  #correctNarration(runtime: ThreadRuntime, completeText: string): void {
    const turn = runtime.activeTurn;
    const last = turn?.lastNarration;
    if (!turn || !last) return;
    const prefix = turn.publishedText.slice(0, turn.publishedText.length - last.text.length);
    if (!completeText.startsWith(prefix)) return;
    const heldBack = turn.text.length > 0 && completeText.endsWith(turn.text) ? turn.text.length : 0;
    const corrected = completeText.slice(prefix.length, completeText.length - heldBack);
    if (!corrected || corrected === last.text) return;
    last.text = corrected;
    turn.publishedText = `${prefix}${corrected}`;
    // Whatever the correction did not take is the answer's again, so the two stay in step.
    turn.text = completeText.slice(prefix.length + corrected.length);
    turn.seenText = completeText;
    this.emit("notification", {
      method: "item/completed",
      params: {
        threadId: runtime.id,
        turnId: turn.id,
        item: { id: last.id, type: "agentMessage", phase: "commentary", text: corrected },
      },
    });
  }

  /** Publish held text as the thinking disclosure, which is what a step boundary proves it was. */
  #flushNarration(runtime: ThreadRuntime): void {
    const turn = runtime.activeTurn;
    if (!turn?.text) return;
    const text = turn.text;
    const id = `${turn.id}:narration:${turn.narrationCount}`;
    this.emit("notification", {
      method: "item/completed",
      params: {
        threadId: runtime.id,
        turnId: turn.id,
        item: { id, type: "agentMessage", phase: "commentary", text },
      },
    });
    turn.lastNarration = { id, text };
    turn.narrationCount += 1;
    turn.publishedText += text;
    turn.text = turn.text.slice(text.length);
  }

  readonly #completeTurn = Effect.fn("ClaudeAgentClient.completeTurn")(function* (
    this: ClaudeAgentClient,
    runtime: ThreadRuntime,
    status: string,
    error: unknown,
  ) {
    const turn = runtime.activeTurn;
    if (!turn) return;
    if (runtime.compacting && status !== "completed") {
      runtime.compacting = false;
      this.emit("notification", {
        method: "openbot/context-compaction",
        params: { threadId: runtime.id, status: "failed" },
      });
    }
    if (turn.thinkingStarted) {
      this.emit("notification", {
        method: "item/completed",
        params: {
          threadId: runtime.id,
          turnId: turn.id,
          item: { id: turn.reasoningItemId, type: "agentMessage", phase: "commentary", text: turn.thinking },
        },
      });
    }
    this.emit("notification", {
      method: "item/completed",
      params: {
        threadId: runtime.id,
        turnId: turn.id,
        item: { id: turn.itemId, type: "agentMessage", text: turn.text },
      },
    });
    if (status === "failed" && error) {
      this.emit("notification", {
        method: "error",
        params: { threadId: runtime.id, turnId: turn.id, message: String(error) },
      });
    }
    this.#emitSubagents(runtime, endClaudeSubagentTurn(runtime.subagents, turn.id, new Date().toISOString()));
    this.emit("notification", {
      method: "turn/completed",
      params: { threadId: runtime.id, turn: { id: turn.id, status } },
    });
    runtime.activeTurn = null;
    yield* this.#threads.markIdle(runtime);
  });

  readonly #readThreadEffect = Effect.fn("ClaudeAgentClient.readThread")(function* (
    this: ClaudeAgentClient,
    threadId: string,
  ): Effect.fn.Return<ThreadResponse, ProviderClientOperationError> {
    const cwd = this.#threads.get(threadId)?.config.cwd ?? this.#threads.released(threadId)?.cwd;
    if (!this.#readSessionMessages) {
      // thread/read is a released full-history response. Reconstruct it transiently from bounded pages.
      const turns: NonNullable<ThreadResponse["thread"]["turns"]> = [];
      let currentTurn: (typeof turns)[number] | null = null;
      yield* this.readHistory({ threadId, ...(cwd === undefined ? {} : { cwd }), items: "full" }, (fragment) =>
        Effect.sync(() => {
          if (currentTurn?.id === fragment.turnId) {
            currentTurn.items = [...(currentTurn.items ?? []), ...fragment.items];
            return true;
          }
          currentTurn = {
            id: fragment.turnId,
            status: fragment.status ?? "completed",
            ...(fragment.startedAt === undefined ? {} : { startedAt: fragment.startedAt }),
            items: fragment.items,
          };
          turns.unshift(currentTurn);
          return true;
        }),
      );
      return { thread: { id: threadId, turns } };
    }
    const readSessionMessages = this.#readSessionMessages;
    if (!readSessionMessages) return { thread: { id: threadId, turns: [] } };
    const messages = yield* providerCall(() => readSessionMessages(threadId, cwd ? { dir: cwd } : undefined));
    const turns: NonNullable<ThreadResponse["thread"]["turns"]> = [];
    let current: (typeof turns)[number] | null = null;
    let currentThinking: ThreadItem | null = null;
    /* Only a turn's last answer is an answer. Every earlier one was narration between tool calls,
       so it is demoted as soon as the next one proves it was not the end of the turn. A restored
       thread otherwise reopens with the chat bubbles a live turn no longer draws. */
    let currentAnswer: ThreadItem | null = null;
    /* Claude writes its compaction summary as a user entry, and the reply after it finishes a turn
       the app already published live under that turn's own ID. Neither is restored. */
    let skippingCompaction = false;
    for (const message of messages) {
      if (message.parent_tool_use_id) continue;
      const text = messageText(message.message);
      if (message.type === "user") {
        if (!text || isClaudeInterruptMarker(text)) continue;
        if (isClaudeCompactionSummary(text)) {
          skippingCompaction = true;
          current = null;
          continue;
        }
        skippingCompaction = false;
        /* A task notification or a slash command still opens the turn that answers it. The user did not
           write that text: the mailbox already holds the command as the user sent it. */
        current = {
          id: message.uuid,
          status: "completed",
          items:
            isClaudeTaskNotification(text) || isClaudeLocalCommand(text)
              ? []
              : [
                  {
                    id: message.uuid,
                    type: "userMessage",
                    clientId: message.uuid,
                    content: [{ type: "text", text }],
                  },
                ],
        };
        turns.push(current);
        currentThinking = null;
        currentAnswer = null;
      } else if (message.type === "assistant") {
        if (skippingCompaction) continue;
        const thinking = messageThinking(message.message);
        const endsStep = messageToolCalls(message.message).length > 0;
        if (!thinking && !text && !endsStep) continue;
        if (!current && (thinking || text)) {
          current = { id: message.uuid, status: "completed", items: [] };
          turns.push(current);
          currentThinking = null;
          currentAnswer = null;
        }
        if (!current) continue;
        /* One message can hold text on both sides of its thinking, and only what follows can be
           the answer. The live turn splits it there, so restoring has to split it the same way. */
        const beforeThinking = thinking ? textBeforeThinking(message.message) : "";
        if (thinking) {
          /* Thinking closes the step for a live turn, so it has to close it here as well. A turn
             that stopped while thinking otherwise keeps the text that led to it as the answer. */
          if (currentAnswer) {
            currentAnswer.phase = "commentary";
            currentAnswer = null;
          }
          if (beforeThinking) {
            current.items?.push({
              id: `${message.uuid}:narration`,
              type: "agentMessage",
              phase: "commentary",
              text: beforeThinking,
            });
          }
          if (currentThinking) {
            currentThinking.text = `${currentThinking.text ?? ""}\n${thinking}`;
          } else {
            currentThinking = {
              id: `${current.id}:reasoning`,
              type: "agentMessage",
              phase: "commentary",
              text: thinking,
            };
            current.items?.push(currentThinking);
          }
        }
        const answerText = text.slice(beforeThinking.length);
        if (answerText) {
          if (currentAnswer) currentAnswer.phase = "commentary";
          currentAnswer = { id: message.uuid, type: "agentMessage", text: answerText };
          current.items?.push(currentAnswer);
        }
        /* A tool call closes the step here too, including one the same message introduced. Without
           this, a turn that stopped on its tool call keeps the narration that led to it as the
           answer, and restores the bubble the live path removed. */
        if (endsStep && currentAnswer) {
          currentAnswer.phase = "commentary";
          currentAnswer = null;
        }
      }
    }
    return { thread: { id: threadId, turns } };
  });

  #createOpenBotServers(threadId: string) {
    const call = (namespace: string, name: string, args: unknown) =>
      runCauseEffect(this.#callDynamicTool(threadId, namespace, name, args));
    return {
      openbot: claudeOpenBotServer((name, args) => call("openbot", name, args)),
    };
  }

  readonly #callDynamicTool = Effect.fn("ClaudeAgentClient.callDynamicTool")(function* (
    this: ClaudeAgentClient,
    threadId: string,
    namespace: string,
    name: string,
    args: unknown,
  ): Effect.fn.Return<CallToolResult, ProviderClientOperationError> {
    const runtime = yield* providerSync(() => this.#requireThread(threadId));
    const result = yield* this.#awaitHost(
      threadId,
      this.#serverRequests.call("item/tool/call", {
        threadId,
        turnId: runtime.activeTurn?.id ?? randomUUID(),
        callId: randomUUID(),
        namespace,
        tool: name,
        arguments: args,
      }),
    ).pipe(toProviderClientOperationError);
    if (!isRecord(result)) return { content: [{ type: "text" as const, text: String(result) }] };
    const content: CallToolResult["content"] = [];
    if (Array.isArray(result.contentItems)) {
      for (const item of result.contentItems) content.push(...dynamicContent(item));
    }
    return { content, isError: result.success === false };
  });

  readonly #requestUserInputEffect = Effect.fn("ClaudeAgentClient.requestUserInput")(function* (
    this: ClaudeAgentClient,
    threadId: string,
    input: DynamicRecord,
    toolUseId: string,
  ): Effect.fn.Return<PermissionResult, ProviderClientOperationError> {
    const runtime = yield* providerSync(() => this.#requireThread(threadId));
    const rawQuestions = Array.isArray(input.questions) ? input.questions.filter(isRecord) : [];
    const questions = rawQuestions.map((question, index) => ({
      id: `question-${index}`,
      header: isString(question.header) ? question.header : "Question",
      question: isString(question.question) ? question.question : "Claude needs more information.",
      options: Array.isArray(question.options) ? question.options : undefined,
      ...(question.multiSelect === true ? { multiSelect: true } : {}),
    }));
    const result = yield* this.#awaitHost(
      threadId,
      this.#serverRequests.call("item/tool/requestUserInput", {
        threadId,
        turnId: runtime.activeTurn?.id ?? randomUUID(),
        itemId: toolUseId,
        questions,
      }),
    ).pipe(toProviderClientOperationError);
    const responseAnswers = isRecord(result) && isRecord(result.answers) ? result.answers : {};
    const answers = Object.fromEntries(
      questions.map((question) => {
        const entry = responseAnswers[question.id];
        const values = isRecord(entry) && Array.isArray(entry.answers) ? entry.answers : [];
        return [question.question, values.filter((value): value is string => isString(value)).join(", ")];
      }),
    );
    return { behavior: "allow", updatedInput: { questions: input.questions, answers } };
  });

  /**
   * A Workspace only agent's file write outside its roots, shown as a file-change approval. The
   * approval registry never answers it without the user, as for a Codex write outside the sandbox.
   */

  /**
   * Asks the host's trust gate about a Bash or MCP tool use. `check` answers at once; `approve` waits
   * for the owner's approval card when the policy asks.
   */
  readonly #trustCheck = Effect.fn("ClaudeAgentClient.trustCheck")(function* (
    this: ClaudeAgentClient,
    threadId: string,
    toolName: string,
    toolInput: unknown,
    phase: "check" | "approve",
  ): Effect.fn.Return<{ decision: "allow" | "deny" | "ask"; reason?: string }, ProviderClientOperationError> {
    const result = yield* this.#awaitHost(
      threadId,
      this.#serverRequests.call(TRUST_CHECK_METHOD, {
        threadId,
        turnId: this.#threads.get(threadId)?.activeTurn?.id ?? randomUUID(),
        toolName,
        toolInput,
        // A script that a Bash command runs by a relative path is read from here.
        cwd: this.#threads.get(threadId)?.config.cwd ?? null,
        phase,
      }),
    ).pipe(toProviderClientOperationError);
    if (!isRecord(result)) return { decision: "allow" };
    const decision = result.decision === "deny" || result.decision === "ask" ? result.decision : "allow";
    return { decision, ...(isString(result.reason) ? { reason: result.reason } : {}) };
  });

  readonly #requestWriteApprovalEffect = Effect.fn("ClaudeAgentClient.requestWriteApproval")(function* (
    this: ClaudeAgentClient,
    threadId: string,
    path: string,
    toolInput: DynamicRecord,
    toolUseId: string,
  ): Effect.fn.Return<PermissionResult, ProviderClientOperationError> {
    const result = yield* this.#awaitHost(
      threadId,
      this.#serverRequests.call("item/fileChange/requestApproval", {
        threadId,
        turnId: this.#threads.get(threadId)?.activeTurn?.id ?? randomUUID(),
        itemId: toolUseId,
        reason: sourceText("status.agent.claudeWriteOutside", { path }),
      }),
    ).pipe(toProviderClientOperationError);
    if (isRecord(result) && result.decision === "accept") return { behavior: "allow", updatedInput: toolInput };
    return { behavior: "deny", message: "The user did not allow this write outside the workspace." };
  });

  #requireThread(threadId: string): ThreadRuntime {
    const runtime = this.#threads.get(threadId);
    if (!runtime) throw new Error(`Unknown Claude thread: ${threadId}`);
    return runtime;
  }

  #resolveEffort(model: string | undefined, effort: string | undefined): ClaudeEffort | undefined {
    if (!effort) return undefined;
    const normalized = normalizeClaudeEffort(effort);
    if (!model) return normalized;
    const capability = this.#modelEffortCapabilities.get(model);
    if (capability === null) return undefined;
    if (!capability || capability.supported.includes(normalized)) return normalized;
    return capability.defaultEffort;
  }

  #sdkModel(model: string): string {
    return this.#modelSdkValues.get(model) ?? normalizeClaudeModel(model);
  }
}

/**
 * The error of a Claude process that a signal ended after the kernel refused a new task: the CLI
 * aborts with no message when it cannot start a thread, and the plain "terminated by signal
 * SIGABRT" says nothing about the cause or the fix. Production on 2026-11-16: eight crashes, each
 * at a "fork rejected by pids controller" of the container's `pids_limit: 1024`.
 */
function processLimitFailure(before: TaskLimitState | null, cause: Error): Error | null {
  if (!/terminated by signal/i.test(cause.message)) return null;
  const after = readTaskLimit();
  if (!taskLimitReachedSince(before, after)) return null;
  return new Error(sourceText("error.provider.claudeProcessLimit", { limit: after?.max ?? after?.current ?? 0 }), {
    cause,
  });
}

type ClaudeSdkLaunch = Pick<Options, "pathToClaudeCodeExecutable" | "spawnClaudeCodeProcess">;

/**
 * The npm wrapper for Claude Code ends with the real program, `"%dp0%\node_modules\…\claude.exe" %*`,
 * or with `cli.js` after `"%_prog%"`.
 */
const NPM_WRAPPER_TARGET = /"%dp0%\\([^"%]+\.(?:exe|js))"\s+%\*/i;

/**
 * The SDK starts every CLI path that does not end in `.js` as a native program, with no shell. Node
 * refuses to start a `.cmd` or `.bat` that way (`spawn EINVAL`), and an npm install of Claude Code on
 * Windows puts `claude.cmd` on `PATH`. The SDK gets the program that an npm wrapper starts, so no
 * `cmd.exe` limits the length or the quoting of the arguments. Another wrapper starts through
 * `cmd.exe`, as `cliSpawnTarget` says.
 */
/** The user-level memory files of Claude Code, its CLAUDE.md and rules, in the config folder and in `~/.claude`. */
function claudeHomeMemoryFiles(configDirectory: string | undefined): string[] {
  const folders = new Set([configDirectory ?? join(homedir(), ".claude"), join(homedir(), ".claude")]);
  return [...folders].flatMap((folder) => [join(folder, "CLAUDE.md"), join(folder, "rules", "**")]);
}

/** A Claude settings file as a record; a missing or broken file reads as empty. */
const readClaudeSettingsFile = Effect.fn("ClaudeAgentClient.readSettingsFile")(function* (path: string) {
  const text = yield* Effect.tryPromise(() => readFile(path, "utf8")).pipe(Effect.orElseSucceed(() => ""));
  try {
    const parsed = text ? JSON.parse(text) : {};
    return isDynamicRecord(parsed) ? parsed : {};
  } catch {
    queryLogger.warn("OpenBot reads no values from a Claude settings file: the file is not valid JSON.", { path });
    return {};
  }
});

/** One file for each thread and start, readable by this user only, removed when the CLI answers. */
const writeClaudeMcpConfig = Effect.fn("ClaudeAgentClient.writeMcpConfig")(function* (
  stateDirectory: string,
  threadId: string,
  servers: Record<string, ClaudeMcpServer>,
) {
  const directory = join(stateDirectory, "claude-mcp");
  const file = join(directory, `${threadId}-${randomUUID()}.json`);
  yield* providerCall(() => mkdir(directory, { recursive: true, mode: 0o700 }));
  yield* providerCall(() => writeFile(file, JSON.stringify({ mcpServers: servers }), { mode: 0o600, flag: "wx" }));
  return file;
});

function removeMcpConfigFile(runtime: ThreadRuntime): void {
  const file = runtime.mcpConfigFile;
  if (!file) return;
  runtime.mcpConfigFile = null;
  void rm(file, { force: true }).catch(() => undefined);
}

/** One file for each thread, rewritten at each start, readable by this user only. */
const writeClaudeFlagSettings = Effect.fn("ClaudeAgentClient.writeFlagSettings")(function* (
  stateDirectory: string,
  threadId: string,
  settings: Settings,
) {
  const directory = join(stateDirectory, "claude-settings");
  const file = join(directory, `${threadId}.json`);
  yield* providerCall(() => mkdir(directory, { recursive: true, mode: 0o700 }));
  yield* providerCall(() => writeFile(file, JSON.stringify(settings), { mode: 0o600 }));
  return file;
});

/** OpenBot's in-process MCP server for Claude. Claude uses the SDK's AskUserQuestion permission flow. */
export function claudeOpenBotServer(call: (name: string, args: unknown) => Promise<CallToolResult>) {
  return createSdkMcpServer({
    name: "openbot",
    version: "0.1.0",
    tools: VISIBLE_TOOL_DEFINITIONS.filter((definition) => definition.name !== "ask_user").map((definition) =>
      tool(definition.name, definition.description, definition.shape, (args) => call(definition.name, args)),
    ),
  });
}

function claudeSdkLaunch(executable: string): ClaudeSdkLaunch {
  if (!cliSpawnTarget(executable, []).windowsVerbatimArguments) return { pathToClaudeCodeExecutable: executable };
  const target = NPM_WRAPPER_TARGET.exec(readWrapper(executable))?.[1];
  const program = target ? join(dirname(executable), target) : null;
  if (program && existsSync(program)) return { pathToClaudeCodeExecutable: program };
  return { pathToClaudeCodeExecutable: executable, spawnClaudeCodeProcess: spawnClaudeWrapper };
}

function readWrapper(executable: string): string {
  try {
    return readFileSync(executable, "utf8");
  } catch {
    return "";
  }
}

/**
 * A kill of `cmd.exe` leaves `claude.exe` running, so a kill stops the whole tree. The SDK reads no
 * stderr from a process it did not start, and a full stderr pipe would block the CLI.
 */
function spawnClaudeWrapper({ command, args, cwd, env, signal }: SpawnOptions): SpawnedProcess {
  const target = cliSpawnTarget(command, args);
  const child = spawn(target.command, target.args, {
    cwd,
    env,
    stdio: ["pipe", "pipe", "ignore"],
    windowsHide: true,
    windowsVerbatimArguments: target.windowsVerbatimArguments,
  });
  const killWrapper = child.kill.bind(child);
  const running = () => child.pid !== undefined && child.exitCode === null && child.signalCode === null;
  let stopping = false;
  // `taskkill /T` finds the children only while `cmd.exe` runs, so the wrapper goes last.
  child.kill = (killSignal) => {
    if (!running()) return false;
    if (stopping) return true;
    stopping = true;
    execFile("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true }, () => {
      if (running()) killWrapper(killSignal);
    });
    return true;
  };
  const abort = () => child.kill();
  const release = () => signal.removeEventListener("abort", abort);
  signal.addEventListener("abort", abort, { once: true });
  child.once("exit", release);
  child.once("error", release);
  if (signal.aborted) abort();
  return child;
}

/** The model of the subagents of every Claude agent, unless the server's provider variables set one. */
const CLAUDE_SUBAGENT_MODEL = "sonnet";

function claudeEnvironment(cli: ClaudeCliInfo): NodeJS.ProcessEnv {
  return {
    ...agentInheritedEnvironment(),
    ...cliPathEnvironment(cli),
    ...(cli.source === "managed" ? { DISABLE_AUTOUPDATER: "1" } : {}),
  };
}

function claudeRateLimits(value: unknown, model: string | null): AccountRateLimitsReadResult {
  if (!isDynamicRecord(value) || value.rate_limits_available !== true || !isDynamicRecord(value.rate_limits)) {
    return { rateLimits: null, rateLimitsByLimitId: null };
  }
  const rateLimits = value.rate_limits;
  const primary = claudeUsageWindow(rateLimits.five_hour, 300);
  const secondary = claudeUsageWindow(rateLimits[claudeWeeklyKey(rateLimits, model)], 10_080);
  if (!primary && !secondary) return { rateLimits: null, rateLimitsByLimitId: null };
  return {
    rateLimits: { limitId: "claude", primary, secondary },
    rateLimitsByLimitId: null,
  };
}

/** The weekly window a reading shows: the one of the model's family when Claude reports it, else the overall one. */
function claudeWeeklyKey(rateLimits: DynamicRecord, model: string | null): string {
  const name = model?.toLowerCase() ?? "";
  const familyKey = name.includes("opus") ? "seven_day_opus" : name.includes("sonnet") ? "seven_day_sonnet" : null;
  return familyKey && claudeUsageWindow(rateLimits[familyKey], 10_080) ? familyKey : "seven_day";
}

/**
 * The windows that a live `rate_limit_event` reports, in the shape of a reading. The CLI sends both windows in
 * `unifiedWindows` on each event. Before its first such response, and in an older CLI, the event holds only the
 * window of `rateLimitType`, at the top level. `unifiedWindows` has no model-family weekly window, so a reading
 * that shows one keeps it.
 */
function claudePushedWindows(
  info: DynamicRecord,
  weeklyKey: string,
): { primary?: AccountRateLimitWindowResult; secondary?: AccountRateLimitWindowResult } | null {
  const windows = isDynamicRecord(info.unifiedWindows)
    ? info.unifiedWindows
    : isString(info.rateLimitType)
      ? { [info.rateLimitType]: info }
      : {};
  const primary = claudePushedWindow(windows.five_hour, 300);
  const secondary = claudePushedWindow(windows[weeklyKey], 10_080);
  if (!primary && !secondary) return null;
  return { ...(primary && { primary }), ...(secondary && { secondary }) };
}

/**
 * The event sends `utilization` as a fraction of 1, where the usage reading sends a percent. A value above 1 is
 * usage past the cap, so it is kept, as a reading keeps a percent above 100.
 */
function claudePushedWindow(value: unknown, windowDurationMins: number): AccountRateLimitWindowResult | null {
  if (!isDynamicRecord(value)) return null;
  const utilization = numberValue(value.utilization);
  if (utilization === null || utilization < 0) return null;
  return { usedPercent: utilization * 100, windowDurationMins, resetsAt: claudeResetSeconds(value.resetsAt) };
}

function claudeUsageWindow(value: unknown, windowDurationMins: number): AccountRateLimitWindowResult | null {
  if (!isDynamicRecord(value)) return null;
  const usedPercent = numberValue(value.utilization) ?? numberValue(value.percent);
  if (usedPercent === null) return null;
  const reset = stringValue(value.resets_at) ?? stringValue(value.resetsAt);
  const resetMilliseconds = reset ? Date.parse(reset) : Number.NaN;
  return {
    usedPercent,
    windowDurationMins,
    resetsAt: Number.isFinite(resetMilliseconds) ? resetMilliseconds / 1_000 : null,
  };
}

/** Claude reports a reset in epoch seconds. A value in milliseconds is converted, so both read the same. */
function claudeResetSeconds(value: unknown): number | null {
  if (!isNumber(value) || !Number.isFinite(value) || value <= 0) return null;
  return value > 100_000_000_000 ? value / 1_000 : value;
}

function stringValue(value: unknown): string | null {
  return isString(value) && value.trim() ? value.trim() : null;
}

function numberValue(value: unknown): number | null {
  return isNumber(value) && Number.isFinite(value) ? value : null;
}

class AsyncMessageQueue implements AsyncIterable<SDKUserMessage> {
  readonly #values: SDKUserMessage[] = [];
  readonly #waiters: Array<(result: IteratorResult<SDKUserMessage>) => void> = [];
  #closed = false;

  push(value: SDKUserMessage): void {
    if (this.#closed) throw new Error("Claude input queue is closed.");
    const waiter = this.#waiters.shift();
    if (waiter) waiter({ done: false, value });
    else this.#values.push(value);
  }

  close(): void {
    this.#closed = true;
    for (const waiter of this.#waiters.splice(0)) waiter({ done: true, value: undefined });
  }

  [Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    return {
      next: () => {
        const value = this.#values.shift();
        if (value) return Promise.resolve({ done: false, value });
        if (this.#closed) return Promise.resolve({ done: true, value: undefined });
        return new Promise((resolve) => this.#waiters.push(resolve));
      },
    };
  }
}

function readThreadConfig(params: unknown): ThreadConfig {
  const roots =
    isRecord(params) && Array.isArray(params.runtimeWorkspaceRoots)
      ? params.runtimeWorkspaceRoots.filter((value): value is string => isString(value))
      : [];
  const cwd = requiredString(params, "cwd");
  const model = getString(params, "model");
  const effort = getString(params, "effort");
  const jailAgentId = getString(params, "jailAgentId");
  const jailReadRoots =
    isRecord(params) && Array.isArray(params.jailReadRoots)
      ? params.jailReadRoots.filter((value): value is string => isString(value))
      : [];
  return {
    cwd,
    mcpChatId: getString(params, "mcpChatId") ?? undefined,
    ...(model === null ? {} : { model }),
    ...(effort === null ? {} : { effort }),
    developerInstructions: getString(params, "developerInstructions") ?? "",
    additionalDirectories: [...new Set([cwd, ...roots])],
    persistSession: !isRecord(params) || params.persistSession !== false,
    profileGeneration: isRecord(params) && params.profileGeneration === true,
    ...(isRecord(params) && params.profileGeneration === true && params.webResearch === true
      ? { webResearch: true }
      : {}),
    computerUse: computerUseParam(params),
    workspaceOnly: isRecord(params) && params.workspaceOnly === true,
    ...(jailAgentId ? { jailAgentId, jailReadRoots } : {}),
  };
}

/**
 * A thread configuration for comparison. A turn sets `model` and `effort` on the live configuration,
 * and that changes the key order: compared as written, a later resume restarted a query that had
 * the same configuration. A restart sends the full conversation to the model again.
 */
function threadConfigKey(config: ThreadConfig, withModel: boolean): string {
  // A teammate who joins or leaves the space reaches the jail at the next start of the process; a
  // restart only for that would write the whole conversation to the cache again.
  const { jailReadRoots: _teammates, ...kept } = config;
  const fields = {
    ...kept,
    model: withModel ? (config.model ?? null) : null,
    effort: withModel ? (config.effort ?? null) : null,
  };
  return JSON.stringify(Object.entries(fields).sort(([a], [b]) => (a < b ? -1 : 1)));
}

function readMemoryContext(params: unknown): MemoryContext | null {
  const context = isRecord(params) ? params.memoryContext : undefined;
  if (!isRecord(context) || !Array.isArray(context.memories)) return null;
  if (!isNumber(context.storedCount) || !isNumber(context.limit)) return null;
  const memories = context.memories.filter(
    (memory): memory is MemoryContext["memories"][number] =>
      isRecord(memory) &&
      isString(memory.id) &&
      isString(memory.text) &&
      isOneOf(["automatic", "manual"] as const, memory.origin),
  );
  return { memories, storedCount: context.storedCount, limit: context.limit };
}

function readSectionTeammates(value: unknown): SectionTeammates | null {
  if (!isRecord(value) || !isString(value.name) || !Array.isArray(value.members)) return null;
  const members = value.members.filter(
    (member): member is SectionTeammates["members"][number] =>
      isRecord(member) && isString(member.id) && isString(member.name) && isString(member.title),
  );
  return members.length > 0 ? { name: value.name, members } : null;
}

function parseAuthStatus(stdout: unknown): DynamicRecord | null {
  if (!isString(stdout)) return null;
  try {
    const status = JSON.parse(stdout);
    return isRecord(status) && typeof status.loggedIn === "boolean" ? status : null;
  } catch {
    return null;
  }
}

function readInputText(params: unknown): string {
  if (!isRecord(params) || !Array.isArray(params.input)) return "";
  return params.input
    .filter(isRecord)
    .filter((item) => item.type === "text" && isString(item.text))
    .map((item) => item.text)
    .join("\n");
}

function messageText(message: unknown): string {
  if (!isRecord(message)) return "";
  if (isString(message.content)) return message.content;
  if (!Array.isArray(message.content)) return "";
  return message.content
    .filter(isRecord)
    .filter(
      (block) =>
        block.type === "text" &&
        isString(block.text) &&
        // OpenBot's memory block is not text that the user wrote.
        !(message.role === "user" && isTurnContextBlock(block.text)),
    )
    .map((block) => block.text)
    .join("\n");
}

/** The text a message placed before its first thinking block, with the break that follows it. */
function textBeforeThinking(message: unknown): string {
  if (!isRecord(message) || !Array.isArray(message.content)) return "";
  const blocks = message.content.filter(isRecord);
  const boundary = blocks.findIndex((block) => block.type === "thinking");
  if (boundary < 0) return "";
  const before = blocks
    .slice(0, boundary)
    .filter((block) => block.type === "text" && isString(block.text))
    .map((block) => String(block.text));
  if (before.length === 0) return "";
  const follows = blocks.slice(boundary + 1).some((block) => block.type === "text" && isString(block.text));
  return `${before.join("\n")}${follows ? "\n" : ""}`;
}

function messageThinking(message: unknown): string {
  if (!isRecord(message) || !Array.isArray(message.content)) return "";
  return message.content
    .filter(isRecord)
    .filter((block) => block.type === "thinking")
    .map((block) => getString(block, "thinking"))
    .filter(isString)
    .join("\n");
}

function messageToolCalls(message: unknown): Array<{ id: string; name: string; input: unknown }> {
  if (!isRecord(message) || !Array.isArray(message.content)) return [];
  return message.content.filter(isRecord).flatMap((block) => {
    const id = getString(block, "id");
    const name = getString(block, "name");
    return block.type === "tool_use" && id && name ? [{ id, name, input: block.input }] : [];
  });
}

function messageToolResults(message: unknown): Array<{ id: string; text: string; isError: boolean }> {
  if (!isRecord(message) || !Array.isArray(message.content)) return [];
  return message.content.filter(isRecord).flatMap((block) => {
    const id = getString(block, "tool_use_id");
    if (block.type !== "tool_result" || !id) return [];
    const content = block.content;
    const text = isString(content)
      ? content
      : Array.isArray(content)
        ? content
            .filter(isRecord)
            .map((part) => getString(part, "text") ?? "")
            .join("\n")
        : "";
    return [{ id, text, isError: block.is_error === true }];
  });
}

function dynamicContent(value: unknown): CallToolResult["content"] {
  if (!isRecord(value)) return [];
  if (value.type === "inputText" && isString(value.text)) {
    return [{ type: "text" as const, text: value.text }];
  }
  if (value.type === "inputImage" && isString(value.imageUrl)) {
    const [, mimeType, data] = value.imageUrl.match(/^data:([^;]+);base64,(.+)$/s) ?? [];
    if (mimeType !== undefined && data !== undefined) return [{ type: "image" as const, mimeType, data }];
  }
  return [];
}

function normalizeClaudeModel(model: string): string {
  return model.startsWith("claude-") ? model : defaultProviderModel("claude");
}

function normalizeClaudeEffort(effort: string): ClaudeEffort {
  return isOneOf(CLAUDE_EFFORTS, effort) ? effort : "high";
}

function isUuid(value: string): value is UUID {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

/** Sums the requests of one result by model, in the field names of the SDK's `modelUsage`. */
function claudeTurnModelUsage(
  requests: Iterable<{ model: string; usage: unknown }>,
): Record<string, Record<string, number | null>> {
  const models: Record<string, Record<string, number | null>> = {};
  for (const { model, usage } of requests) {
    if (!isDynamicRecord(usage)) continue;
    const total = models[model] ?? {
      inputTokens: 0,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
      outputTokens: 0,
      smallestRequestInputTokens: Number.POSITIVE_INFINITY,
    };
    models[model] = total;
    let prompt: number | null = 0;
    for (const [key, field] of [
      ["inputTokens", "input_tokens"],
      ["cacheReadInputTokens", "cache_read_input_tokens"],
      ["cacheCreationInputTokens", "cache_creation_input_tokens"],
      ["outputTokens", "output_tokens"],
    ] as const) {
      // The API sends `null` or leaves out a cache count that is zero.
      const value = usage[field] ?? 0;
      const sum = total[key];
      total[key] = isNumber(value) && isNumber(sum) ? sum + value : null;
      if (key !== "outputTokens") prompt = isNumber(value) && prompt !== null ? prompt + value : null;
    }
    // Some long-context prices apply to each request by its own prompt, so the smallest one shows
    // whether all of the turn's requests pay them.
    const smallest = total.smallestRequestInputTokens;
    total.smallestRequestInputTokens = isNumber(smallest) && prompt !== null ? Math.min(smallest, prompt) : null;
  }
  return models;
}

/** The path argument of a Claude file tool, as the step trail reads it (`toolStepView`). */
function fileToolArguments(input: DynamicRecord): { arguments: { file_path: string } } | Record<never, never> {
  const path =
    typeof input.file_path === "string"
      ? input.file_path
      : typeof input.notebook_path === "string"
        ? input.notebook_path
        : null;
  return path ? { arguments: { file_path: path.slice(0, 1_000) } } : {};
}
