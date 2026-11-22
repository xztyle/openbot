import { randomUUID } from "node:crypto";
import type { BrowserTab } from "@openbot/contracts/ipc";
import { isDynamicRecord, isString } from "@openbot/contracts/runtime-values";
import { normalizeTrustPlatform } from "@openbot/contracts/trust-control";
import {
  normalizeUiBlockSpec,
  type UiAction,
  type UiBlockResponse,
  type UiConfirmField,
} from "@openbot/contracts/ui-blocks";
import { Effect } from "effect";
import { z } from "zod";
import type { PromptResponder, SurfacedUiBlock } from "../agent/attention-registry";
import { openBotToolFailure, openBotToolResult } from "../agent/routine-tools";
import type { AgentClient } from "../agent-client";
import { REQUEST_DECISION_ACTIONS, requestDecisionToolSchema } from "../openbot-tools";
import type { AppServerRequest, DynamicToolCallParams, DynamicToolResult } from "../protocol";
import {
  classifyBrowserCall,
  classifyCommand,
  classifyToolUse,
  type TrustClassification,
  trustSummary,
} from "./trust-classifier";
import type { TrustApprovalAnswer, TrustService, TrustSubject } from "./trust-service";

export { TRUST_CHECK_METHOD } from "./trust-classifier";

/** What the gate uses of a provider client: it answers the request. */
export type TrustClient = Pick<AgentClient, "respond" | "running">;

/** What the attention registry gives the gate: an approval card and a decision card. */
export interface TrustAttention {
  awaitToolApproval(
    client: TrustClient,
    request: AppServerRequest,
    approval: {
      requestId: string | number;
      agentId: string;
      threadId: string;
      turnId: string;
      kind: "permissions";
      command: string | null;
      cwd: null;
      reason: string;
      grantRoot: null;
      permissions: null;
    },
    options: { readonly alwaysAsk?: boolean; readonly ownerOnly?: boolean },
  ): Effect.Effect<TrustApprovalAnswer>;
  surfaceUiBlock(
    client: TrustClient,
    request: AppServerRequest,
    block: SurfacedUiBlock,
    autoAnswer?: { actionId: string; afterMs: number },
  ): void;
}

export interface TrustToolGateOptions {
  trust: TrustService;
  attention: TrustAttention;
  agentForThread(threadId: string): string | undefined;
  publicThreadId(agentId: string, threadId: string): string;
  listTabs(): BrowserTab[];
  /** Slack, Discord and Telegram show no card, so a decision cannot wait there. */
  messagingThread(publicThreadId: string): boolean;
}

const OPTION_IDS: readonly string[] = ["option1", "option2", "option3"];

/**
 * Owns the router's half of trust and control: it turns a tool call into a classification, runs it
 * through the trust gate with an approval card that only the owner can answer, and shows the
 * decision card of `request_decision`. It answers the Claude hook's `openbot/trust-check` request too.
 *
 * It never imports the router or the agent service.
 */
export class TrustToolGate {
  readonly #trust: TrustService;
  readonly #attention: TrustAttention;
  readonly #options: TrustToolGateOptions;

  constructor(options: TrustToolGateOptions) {
    this.#trust = options.trust;
    this.#attention = options.attention;
    this.#options = options;
  }

  #approve(
    client: TrustClient,
    request: AppServerRequest,
    subject: Required<Pick<TrustSubject, "agentId" | "threadId" | "turnId">>,
    action: TrustClassification,
  ) {
    return (reason: string) =>
      this.#attention.awaitToolApproval(
        client,
        request,
        {
          requestId: request.id,
          agentId: subject.agentId,
          threadId: subject.threadId,
          turnId: subject.turnId,
          kind: "permissions",
          command:
            action.amount === undefined
              ? action.summary
              : `${action.summary} (${action.amount} ${action.currency ?? "USD"})`,
          cwd: null,
          reason,
          grantRoot: null,
          permissions: null,
        },
        // Full access does not answer it, and only the owner can: the money and the name are theirs.
        { alwaysAsk: true, ownerOnly: true },
      );
  }

  /**
   * Checks a browser tool call before it runs. Null lets it run; a result refuses it. `params` has the
   * public thread id already, as the browser host gets it.
   */
  readonly checkBrowser = Effect.fn("TrustToolGate.checkBrowser")(function* (
    this: TrustToolGate,
    client: TrustClient,
    request: AppServerRequest,
    params: DynamicToolCallParams,
    agentId: string,
  ) {
    const args = isDynamicRecord(params.arguments) ? params.arguments : {};
    const tabId = isString(args.tabId) ? args.tabId : undefined;
    const tab = tabId ? this.#options.listTabs().find((candidate) => candidate.id === tabId) : undefined;
    const action = classifyBrowserCall(params.tool, params.arguments, tab?.url);
    if (!action) return null;
    const subject = { agentId, threadId: params.threadId, turnId: params.turnId };
    const result = yield* this.#trust.gate(subject, action, this.#approve(client, request, subject, action));
    return result.allowed ? null : openBotToolFailure(result.message);
  });

  /** Records a secret fill or a sign-in that `submit_secret` finished, with no value. */
  recordSecret(agentId: string, params: DynamicToolCallParams, result: DynamicToolResult): void {
    if (!result.success) return;
    const args = isDynamicRecord(params.arguments) ? params.arguments : {};
    const tabId = isString(args.tabId) ? args.tabId : undefined;
    const url = this.#options.listTabs().find((tab) => tab.id === tabId)?.url;
    let host = "a page";
    try {
      if (url) host = new URL(url).hostname;
    } catch {
      // The tab has no address yet.
    }
    const method = isString(args.method) ? args.method : "secret";
    const source = isString(args.loginId)
      ? " (saved login)"
      : isString(args.secretKey)
        ? ` (key ${args.secretKey})`
        : "";
    this.#trust.record({
      actor: {
        kind: "agent",
        id: agentId,
        ...(this.#trust.agentName(agentId) ? { name: this.#trust.agentName(agentId) } : {}),
      },
      category: method === "password" ? "sign_in" : "secret",
      action: "openbot_browser.submit_secret",
      summary: trustSummary(`${method} on ${host}${source}`),
      outcome: "allowed",
      platform: normalizeTrustPlatform(host),
      agentId,
      threadId: this.#options.publicThreadId(agentId, params.threadId),
      turnId: params.turnId,
    });
  }

  /** Checks an `openbot` tool. Today that is `create_agent`. */
  readonly checkOpenBotTool = Effect.fn("TrustToolGate.checkOpenBotTool")(function* (
    this: TrustToolGate,
    client: TrustClient,
    request: AppServerRequest,
    params: DynamicToolCallParams,
  ) {
    if (params.tool !== "create_agent") return null;
    const agentId = this.#options.agentForThread(params.threadId);
    if (!agentId) return null;
    const args = isDynamicRecord(params.arguments) ? params.arguments : {};
    const action: TrustClassification = {
      action: "create_agent",
      label: "openbot.create_agent",
      summary: trustSummary(`Create the agent ${isString(args.name) ? args.name : ""}`),
    };
    const subject = {
      agentId,
      threadId: this.#options.publicThreadId(agentId, params.threadId),
      turnId: params.turnId,
    };
    const result = yield* this.#trust.gate(subject, action, this.#approve(client, request, subject, action));
    return result.allowed ? null : openBotToolFailure(result.message);
  });

  /**
   * `openbot/trust-check`: the Claude hook asks before Bash or an MCP tool runs. `phase: "check"`
   * answers at once (`allow`, `deny` or `ask`); `phase: "approve"` comes from the permission prompt
   * after an `ask` and waits for the owner's card.
   */
  readonly handleTrustCheck = Effect.fn("TrustToolGate.handleTrustCheck")(function* (
    this: TrustToolGate,
    client: TrustClient,
    request: AppServerRequest,
  ) {
    const params = isDynamicRecord(request.params) ? request.params : {};
    const threadId = isString(params.threadId) ? params.threadId : "";
    const turnId = isString(params.turnId) ? params.turnId : randomUUID();
    const agentId = threadId ? this.#options.agentForThread(threadId) : undefined;
    const action = classifyToolUse(params.toolName, params.toolInput, isString(params.cwd) ? params.cwd : null);
    const answer = (decision: "allow" | "deny" | "ask", reason?: string) => {
      if (!request.signal?.aborted && client.running)
        client.respond(request.id, { decision, ...(reason ? { reason } : {}) });
    };
    if (!agentId || !action) return answer("allow");
    const subject = { agentId, threadId: this.#options.publicThreadId(agentId, threadId), turnId };
    if (params.phase !== "approve" && this.#trust.evaluate(subject, action).kind === "ask") return answer("ask");
    const result = yield* this.#trust.gate(subject, action, this.#approve(client, request, subject, action));
    return result.allowed ? answer("allow") : answer("deny", result.message);
  });

  /**
   * A shell command that a provider asks to run: Codex, Muse and the ACP providers ask through
   * `item/commandExecution/requestApproval` (or the older `execCommandApproval`). Claude asks through
   * its hook instead. Only money goes through the gate here, so an agent's auto-approve grant cannot
   * answer a payment or an ad launch for the owner. Null when the call spends nothing; otherwise
   * whether the gate allowed it.
   */
  readonly checkProviderCommand = Effect.fn("TrustToolGate.checkProviderCommand")(function* (
    this: TrustToolGate,
    client: TrustClient,
    request: AppServerRequest,
    command: string | null,
  ) {
    const params = isDynamicRecord(request.params) ? request.params : {};
    const threadId = isString(params.threadId)
      ? params.threadId
      : isString(params.conversationId)
        ? params.conversationId
        : "";
    const agentId = threadId ? this.#options.agentForThread(threadId) : undefined;
    if (!agentId || !command) return null;
    const action = classifyCommand(command, { cwd: isString(params.cwd) ? params.cwd : null });
    if (!action || (action.action !== "pay" && action.action !== "launch_ads")) return null;
    const turnId = isString(params.turnId) ? params.turnId : String(request.id);
    const subject = { agentId, threadId: this.#options.publicThreadId(agentId, threadId), turnId };
    const result = yield* this.#trust.gate(subject, action, this.#approve(client, request, subject, action));
    return result.allowed;
  });

  /** Shows the decision card of `request_decision`. It answers the call when the person answers. */
  requestDecision(client: TrustClient, request: AppServerRequest, params: DynamicToolCallParams): undefined {
    const refuse = (message: string): undefined => {
      client.respond(request.id, openBotToolFailure(message));
      return undefined;
    };
    const agentId = this.#options.agentForThread(params.threadId);
    if (!agentId) return refuse("The calling Atelier agent is unknown.");
    const threadId = this.#options.publicThreadId(agentId, params.threadId);
    if (this.#options.messagingThread(threadId))
      return refuse(
        "This chat is in Slack, Discord or Telegram and cannot show the decision card. Ask in your answer.",
      );
    const parsed = requestDecisionToolSchema.safeParse(params.arguments);
    if (!parsed.success) return refuse(`${z.prettifyError(parsed.error)}\nCorrect the arguments and retry.`);
    const input = parsed.data;
    const single = input.options.length === 1;
    const actions: UiAction[] = input.options.map((option, index) => ({
      id: OPTION_IDS[index] ?? "option1",
      label: option.label,
      ...(index === 0 ? { style: "primary" as const } : {}),
    }));
    if (input.options.length < 3)
      actions.push({ id: REQUEST_DECISION_ACTIONS.change, label: input.changeLabel ?? "Change…" });
    actions.push({ id: REQUEST_DECISION_ACTIONS.no, label: input.noLabel ?? "No", style: "ghost" });
    const fields: UiConfirmField[] = [];
    for (const option of input.options)
      if (option.consequence) fields.push({ label: single ? "→" : option.label, value: option.consequence });
    if (input.amount)
      fields.push({
        label: "💰",
        value: `${input.amount.value} ${input.amount.currency?.toUpperCase() ?? "USD"}${input.amount.perDay ? "/day" : ""}${input.amount.platform ? ` · ${input.amount.platform}` : ""}`,
      });
    const defaultAction =
      input.defaultOption === undefined
        ? undefined
        : input.defaultOption === 4
          ? REQUEST_DECISION_ACTIONS.no
          : OPTION_IDS[input.defaultOption - 1];
    if (defaultAction && !actions.some((action) => action.id === defaultAction))
      return refuse("defaultOption names an option that the card does not have.");
    if (defaultAction && input.timeoutMinutes)
      fields.push({
        label: "⏱",
        value: `${input.timeoutMinutes} min → ${actions.find((action) => action.id === defaultAction)?.label ?? ""}`,
      });
    if (input.ticket) fields.push({ label: "#", value: input.ticket });
    const preview = [input.previewUrl ? `[${input.previewUrl}](${input.previewUrl})` : "", input.preview ?? ""]
      .filter(Boolean)
      .join("\n\n");
    const spec = normalizeUiBlockSpec({
      type: "confirm",
      title: input.title,
      ...(fields.length ? { fields: fields.slice(0, 8) } : {}),
      ...(preview ? { preview } : {}),
      actions,
    });
    if (!spec)
      return refuse("Each button needs a different label, and the text must fit the card. Correct it and retry.");
    const blockId = randomUUID();
    const onAnswer = (response: UiBlockResponse | null, responder: PromptResponder | undefined) =>
      this.#decided(agentId, threadId, params.turnId, input, actions, response, responder);
    this.#attention.surfaceUiBlock(
      client,
      request,
      { blockId, spec, card: true, onAnswer },
      defaultAction && input.timeoutMinutes
        ? { actionId: defaultAction, afterMs: input.timeoutMinutes * 60_000 }
        : undefined,
    );
    return undefined;
  }

  #decided(
    agentId: string,
    threadId: string,
    turnId: string,
    input: z.infer<typeof requestDecisionToolSchema>,
    actions: readonly UiAction[],
    response: UiBlockResponse | null,
    responder: PromptResponder | undefined,
  ): DynamicToolResult {
    const automatic = responder?.automatic === true;
    const actionId = response?.actionId;
    const chosen = actions.find((action) => action.id === actionId);
    const optionIndex = OPTION_IDS.indexOf(actionId ?? "");
    const approved = optionIndex >= 0;
    const answeredBy = automatic ? "timeout" : (responder?.sender?.name ?? "owner");
    let goLive: "granted" | "needs-owner" | "not-on-timeout" | undefined;
    if (input.goLive && approved) {
      if (automatic) goLive = "not-on-timeout";
      else if (responder && !responder.privileged) goLive = "needs-owner";
      else {
        this.#trust.grantGoLive(agentId, input.goLive);
        goLive = "granted";
      }
    }
    const name = this.#trust.agentName(agentId);
    this.#trust.record({
      actor: { kind: "agent", id: agentId, ...(name ? { name } : {}) },
      category: input.goLive ? "approval" : "decision",
      action: input.goLive ? `request_decision (go-live ${input.goLive})` : "request_decision",
      summary: trustSummary(
        `${input.title} → ${response === null ? "skipped" : response.actionId === "_text" ? `"${response.text ?? ""}"` : (chosen?.label ?? actionId ?? "")}${input.previewUrl ? ` · ${input.previewUrl}` : ""}`,
      ),
      outcome: automatic
        ? "timed_out"
        : approved
          ? input.goLive
            ? "approved"
            : "answered"
          : input.goLive
            ? "declined"
            : "answered",
      ...(input.amount
        ? {
            amount: input.amount.value,
            currency: input.amount.currency?.toUpperCase() ?? "USD",
            ...(input.amount.platform ? { platform: normalizeTrustPlatform(input.amount.platform) } : {}),
          }
        : {}),
      agentId,
      threadId,
      turnId,
      ...(input.ticket ? { ticket: input.ticket } : {}),
      answeredBy,
    });
    if (response === null) return openBotToolResult({ status: "skipped" });
    if (response.actionId === "_text")
      return openBotToolResult({ status: "answered", option: "change", text: response.text });
    return openBotToolResult({
      status: "answered",
      option: approved ? optionIndex + 1 : actionId,
      label: chosen?.label,
      ...(automatic ? { byTimeout: true } : {}),
      ...(goLive === "granted"
        ? { goLive: `approved: run the ${input.goLive} publish command now` }
        : goLive === "needs-owner"
          ? { goLive: "not approved: only the owner or an admin can approve a go-live. Ask the owner." }
          : goLive === "not-on-timeout"
            ? { goLive: "not approved: a timed-out default never approves a go-live. Do not publish." }
            : {}),
    });
  }
}
