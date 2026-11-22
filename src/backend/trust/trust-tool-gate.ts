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
import { sourceText } from "@openbot/i18n/source";
import { Effect } from "effect";
import { z } from "zod";
import type { PromptResponder, SurfacedUiBlock } from "../agent/attention-registry";
import { openBotToolFailure, openBotToolResult } from "../agent/routine-tools";
import type { AgentClient } from "../agent-client";
import type { GuardrailsService } from "../guardrails/guardrails-service";
import { MoneyApprovals, moneyDigest, moneyEffect } from "../guardrails/money-approvals";
import { guardrailToolCall } from "../guardrails/tool-fingerprint";
import { REQUEST_DECISION_ACTIONS, requestDecisionToolSchema } from "../openbot-tools";
import type { AppServerRequest, DynamicToolCallParams, DynamicToolResult } from "../protocol";
import {
  classifyBrowserCall,
  classifyCommand,
  classifyToolUse,
  type TrustClassification,
  trustCategory,
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
  /** Ends a waiting approval as unanswered: a money approval that expired. */
  cancelRequest(client: TrustClient, requestId: string | number): void;
}

export interface TrustToolGateOptions {
  trust: TrustService;
  attention: TrustAttention;
  agentForThread(threadId: string): string | undefined;
  publicThreadId(agentId: string, threadId: string): string;
  listTabs(): BrowserTab[];
  /** Slack, Discord and Telegram show no card, so a decision cannot wait there. */
  messagingThread(publicThreadId: string): boolean;
  /** The injection monitor and the expiry of money approvals. Null where no guardrails run. */
  guardrails?: GuardrailsService | null;
}

/** The guardrails' answer for one call: refuse it, or how the trust gate must treat it. */
type GuardCheck = { allowed: true; askOwner: boolean; tainted: boolean } | { allowed: false; message: string };

function isMoney(action: TrustClassification | null): action is TrustClassification {
  return action?.action === "pay" || action?.action === "launch_ads";
}

/** The action without its browser surface, so the pass of an earlier approval does not cover it. */
function withoutSurface(action: TrustClassification): TrustClassification {
  const { surface: _surface, ...rest } = action;
  return rest;
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
  readonly #money = new MoneyApprovals();

  constructor(options: TrustToolGateOptions) {
    this.#trust = options.trust;
    this.#attention = options.attention;
    this.#options = options;
  }

  /**
   * The approval card of one action. A money card shows the effect (the target, the amount, the budget
   * before and after) and, for a payment, what the owner pays by hand and where; it expires after the
   * guardrails' `moneyApprovalHours`, and the call then does not run.
   */
  #approve(
    client: TrustClient,
    request: AppServerRequest,
    subject: Required<Pick<TrustSubject, "agentId" | "threadId" | "turnId">>,
    action: TrustClassification,
  ) {
    return (reason: string) => {
      const money = isMoney(action);
      const effect = money ? moneyEffect(action, this.#trust.audit) : null;
      const policy = this.#options.guardrails?.policy();
      const hours = money && policy?.enabled ? policy.moneyApprovalHours : null;
      let expired = false;
      const timer =
        hours === null
          ? null
          : setTimeout(() => {
              expired = true;
              this.#attention.cancelRequest(client, request.id);
            }, hours * 3_600_000);
      timer?.unref?.();
      const command = effect
        ? [effect.headline, effect.payByHand].filter(Boolean).join("\n")
        : action.amount === undefined
          ? action.summary
          : `${action.summary} (${action.amount} ${action.currency ?? "USD"})`;
      return this.#attention
        .awaitToolApproval(
          client,
          request,
          {
            requestId: request.id,
            agentId: subject.agentId,
            threadId: subject.threadId,
            turnId: subject.turnId,
            kind: "permissions",
            command,
            cwd: null,
            reason:
              hours === null
                ? reason
                : `${reason} ${sourceText("status.agent.moneyApprovalExpires", { hours: String(hours) })}`,
            grantRoot: null,
            permissions: null,
          },
          // Full access does not answer it, and only the owner can: the money and the name are theirs.
          { alwaysAsk: true, ownerOnly: true },
        )
        .pipe(
          Effect.ensuring(Effect.sync(() => timer && clearTimeout(timer))),
          Effect.tap(() =>
            Effect.sync(() => {
              if (expired) this.#options.guardrails?.moneyExpired(subject.agentId, subject.turnId, action.summary);
            }),
          ),
        );
    };
  }

  /** The guardrails' check of a call before the trust gate: the injection monitor. */
  #guard(agentId: string, turnId: string, name: string, input: unknown, action: TrustClassification | null) {
    const guardrails = this.#options.guardrails;
    return guardrails
      ? guardrails.checkAction(agentId, turnId, name, input, action).pipe(Effect.map((check): GuardCheck => check))
      : Effect.succeed<GuardCheck | null>(null);
  }

  /**
   * Runs one classified action through the trust gate with the guardrails' money rules: an identical
   * call that the owner approved minutes ago runs once without a second card, a changed call asks
   * again; after untrusted content no pass of an earlier approval covers money, and a money action
   * that the monitor could not clear asks the owner even within a budget.
   */
  readonly #gate = Effect.fn("TrustToolGate.gate")(function* (
    this: TrustToolGate,
    client: TrustClient,
    request: AppServerRequest,
    subject: Required<Pick<TrustSubject, "agentId" | "threadId" | "turnId">>,
    action: TrustClassification,
    guard: GuardCheck | null,
  ) {
    const money = isMoney(action);
    const digest = money ? moneyDigest(action) : null;
    if (digest && this.#money.consume(subject.agentId, digest)) return { allowed: true as const };
    const gated = money && guard?.allowed && guard.tainted ? withoutSurface(action) : action;
    let accepted = false;
    const approve = (reason: string) =>
      this.#approve(
        client,
        request,
        subject,
        gated,
      )(reason).pipe(
        Effect.tap((answer) =>
          Effect.sync(() => {
            accepted = answer === "accept";
          }),
        ),
      );
    if (money && guard?.allowed && guard.askOwner && this.#trust.evaluate(subject, gated).kind === "allow") {
      const answer = yield* approve(
        sourceText("status.agent.trustAskAfterUntrusted", {
          agent: this.#trust.agentName(subject.agentId) ?? subject.agentId,
        }),
      );
      const name = this.#trust.agentName(subject.agentId);
      this.#trust.record({
        actor: { kind: "agent", id: subject.agentId, ...(name ? { name } : {}) },
        category: trustCategory(gated.action),
        action: gated.label,
        summary: gated.summary,
        ...(gated.amount === undefined ? {} : { amount: gated.amount, currency: gated.currency ?? "USD" }),
        ...(gated.platform ? { platform: normalizeTrustPlatform(gated.platform) } : {}),
        agentId: subject.agentId,
        threadId: subject.threadId,
        turnId: subject.turnId,
        outcome: answer === "accept" ? "approved" : "declined",
        ...(answer === "cancel" ? {} : { answeredBy: "owner" }),
      });
      if (answer !== "accept")
        return {
          allowed: false as const,
          message: `The owner did not approve ${gated.label}. Do not retry it or try it another way.`,
        };
      if (digest) this.#money.grant(subject.agentId, digest);
      return { allowed: true as const };
    }
    const result = yield* this.#trust.gate(subject, gated, approve);
    if (result.allowed && accepted && digest) this.#money.grant(subject.agentId, digest);
    return result;
  });

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
    const guard = yield* this.#guard(
      agentId,
      params.turnId,
      `openbot_browser.${params.tool}`,
      params.arguments,
      action,
    );
    if (guard && !guard.allowed) return openBotToolFailure(guard.message);
    if (!action) return null;
    const subject = { agentId, threadId: params.threadId, turnId: params.turnId };
    const result = yield* this.#gate(client, request, subject, action, guard);
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
    const agentId = this.#options.agentForThread(params.threadId);
    if (!agentId) return null;
    const args = isDynamicRecord(params.arguments) ? params.arguments : {};
    const action: TrustClassification | null =
      params.tool === "create_agent"
        ? {
            action: "create_agent",
            label: "openbot.create_agent",
            summary: trustSummary(`Create the agent ${isString(args.name) ? args.name : ""}`),
          }
        : null;
    const guard = yield* this.#guard(agentId, params.turnId, `openbot.${params.tool}`, params.arguments, action);
    if (guard && !guard.allowed) return openBotToolFailure(guard.message);
    if (!action) return null;
    const subject = {
      agentId,
      threadId: this.#options.publicThreadId(agentId, params.threadId),
      turnId: params.turnId,
    };
    const result = yield* this.#gate(client, request, subject, action, guard);
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
    if (!agentId) return answer("allow");
    const call = guardrailToolCall(params.toolName, params.toolInput);
    const guard = call ? yield* this.#guard(agentId, turnId, call.name, call.input, action) : null;
    if (guard && !guard.allowed) return answer("deny", guard.message);
    if (!action) return answer("allow");
    const subject = { agentId, threadId: this.#options.publicThreadId(agentId, threadId), turnId };
    if (params.phase !== "approve") {
      const gated = isMoney(action) && guard?.allowed && guard.tainted ? withoutSurface(action) : action;
      const asks =
        this.#trust.evaluate(subject, gated).kind === "ask" || (isMoney(action) && guard?.allowed && guard.askOwner);
      if (asks) {
        // The owner approved this exact call a moment ago, such as before a retry: it runs once more.
        if (isMoney(action) && this.#money.consume(agentId, moneyDigest(action))) return answer("allow");
        return answer("ask");
      }
    }
    const result = yield* this.#gate(client, request, subject, action, guard);
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
    const turnId = isString(params.turnId) ? params.turnId : String(request.id);
    // The guardrails check a high-impact command of a turn that read untrusted content.
    const guard = yield* this.#guard(agentId, turnId, "Bash", { command }, action);
    if (guard && !guard.allowed) return false;
    if (!action || (action.action !== "pay" && action.action !== "launch_ads")) return null;
    const subject = { agentId, threadId: this.#options.publicThreadId(agentId, threadId), turnId };
    const result = yield* this.#gate(client, request, subject, action, guard);
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
