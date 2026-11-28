import { randomUUID } from "node:crypto";
import type {
  AgentApproval,
  AgentApprovalKind,
  AgentEvent,
  AgentPromptQuestion,
  AgentPromptResolution,
  AgentRuntimeSnapshot,
  BrowserTab,
  BrowserTakeoverRequest,
  ConversationMessage,
  ConversationMessageSender,
  LocalBrowserSecretResponse,
  RespondToApprovalInput,
  RespondToBrowserTakeoverInput,
  RespondToPromptInput,
  SecretRequest,
} from "@openbot/contracts/ipc";
import {
  AGENT_ATTENTION_ITEMS_LIMIT,
  AGENT_ATTENTION_OPTIONS_LIMIT,
  AGENT_ATTENTION_TEXT_LIMIT,
  AGENT_RUNTIME_ATTENTION_LIMIT,
  type AgentAttentionItem,
  type AgentAttentionOption,
  BROWSER_TAKEOVER_REASONS,
  sameTicketKey,
  TICKET_ANSWER_FIELD,
  TICKET_DECISION_FIELD,
  TICKET_DECISIONS,
  TICKET_VERDICT_FIELD,
  TICKET_VERDICTS,
  type TicketDecision,
  type TicketVerdict,
  ticketKeyOf,
} from "@openbot/contracts/ipc";
import { type DynamicRecord, isOneOf } from "@openbot/contracts/runtime-values";
import { parseTwoStepKey, twoStepCode } from "@openbot/contracts/two-step-code";
import {
  type ConversationUiBlock,
  normalizeConversationUiBlock,
  ownerDecisionView,
  pastDecisionBlockId,
  pastDecisionRequestId,
  UI_BLOCK_SUBMIT_ACTION_ID,
  UI_BLOCK_TEXT_ACTION_ID,
  UI_BLOCK_VERSION,
  type UiBlockAutoAnswer,
  type UiBlockResponse,
  type UiBlockSpec,
  type UiBlockState,
  uiBlockActionIsPrivileged,
  uiBlockAnswersFromResponse,
  uiBlockFallbackQuestions,
  uiBlockHasPrivilegedAction,
  uiBlockOutcomeText,
  uiBlockResponseFromAnswers,
  validateUiBlockResponse,
} from "@openbot/contracts/ui-blocks";
import { sourceText } from "@openbot/i18n/source";
import { createOpenBotLogger, redactSecrets, redactText, toLogValue } from "@openbot/logging";
import { Deferred, Effect, Exit, Fiber, Option, Result, Schema } from "effect";
import { type AgentApiKeys, SHARED_API_KEY_SCOPE } from "../agent-api-keys";
import type { AgentClient } from "../agent-client";
import { clientRunsJailed } from "../agent-jail";
import { type BrowserOperationError, browserFailure } from "../browser-effects";
import type { PreparedBrowserSecret } from "../browser-host";
import type { BrowserCardVault } from "../browser-tool-actions";
import { type BrowserToolArguments, parseBrowserToolCall } from "../browser-tools";
import { causeHelpers } from "../effect-boundary";
import type { PasswordVault, PasswordVaultError } from "../password-vault";
import {
  type AppServerRequest,
  type DynamicToolCallParams,
  type DynamicToolResult,
  getRecord,
  getString,
  type RequestId,
} from "../protocol";
import type { VaultAgentChange, VaultAgentResult, VaultItems } from "../vault-items";
import { type ApprovalAutomationPolicy, NO_APPROVAL_AUTOMATION, shouldAutoApprove } from "./approval-automation";
import type { ConversationRuntime } from "./conversation-runtime";
import type { HostedSiteOperationFailed } from "./hosted-site-coordinator";
import {
  HOSTED_SITE_APPROVAL_METHOD,
  type HostedSiteApprovalTarget,
  type HostedSiteMutationContext,
} from "./hosted-site-coordinator";
import type { HostedSiteMutationTool } from "./hosted-site-events";
import { ForbiddenAttentionAnswer, InactiveAttentionRequest } from "./inactive-attention-request";
import type { OwnerDecisionMeta, PastDecision, PastDecisions } from "./past-decisions";
import {
  API_KEY_FIELD_ID,
  apiKeyPromptResult,
  approvalPermissions,
  browserTakeoverError,
  browserTakeoverResult,
  commandText,
  dynamicPromptResult,
  expiredPromptResult,
  MCP_TOOL_CONSENT_ALLOW_ONCE,
  mcpElicitationQuestions,
  mcpElicitationResult,
  mcpToolCallConsent,
  promptQuestions,
  promptResolution,
  questionPromptText,
  uiBlockPromptResult,
  validPromptQuestions,
} from "./prompts";
import { compactRuntimeApproval, compactRuntimeQuestion } from "./runtime-snapshot";
import { isDynamicToolCall } from "./thread-items";

const logger = createOpenBotLogger("attention-registry");
/** How long a takeover card waits for the tab's queue before it shows anyway. See `#handOver`. */
const TAKEOVER_HANDOVER_WAIT_MS = 5_000;

interface PendingPrompt {
  client: AgentClient;
  id: RequestId;
  responseKind: "dynamic-tool" | "mcp-elicitation" | "user-input" | "ui-block";
  params: unknown;
  agentId: string;
  publicThreadId: string;
  turnId: string;
  messageId: string;
  /** For `ui-block`, the fallback questions of the block. */
  questions: AgentPromptQuestion[];
  /** Set exactly when `responseKind` is `ui-block`. */
  uiBlock?: SurfacedUiBlock;
  /** True while the answer of a `request_api_key` block is written to its file. */
  savingApiKey?: boolean;
  /** The block's own answer, and the timer that gives it. Removing the prompt clears the timer. */
  autoAnswer?: { state: UiBlockAutoAnswer; timer: ReturnType<typeof setTimeout> };
}

/**
 * An `ask_ui` block, or the form of `request_api_key`. With `apiKey`, the value of its secret field
 * `API_KEY_FIELD_ID` is saved for the agent under that name, and the agent gets the file path only.
 */
export interface SurfacedUiBlock {
  blockId: string;
  spec: UiBlockSpec;
  /** `shared`: saved for every agent of the server, not only the asking one. */
  apiKey?: { name: string; shared?: true };
  /** Always a card here, also for work of a team channel: a decision waits for its answer. */
  card?: true;
  /**
   * The card of a decision only the owner takes. It waits for the owner after the call ends too: the
   * owner's answer then goes to the agent as a message (`PastDecisions`).
   */
  ownerDecision?: OwnerDecisionMeta;
  /**
   * The Motion ticket this decision is about, by key. The ticket's waiting item and this card are one
   * request: while the card is open the list leaves the ticket out, the card's answer goes on the
   * ticket as the owner's, and an answer or a dismissal of the ticket answers or closes the card.
   * `approve` and `decline` are the card's actions that the ticket's two buttons press.
   */
  ticket?: { key: string; approve: string; decline?: string };
  /**
   * Sees the answer before the agent does, such as a decision that grants a go-live. A result it
   * returns replaces the block's own. A skipped block gives `null`.
   */
  onAnswer?: (
    response: UiBlockResponse | null,
    responder: PromptResponder | undefined,
  ) => DynamicToolResult | undefined;
}

/**
 * Who answers a prompt. Absent means the person at this computer, who owns the server. A team member
 * answers through the Team API, which knows their role.
 */
export interface PromptResponder {
  sender?: ConversationMessageSender;
  /** The server owner or an admin. Only they may take a privileged UI block action. */
  privileged: boolean;
  /** The host gave the block's auto answer: nobody answered in time. */
  automatic?: boolean;
}

const AUTOMATIC_RESPONDER: PromptResponder = { privileged: true, automatic: true };

/**
 * Who answers an approval. Absent means the person at this computer, who owns the server. A team
 * member, a chat app user or a local script gives `owner: false`, and the Team API gives the owner's
 * own clients `owner: true`.
 */
export interface ApprovalResponder {
  owner: boolean;
}

interface PendingApproval {
  client: AgentClient;
  id: RequestId;
  method: string;
  params: unknown;
  approval: AgentApproval;
  hostedSiteMutation?: HostedSiteMutationContext;
  /** A built-in tool waits for this answer and does the work itself. "cancel" means nobody answered. */
  decide?: (decision: ToolApprovalDecision) => void;
  /** The tool asks even when the agent has Full access, so a later grant does not answer it. */
  alwaysAsk?: boolean;
  /** Only the owner can answer, because the approval lets agents use what is the owner's alone. */
  ownerOnly?: boolean;
}

type ToolApprovalDecision = "accept" | "decline" | "cancel";

const TOOL_APPROVAL_METHOD = "openbot/tool-approval";
/** The agent reads this, not the user: it says how to ask in a Slack, Discord or Telegram turn. */
const MESSAGING_QUESTION_REFUSED =
  "This conversation is in Slack, Discord or Telegram, where nobody can answer a question card. Ask the question in your answer: the person replies in the conversation.";

/** The agent reads these, not the user. */
const VAULT_UNAVAILABLE = "No Vault is available on this computer. Ask the user.";
const VAULT_LOGIN_ADD_REFUSED =
  "You cannot add a login: a password comes only from the user. Sign in with submit_secret, and the user can save the password from the card. Or ask the user to add the login in Server settings > Vault.";
const VAULT_CARD_ADD_REFUSED =
  "You cannot add a card: its number comes only from the user. Ask the user to add it in Server settings > Vault.";
const VAULT_FIELDS: Record<BrowserToolArguments<"save_vault_item">["kind"], readonly string[]> = {
  contact: ["label", "fullName", "address", "address2", "city", "region", "postalCode", "country", "phone", "email"],
  login: ["username"],
  card: ["label", "nameOnCard", "expMonth", "expYear", "billingContactId"],
};

/** The change that `save_vault_item` asks for, or the text that tells the agent what is wrong. */
function vaultChange(args: BrowserToolArguments<"save_vault_item">): VaultAgentChange | string {
  const allowed = VAULT_FIELDS[args.kind];
  const misplaced = Object.entries(args).find(
    ([key, value]) => value !== undefined && key !== "kind" && key !== "id" && !allowed.includes(key),
  );
  if (misplaced) return `${misplaced[0]} is not a field of a ${args.kind}. Its fields are: ${allowed.join(", ")}.`;
  if (args.kind === "login")
    return args.id ? { kind: "login", id: args.id, username: args.username } : VAULT_LOGIN_ADD_REFUSED;
  if (args.kind === "card")
    return args.id
      ? {
          kind: "card",
          id: args.id,
          label: args.label,
          nameOnCard: args.nameOnCard,
          expMonth: args.expMonth,
          expYear: args.expYear,
          billingContactId: args.billingContactId,
        }
      : VAULT_CARD_ADD_REFUSED;
  const fields = {
    label: args.label,
    fullName: args.fullName,
    address: args.address,
    address2: args.address2,
    city: args.city,
    region: args.region,
    postalCode: args.postalCode,
    country: args.country,
    phone: args.phone,
    email: args.email,
  };
  if (!args.id && !Object.values(fields).some((value) => value?.trim())) return "Give at least one contact field.";
  return { kind: "contact", id: args.id, fields };
}

/**
 * A refused change tells the agent why: the Vault's own errors are user text with no secret in them.
 * A file error is logged and the agent gets a fixed text.
 */
function vaultFailure(action: "save" | "delete", failure: PasswordVaultError): DynamicToolResult {
  logger.warn(`Unable to ${action} a Vault item for an agent`, { error: toLogValue(failure.cause) });
  const { cause } = failure;
  return browserTakeoverError(
    cause instanceof Error && !("code" in cause) ? cause.message : `The Vault item could not be ${action}d.`,
  );
}

function vaultResult(value: { status: string } & VaultAgentResult): DynamicToolResult {
  return { success: true, contentItems: [{ type: "inputText", text: JSON.stringify(value) }] };
}

interface PendingBrowserTakeover {
  client: AgentClient;
  /** The provider's request. `submit_secret` keys the entry by a new id, so it is kept here. */
  providerRequestId: RequestId;
  secret?: PreparedBrowserSecret | undefined;
  submitting?: boolean;
  /** The saved login that OpenBot filled without the card, so the agent does not credit the user. */
  vaultLoginId?: string;
  /** The Secrets key that `submit_secret` names. OpenBot fills its value without the card. */
  secretKey?: string;
  /** The Secrets key that OpenBot filled without the card, so the agent does not credit the user. */
  filledSecretKey?: string;
  params: DynamicToolCallParams;
  request: BrowserTakeoverRequest;
  resolve: (result: DynamicToolResult) => void;
  /** The card is shown. Before that, the tab is still being handed over or filled from the vault. */
  surfaced?: boolean;
}

/**
 * The hosted-site half of an approval, narrow enough that the registry never learns what a site is.
 * `HostedSiteCoordinator` satisfies it.
 */
export interface HostedSiteApprovals {
  prepareApproval(
    client: AgentClient,
    request: AppServerRequest,
    params: DynamicToolCallParams,
    tool: HostedSiteMutationTool,
  ): Effect.Effect<{ approval: AgentApproval; mutation: HostedSiteMutationContext } | null, HostedSiteOperationFailed>;
  resolveApproval(
    mutation: HostedSiteMutationContext,
    target: HostedSiteApprovalTarget,
    decision: "accept" | "decline",
  ): Effect.Effect<void, HostedSiteOperationFailed>;
}

/**
 * How an outstanding question feeds back into a routine run's status. Implemented by the facade in
 * this PR and handed to `RoutineScheduler` in the next.
 */
export interface RoutineAttention {
  markNeedsAttention(turnId: string | null): void;
  markRunningForTurn(turnId: string | null): void;
}

/**
 * The browser surface a takeover needs: the tab roster, to check that the agent asking owns the tab it
 * names, and the pair of calls that suspend and resume agent control of it. `BrowserHost` satisfies it.
 */
export interface AttentionBrowserHost {
  prepareSecret?(params: DynamicToolCallParams): Effect.Effect<PreparedBrowserSecret, BrowserOperationError>;
  listTabs(): BrowserTab[];
  beginTakeover(tabId: string): Effect.Effect<void, BrowserOperationError>;
  endTakeover(tabId: string): void;
  /** Clicks the checkbox of a simple check once before a takeover reaches the user. */
  tryChallengeCheckbox?(tabId: string): Effect.Effect<"passed" | "stayed" | "none">;
}

/** What the registry reads of the conversation runtime, so a test can give it a small one. */
type AttentionConversation = Pick<
  ConversationRuntime,
  "agentForThread" | "emitConversation" | "ensureSnapshot" | "publicThreadId"
>;

export interface AttentionRegistryOptions {
  conversation: AttentionConversation;
  browser: AttentionBrowserHost;
  hostedSites: HostedSiteApprovals;
  routines: RoutineAttention;
  /** Read at each approval, so a grant the user gives now applies to the next request. */
  approvalAutomation?: ApprovalAutomationPolicy | undefined;
  /**
   * Whether the agent runs in the workspace sandbox now. Each approval it raises asks to go outside
   * the limit the user chose, so Full access does not answer it.
   */
  workspaceSandboxed?(agentId: string): boolean;
  /**
   * Whether this thread answers a Slack, Discord or Telegram conversation. Nobody there can answer a
   * question card, and the turn would wait for one with no limit while every other conversation of
   * the agent waits behind it.
   */
  messagingThread?(threadId: string): boolean;
  emit(event: AgentEvent): void;
  emitError(code: string, error: unknown, agentId?: string): void;
  emitRuntimeSnapshot(): void;
  /**
   * The vault the user shared with OpenBot, or null. A password or authenticator request for a login
   * saved there is filled without a card: putting the login in the shared vault is the consent.
   */
  passwordVault?: PasswordVault | null | undefined;
  /** The cards and contact info of the Vault, or null. `fill_card` types a card without the agent reading it. */
  vaultItems?: VaultItems | null | undefined;
  /** The name of an agent now. An item that an agent adds to the Vault keeps it. */
  agentName?(agentId: string): string | undefined;
  /** Adds a note to the chat that an agent changed the Vault. `text` is source text. */
  noteVaultChange?(agentId: string, threadId: string, turnId: string, text: string): void;
  /** Where the answer of `request_api_key` is saved; null where nothing can save it. */
  apiKeys?: AgentApiKeys | null | undefined;
  /**
   * The team channel that a turn works for, outside a channel task: a question from it goes to that
   * channel, not to the agent's own chat, where the people of the conversation would not see it.
   */
  teamQuestion?: TeamQuestionRouting | undefined;
  /**
   * While the owner is in quiet hours or focus and away, a question is held for when they are back
   * instead of waiting: the answer is what the agent reads instead, or null to ask as usual.
   */
  ownerHold?:
    | ((agentId: string, turnId: string, questions: readonly AgentPromptQuestion[]) => string | null)
    | undefined;
  /** The owner decision cards that wait for the owner, also after their call ended. */
  pastDecisions?: PastDecisions | undefined;
  /** A stored message that the bounded snapshot no longer holds, such as an old decision card. */
  readStoredMessage?(agentId: string, threadId: string, messageId: string): ConversationMessage | undefined;
}

/**
 * Gives the agent the owner's answer to a decision card whose call had ended, as a message from the
 * owner that starts its turn. A failure leaves the card open for another try.
 */
export type PastDecisionAnswered = (
  decision: PastDecision,
  response: UiBlockResponse,
  responder: PromptResponder | undefined,
) => Effect.Effect<void, unknown>;

/** How a question of work that belongs to a team channel reaches the people of that channel. */
export interface TeamQuestionRouting {
  context(
    agentId: string,
    turnId: string,
  ): { channelId: string; name: string; handsOff: boolean; channelTurn: boolean } | null;
  post(agentId: string, channelId: string, text: string): boolean;
}

export type RuntimeAttention = Pick<
  AgentRuntimeSnapshot,
  "attentionComplete" | "pendingPrompts" | "pendingApprovals" | "pendingBrowserTakeovers"
>;

/** One request that waits for the user, as `pendingRequests` reports it. */
export type PendingAttentionRequest =
  | {
      kind: "prompt";
      requestId: RequestId;
      agentId: string;
      threadId: string;
      turnId: string;
      questions: readonly AgentPromptQuestion[];
    }
  | {
      kind: "approval";
      requestId: RequestId;
      agentId: string;
      threadId: string;
      turnId: string;
      approvalKind: AgentApprovalKind;
      /** The team channel that shows the request (see `AgentAttentionItem.channelId`). */
      channelId?: string;
    }
  | {
      kind: "browser-takeover";
      requestId: RequestId;
      agentId: string;
      threadId: string;
      turnId: string;
      channelId?: string;
    };

export type LocalAttentionResponse =
  | { kind: "prompt"; requestId: string; answers: Record<string, string[]> }
  | { kind: "approval"; requestId: string; decision: "accept" | "decline" };

/**
 * Everything an agent can be blocked on waiting for the user: a question, an approval, a request to
 * take over a browser tab.
 *
 * The three live together because they are one queue as far as the product is concerned — the
 * runtime snapshot budgets them against a single attention limit in that order, duplication refuses
 * while any of them is outstanding, and a turn ending clears all three at once. Each also owes the
 * provider a response, so every path out of these maps either answers the request or cancels it;
 * an entry silently dropped is an agent stuck forever.
 */
export class AttentionRegistry {
  // A handle belongs to one pending object, even when a provider reuses its request ID.
  readonly #localHandles = new WeakMap<PendingPrompt | PendingApproval | PendingBrowserTakeover, string>();
  readonly #conversation: AttentionConversation;
  readonly #browser: AttentionBrowserHost;
  readonly #hostedSites: HostedSiteApprovals;
  readonly #routines: RoutineAttention;
  readonly #approvalAutomation: ApprovalAutomationPolicy;
  readonly #workspaceSandboxed: (agentId: string) => boolean;
  readonly #messagingThread: (threadId: string) => boolean;
  readonly #emit: (event: AgentEvent) => void;
  readonly #emitError: (code: string, error: unknown, agentId?: string) => void;
  readonly #emitRuntimeSnapshot: () => void;
  readonly #passwordVault: PasswordVault | null;
  readonly #vaultItems: VaultItems | null;
  readonly #agentName: (agentId: string) => string | undefined;
  readonly #noteVaultChange: (agentId: string, threadId: string, turnId: string, text: string) => void;
  readonly #apiKeys: AgentApiKeys | null;
  readonly #teamQuestion: TeamQuestionRouting | null;
  readonly #ownerHold: AttentionRegistryOptions["ownerHold"];
  readonly #pastDecisions: PastDecisions | null;
  readonly #readStoredMessage: AttentionRegistryOptions["readStoredMessage"];
  #pastDecisionAnswered: PastDecisionAnswered | null = null;
  readonly #prompts = new Map<RequestId, PendingPrompt>();
  readonly #approvals = new Map<RequestId, PendingApproval>();
  /** The saved-key fills that wait for the owner's yes, by approval request id, for the keys screen. */
  readonly #secretFills = new Map<RequestId, { agentId: string; name: string; site: string; createdAt: number }>();
  readonly #takeovers = new Map<RequestId, PendingBrowserTakeover>();
  /** When `attentionItems` first listed each request. */
  readonly #listedAt = new WeakMap<PendingPrompt | PendingApproval | PendingBrowserTakeover, string>();
  /** The Motion tickets that wait on the user, which belong to no turn (`isTicketAttention`). */
  #tickets: AgentAttentionItem[] = [];
  /** The team channel of each approval and takeover, once looked up; null for none. */
  readonly #channels = new WeakMap<PendingApproval | PendingBrowserTakeover, string | null>();

  constructor(options: AttentionRegistryOptions) {
    this.#conversation = options.conversation;
    this.#browser = options.browser;
    this.#hostedSites = options.hostedSites;
    this.#routines = options.routines;
    this.#approvalAutomation = options.approvalAutomation ?? NO_APPROVAL_AUTOMATION;
    this.#workspaceSandboxed = options.workspaceSandboxed ?? (() => false);
    this.#messagingThread = options.messagingThread ?? (() => false);
    this.#emit = options.emit;
    this.#emitError = options.emitError;
    this.#emitRuntimeSnapshot = options.emitRuntimeSnapshot;
    this.#passwordVault = options.passwordVault ?? null;
    this.#vaultItems = options.vaultItems ?? null;
    this.#agentName = options.agentName ?? (() => undefined);
    this.#noteVaultChange = options.noteVaultChange ?? (() => undefined);
    this.#apiKeys = options.apiKeys ?? null;
    this.#teamQuestion = options.teamQuestion ?? null;
    this.#ownerHold = options.ownerHold;
    this.#pastDecisions = options.pastDecisions ?? null;
    this.#readStoredMessage = options.readStoredMessage;
  }

  onPastDecisionAnswered(answered: PastDecisionAnswered): void {
    this.#pastDecisionAnswered = answered;
  }

  /** The owner decision cards whose call ended and that still wait for the owner. */
  #waitingPastDecisions(): PastDecision[] {
    if (!this.#pastDecisions) return [];
    const live = new Set([...this.#prompts.values()].flatMap((pending) => pending.uiBlock?.blockId ?? []));
    return this.#pastDecisions
      .list()
      .filter((decision) => !live.has(decision.blockId) && this.#agentName(decision.agentId) !== undefined);
  }

  /**
   * Sends a question of team work to its channel instead of the agent's own chat. Returns what the
   * agent reads instead of an answer, or null when the question stays a card here: a person's own
   * chat, a channel task (whose cards the channel already shows), or a question the agent marked
   * private. In hands-off mode no question reaches anyone: the agent decides and logs it. A key
   * request becomes a request in the channel to add the key in Secrets.
   */
  #routeTeamQuestion(
    agentId: string,
    turnId: string,
    questions: readonly AgentPromptQuestion[],
    options: { private?: boolean; apiKey?: string; purpose?: string },
  ): string | null {
    const context = this.#teamQuestion?.context(agentId, turnId);
    // The owner is quiet and away: the question waits in their list, and the agent does not. A private
    // question, a secret or a key form still asks; hands-off mode asks no one.
    if (!context?.handsOff && !options.private && !options.apiKey && !questions.some((question) => question.isSecret)) {
      const held = this.#ownerHold?.(agentId, turnId, questions);
      if (held) return held;
    }
    // A card of a channel task shows in its channel already; hands-off mode refuses that one too.
    if (!context || (context.channelTurn && !context.handsOff)) return null;
    const channel = `#${context.name}`;
    if (options.apiKey && !context.channelTurn) {
      const posted = this.#teamQuestion?.post(
        agentId,
        context.channelId,
        `I need the key \`${options.apiKey}\`${options.purpose ? ` (${options.purpose})` : ""}. Add it in Secrets (shared), or tell me to create it myself.`,
      );
      return posted
        ? `No form here: this work belongs to ${channel}. Atelier asked the people there to add ${options.apiKey} in Secrets. ${
            context.handsOff
              ? "Hands-off mode: do not wait. Create the key yourself if you can (openbot_browser.save_secret_from_page or openbot.save_api_key), or continue without it and log the decision with openbot.log_decision."
              : "Do not wait for it: continue without the key or end your turn. Check openbot.list_api_keys later."
          }`
        : null;
    }
    if (context.handsOff)
      return `Not asked: ${channel} is in hands-off mode, so no person answers questions. Decide yourself: take the path the team recommends, call openbot.log_decision (through openbot.tool_call when it is not in your tool list) with the decision, why, and the alternatives, then continue.`;
    if (options.private || context.channelTurn) return null;
    const text = questions
      .map((question) => {
        const choices = question.options?.length
          ? `\n${question.options.map((option, index) => `${String.fromCharCode(65 + index)}) ${option.label}${option.description ? ` - ${option.description}` : ""}`).join("\n")}`
          : "";
        return `${question.question}${choices}`;
      })
      .join("\n\n");
    if (!this.#teamQuestion?.post(agentId, context.channelId, `${text}\n\nReply in this thread.`)) return null;
    return `Not shown in your own chat: this work belongs to ${channel}, so Atelier posted your question there for the people. Do not wait: end your turn, or continue with work that does not depend on the answer. The answer comes back to you as channel work in the thread of your question. Ask privately only for something private to one person: openbot.ask_ui with private true.`;
  }

  /**
   * The team channel that shows an approval or a takeover, as a card, in Needs you and in its
   * notification: the channel of its channel task, or the channel that a teammate's delegated work
   * belongs to. Only the person can act on these, so the request must reach them where the work is,
   * not only the agent's own chat, which nobody opens for a teammate. Null for a person's own chat with
   * the agent, other work, and a channel in hands-off mode.
   */
  #channelOf(pending: PendingApproval | PendingBrowserTakeover): string | null {
    const known = this.#channels.get(pending);
    if (known !== undefined) return known;
    const { agentId, turnId } = "approval" in pending ? pending.approval : pending.request;
    let channelId: string | null = null;
    try {
      const context = this.#teamQuestion?.context(agentId, turnId);
      channelId = context && !context.handsOff ? context.channelId : null;
    } catch {
      channelId = null;
    }
    this.#channels.set(pending, channelId);
    return channelId;
  }

  /** The agent that asks `requestId`: a prompt, an approval, a browser takeover or a browser secret. */
  agentIdForRequest(requestId: RequestId): string | undefined {
    return (
      this.#prompts.get(requestId)?.agentId ??
      this.#approvals.get(requestId)?.approval.agentId ??
      this.#takeovers.get(requestId)?.request.agentId ??
      this.#tickets.find((item) => item.requestId === requestId)?.agentId ??
      this.#pastDecisions?.get(pastDecisionBlockId(requestId) ?? "")?.agentId
    );
  }

  hasAttentionFor(agentId: string): boolean {
    return (
      [...this.#prompts.values()].some((pending) => pending.agentId === agentId) ||
      [...this.#approvals.values()].some((pending) => pending.approval.agentId === agentId) ||
      [...this.#takeovers.values()].some((pending) => pending.request.agentId === agentId)
    );
  }

  /**
   * How many questions, approvals and browser takeovers wait for the user on this agent. Counts
   * only: an approval holds the command text, and that text can hold a secret.
   */
  attentionCountsFor(agentId: string): { questions: number; approvals: number; browserTakeovers: number } {
    return {
      questions: [...this.#prompts.values()].filter((pending) => pending.agentId === agentId).length,
      approvals: [...this.#approvals.values()].filter((pending) => pending.approval.agentId === agentId).length,
      browserTakeovers: [...this.#takeovers.values()].filter((pending) => pending.request.agentId === agentId).length,
    };
  }

  /**
   * Every request that waits for the user now, oldest first in each kind: what a delegator learns
   * about. A question keeps its questions, so that a secret one is never quoted; an approval keeps its
   * kind only, because its command text can hold a secret.
   */
  pendingRequests(): PendingAttentionRequest[] {
    return [
      ...[...this.#prompts.values()].map((pending) => ({
        kind: "prompt" as const,
        requestId: pending.id,
        agentId: pending.agentId,
        threadId: pending.publicThreadId,
        turnId: pending.turnId,
        questions: pending.questions,
      })),
      ...[...this.#approvals.values()].map((pending) => {
        const { approval } = pending;
        const channelId = this.#channelOf(pending);
        return {
          kind: "approval" as const,
          requestId: approval.requestId,
          agentId: approval.agentId,
          threadId: approval.threadId,
          turnId: approval.turnId,
          approvalKind: approval.kind,
          ...(channelId ? { channelId } : {}),
        };
      }),
      ...[...this.#takeovers.values()].flatMap((pending) => {
        const { request, surfaced } = pending;
        if (!surfaced) return [];
        const channelId = this.#channelOf(pending);
        return [
          {
            kind: "browser-takeover" as const,
            requestId: request.requestId,
            agentId: request.agentId,
            threadId: request.threadId,
            turnId: request.turnId,
            ...(channelId ? { channelId } : {}),
          },
        ];
      }),
    ];
  }

  /** What agents wait for on the keys screen: a key to type in, or the owner's yes to fill a saved one. */
  secretRequests(): SecretRequest[] {
    const requests: SecretRequest[] = [];
    for (const pending of this.#prompts.values()) {
      const apiKey = pending.uiBlock?.apiKey;
      if (!apiKey) continue;
      const listed = this.#listedAt.get(pending);
      requests.push({
        kind: "fill",
        requestId: String(pending.id),
        agentId: pending.agentId,
        name: apiKey.name,
        shared: apiKey.shared === true,
        createdAt: listed ? Date.parse(listed) : Date.now(),
      });
    }
    for (const [requestId, fill] of this.#secretFills)
      if (this.#approvals.has(requestId)) requests.push({ kind: "approve", requestId: String(requestId), ...fill });
    return requests;
  }

  /** Types the key into an agent's `request_api_key` form from the keys screen, as the form's Save does. */
  readonly fillSecretRequest = Effect.fn("AttentionRegistry.fillSecretRequest")(function* (
    this: AttentionRegistry,
    requestId: string,
    value: string,
    responder?: PromptResponder,
  ) {
    const pending = [...this.#prompts.values()].find((candidate) => String(candidate.id) === requestId);
    if (!pending?.uiBlock?.apiKey)
      return yield* Effect.fail(new InactiveAttentionRequest(sourceText("error.backend.promptInactive")));
    const answers = uiBlockAnswersFromResponse(pending.uiBlock.spec, {
      actionId: UI_BLOCK_SUBMIT_ACTION_ID,
      values: { [API_KEY_FIELD_ID]: value },
    });
    yield* this.respondToPrompt({ requestId: pending.id, answers }, responder);
  });

  /** The owner's answer to a saved-key fill from the keys screen. */
  readonly answerSecretFill = Effect.fn("AttentionRegistry.answerSecretFill")(function* (
    this: AttentionRegistry,
    requestId: string,
    decision: "accept" | "decline",
  ) {
    const id = [...this.#secretFills.keys()].find((candidate) => String(candidate) === requestId);
    if (id === undefined)
      return yield* Effect.fail(new InactiveAttentionRequest(sourceText("error.backend.approvalInactive")));
    yield* this.respondToApproval({ requestId: id, decision }, { owner: true });
  });

  /**
   * Every request that waits for the user now, of every agent, with what is safe to show of it: the
   * host's one list of what needs the user. A takeover counts once its card shows. Oldest first.
   */
  attentionItems(): AgentAttentionItem[] {
    const now = new Date().toISOString();
    const listedAt = (pending: PendingPrompt | PendingApproval | PendingBrowserTakeover) => {
      let at = this.#listedAt.get(pending);
      if (!at) {
        at = now;
        this.#listedAt.set(pending, at);
      }
      return at;
    };
    const tabs = new Map(this.#browser.listTabs().map((tab) => [tab.id, tab]));
    const items: AgentAttentionItem[] = [];
    for (const pending of this.#prompts.values()) {
      const apiKey = pending.uiBlock?.apiKey;
      const question = pending.questions.find((entry) => !entry.isSecret);
      const kind = apiKey ? "api-key" : pending.uiBlock ? "form" : "question";
      const summary = apiKey
        ? apiKey.name
        : pending.uiBlock
          ? (pending.uiBlock.spec.title ?? question?.question)
          : pending.questions.some((entry) => entry.isSecret)
            ? undefined
            : (question?.question ?? question?.header);
      items.push({
        kind,
        requestId: pending.id,
        agentId: pending.agentId,
        threadId: pending.publicThreadId,
        turnId: pending.turnId,
        createdAt: listedAt(pending),
        ...optionalText("summary", attentionLine(summary)),
        ...(pending.uiBlock?.card ? { decision: true as const, ...decisionOptions(pending.uiBlock.spec) } : {}),
      });
    }
    for (const pending of this.#approvals.values()) {
      const { approval } = pending;
      const channelId = this.#channelOf(pending);
      items.push({
        kind: "approval",
        requestId: approval.requestId,
        agentId: approval.agentId,
        threadId: approval.threadId,
        turnId: approval.turnId,
        createdAt: listedAt(pending),
        ...(channelId ? { channelId } : {}),
      });
    }
    for (const pending of this.#takeovers.values()) {
      if (!pending.surfaced) continue;
      const { request } = pending;
      const tab = tabs.get(request.tabId);
      const origin = request.secret?.origin ?? tab?.url;
      const channelId = this.#channelOf(pending);
      items.push({
        kind: request.secret ? "secret" : request.reason === "sign-in-blocked" ? "sign-in" : "browser-takeover",
        requestId: request.requestId,
        agentId: request.agentId,
        threadId: request.threadId,
        turnId: request.turnId,
        createdAt: listedAt(pending),
        ...optionalText("summary", attentionLine(tab?.title)),
        ...optionalText("origin", attentionLine(origin ? urlHost(origin) : undefined)),
        ...(channelId ? { channelId } : {}),
      });
    }
    // A ticket whose decision card is open shows as the card alone: one request, one answer.
    items.push(...this.#tickets.filter((ticket) => !this.#decisionCardOf(ticket) && !this.#pastDecisionOf(ticket)));
    for (const decision of this.#waitingPastDecisions())
      items.push({
        kind: "form",
        requestId: pastDecisionRequestId(decision.blockId),
        agentId: decision.agentId,
        threadId: decision.threadId,
        turnId: decision.turnId,
        createdAt: decision.createdAt,
        ...optionalText("summary", attentionLine(decision.spec.title)),
        decision: true,
        ...decisionOptions(decision.spec),
      });
    return items.sort((a, b) => a.createdAt.localeCompare(b.createdAt)).slice(0, AGENT_ATTENTION_ITEMS_LIMIT);
  }

  /** The open decision card of a waiting ticket, by the ticket's key. */
  #decisionCardOf(ticket: Pick<AgentAttentionItem, "summary">): PendingPrompt | undefined {
    const key = ticketKeyOf(ticket.summary);
    if (!key) return undefined;
    return [...this.#prompts.values()].find((pending) => sameTicketKey(pending.uiBlock?.ticket?.key, key));
  }

  /** The decision card of a waiting ticket whose call ended and that still waits for the owner. */
  #pastDecisionOf(ticket: Pick<AgentAttentionItem, "summary">): PastDecision | undefined {
    const key = ticketKeyOf(ticket.summary);
    if (!key) return undefined;
    return this.#waitingPastDecisions().find((decision) => sameTicketKey(decision.meta.ticket, key));
  }

  /** The waiting ticket of a decision card, by the card's key. */
  #ticketOfKey(key: string | undefined): AgentAttentionItem | undefined {
    return key ? this.#tickets.find((ticket) => sameTicketKey(ticketKeyOf(ticket.summary), key)) : undefined;
  }

  /** The tickets whose answer is going to their card now, so the card's answer does not go back to the ticket. */
  readonly #ticketsAnswering = new Set<string>();

  /**
   * The owner answered or dismissed a waiting ticket: its open decision card follows. An approval
   * presses the card's approve action, a decline its decline action, and a dismissal closes the card
   * without an answer. A written answer with no decision decides nothing: the card stays open.
   */
  readonly #answerTicketCard: (
    ticket: AgentAttentionItem,
    decision: TicketDecision | "dismiss" | null,
    responder: PromptResponder | undefined,
  ) => Effect.Effect<void, AttentionOperationFailed> = Effect.fn("AttentionRegistry.answerTicketCard")(function* (
    this: AttentionRegistry,
    ticket: AgentAttentionItem,
    decision: TicketDecision | "dismiss" | null,
    responder: PromptResponder | undefined,
  ) {
    if (decision === null) return;
    const card = this.#decisionCardOf(ticket);
    const past = card ? undefined : this.#pastDecisionOf(ticket);
    const block = card?.uiBlock;
    const spec = block?.spec ?? past?.spec;
    if (!spec) return;
    // A card whose call ended has no link: its approve is the primary option, its decline the No.
    const actionsOf = spec.type === "confirm" ? spec.actions : [];
    const approve =
      block?.ticket?.approve ?? (actionsOf.find((action) => action.style === "primary") ?? actionsOf[0])?.id;
    const decline = block?.ticket?.decline ?? actionsOf.find((action) => action.id === "no")?.id;
    const actionId = decision === "approve" ? approve : decision === "decline" ? decline : undefined;
    if (decision !== "dismiss" && !actionId) return;
    const answers = actionId ? uiBlockAnswersFromResponse(spec, { actionId }) : {};
    const cardRequestId = card ? card.id : past ? pastDecisionRequestId(past.blockId) : undefined;
    if (cardRequestId === undefined) return;
    const requestId = String(ticket.requestId);
    this.#ticketsAnswering.add(requestId);
    try {
      yield* this.respondToPrompt({ requestId: cardRequestId, answers }, responder);
    } finally {
      this.#ticketsAnswering.delete(requestId);
    }
  }).bind(this);

  /**
   * The owner answered or closed a decision card that is about a waiting ticket: the ticket follows.
   * A chosen option or a No goes on the ticket as the owner's answer, in the card's words; an answer
   * in words goes as it is; a closed card dismisses the ticket. The ticket leaves the list at once.
   */
  readonly #answerCardTicket = Effect.fn("AttentionRegistry.answerCardTicket")(function* (
    this: AttentionRegistry,
    key: string | undefined,
    spec: UiBlockSpec,
    response: UiBlockResponse | null,
  ) {
    const ticket = this.#ticketOfKey(key);
    if (!ticket || this.#ticketsAnswering.has(String(ticket.requestId))) return;
    const chosen =
      spec.type === "confirm" ? spec.actions.find((action) => action.id === response?.actionId) : undefined;
    const title = spec.title ?? "";
    const answer =
      response === null
        ? null
        : response.actionId === UI_BLOCK_TEXT_ACTION_ID
          ? response.text?.trim() || null
          : [chosen?.label ?? response.actionId, title].filter(Boolean).join(" · ");
    const requestId = String(ticket.requestId);
    this.#tickets = this.#tickets.filter((item) => item.requestId !== ticket.requestId);
    yield* attentionIo(() => this.#ticketDismissed(requestId, answer, null)).pipe(
      Effect.catch((failure) =>
        Effect.sync(() =>
          logger.warn("A decision card's answer did not reach its Motion ticket", { error: toLogValue(failure) }),
        ),
      ),
    );
  }).bind(this);

  /** The Motion tickets that wait on the user now, the whole list. */
  setTickets(items: readonly AgentAttentionItem[]): void {
    this.#tickets = [...items];
  }

  /**
   * Where a dismissed or answered Motion ticket goes: the Motion events, which keep the waiting list.
   * An answer is the owner's text, which goes on the ticket; a dismissal has none.
   */
  #ticketDismissed: (requestId: string, answer: string | null, verdict: TicketVerdict | null) => Promise<void> =
    async () => undefined;

  onTicketDismissed(
    dismiss: (requestId: string, answer: string | null, verdict: TicketVerdict | null) => Promise<void>,
  ): void {
    this.#ticketDismissed = dismiss;
  }

  /** Full details for one agent; the UI snapshot has a separate size budget. */
  localAttention(agentId: string) {
    return {
      prompts: [...this.#prompts.values()]
        .filter((pending) => pending.agentId === agentId)
        .map((pending) => ({
          requestId: this.#localHandle(pending),
          questions: structuredClone(pending.questions),
          requiresOpenBot: pending.questions.some(localQuestionNeedsOpenBot),
        })),
      approvals: [...this.#approvals.values()]
        .filter((pending) => pending.approval.agentId === agentId)
        .map((pending) => ({ ...structuredClone(pending.approval), requestId: this.#localHandle(pending) })),
      browserTakeovers: [...this.#takeovers.values()]
        .filter((pending) => pending.request.agentId === agentId)
        .map((pending) => ({ requestId: this.#localHandle(pending), requiresOpenBot: true })),
    };
  }

  readonly respondToLocalAttention = Effect.fn("AttentionRegistry.respondToLocalAttention")(function* (
    this: AttentionRegistry,
    agentId: string,
    input: LocalAttentionResponse,
  ) {
    if (input.kind === "prompt") {
      const pending = [...this.#prompts.values()].find(
        (entry) => entry.agentId === agentId && this.#localHandles.get(entry) === input.requestId,
      );
      if (!pending || pending.questions.some(localQuestionNeedsOpenBot)) {
        return yield* attentionStep(() => {
          throw new InactiveAttentionRequest(sourceText("error.backend.promptInactive"));
        });
      }
      return yield* this.respondToPrompt({ requestId: pending.id, answers: input.answers });
    }
    const pending = [...this.#approvals.values()].find(
      (entry) => entry.approval.agentId === agentId && this.#localHandles.get(entry) === input.requestId,
    );
    if (!pending) {
      return yield* attentionStep(() => {
        throw new InactiveAttentionRequest(sourceText("error.backend.approvalInactive"));
      });
    }
    // A local script is not the owner: an agent can run one.
    return yield* this.respondToApproval({ requestId: pending.id, decision: input.decision }, { owner: false });
  }).bind(this);

  #localHandle(pending: PendingPrompt | PendingApproval | PendingBrowserTakeover): string {
    const existing = this.#localHandles.get(pending);
    if (existing) return existing;
    const handle = randomUUID();
    this.#localHandles.set(pending, handle);
    return handle;
  }

  /** The attention section of the runtime snapshot, budgeted prompts first and takeovers last. */
  runtimeAttention(): RuntimeAttention {
    const attentionComplete =
      this.#prompts.size + this.#approvals.size + this.#takeovers.size <= AGENT_RUNTIME_ATTENTION_LIMIT;
    let remainingAttention = AGENT_RUNTIME_ATTENTION_LIMIT;
    const pendingPrompts = [...this.#prompts.values()].slice(0, remainingAttention).map((pending) => ({
      requestId: pending.id,
      agentId: pending.agentId,
      threadId: pending.publicThreadId,
      turnId: pending.turnId,
      questions: pending.questions.map(compactRuntimeQuestion),
    }));
    remainingAttention -= pendingPrompts.length;
    const pendingApprovals = [...this.#approvals.values()]
      .slice(0, remainingAttention)
      .map((pending) => compactRuntimeApproval(pending.approval));
    remainingAttention -= pendingApprovals.length;
    const pendingBrowserTakeovers = [...this.#takeovers.values()]
      .slice(0, remainingAttention)
      .map((pending) => structuredClone(pending.request));
    return { attentionComplete, pendingPrompts, pendingApprovals, pendingBrowserTakeovers };
  }

  /**
   * The approvals and browser takeovers that the snapshot's attention limit left out, whole, as the
   * events that announced them. A Team client that connects after they were asked learns them only
   * from the snapshot, so without these it showed the agent as waiting with no card to answer.
   * Questions are not here: a client reads them from the agent's page.
   */
  attentionOverflowEvents(
    snapshot?: Pick<RuntimeAttention, "pendingApprovals" | "pendingBrowserTakeovers">,
  ): AgentEvent[] {
    const sent = snapshot ?? this.runtimeAttention();
    const key = (agentId: string, requestId: RequestId) => `${agentId}\n${String(requestId)}`;
    const sentApprovals = new Set(sent.pendingApprovals.map((approval) => key(approval.agentId, approval.requestId)));
    const sentTakeovers = new Set(
      sent.pendingBrowserTakeovers.map((request) => key(request.agentId, request.requestId)),
    );
    // A size cut can leave out a request that fits the count, so each request is checked by its key.
    const approvalEvents = [...this.#approvals.values()]
      .filter(({ approval }) => !sentApprovals.has(key(approval.agentId, approval.requestId)))
      .map((pending): AgentEvent => ({ type: "approval", approval: structuredClone(pending.approval) }));
    const takeoverEvents = [...this.#takeovers.values()]
      .filter(({ request }) => !sentTakeovers.has(key(request.agentId, request.requestId)))
      .map(
        (pending): AgentEvent => ({ type: "browser-takeover-requested", request: structuredClone(pending.request) }),
      );
    return [...approvalEvents, ...takeoverEvents];
  }

  /**
   * For each agent that waits for a person: why, and the request text (a question, a command or the
   * reason of an approval). The first request of each agent wins. Unlike `runtimeAttention`, no
   * agent is left out by the snapshot's attention limit.
   */
  waitingAgents(): Map<string, { reason: "question" | "approval" | "browser"; what: string; turnId: string }> {
    const waiting = new Map<string, { reason: "question" | "approval" | "browser"; what: string; turnId: string }>();
    for (const pending of this.#prompts.values()) {
      if (waiting.has(pending.agentId)) continue;
      const question = pending.questions[0];
      waiting.set(pending.agentId, {
        reason: "question",
        what: question?.question || question?.header || "",
        turnId: pending.turnId,
      });
    }
    for (const pending of this.#approvals.values()) {
      const approval = pending.approval;
      if (waiting.has(approval.agentId)) continue;
      waiting.set(approval.agentId, {
        reason: "approval",
        what: approval.reason ?? approval.command ?? "",
        turnId: approval.turnId,
      });
    }
    for (const pending of this.#takeovers.values()) {
      const request = pending.request;
      if (waiting.has(request.agentId)) continue;
      waiting.set(request.agentId, { reason: "browser", what: request.reason ?? "", turnId: request.turnId });
    }
    return waiting;
  }

  readonly respondToPrompt = Effect.fn("AttentionRegistry.respondToPrompt")(function* (
    this: AttentionRegistry,
    given: RespondToPromptInput,
    responder?: PromptResponder,
  ) {
    // An owner decision card answered by its lasting id while its call still waits: the call gets it.
    const pastBlockId = pastDecisionBlockId(given.requestId);
    const live =
      pastBlockId === null
        ? undefined
        : [...this.#prompts.values()].find((pending) => pending.uiBlock?.blockId === pastBlockId);
    const input = live ? { ...given, requestId: live.id } : given;
    // A waiting Motion ticket has no turn to answer. Empty answers dismiss it from Needs you; the
    // `answer` field's text goes on the ticket as the owner's comment, then it leaves Needs you too.
    const ticket = this.#tickets.find((item) => item.requestId === input.requestId);
    if (ticket) {
      const requestId = String(ticket.requestId);
      const answer = (input.answers[TICKET_ANSWER_FIELD] ?? []).join("\n").trim() || null;
      // An escalated review's verdict: the host closes or reopens the ticket with the answer.
      const given = input.answers[TICKET_VERDICT_FIELD]?.[0];
      const verdict = answer && isOneOf(TICKET_VERDICTS, given) ? given : null;
      // What the answer decides, for the ticket's open decision card: the client's decision field, or
      // the verdict's side; a dismissal closes the card; a written answer alone leaves it open.
      const decided = input.answers[TICKET_DECISION_FIELD]?.[0];
      const decision: TicketDecision | "dismiss" | null =
        answer === null
          ? "dismiss"
          : isOneOf(TICKET_DECISIONS, decided)
            ? decided
            : verdict === "accept"
              ? "approve"
              : verdict === "send-back"
                ? "decline"
                : null;
      yield* attentionIo(() => this.#ticketDismissed(requestId, answer, verdict));
      return yield* this.#answerTicketCard(ticket, decision, responder);
    }
    if (pastBlockId !== null && !live) return yield* this.#answerPastDecision(pastBlockId, input.answers, responder);
    const saved = yield* this.#saveApiKeyAnswer(input, responder);
    const answered = yield* attentionStep(() => {
      const pending = this.#prompts.get(input.requestId);
      // The turn ended while the key was written. The key stays saved, and the agent can list it.
      if (saved && pending !== saved.pending) return null;
      if (!pending) throw new InactiveAttentionRequest(sourceText("error.backend.promptInactive"));
      const questionIds = new Set(pending.questions.map((question) => question.id));
      if (Object.keys(input.answers).some((id) => !questionIds.has(id))) {
        throw new Error(sourceText("error.backend.promptAnswerMismatch"));
      }
      // A refused UI block answer leaves the block open for an answer that fits.
      const uiBlockResponse = pending.uiBlock ? uiBlockAnswer(pending.uiBlock.spec, input.answers, responder) : null;
      this.#routines.markRunningForTurn(getString(pending.params, "turnId"));

      // The form of `request_api_key` never gives the agent its values, whatever the answer was.
      const result = pending.uiBlock?.apiKey
        ? apiKeyPromptResult(pending.uiBlock.blockId, saved?.key ?? null)
        : pending.uiBlock
          ? uiBlockPromptResult(
              uiBlockResponse
                ? { status: "answered", blockId: pending.uiBlock.blockId, response: uiBlockResponse }
                : { status: "skipped", blockId: pending.uiBlock.blockId },
            )
          : pending.responseKind === "dynamic-tool"
            ? dynamicPromptResult(input.answers)
            : pending.responseKind === "mcp-elicitation"
              ? mcpElicitationResult(pending.params, input.answers)
              : {
                  answers: Object.fromEntries(
                    Object.entries(input.answers).map(([id, values]) => [id, { answers: values }]),
                  ),
                };
      let answered: DynamicToolResult | undefined;
      try {
        answered = pending.uiBlock?.onAnswer?.(uiBlockResponse, responder);
      } catch (error) {
        logger.warn("A block's answer hook failed", { error: toLogValue(error) });
      }
      pending.client.respond(pending.id, answered ?? result);
      this.#prompts.delete(input.requestId);
      clearTimeout(pending.autoAnswer?.timer);
      if (pending.uiBlock?.ownerDecision) this.#pastDecisions?.remove(pending.uiBlock.blockId);
      this.#emitInputResolved("prompt", input.requestId, pending.agentId);
      try {
        if (pending.uiBlock) {
          this.#resolvePersistedPrompt(
            pending,
            uiBlockResponse ? promptResolution(pending.questions, input.answers) : { status: "cancelled" },
            answeredUiBlockState(pending.uiBlock.spec, uiBlockResponse, responder, pending.autoAnswer?.state),
          );
        } else {
          this.#resolvePersistedPrompt(pending, promptResolution(pending.questions, input.answers));
        }
      } catch (error) {
        this.#emitError("prompt_persistence_failed", error, pending.agentId);
      }
      this.#emitRuntimeSnapshot();
      return pending.uiBlock?.ticket
        ? { key: pending.uiBlock.ticket.key, spec: pending.uiBlock.spec, response: uiBlockResponse }
        : null;
    });
    // A decision card about a waiting ticket: the ticket gets the owner's answer too.
    if (answered) yield* this.#answerCardTicket(answered.key, answered.spec, answered.response);
  }).bind(this);

  /**
   * Saves the key of a submitted `request_api_key` form before its prompt resolves, so a failed write
   * leaves the form open for another try. Null for every other prompt and answer.
   */
  readonly #saveApiKeyAnswer = Effect.fn("AttentionRegistry.saveApiKeyAnswer")(function* (
    this: AttentionRegistry,
    input: RespondToPromptInput,
    responder: PromptResponder | undefined,
  ) {
    const answer = yield* attentionStep(() => {
      const pending = this.#prompts.get(input.requestId);
      const apiKey = pending?.uiBlock?.apiKey;
      if (!pending?.uiBlock || !apiKey) return null;
      if (pending.savingApiKey) throw new Error(sourceText("error.backend.apiKeySaving"));
      const answered = uiBlockAnswer(pending.uiBlock.spec, input.answers, responder)?.values?.[API_KEY_FIELD_ID];
      // A pasted key often brings a space or a line break, which the service would refuse.
      const value = typeof answered === "string" ? answered.trim() : "";
      // A skip saves nothing, so a member may give it: the turn must not wait for an owner.
      if (value === "") return null;
      // The key goes to an agent of this server that every member may run.
      if (responder && !responder.privileged)
        throw new ForbiddenAttentionAnswer(sourceText("error.backend.apiKeyNotAllowed"));
      if (!this.#apiKeys) throw new Error(sourceText("error.backend.apiKeySaveFailed"));
      pending.savingApiKey = true;
      return {
        pending,
        apiKeys: this.#apiKeys,
        scope: apiKey.shared ? SHARED_API_KEY_SCOPE : pending.agentId,
        name: apiKey.name,
        value,
      };
    });
    if (!answer) return null;
    const key = yield* answer.apiKeys
      .save(answer.scope, answer.name, answer.value, { kind: responder ? "person" : "owner" })
      .pipe(
        toAttentionOperationFailed,
        Effect.ensuring(
          Effect.sync(() => {
            answer.pending.savingApiKey = false;
          }),
        ),
      );
    return { pending: answer.pending, key };
  });

  readonly respondToApproval = Effect.fn("AttentionRegistry.respondToApproval")(function* (
    this: AttentionRegistry,
    input: RespondToApprovalInput,
    responder?: ApprovalResponder,
  ) {
    const pending = yield* attentionStep(() => {
      const value = this.#approvals.get(input.requestId);
      if (!value) throw new InactiveAttentionRequest(sourceText("error.backend.approvalInactive"));
      if (value.ownerOnly && responder && !responder.owner)
        throw new ForbiddenAttentionAnswer(sourceText("error.backend.approvalOwnerOnly"));
      return value;
    });
    this.#routines.markRunningForTurn(getString(pending.params, "turnId"));

    const mutation = pending.hostedSiteMutation;
    if (pending.decide) {
      pending.decide(input.decision);
    } else if (mutation) {
      this.#approvals.delete(input.requestId);
      yield* this.#hostedSites
        .resolveApproval(
          mutation,
          { client: pending.client, id: pending.id, agentId: pending.approval.agentId },
          input.decision,
        )
        .pipe(toAttentionOperationFailed);
    } else {
      pending.client.respond(
        pending.id,
        approvalReply(pending.method, pending.params, input.decision, "The user declined this action."),
      );
    }
    this.#approvals.delete(input.requestId);
    this.#emitInputResolved("approval", input.requestId, pending.approval.agentId);
    this.#emitRuntimeSnapshot();
  }, Effect.uninterruptible).bind(this);

  /**
   * Whether this agent is waiting on a takeover. Its browser tools are refused while one is outstanding:
   * the user has the tab, every reference the agent holds is already stale, and a tool call landing
   * mid-login would act on a page the user is in the middle of.
   */
  hasBrowserTakeoverForAgent(agentId: string): boolean {
    return [...this.#takeovers.values()].some((pending) => pending.request.agentId === agentId);
  }

  /**
   * Ends the plain takeovers of a turn as done, when the user writes into that turn. A secure input
   * card stays: only the user's answer there can end it.
   */
  completeBrowserTakeoversForTurn(agentId: string, turnId: string): void {
    for (const [requestId, pending] of [...this.#takeovers]) {
      const request = pending.request;
      if (request.agentId !== agentId || request.turnId !== turnId || pending.secret || pending.submitting) continue;
      this.#routines.markRunningForTurn(turnId);
      this.#resolveBrowserTakeover(requestId, pending, "complete");
    }
  }

  readonly respondToBrowserTakeover = Effect.fn("AttentionRegistry.respondToBrowserTakeover")(
    (input: RespondToBrowserTakeoverInput) =>
      attentionStep(() => {
        const pending = this.#takeovers.get(input.requestId);
        if (!pending) throw new InactiveAttentionRequest(sourceText("error.backend.takeoverInactive"));
        if (pending.submitting) throw new Error(sourceText("error.backend.authSubmitting"));
        pending.secret?.cancel();
        this.#routines.markRunningForTurn(pending.request.turnId);
        this.#resolveBrowserTakeover(input.requestId, pending, input.decision);
      }),
  ).bind(this);

  readonly respondToBrowserSecret = Effect.fnUntraced(function* (
    this: AttentionRegistry,
    input: LocalBrowserSecretResponse,
  ) {
    const { pending, secret } = yield* attentionStep(() => {
      const value = this.#takeovers.get(input.requestId);
      if (!value?.secret || value.request.agentId !== input.agentId)
        throw new InactiveAttentionRequest(sourceText("error.backend.authRequestInactive"));
      if (value.submitting) throw new Error(sourceText("error.backend.authRequestInactive"));
      return { pending: value, secret: value.secret };
    });
    if (input.decision === "cancel") {
      secret.cancel();
      this.#resolveBrowserTakeover(input.requestId, pending, "cancel");
      return;
    }
    if (input.decision === "takeover") {
      secret.cancel();
    } else {
      pending.submitting = true;
      const outcome = yield* secret.submit(input.secret, Boolean(pending.vaultLoginId || pending.filledSecretKey)).pipe(
        Effect.catch(() => Effect.succeed("takeover")),
        Effect.ensuring(
          Effect.sync(() => {
            pending.submitting = false;
          }),
        ),
      );
      if (this.#takeovers.get(input.requestId) !== pending) return;
      if (outcome === "submitted") {
        const vault = pending.vaultLoginId
          ? `Atelier filled saved login ${pending.vaultLoginId}; the user did not type it.`
          : pending.filledSecretKey
            ? `Atelier filled the saved key ${pending.filledSecretKey}; the user did not type it.`
            : input.saveToVault && secret.request.method === "password"
              ? yield* this.#saveTypedPassword(pending, secret.request.origin, input.secret)
              : undefined;
        if (this.#takeovers.get(input.requestId) !== pending) return;
        this.#resolveBrowserTakeover(input.requestId, pending, "complete", vault);
        return;
      }
    }
    secret.cancel();
    delete pending.secret;
    // The user finishes in the tab, so a later completion is theirs.
    delete pending.vaultLoginId;
    delete pending.filledSecretKey;
    if (input.decision === "submit" && pending.request.secret)
      pending.request.secret = { ...pending.request.secret, requiresReload: true };
    else delete pending.request.secret;
    // As for a first takeover, the card does not wait with no end for the tab's queue.
    yield* this.#handOver(input.requestId, pending);
    if (this.#takeovers.get(input.requestId) !== pending) return;
    pending.surfaced = true;
    this.#emit({ type: "browser-takeover-requested", request: pending.request });
    this.#emitRuntimeSnapshot();
  }, Effect.uninterruptible);

  /**
   * Answers an approval the user has already consented to, and reports whether it did.
   *
   * Nothing is registered and no `approval` event is emitted on this path, which is the whole point:
   * an emitted approval opens a card, raises an operating-system notification and lights the
   * Dynamic Island, and an automated grant that did all three before resolving itself a moment
   * later would be worse than the prompt it replaced. What the agent then does is still visible -
   * the command and the file change are ordinary timeline items either way.
   *
   * The response shape is the one `respondToApproval` uses for an accepted request.
   */
  #answerWithoutAsking(client: AgentClient, request: AppServerRequest, approval: AgentApproval): boolean {
    // A command, a file change or a permission of an agent in the jail stays inside the jail, which is
    // the agent's limit: approvals tier 0. A money command is answered before this, by the trust gate.
    if (!clientRunsJailed(client) && !this.#answersForAgent(approval.agentId)) return false;
    client.respond(request.id, approvalReply(request.method, request.params, "accept", ""));
    return true;
  }

  /**
   * The one rule for every approval OpenBot could answer itself: the agent has Full access. A
   * Workspace only agent asks to go outside the limit the user chose, so its approvals always reach
   * the user, and an agent at Ask first has no standing grant.
   */
  #answersForAgent(agentId: string): boolean {
    return !this.#workspaceSandboxed(agentId) && shouldAutoApprove(this.#approvalAutomation, { agentId });
  }

  /**
   * Answers what already waits for an agent that now has Full access. The grant is read when a request
   * arrives, so without this a card stays open after the user moves the agent to Full access, presses
   * Always allow on another of its cards, or an admin changes it from another computer. The rule is the
   * one for a new request: a Workspace only agent and a tool that always asks keep their card, and a
   * question is never answered.
   */
  answerGrantedRequests(): void {
    const report = (agentId: string) => (error: unknown) =>
      Effect.sync(() => this.#emitError("auto_approval_failed", error, agentId));
    for (const pending of [...this.#approvals.values()]) {
      const agentId = pending.approval.agentId;
      if (pending.alwaysAsk || !this.#answersForAgent(agentId)) continue;
      Effect.runFork(
        this.respondToApproval({ requestId: pending.id, decision: "accept" }).pipe(
          Effect.catch(report(agentId)),
          Effect.catchDefect(report(agentId)),
        ),
      );
    }
    for (const pending of [...this.#prompts.values()]) {
      if (pending.responseKind !== "mcp-elicitation") continue;
      if (!this.#answersMcpToolConsent(pending.params, pending.agentId)) continue;
      Effect.runFork(
        this.respondToPrompt({ requestId: pending.id, answers: MCP_TOOL_CONSENT_ALLOW_ONCE }).pipe(
          Effect.catch(report(pending.agentId)),
          Effect.catchDefect(report(pending.agentId)),
        ),
      );
    }
  }

  surfaceApproval(client: AgentClient, request: AppServerRequest, kind: AgentApprovalKind): void {
    const threadId = getString(request.params, "threadId");
    const turnId = getString(request.params, "turnId") ?? (kind === "file-change" ? String(request.id) : null);
    const agentId = threadId ? this.#conversation.agentForThread(threadId) : undefined;
    if (!threadId || !turnId || !agentId) {
      this.#respondToMalformedApproval(client, request);
      return;
    }

    const approval: AgentApproval = {
      requestId: request.id,
      agentId,
      threadId: this.#conversation.publicThreadId(agentId, threadId),
      turnId,
      kind,
      command: shownText(commandText(request.params)),
      cwd: getString(request.params, "cwd"),
      reason: shownText(getString(request.params, "reason")),
      grantRoot: getString(request.params, "grantRoot"),
      permissions: kind === "permissions" ? approvalPermissions(request.params) : null,
    };
    if (this.#answerWithoutAsking(client, request, approval)) return;
    this.#approvals.set(request.id, {
      client,
      id: request.id,
      method: request.method,
      params: request.params,
      approval,
    });
    this.#routines.markNeedsAttention(turnId);
    this.#emit({ type: "approval", approval });
  }

  /**
   * Asks the user to approve a built-in tool call, and gives the answer to the tool. The tool does
   * nothing before "accept". An agent with Full access is answered for, as for a hosted-site change,
   * unless `alwaysAsk` is set. A turn that ends or a request that the provider abandons gives "cancel".
   */
  readonly awaitToolApproval = Effect.fn("AttentionRegistry.awaitToolApproval")(function* (
    this: AttentionRegistry,
    client: AgentClient,
    request: AppServerRequest,
    approval: AgentApproval,
    options: { readonly alwaysAsk?: boolean; readonly ownerOnly?: boolean } = {},
  ) {
    if (request.signal?.aborted) return "cancel" as const;
    const alwaysAsk = options.alwaysAsk || options.ownerOnly;
    if (!alwaysAsk && this.#answersForAgent(approval.agentId)) return "accept" as const;
    const decision = Deferred.makeUnsafe<ToolApprovalDecision>();
    this.#approvals.set(request.id, {
      client,
      id: request.id,
      method: TOOL_APPROVAL_METHOD,
      params: request.params,
      approval,
      decide: (value) => Deferred.doneUnsafe(decision, Effect.succeed(value)),
      ...(alwaysAsk ? { alwaysAsk: true } : {}),
      ...(options.ownerOnly ? { ownerOnly: true } : {}),
    });
    this.#routines.markNeedsAttention(approval.turnId);
    this.#emit({ type: "approval", approval });
    return yield* Deferred.await(decision);
  }).bind(this);

  readonly surfaceHostedSiteApproval = Effect.fn("AttentionRegistry.surfaceHostedSiteApproval")(function* (
    this: AttentionRegistry,
    client: AgentClient,
    request: AppServerRequest,
    params: DynamicToolCallParams,
    tool: HostedSiteMutationTool,
  ) {
    const prepared = yield* this.#hostedSites
      .prepareApproval(client, request, params, tool)
      .pipe(toAttentionOperationFailed);
    // A request the provider abandoned during the preparation has nobody to report the decision to.
    if (!prepared || request.signal?.aborted) return;
    if (this.#answersForAgent(prepared.approval.agentId)) {
      yield* this.#hostedSites
        .resolveApproval(prepared.mutation, { client, id: request.id, agentId: prepared.approval.agentId }, "accept")
        .pipe(toAttentionOperationFailed);
      return;
    }
    this.#approvals.set(request.id, {
      client,
      id: request.id,
      method: HOSTED_SITE_APPROVAL_METHOD,
      params,
      approval: prepared.approval,
      hostedSiteMutation: prepared.mutation,
    });
    this.#routines.markNeedsAttention(prepared.approval.turnId);
    this.#emit({ type: "approval", approval: prepared.approval });
  }, Effect.uninterruptible).bind(this);

  surfaceLegacyApproval(client: AgentClient, request: AppServerRequest): void {
    const threadId = getString(request.params, "conversationId");
    const agentId = threadId ? this.#conversation.agentForThread(threadId) : undefined;
    if (!threadId || !agentId) {
      this.#respondToMalformedApproval(client, request);
      return;
    }

    const kind: AgentApprovalKind = request.method === "execCommandApproval" ? "command" : "file-change";
    const approval: AgentApproval = {
      requestId: request.id,
      agentId,
      threadId: this.#conversation.publicThreadId(agentId, threadId),
      turnId: getString(request.params, "turnId") ?? String(request.id),
      kind,
      command: shownText(commandText(request.params)),
      cwd: getString(request.params, "cwd"),
      reason: shownText(getString(request.params, "reason")),
      grantRoot: getString(request.params, "grantRoot"),
      permissions: null,
    };
    if (this.#answerWithoutAsking(client, request, approval)) return;
    this.#approvals.set(request.id, {
      client,
      id: request.id,
      method: request.method,
      params: request.params,
      approval,
    });
    this.#routines.markNeedsAttention(approval.turnId);
    this.#emit({ type: "approval", approval });
  }

  readonly surfaceBrowserTakeover = Effect.fn("AttentionRegistry.surfaceBrowserTakeover")(function* (
    this: AttentionRegistry,
    client: AgentClient,
    request: AppServerRequest,
  ) {
    if (!isDynamicToolCall(request.params)) return browserTakeoverError();
    const params = request.params;
    const { threadId, turnId } = params;
    const agentId = this.#conversation.agentForThread(threadId);
    const args = getRecord(params, "arguments");
    const tabId = getString(args, "tabId");
    const publicThreadId = agentId ? this.#conversation.publicThreadId(agentId, threadId) : null;
    const tab = tabId ? this.#browser.listTabs().find((candidate) => candidate.id === tabId) : undefined;
    if (
      !agentId ||
      !turnId ||
      !tabId ||
      !publicThreadId ||
      !tab ||
      tab.ownerThreadId !== publicThreadId ||
      tab.ownerAgentId !== agentId ||
      // A second request for a tab the user already holds would be answered by whichever card they
      // happened to press, and resolving either one would hand control back while the other still waits.
      [...this.#takeovers.values()].some((pending) => pending.request.tabId === tabId)
    ) {
      // A takeover that never showed a card left no trace of which check, if any, turned it away.
      logger.warn("A browser takeover was refused.", {
        tool: params.tool,
        agentId,
        reason: !agentId
          ? "unknown-agent"
          : !turnId || !publicThreadId
            ? "unknown-turn"
            : !tab
              ? "tab-not-found"
              : tab.ownerThreadId !== publicThreadId || tab.ownerAgentId !== agentId
                ? "tab-of-another-chat"
                : "tab-already-handed-over",
      });
      return browserTakeoverError();
    }

    const secretKey = params.tool === "submit_secret" ? getString(args, "secretKey") : null;
    if (secretKey) {
      const refused = this.#secretKeyRefusal(args, agentId, secretKey);
      if (refused) return browserTakeoverError(refused);
    }
    const reason = getString(args, "reason");
    // One click passes many Turnstile, reCAPTCHA and hCaptcha checks, so the user gets only the rest.
    if (params.tool === "request_takeover" && !reason && this.#browser.tryChallengeCheckbox) {
      const challenge = yield* this.#browser.tryChallengeCheckbox(tabId);
      if (challenge === "passed") {
        logger.info("A security check passed with one click; no takeover was needed.", { agentId, tabId });
        return {
          success: true,
          contentItems: [
            {
              type: "inputText",
              text: "Atelier clicked the checkbox of the security check once, and the check passed. The user was not asked. Take a fresh snapshot and continue.",
            },
          ],
        } satisfies DynamicToolResult;
      }
    }
    const requestId = params.tool === "submit_secret" ? randomUUID() : request.id;
    const takeover: BrowserTakeoverRequest = {
      requestId,
      agentId,
      threadId: publicThreadId,
      turnId,
      tabId,
      ...(params.tool === "request_takeover" && isOneOf(BROWSER_TAKEOVER_REASONS, reason) ? { reason } : {}),
    };
    const completion = Deferred.makeUnsafe<DynamicToolResult>();
    const resolve = (result: DynamicToolResult) => Deferred.doneUnsafe(completion, Effect.succeed(result));
    const pending: PendingBrowserTakeover = {
      client,
      providerRequestId: request.id,
      params,
      request: takeover,
      resolve,
      ...(secretKey ? { secretKey } : {}),
    };
    this.#takeovers.set(requestId, pending);
    const askedAt = Date.now();
    logger.info("A browser takeover was asked for.", {
      tool: params.tool,
      agentId,
      requestId: String(requestId),
      tabId,
    });
    return yield* Effect.gen({ self: this }, function* () {
      // The card is only shown once the tab has actually been handed over -- references invalidated,
      // diagnostics cleared, any recording stopped. Asking the user for control OpenBot then failed to
      // give them would leave the agent acting on the page underneath them.
      const prepare = Effect.gen({ self: this }, function* () {
        if (params.tool === "submit_secret") {
          const prepareSecret = this.#browser.prepareSecret?.bind(this.#browser);
          if (!prepareSecret)
            return yield* new AttentionOperationFailed({
              cause: new Error(sourceText("error.backend.secureAuthUnavailable")),
            });
          const secret = yield* prepareSecret({
            ...params,
            threadId: publicThreadId,
            ownerAgentId: agentId,
          }).pipe(toAttentionOperationFailed);
          if (this.#takeovers.get(requestId) !== pending) {
            secret.cancel();
            return;
          }
          pending.secret = secret;
          pending.request.secret = secret.request;
        } else yield* this.#handOver(requestId, pending);
      });
      const prepared = yield* Effect.result(prepare);
      if (Result.isSuccess(prepared)) {
        if (
          this.#takeovers.get(requestId) === pending &&
          !(yield* pending.secretKey
            ? this.#fillFromSecretKey(client, request, requestId, pending)
            : this.#fillFromVault(requestId, pending)) &&
          this.#takeovers.get(requestId) === pending
        ) {
          this.#routines.markNeedsAttention(turnId);
          pending.surfaced = true;
          this.#emit({ type: "browser-takeover-requested", request: takeover });
          logger.info("A browser takeover waits for the user.", {
            tool: params.tool,
            agentId,
            requestId: String(requestId),
            tabId,
            handoverMs: Date.now() - askedAt,
          });
        }
      } else {
        const error = prepared.failure.cause;
        logger.warn("Unable to prepare browser takeover", { tool: params.tool, error: toLogValue(error) });
        if (this.#takeovers.get(requestId) === pending) {
          this.#takeovers.delete(requestId);
          resolve(
            params.tool === "submit_secret" && error instanceof Error
              ? browserTakeoverError(error.message)
              : browserTakeoverError(),
          );
          this.#emitRuntimeSnapshot();
        }
      }
      return yield* Deferred.await(completion);
    }).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          if (this.#takeovers.get(requestId) === pending) this.#resolveBrowserTakeover(requestId, pending, "cancel");
        }),
      ),
    );
  }).bind(this);

  /**
   * Answers `list_vault_items`: the saved cards without their number or security code, and the saved
   * contact info in full, which the agent types itself.
   */
  readonly listVaultItems = Effect.fn("AttentionRegistry.listVaultItems")(function* (
    this: AttentionRegistry,
    params: DynamicToolCallParams,
  ) {
    const call = yield* attentionStep(() => parseBrowserToolCall("list_vault_items", params.arguments));
    if (call.tool !== "list_vault_items")
      return yield* new AttentionOperationFailed({ cause: new Error("Invalid Vault list request.") });
    const listed = yield* Effect.result(attentionStep(() => this.#vaultItems?.listForAgent() ?? null));
    if (Result.isFailure(listed)) {
      logger.warn("Unable to list the Vault items", { error: toLogValue(listed.failure.cause) });
      return browserTakeoverError("The Vault could not be read. Ask the user, or use request_takeover.");
    }
    const answer =
      listed.success === null
        ? {
            available: false,
            logins: [],
            cards: [],
            contacts: [],
            next: "No Vault is available. Ask the user, or use request_takeover.",
          }
        : { available: true, ...listed.success };
    const result: DynamicToolResult = {
      success: true,
      contentItems: [{ type: "inputText", text: JSON.stringify(answer) }],
    };
    return result;
  }).bind(this);

  /**
   * The saved cards for one `fill_card` call. Their values go to the browser host only, never to the
   * agent. A fill on a page that the owner did not approve for the card waits for the owner, with Full
   * access too: a page or a team member can tell an agent to fill a card into a form that sends it away.
   */
  cardVault(
    client: AgentClient,
    request: AppServerRequest,
    params: DynamicToolCallParams,
  ): BrowserCardVault | undefined {
    const vault = this.#vaultItems;
    const agentId = params.ownerAgentId;
    if (!vault || !agentId) return undefined;
    return {
      secret: (cardId) => vault.cardSecret(cardId),
      approved: (cardId, page, frames) => vault.cardFillApproved(cardId, page, frames),
      approve: (cardId, page, frames) =>
        Effect.gen({ self: this }, function* () {
          const card = vault.listForAgent().cards.find(({ id }) => id === cardId);
          if (!card) return false;
          const others = frames.filter((frame) => frame !== page);
          const reason = [
            sourceText("status.agent.vaultCardFill", { card: card.label || `•••• ${card.last4}`, site: page }),
            ...(others.length > 0
              ? [sourceText("status.agent.vaultCardFillFrames", { origins: others.join(", ") })]
              : []),
          ].join(" ");
          const decision = yield* this.awaitToolApproval(
            client,
            request,
            {
              requestId: request.id,
              agentId,
              threadId: params.threadId,
              turnId: params.turnId,
              kind: "permissions",
              command: null,
              cwd: null,
              reason,
              grantRoot: null,
              permissions: null,
            },
            { ownerOnly: true },
          );
          if (decision !== "accept") return false;
          yield* vault.approveCardFill(cardId, page, frames).pipe(Effect.mapError(browserFailure));
          return true;
        }),
    };
  }

  /**
   * Answers `save_vault_item`: adds or changes contact info, or changes the fields of a login or a card
   * that are not secret. The user does not approve it: the chat shows a note, and a new item keeps the
   * agent's name.
   */
  readonly saveVaultItem = Effect.fn("AttentionRegistry.saveVaultItem")(function* (
    this: AttentionRegistry,
    params: DynamicToolCallParams,
  ) {
    const call = yield* attentionStep(() => parseBrowserToolCall("save_vault_item", params.arguments));
    if (call.tool !== "save_vault_item")
      return yield* new AttentionOperationFailed({ cause: new Error("Invalid Vault save request.") });
    const vault = this.#vaultItems;
    const agentId = params.ownerAgentId;
    if (!vault || !agentId) return browserTakeoverError(VAULT_UNAVAILABLE);
    const change = vaultChange(call.args);
    if (typeof change === "string") return browserTakeoverError(change);
    const saved = yield* Effect.result(vault.save(change, this.#agentName(agentId)));
    if (Result.isFailure(saved)) return vaultFailure("save", saved.failure);
    const { created, ...item } = saved.success;
    this.#noteVaultChange(
      agentId,
      params.threadId,
      params.turnId,
      sourceText(created ? "status.agent.vaultAdded" : "status.agent.vaultUpdated", { name: item.name }),
    );
    return vaultResult({ status: created ? "added" : "updated", ...item });
  }).bind(this);

  /** Answers `delete_vault_item`. The chat shows a note, as for a save. */
  readonly deleteVaultItem = Effect.fn("AttentionRegistry.deleteVaultItem")(function* (
    this: AttentionRegistry,
    params: DynamicToolCallParams,
  ) {
    const call = yield* attentionStep(() => parseBrowserToolCall("delete_vault_item", params.arguments));
    if (call.tool !== "delete_vault_item")
      return yield* new AttentionOperationFailed({ cause: new Error("Invalid Vault delete request.") });
    const vault = this.#vaultItems;
    const agentId = params.ownerAgentId;
    if (!vault || !agentId) return browserTakeoverError(VAULT_UNAVAILABLE);
    const deleted = yield* Effect.result(vault.delete(call.args.id));
    if (Result.isFailure(deleted)) return vaultFailure("delete", deleted.failure);
    if (deleted.success === null) return browserTakeoverError("No Vault item has this id. Call list_vault_items.");
    this.#noteVaultChange(
      agentId,
      params.threadId,
      params.turnId,
      sourceText("status.agent.vaultDeleted", { name: deleted.success.name }),
    );
    return vaultResult({ status: "deleted", ...deleted.success });
  }).bind(this);

  /**
   * Keeps a password that the user typed into the secure input and asked to save. The agent never
   * sees it: the answer says only what was saved. A failed save does not stop the sign-in.
   */
  readonly #saveTypedPassword = Effect.fn("AttentionRegistry.saveTypedPassword")(function* (
    this: AttentionRegistry,
    pending: PendingBrowserTakeover,
    origin: string,
    password: string,
  ) {
    const vault = this.#vaultItems;
    if (!vault) return "The password was not saved: no Vault is available.";
    const { agentId, threadId, turnId } = pending.request;
    const call = yield* Effect.result(
      attentionStep(() => parseBrowserToolCall("submit_secret", pending.params.arguments)),
    );
    const username = Result.isSuccess(call) && call.success.tool === "submit_secret" ? call.success.args.username : "";
    const saved = yield* Effect.result(
      vault.saveLogin({ origin, username: username ?? "", password }, this.#agentName(agentId)),
    );
    if (Result.isFailure(saved)) {
      logger.warn("Unable to save the typed password in the Vault", { error: toLogValue(saved.failure.cause) });
      return "The password was not saved in the Vault.";
    }
    const { id, name, created, changed } = saved.success;
    if (changed)
      this.#noteVaultChange(
        agentId,
        threadId,
        turnId,
        sourceText(created ? "status.agent.vaultAdded" : "status.agent.vaultUpdated", { name }),
      );
    return `The user saved this password in the Vault as login ${id} (${name}).`;
  }).bind(this);

  /**
   * Answers `list_logins`: the logins of the shared vault for the tab's current site. `params` carries
   * the public thread id and the owner agent, as the browser host receives them.
   */
  readonly listVaultLogins = Effect.fn("AttentionRegistry.listVaultLogins")(function* (
    this: AttentionRegistry,
    params: DynamicToolCallParams,
  ) {
    const call = yield* attentionStep(() => parseBrowserToolCall("list_logins", params.arguments));
    if (call.tool !== "list_logins")
      return yield* new AttentionOperationFailed({ cause: new Error("Invalid login list request.") });
    const { tabId } = call.args;
    const tab = this.#browser.listTabs().find((candidate) => candidate.id === tabId);
    if (!tab || tab.ownerAgentId !== params.ownerAgentId || tab.ownerThreadId !== params.threadId)
      return browserTakeoverError(sourceText("error.backend.browserTabNotFound"));
    const listed = yield* Effect.result(
      this.#passwordVault ? this.#passwordVault.loginsFor(tab.url) : Effect.succeed(null),
    );
    if (Result.isFailure(listed)) {
      logger.warn("Unable to list the shared logins", { error: toLogValue(listed.failure.cause) });
      return browserTakeoverError("The shared password vault could not be read. Use submit_secret without loginId.");
    }
    const logins = listed.success;
    const answer =
      logins === null
        ? { connected: false, logins: [], next: "No password vault is connected. Use submit_secret without loginId." }
        : { connected: true, logins };
    const result: DynamicToolResult = {
      success: true,
      contentItems: [{ type: "inputText", text: JSON.stringify(answer) }],
    };
    return result;
  }).bind(this);

  surfaceDynamicPrompt(client: AgentClient, request: AppServerRequest): void {
    const threadId = getString(request.params, "threadId");
    const turnId = getString(request.params, "turnId");
    const agentId = threadId ? this.#conversation.agentForThread(threadId) : undefined;
    const publicThreadId = threadId && agentId ? this.#conversation.publicThreadId(agentId, threadId) : null;
    const args = getRecord(request.params, "arguments");
    const questions = promptQuestions(args);
    if (!threadId || !turnId || !agentId || !publicThreadId || !validPromptQuestions(questions)) {
      client.respond(request.id, {
        success: false,
        contentItems: [
          {
            type: "inputText",
            text: "Atelier could not create a user question.",
          },
        ],
      });
      return;
    }
    if (this.#messagingThread(publicThreadId)) {
      client.respond(request.id, {
        success: false,
        contentItems: [{ type: "inputText", text: MESSAGING_QUESTION_REFUSED }],
      });
      return;
    }
    const routed = this.#routeTeamQuestion(agentId, turnId, questions, { private: args?.private === true });
    if (routed) {
      client.respond(request.id, { success: true, contentItems: [{ type: "inputText", text: routed }] });
      return;
    }

    const messageId = this.#persistQuestionPrompt(agentId, publicThreadId, turnId, request.id, questions);
    this.#prompts.set(request.id, {
      client,
      id: request.id,
      responseKind: "dynamic-tool",
      params: request.params,
      agentId,
      publicThreadId,
      turnId,
      messageId,
      questions,
    });
    this.#routines.markNeedsAttention(turnId);
    this.#emit({
      type: "prompt",
      requestId: request.id,
      agentId,
      threadId: publicThreadId,
      turnId,
      questions,
    });
  }

  /**
   * Shows an `ask_ui` block and waits for its answer. The block is a question prompt: its fallback
   * questions let a client that does not know `uiBlock` answer it through `respondToPrompt`. The
   * caller has checked the spec and refused a channel. With `autoAnswer`, the host answers that action
   * itself after `afterMs` when nobody answered first.
   */
  surfaceUiBlock(
    client: AgentClient,
    request: AppServerRequest,
    block: SurfacedUiBlock,
    autoAnswer?: { actionId: string; afterMs: number },
  ): void {
    const threadId = getString(request.params, "threadId");
    const turnId = getString(request.params, "turnId");
    const agentId = threadId ? this.#conversation.agentForThread(threadId) : undefined;
    const publicThreadId = threadId && agentId ? this.#conversation.publicThreadId(agentId, threadId) : null;
    const questions = uiBlockFallbackQuestions(block.spec);
    const auto: UiBlockAutoAnswer | undefined = autoAnswer && {
      actionId: autoAnswer.actionId,
      at: new Date(Date.now() + autoAnswer.afterMs).toISOString(),
    };
    // Store only what the contract reads back: a block it refuses would make the whole page unreadable.
    const uiBlock = normalizeConversationUiBlock({
      version: UI_BLOCK_VERSION,
      blockId: block.blockId,
      spec: block.spec,
      state: auto ? { status: "pending", autoAnswer: auto } : { status: "pending" },
    });
    if (!threadId || !turnId || !agentId || !publicThreadId || !uiBlock || !validPromptQuestions(questions)) {
      client.respond(request.id, {
        success: false,
        contentItems: [{ type: "inputText", text: "Atelier could not show this block." }],
      });
      return;
    }
    // Nobody in an external chat sees the card, so the turn would wait, and hold the chat, until a
    // restart (upstream d4b245206).
    if (this.#messagingThread(publicThreadId)) {
      client.respond(request.id, {
        success: false,
        contentItems: [{ type: "inputText", text: MESSAGING_QUESTION_REFUSED }],
      });
      return;
    }
    // A block that answers itself, such as the plan card, never holds the agent.
    const routed =
      autoAnswer || block.card
        ? null
        : this.#routeTeamQuestion(agentId, turnId, questions, {
            private: getRecord(request.params, "arguments")?.private === true,
            ...(block.apiKey ? { apiKey: block.apiKey.name, purpose: block.spec.title } : {}),
          });
    if (routed) {
      client.respond(request.id, {
        success: true,
        contentItems: [{ type: "inputText", text: JSON.stringify({ status: "not_asked_here", note: routed }) }],
      });
      return;
    }

    const messageId = this.#persistQuestionPrompt(agentId, publicThreadId, turnId, request.id, questions, uiBlock);
    if (block.ownerDecision && uiBlock.spec.type === "confirm")
      this.#pastDecisions?.add({
        blockId: block.blockId,
        agentId,
        threadId: publicThreadId,
        turnId,
        messageId,
        spec: uiBlock.spec,
        meta: block.ownerDecision,
        createdAt: new Date().toISOString(),
      });
    let autoAnswerTimer: PendingPrompt["autoAnswer"];
    if (auto && autoAnswer) {
      const timer = setTimeout(() => this.#answerAutomatically(request.id), autoAnswer.afterMs);
      timer.unref?.();
      autoAnswerTimer = { state: auto, timer };
    }
    this.#prompts.set(request.id, {
      client,
      id: request.id,
      responseKind: "ui-block",
      params: request.params,
      agentId,
      publicThreadId,
      turnId,
      messageId,
      questions,
      uiBlock: block,
      ...(autoAnswerTimer ? { autoAnswer: autoAnswerTimer } : {}),
    });
    this.#routines.markNeedsAttention(turnId);
    this.#emit({
      type: "prompt",
      requestId: request.id,
      agentId,
      threadId: publicThreadId,
      turnId,
      questions,
    });
  }

  /** Nobody answered the block before its time, so the host presses its auto answer action. */
  #answerAutomatically(requestId: RequestId): void {
    const pending = this.#prompts.get(requestId);
    if (!pending?.uiBlock || !pending.autoAnswer) return;
    const answers = uiBlockAnswersFromResponse(pending.uiBlock.spec, { actionId: pending.autoAnswer.state.actionId });
    const report = (error: unknown) =>
      Effect.sync(() => logger.warn("Unable to give a block its auto answer", { error: toLogValue(error) }));
    Effect.runFork(
      this.respondToPrompt({ requestId, answers }, AUTOMATIC_RESPONDER).pipe(
        Effect.catch((failure) => report(failure)),
        Effect.catchDefect(report),
      ),
    );
  }

  surfacePrompt(client: AgentClient, request: AppServerRequest): void {
    const threadId = getString(request.params, "threadId");
    const turnId = getString(request.params, "turnId");
    const agentId = threadId ? this.#conversation.agentForThread(threadId) : undefined;
    if (!threadId || !turnId || !agentId) {
      client.respond(request.id, { answers: {} });
      return;
    }

    const questions = promptQuestions(request.params);
    if (!validPromptQuestions(questions)) {
      client.respond(request.id, { answers: {} });
      return;
    }
    const publicThreadId = this.#conversation.publicThreadId(agentId, threadId);
    // No answers is what the provider gets for a question that nobody answered.
    if (this.#messagingThread(publicThreadId)) {
      client.respond(request.id, { answers: {} });
      return;
    }
    // The provider's own question tool has no private flag: in team work it always goes to the channel.
    const routed = this.#routeTeamQuestion(agentId, turnId, questions, {});
    if (routed) {
      client.respond(request.id, {
        answers: Object.fromEntries(questions.map((question) => [question.id, { answers: [routed] }])),
      });
      return;
    }
    const messageId = this.#persistQuestionPrompt(agentId, publicThreadId, turnId, request.id, questions);
    this.#prompts.set(request.id, {
      client,
      id: request.id,
      responseKind: "user-input",
      params: request.params,
      agentId,
      publicThreadId,
      turnId,
      messageId,
      questions,
    });
    this.#routines.markNeedsAttention(turnId);
    this.#emit({
      type: "prompt",
      requestId: request.id,
      agentId,
      threadId: publicThreadId,
      turnId,
      questions,
    });
  }

  /**
   * Accepts Codex's consent to run one MCP tool, once, when the agent's grant covers it. Nothing is
   * saved: "Always allow" stays the user's choice in the card, and Codex keeps it per server and tool.
   */
  #answerMcpToolConsentWithoutAsking(client: AgentClient, request: AppServerRequest, agentId: string): boolean {
    if (!this.#answersMcpToolConsent(request.params, agentId)) return false;
    client.respond(request.id, { action: "accept", content: {}, _meta: null });
    return true;
  }

  /**
   * Only the consent that Codex marks is covered, a tool set to ask every time included. A form, a
   * hand-off, a sign-in and any request that OpenBot does not know still reach the user. A Workspace
   * only agent keeps its card: it asks to go outside the limit the user chose. Computer Use is
   * covered too: its own switch decides whether the agent has those tools at all, so an agent that
   * asks has it on, and the owner wants its clicks and keys to run without a card each time.
   */
  #answersMcpToolConsent(params: unknown, agentId: string): boolean {
    return mcpToolCallConsent(params) && this.#answersForAgent(agentId);
  }

  surfaceMcpElicitation(client: AgentClient, request: AppServerRequest): void {
    const threadId = getString(request.params, "threadId");
    const turnId = getString(request.params, "turnId");
    const agentId = threadId ? this.#conversation.agentForThread(threadId) : undefined;
    const publicThreadId = threadId && agentId ? this.#conversation.publicThreadId(agentId, threadId) : null;
    // Codex's consent to run one tool is answered before the card is built: a consent with no card
    // text, or with no turn, must not be declined for that reason.
    if (agentId && this.#answerMcpToolConsentWithoutAsking(client, request, agentId)) return;
    const questions = mcpElicitationQuestions(request.params);
    if (!threadId || !turnId || !agentId || !publicThreadId || !questions) {
      const meta = getRecord(request.params, "_meta");
      logger.warn("Declined a plugin request that Atelier cannot show.", {
        agentId,
        serverName: getString(request.params, "serverName"),
        mode: getString(request.params, "mode"),
        approvalKind: getString(meta, "codex_approval_kind"),
        fields: Object.keys(getRecord(getRecord(request.params, "requestedSchema"), "properties") ?? {}),
        hasThread: Boolean(threadId),
        hasTurn: Boolean(turnId),
      });
      client.respond(request.id, { action: "decline", content: null, _meta: null });
      this.#emitError(
        "mcp_safety_handoff",
        "A local plugin requested an unsupported security hand-off, so Atelier declined it.",
        agentId,
      );
      return;
    }
    if (this.#messagingThread(publicThreadId)) {
      client.respond(request.id, { action: "cancel", content: null, _meta: null });
      return;
    }

    const messageId = this.#persistQuestionPrompt(agentId, publicThreadId, turnId, request.id, questions);
    this.#prompts.set(request.id, {
      client,
      id: request.id,
      responseKind: "mcp-elicitation",
      params: request.params,
      agentId,
      publicThreadId,
      turnId,
      messageId,
      questions,
    });
    this.#routines.markNeedsAttention(turnId);
    this.#emit({
      type: "prompt",
      requestId: request.id,
      agentId,
      threadId: publicThreadId,
      turnId,
      questions,
    });
  }

  /**
   * A turn ending expires its questions, drops its approvals and cancels its takeovers. Each removal
   * emits its resolved event: a compaction turn sends no `turn-completed`, so a client learns about
   * the removal only from that event.
   */
  clearForTurn(threadId: string, turnId: string): void {
    for (const [requestId, pending] of this.#prompts) {
      const pendingThreadId = getString(pending.params, "threadId");
      const pendingTurnId = getString(pending.params, "turnId");
      if (pendingThreadId === threadId && pendingTurnId === turnId) this.#expirePrompt(requestId, pending);
    }
    for (const [requestId, pending] of this.#approvals) {
      const pendingThreadId = getString(pending.params, "threadId") ?? getString(pending.params, "conversationId");
      const pendingTurnId = getString(pending.params, "turnId");
      if (pendingThreadId === threadId && (!pendingTurnId || pendingTurnId === turnId)) {
        this.#approvals.delete(requestId);
        pending.decide?.("cancel");
        this.#emitInputResolved("approval", requestId, pending.approval.agentId);
      }
    }
    for (const [requestId, pending] of this.#takeovers) {
      if (pending.params.threadId === threadId && pending.params.turnId === turnId) {
        this.#resolveBrowserTakeover(requestId, pending, "cancel");
      }
    }
  }

  /** Expires the prompts of one lost provider client, or of all clients when none is given. */
  clearPrompts(client?: AgentClient): void {
    for (const [requestId, pending] of this.#prompts) {
      if (client && pending.client !== client) continue;
      this.#expirePrompt(requestId, pending);
    }
  }

  /**
   * The provider stopped waiting for this request, such as an MCP client whose tool call timed out.
   * An answer now reaches nobody, so the question expires and the approval or takeover closes. The
   * turn continues without it.
   */
  cancelRequest(client: AgentClient, requestId: RequestId): void {
    let changed = false;
    const prompt = this.#prompts.get(requestId);
    if (prompt?.client === client) {
      this.#routines.markRunningForTurn(prompt.turnId);
      this.#expirePrompt(requestId, prompt);
      changed = true;
    }
    const approval = this.#approvals.get(requestId);
    if (approval?.client === client) {
      this.#routines.markRunningForTurn(approval.approval.turnId);
      this.#approvals.delete(requestId);
      approval.decide?.("cancel");
      this.#emitInputResolved("approval", requestId, approval.approval.agentId);
      changed = true;
    }
    for (const [key, takeover] of this.#takeovers) {
      // Resolving emits its own runtime snapshot.
      if (takeover.client === client && takeover.providerRequestId === requestId) {
        this.#resolveBrowserTakeover(key, takeover, "cancel");
      }
    }
    if (changed) this.#emitRuntimeSnapshot();
  }

  /**
   * A failed write must not stop the clear: the remaining requests would stay, and the provider
   * paths that clear a stopped client would fail after the client is gone.
   *
   * A client that still runs can still wait for the answer, for example an ACP turn that ended while
   * its MCP tool call stayed open. It gets a refusal, so its request does not wait forever. A client
   * that forgot the request ignores the answer.
   */
  #expirePrompt(requestId: RequestId, pending: PendingPrompt): void {
    this.#prompts.delete(requestId);
    clearTimeout(pending.autoAnswer?.timer);
    this.#emitInputResolved("prompt", requestId, pending.agentId);
    if (pending.client.running) {
      try {
        pending.client.respond(
          pending.id,
          pending.uiBlock
            ? uiBlockPromptResult({ status: "expired", blockId: pending.uiBlock.blockId })
            : expiredPromptResult(pending.responseKind),
        );
      } catch (error) {
        logger.warn("Unable to answer an expired prompt", { error: toLogValue(error) });
      }
    }
    try {
      this.#resolvePersistedPrompt(pending, { status: "expired" }, { status: "expired" });
    } catch (error) {
      this.#emitError("prompt_persistence_failed", error, pending.agentId);
    }
  }

  /** Cancels the takeovers of one lost provider client, or of all clients when none is given. */
  clearBrowserTakeovers(client?: AgentClient): void {
    for (const [requestId, pending] of this.#takeovers) {
      if (client && pending.client !== client) continue;
      this.#resolveBrowserTakeover(requestId, pending, "cancel");
    }
  }

  /**
   * Drops the approvals of one lost provider client, or of all clients when none is given. The other
   * clients are still running and wait for an answer, so their approvals stay.
   */
  clearApprovals(client?: AgentClient): void {
    for (const [requestId, pending] of this.#approvals) {
      if (client && pending.client !== client) continue;
      this.#approvals.delete(requestId);
      pending.decide?.("cancel");
      this.#emitInputResolved("approval", requestId, pending.approval.agentId);
    }
  }

  #emitInputResolved(kind: "prompt" | "approval", requestId: RequestId, agentId: string): void {
    this.#emit({ type: "agent-input-resolved", kind, requestId, agentId });
  }

  /** A takeover whose tab disappeared can never be answered, so the tab list closing one cancels it. */
  cancelTakeoversForMissingTabs(tabs: BrowserTab[]): void {
    for (const [requestId, pending] of this.#takeovers) {
      if (!tabs.some((tab) => tab.id === pending.request.tabId)) {
        this.#resolveBrowserTakeover(requestId, pending, "cancel");
      }
    }
  }

  #respondToMalformedApproval(client: AgentClient, request: AppServerRequest): void {
    client.respond(
      request.id,
      approvalReply(request.method, request.params, "decline", "Atelier could not identify this approval."),
    );
  }

  /**
   * Hands the tab of a takeover to the user before its card shows. The tab is the user's from the
   * first step of `beginTakeover`: the agent's references are void and its browser tools refused. The
   * rest, the end of a recording, waits for the tab's queue, and an earlier operation can hold that
   * queue with no end. The card then never showed, and the agent waited for an answer that nobody
   * could give. So after `TAKEOVER_HANDOVER_WAIT_MS` the card shows and the handover ends in the
   * background; a handover that fails later closes the card, as a failure before the card does.
   */
  readonly #handOver = Effect.fn("AttentionRegistry.handOver")(function* (
    this: AttentionRegistry,
    requestId: RequestId,
    pending: PendingBrowserTakeover,
  ) {
    const handover = yield* Effect.forkDetach(this.#browser.beginTakeover(pending.request.tabId));
    const handed = yield* Fiber.join(handover).pipe(
      Effect.timeoutOption(TAKEOVER_HANDOVER_WAIT_MS),
      toAttentionOperationFailed,
    );
    if (Option.isSome(handed)) return;
    logger.warn("The browser tab is still busy. The takeover card shows before the handover ends.", {
      agentId: pending.request.agentId,
    });
    yield* Effect.forkDetach(
      Fiber.await(handover).pipe(
        Effect.flatMap((exit) =>
          Effect.sync(() => {
            if (Exit.isSuccess(exit) || this.#takeovers.get(requestId) !== pending) return;
            logger.warn("Unable to hand a browser tab to the user", { error: toLogValue(exit.cause) });
            this.#resolveBrowserTakeover(requestId, pending, "cancel");
          }),
        ),
      ),
    );
  }).bind(this);

  /**
   * Fills a password or authenticator request from the shared vault, without a card. True when the
   * request was answered this way. With no login for the site, or several and no `loginId`, the card
   * opens as before. The value goes to the browser only; the agent gets the usual result.
   */
  readonly #fillFromVault = Effect.fn("AttentionRegistry.fillFromVault")(function* (
    this: AttentionRegistry,
    requestId: RequestId,
    pending: PendingBrowserTakeover,
  ) {
    const vault = this.#passwordVault;
    const request = pending.secret?.request;
    if (!vault || !request || request.method === "otp") return false;
    // A script the agent ran on this site can read what is filled, and a field built for something
    // else can carry the value into a URL. In both cases the card lets the user decide.
    if (pending.secret?.agentScriptedOrigin !== false || pending.secret.vaultFillable !== true) return false;
    const kind = request.method === "password" ? "password" : "totp";
    const found = yield* Effect.result(
      Effect.gen(function* () {
        const call = yield* attentionStep(() => parseBrowserToolCall("submit_secret", pending.params.arguments));
        const loginId = call.tool === "submit_secret" ? call.args.loginId : undefined;
        const candidates = loginId
          ? []
          : ((yield* vault.loginsFor(request.origin)) ?? []).filter(
              (login) => kind === "password" || login.hasOneTimePassword,
            );
        const chosen = loginId ?? (candidates.length === 1 ? candidates[0]?.id : undefined);
        return chosen ? { loginId: chosen, secret: yield* vault.secretFor(chosen, request.origin, kind) } : null;
      }),
    );
    if (Result.isFailure(found)) {
      logger.warn("Unable to fill from the shared vault", { error: toLogValue(found.failure.cause) });
      return false;
    }
    const login = found.success;
    if (!login?.secret || this.#takeovers.get(requestId) !== pending) return false;
    pending.vaultLoginId = login.loginId;
    const submitted = yield* Effect.result(
      this.respondToBrowserSecret({
        requestId,
        agentId: pending.request.agentId,
        decision: "submit",
        secret: login.secret,
      }),
    );
    if (Result.isFailure(submitted)) {
      // The tab could not be handed to the user. Answer the agent, so it does not wait forever.
      logger.warn("Unable to submit the shared login", { error: toLogValue(submitted.failure.cause) });
      if (this.#takeovers.get(requestId) === pending) this.#resolveBrowserTakeover(requestId, pending, "cancel");
      return true;
    }
    // A failed fill hands the tab to the user, as a failed card submission does.
    if (this.#takeovers.get(requestId) === pending) this.#routines.markNeedsAttention(pending.request.turnId);
    return true;
  }).bind(this);

  /**
   * Why `submit_secret` with `secretKey` cannot start, or null. The agent learns only whether the key
   * exists, as from `list_api_keys`, never its value.
   */
  #secretKeyRefusal(args: DynamicRecord | null, agentId: string, name: string): string | null {
    const method = getString(args, "method");
    if (method !== "password" && method !== "authenticator")
      return "secretKey works only with method=password or method=authenticator.";
    if (getString(args, "loginId")) return "Pass loginId or secretKey, not both.";
    if (!this.#apiKeys) return "No key store is available. Use submit_secret without secretKey.";
    const key = this.#apiKeys.resolveNow(agentId, name);
    if (!key)
      return `No saved key is named ${name}. Call openbot.list_api_keys for the names of the saved keys, or use submit_secret without secretKey, and the user types the ${method === "password" ? "password" : "code"}.`;
    if (method === "authenticator" && !parseTwoStepKey(key.value))
      return `${name} is not an authenticator setup key (base32, at least 16 characters, or an otpauth://totp/ link). Use submit_secret without secretKey.`;
    return null;
  }

  /**
   * Fills a password from a Secrets key, or the current code of an authenticator setup key kept in
   * Secrets, without a card. True when the request was answered this way. The checks are those of a Vault fill: with a script of the agent on the site or a field that
   * is not a password field, the card opens. A key has no site of its own, so the first fill of a key
   * on a site waits for the owner's approval, with Full access too: a page can tell an agent to fill
   * a password into a form that sends it away. The value goes to the browser only.
   */
  readonly #fillFromSecretKey = Effect.fn("AttentionRegistry.fillFromSecretKey")(function* (
    this: AttentionRegistry,
    client: AgentClient,
    providerRequest: AppServerRequest,
    requestId: RequestId,
    pending: PendingBrowserTakeover,
  ) {
    const keys = this.#apiKeys;
    const name = pending.secretKey;
    const request = pending.secret?.request;
    if (!keys || !name || (request?.method !== "password" && request?.method !== "authenticator")) return false;
    if (pending.secret?.agentScriptedOrigin !== false || pending.secret.vaultFillable !== true) return false;
    const { agentId, threadId, turnId } = pending.request;
    const { origin } = request;
    const key = keys.resolveNow(agentId, name);
    if (!key) return false;
    if (!keys.fillApproved(key.scope, name, origin)) {
      // The approval card is the only thing the agent waits for now, so the log says so.
      logger.info("A saved key fill waits for the owner's approval.", {
        agentId,
        requestId: String(requestId),
        approvalId: String(providerRequest.id),
        origin,
      });
      this.#secretFills.set(providerRequest.id, { agentId, name, site: origin, createdAt: Date.now() });
      const decision = yield* this.awaitToolApproval(
        client,
        providerRequest,
        {
          requestId: providerRequest.id,
          agentId,
          threadId,
          turnId,
          kind: "permissions",
          command: null,
          cwd: null,
          reason: sourceText(
            request.method === "authenticator" ? "status.agent.secretKeyCodeFill" : "status.agent.secretKeyFill",
            { name, site: origin },
          ),
          grantRoot: null,
          permissions: null,
        },
        { ownerOnly: true },
      ).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            this.#secretFills.delete(providerRequest.id);
          }),
        ),
      );
      logger.info("The owner answered a saved key fill.", { agentId, requestId: String(requestId), decision });
      if (this.#takeovers.get(requestId) !== pending) return true;
      if (decision !== "accept") {
        this.#resolveBrowserTakeover(
          requestId,
          pending,
          "cancel",
          `The server owner did not let Atelier fill ${name} on ${origin}. Do not try again: ask the user, or use submit_secret without secretKey.`,
        );
        return true;
      }
      const kept = yield* Effect.result(keys.approveFill(key.scope, name, origin));
      if (Result.isFailure(kept))
        logger.warn("Unable to keep the approval to fill a saved key", { error: toLogValue(kept.failure.cause) });
    }
    // An authenticator key fills its current code, made after any approval wait so it is fresh.
    const twoStepKey = request.method === "authenticator" ? parseTwoStepKey(key.value) : null;
    if (request.method === "authenticator" && !twoStepKey) return false;
    const value = twoStepKey ? yield* Effect.promise(() => twoStepCode(twoStepKey, Date.now())) : key.value;
    pending.filledSecretKey = name;
    keys.ledger.noteUse(key.scope, name, { kind: "agent", id: agentId }, agentId, `filled on ${origin}`);
    const submitted = yield* Effect.result(
      this.respondToBrowserSecret({ requestId, agentId, decision: "submit", secret: value }),
    );
    if (Result.isFailure(submitted)) {
      logger.warn("Unable to submit the saved key", { error: toLogValue(submitted.failure.cause) });
      if (this.#takeovers.get(requestId) === pending) this.#resolveBrowserTakeover(requestId, pending, "cancel");
      return true;
    }
    if (this.#takeovers.get(requestId) === pending) this.#routines.markNeedsAttention(turnId);
    return true;
  }).bind(this);

  #resolveBrowserTakeover(
    requestId: RequestId,
    pending: PendingBrowserTakeover,
    decision: RespondToBrowserTakeoverInput["decision"],
    vault?: string,
  ): void {
    pending.secret?.cancel();
    logger.info("A browser takeover ended.", {
      agentId: pending.request.agentId,
      requestId: String(pending.request.requestId),
      decision,
      shown: pending.surfaced === true,
    });
    this.#routines.markRunningForTurn(pending.request.turnId);
    this.#takeovers.delete(requestId);
    // `surfaceBrowserTakeover` refuses a second request for the same tab, so this is belt and braces --
    // but returning control while another request still waits on the tab would be the worse mistake.
    if (![...this.#takeovers.values()].some((candidate) => candidate.request.tabId === pending.request.tabId)) {
      this.#browser.endTakeover(pending.request.tabId);
    }
    this.#emit({
      type: "browser-takeover-resolved",
      requestId: pending.request.requestId,
      agentId: pending.request.agentId,
    });
    this.#emitRuntimeSnapshot();
    pending.resolve(browserTakeoverResult(decision, vault));
  }

  #persistQuestionPrompt(
    agentId: string,
    publicThreadId: string,
    turnId: string,
    requestId: RequestId,
    questions: AgentPromptQuestion[],
    uiBlock?: ConversationUiBlock,
  ): string {
    const snapshot = this.#conversation.ensureSnapshot(agentId, publicThreadId);
    const messageId = `question-prompt:${turnId}:${String(requestId)}`;
    const existing = snapshot.messages.find((message) => message.id === messageId);
    if (!existing) {
      snapshot.messages.push({
        id: messageId,
        turnId,
        author: "assistant",
        source: "assistant",
        text: questionPromptText(questions, null),
        createdAt: new Date().toISOString(),
        status: "completed",
        itemType: "question_prompt",
        questionPrompt: {
          requestId,
          questions: structuredClone(questions),
          resolution: null,
        },
        ...(uiBlock ? { uiBlock } : {}),
      });
      this.#conversation.emitConversation(snapshot, "prompt.requested", { turnId, requestId });
    }
    return messageId;
  }

  /**
   * The owner answers or dismisses a decision card whose call ended. An answer goes to the agent as a
   * message (`onPastDecisionAnswered`) before the card freezes, so a failed delivery leaves it open.
   * A dismissal (no answer) only closes it.
   */
  readonly #answerPastDecision = Effect.fn("AttentionRegistry.answerPastDecision")(function* (
    this: AttentionRegistry,
    blockId: string,
    answers: Record<string, string[]>,
    responder: PromptResponder | undefined,
  ) {
    const { decision, response } = yield* attentionStep(() => {
      const decision = this.#pastDecisions?.get(blockId);
      if (!decision) throw new InactiveAttentionRequest(sourceText("error.backend.promptInactive"));
      const questionIds = new Set(uiBlockFallbackQuestions(decision.spec).map((question) => question.id));
      if (Object.keys(answers).some((id) => !questionIds.has(id)))
        throw new Error(sourceText("error.backend.promptAnswerMismatch"));
      return { decision, response: uiBlockAnswer(decision.spec, answers, responder) };
    });
    if (response) {
      const answered = this.#pastDecisionAnswered;
      if (!answered) {
        return yield* attentionStep(() => {
          throw new InactiveAttentionRequest(sourceText("error.backend.promptInactive"));
        });
      }
      yield* answered(decision, response, responder).pipe(
        Effect.mapError((cause) => new AttentionOperationFailed({ cause })),
      );
    }
    const frozen = yield* attentionStep(() => {
      // Another answer took it while the message went out.
      if (!this.#pastDecisions?.get(blockId)) return false;
      this.#pastDecisions.remove(blockId);
      try {
        this.#freezePastDecision(decision, answers, response, responder);
      } catch (error) {
        this.#emitError("prompt_persistence_failed", error, decision.agentId);
      }
      this.#emitRuntimeSnapshot();
      return true;
    });
    // A decision card about a waiting ticket: the ticket gets the owner's answer too.
    if (frozen) yield* this.#answerCardTicket(decision.meta.ticket, decision.spec, response);
  }).bind(this);

  /** Shows the owner's answer on a decision card whose call had ended. */
  #freezePastDecision(
    decision: PastDecision,
    answers: Record<string, string[]>,
    response: UiBlockResponse | null,
    responder: PromptResponder | undefined,
  ): void {
    const snapshot = this.#conversation.ensureSnapshot(decision.agentId, decision.threadId);
    let message = snapshot.messages.find((candidate) => candidate.id === decision.messageId);
    if (!message) {
      message = this.#readStoredMessage?.(decision.agentId, snapshot.threadId ?? decision.threadId, decision.messageId);
      if (!message) return;
      snapshot.messages.push(message);
    }
    if (!message.questionPrompt || !message.uiBlock) return;
    const resolution: AgentPromptResolution = response
      ? promptResolution(message.questionPrompt.questions, answers)
      : { status: "cancelled" };
    message.questionPrompt.resolution = resolution;
    message.text = questionPromptText(message.questionPrompt.questions, resolution);
    const frozen = normalizeConversationUiBlock({
      ...message.uiBlock,
      state: answeredUiBlockState(decision.spec, response, responder, undefined),
    });
    if (frozen) message.uiBlock.state = frozen.state;
    this.#conversation.emitConversation(snapshot, "prompt.resolved", {
      turnId: decision.turnId,
      requestId: pastDecisionRequestId(decision.blockId),
      status: resolution.status,
    });
  }

  /** `uiBlockState` freezes the message's UI block, when it has one, in the same write. */
  #resolvePersistedPrompt(
    pending: PendingPrompt,
    resolution: AgentPromptResolution,
    uiBlockState?: UiBlockState,
  ): void {
    const snapshot = this.#conversation.ensureSnapshot(pending.agentId, pending.publicThreadId);
    const message = snapshot.messages.find((candidate) => candidate.id === pending.messageId);
    if (!message?.questionPrompt || message.questionPrompt.resolution !== null) return;
    message.questionPrompt.resolution = structuredClone(resolution);
    message.text = questionPromptText(message.questionPrompt.questions, resolution);
    if (message.uiBlock && uiBlockState) {
      // The read drops a secret form value; storing the read result keeps it out of the database.
      const frozen = normalizeConversationUiBlock({ ...message.uiBlock, state: uiBlockState });
      message.uiBlock.state = frozen?.state ?? {
        status: uiBlockState.status === "answered" ? "closed" : uiBlockState.status,
      };
    }
    this.#conversation.emitConversation(snapshot, "prompt.resolved", {
      turnId: pending.turnId,
      requestId: pending.id,
      status: resolution.status,
    });
  }
}

/**
 * The response the answers give, or null when the person skipped the block. The answers come keyed by
 * the fallback questions, from a client that knows the block (`uiBlockAnswersFromResponse`) or from one
 * that only showed the questions. Throws when the answer does not fit, or when a member who is not the
 * owner or an admin takes a privileged action.
 */
/** The buttons of a decision card for a list that answers in place: its options and its No, not Change…. */
function decisionOptions(spec: UiBlockSpec): { options?: AgentAttentionOption[] } {
  if (spec.type !== "confirm") return {};
  const view = ownerDecisionView(spec);
  const options: AgentAttentionOption[] = view.options.map((option) => ({
    label: option.action.label.slice(0, AGENT_ATTENTION_TEXT_LIMIT),
    ...(option.recommended ? { recommended: true as const } : {}),
  }));
  const no = view.others.find((action) => action.id === "no");
  if (no) options.push({ label: no.label.slice(0, AGENT_ATTENTION_TEXT_LIMIT), decline: true });
  return options.length > 0 && options.length <= AGENT_ATTENTION_OPTIONS_LIMIT ? { options } : {};
}

function uiBlockAnswer(
  spec: UiBlockSpec,
  answers: Readonly<Record<string, readonly string[]>>,
  responder: PromptResponder | undefined,
): UiBlockResponse | null {
  const read = uiBlockResponseFromAnswers(spec, answers);
  if (!read) return null;
  const response = validateUiBlockResponse(spec, read);
  if (!response) throw new Error(sourceText("error.backend.uiBlockAnswerInvalid"));
  // On a block with a privileged action an answer in words is privileged too: a member could
  // otherwise write "yes" to an action they may not press.
  const privileged =
    response.actionId === UI_BLOCK_TEXT_ACTION_ID
      ? uiBlockHasPrivilegedAction(spec)
      : uiBlockActionIsPrivileged(spec, response.actionId);
  if (responder && !responder.privileged && privileged) {
    throw new ForbiddenAttentionAnswer(sourceText("error.backend.uiBlockActionNotAllowed"));
  }
  return response;
}

function answeredUiBlockState(
  spec: UiBlockSpec,
  response: UiBlockResponse | null,
  responder: PromptResponder | undefined,
  autoAnswer: UiBlockAutoAnswer | undefined,
): UiBlockState {
  const state: UiBlockState = response ? { status: "answered", response } : { status: "closed" };
  // The contract refuses a blank outcome, such as a form sent with every optional field empty.
  const outcome = response ? uiBlockOutcomeText(spec, response) : "";
  if (outcome.trim()) state.outcome = outcome;
  // The frozen block says that the host chose, not a person.
  if (autoAnswer && responder?.automatic) state.autoAnswer = { ...autoAnswer, done: true };
  if (responder?.sender) state.respondedBy = structuredClone(responder.sender);
  state.respondedAt = new Date().toISOString();
  return state;
}

class AttentionOperationFailed extends Schema.TaggedError<AttentionOperationFailed>()("AttentionOperationFailed", {
  cause: Schema.Defect(),
}) {}

/** Redacted choice labels and IDs cannot be sent back as the provider's original values. */
function localQuestionNeedsOpenBot(question: AgentPromptQuestion): boolean {
  return (
    question.isSecret ||
    redactText(question.id) !== question.id ||
    (question.options?.some((option) => redactText(option.label) !== option.label) ?? false)
  );
}

const {
  io: attentionIo,
  sync: attentionStep,
  rewrap: toAttentionOperationFailed,
} = causeHelpers(AttentionOperationFailed);

/**
 * An approval's command or reason as its card shows it: a token in a `curl -H "Authorization: …"` goes,
 * on every screen and in the briefing. Only the card reads it; the answer goes back with the
 * provider's own request, so the command that runs is unchanged.
 */
function shownText(value: string | null): string | null {
  return value === null ? null : redactSecrets(value);
}

/** One line of text of an attention item, redacted and cut to its bound, or undefined. */
function attentionLine(value: string | undefined): string | undefined {
  const line = value ? redactText(value).replace(/\s+/gu, " ").trim() : "";
  if (!line) return undefined;
  const characters = Array.from(line);
  return characters.length > AGENT_ATTENTION_TEXT_LIMIT
    ? `${characters.slice(0, AGENT_ATTENTION_TEXT_LIMIT - 1).join("")}…`
    : line;
}

function optionalText(key: "summary" | "origin", value: string | undefined): { summary?: string; origin?: string } {
  return value === undefined ? {} : key === "summary" ? { summary: value } : { origin: value };
}

/** The host name of a page address, or nothing for a value that is no URL. */
function urlHost(value: string): string | undefined {
  try {
    return new URL(value).hostname || undefined;
  } catch {
    return undefined;
  }
}

type ApprovalReply =
  | { permissions: DynamicRecord; scope: "turn" }
  | { decision: "approved" | { denied: { rejection: string } } }
  | { decision: "accept" | "decline" };

/** The reply each approval method's provider understands for a decision. */
function approvalReply(
  method: string,
  params: unknown,
  decision: "accept" | "decline",
  rejection: string,
): ApprovalReply {
  if (method === "item/permissions/requestApproval")
    return { permissions: decision === "accept" ? (getRecord(params, "permissions") ?? {}) : {}, scope: "turn" };
  if (method === "applyPatchApproval" || method === "execCommandApproval")
    return { decision: decision === "accept" ? "approved" : { denied: { rejection } } };
  return { decision };
}
