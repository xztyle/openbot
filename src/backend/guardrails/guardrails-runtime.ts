import { randomUUID } from "node:crypto";
import {
  type AccountUsageLimit,
  AGENT_PROVIDERS,
  type AgentModelChoice,
  type AgentModelOption,
  type AgentStatus,
  type AgentSummary,
  DEFAULT_PROVIDER_ACCOUNT_ID,
  defaultProviderModel,
} from "@openbot/contracts/ipc";
import { CLAUDE_API_KEY_ACCOUNT_ID } from "@openbot/contracts/team-protocol/claude-api-key-v1";
import { createOpenBotLogger, toLogValue } from "@openbot/logging";
import { Effect } from "effect";
import type { AgentClient, AgentProvider } from "../agent-client";
import type { AgentStore } from "../agent-store";
import type { MailboxStore } from "../mailbox-store";
import type { OwnerAwayService } from "../owner-away";
import { decodeRecordResponse } from "../protocol";
import type { TrustAuditInput } from "../trust/trust-audit-log";
import type { GuardrailsRuntime } from "./guardrails-service";
import type { MeterAccount } from "./subscription-meter";

const logger = createOpenBotLogger("guardrails");

/** What the runtime reads of the agent service. Each member is a plain read or one action. */
export interface GuardrailsRuntimeOptions {
  store: AgentStore;
  mailbox: MailboxStore;
  status(): AgentStatus;
  models(): readonly AgentModelOption[];
  usageAccounts(provider: AgentProvider): Array<{ accountId: string; limit: AccountUsageLimit | null }>;
  poolOf(provider: AgentProvider): { leftOut: readonly string[]; inUse: string | null } | null;
  clientFor(agent: AgentSummary): AgentClient | null;
  /** The public thread of a provider thread. */
  publicThread(agentId: string, providerThreadId: string): string;
  routineTrigger(agentId: string, routineId: string): string | null;
  interrupt(agentId: string, turnId: string, executionThreadId?: string): Effect.Effect<void, unknown>;
  scheduleDrain(agentId: string): void;
  generateCheap(prompt: string): Effect.Effect<string, unknown>;
  ownerAway: OwnerAwayService | null;
  /** A note from Atelier to an agent's chat, which starts a turn. */
  noteAgent(agentId: string, text: string): void;
  /** One line of the trust log, when the host keeps one. */
  recordTrust(entry: TrustAuditInput): void;
  /** Whether a model choice is ready and no usage limit holds it. */
  modelReady(choice: AgentModelChoice): boolean;
  changed(): void;
}

function codexVersion(id: string): number {
  const match = /(\d+(?:\.\d+)?)/u.exec(id);
  return match?.[1] ? Number(match[1]) : 0;
}

/**
 * The Codex models in the order that a failover tries them, the same for every tier: Codex's default
 * model, then the newest listed model.
 */
export function codexFailoverModels(models: readonly AgentModelOption[]): string[] {
  const preferred = defaultProviderModel("codex");
  return models
    .filter((model) => model.provider === "codex" && !model.id.includes("["))
    .map((model) => model.id)
    .sort(
      (left, right) =>
        Number(right === preferred) - Number(left === preferred) || codexVersion(right) - codexVersion(left),
    );
}

function accountOf(agent: AgentSummary): string {
  return agent.providerAccountId ?? DEFAULT_PROVIDER_ACCOUNT_ID;
}

/**
 * The `GuardrailsRuntime` of the agent service: the reads and actions the guardrails need, built from
 * the service's stores and controllers. It holds no state.
 */
export function guardrailsRuntime(options: GuardrailsRuntimeOptions): GuardrailsRuntime {
  const agents = () => options.store.list();
  const agent = (agentId: string) => agents().find((candidate) => candidate.id === agentId);
  return {
    agents,
    spaceOf: (agentId) => options.store.spaces.agentSpaceId(agentId),
    dailyTotals: (since) => options.store.database.usage.dailyTotals(since),
    turnTotals: (agentId, turnId, since) => options.store.database.usage.readTurnTotals(agentId, turnId, since),
    costsSince: (since, provider) => options.store.database.usage.costsSince(since, provider),
    meterAccounts: () => {
      const status = options.status();
      const list = agents();
      const accounts: MeterAccount[] = [];
      for (const provider of AGENT_PROVIDERS) {
        const row = status.providers?.find((candidate) => candidate.id === provider);
        if (row?.state !== "available") continue;
        const pool = options.poolOf(provider);
        for (const { accountId, limit } of options.usageAccounts(provider)) {
          const users = list.filter((item) => item.provider === provider && accountOf(item) === accountId).length;
          const windows = [limit?.primary, limit?.secondary].filter(
            (window) => window !== null && window !== undefined,
          );
          if (windows.length === 0 && users === 0) continue;
          const account = row.accounts?.find((candidate) => candidate.id === accountId);
          const pooled = pool !== null && !pool.leftOut.includes(accountId);
          accounts.push({
            provider,
            accountId,
            label:
              account?.label ??
              account?.email ??
              (accountId === DEFAULT_PROVIDER_ACCOUNT_ID ? (row.email ?? undefined) : undefined),
            pooled,
            inUse: pooled ? pool?.inUse === accountId : users > 0,
            windows,
            credits: limit?.credits ?? null,
            ordinaryUsageAllowed: limit?.ordinaryUsageAllowed,
            resetCredits: limit?.resetCredits,
            agents: users,
          });
        }
      }
      return accounts;
    },
    agentAccount: (agentId) => {
      const found = agent(agentId);
      return found ? { provider: found.provider, accountId: accountOf(found) } : null;
    },
    turnTask: (agentId, turnId) =>
      options.mailbox.findDeliveriesByTurn(agentId, turnId).map((context) => {
        const { sender, text } = context.delivery;
        const from =
          sender.kind === "user"
            ? "owner"
            : sender.kind === "agent"
              ? `teammate ${agent(sender.agentId)?.name ?? sender.agentId}`
              : `routine ${sender.routineName}`;
        const untrusted = context.eventCheck
          ? ("event-check" as const)
          : context.notice === "inbound-email"
            ? ("email" as const)
            : sender.kind === "routine" && options.routineTrigger(agentId, sender.routineId) === "webhook"
              ? ("webhook" as const)
              : null;
        return { from, text, untrusted };
      }),
    steer: (agentId, threadId, turnId, text) =>
      Effect.suspend(() => {
        const found = agent(agentId);
        const client = found ? options.clientFor(found) : null;
        if (!client) return Effect.succeed(false);
        return client
          .request(
            "turn/steer",
            { threadId, expectedTurnId: turnId, clientUserMessageId: randomUUID(), input: [{ type: "text", text }] },
            decodeRecordResponse,
          )
          .pipe(
            Effect.as(true),
            Effect.catchCause(() => Effect.succeed(false)),
          );
      }),
    interrupt: (agentId, threadId, turnId) =>
      Effect.suspend(() => {
        // A turn of a task or a channel runs in a thread of its own, which the stop must name.
        const publicThread = threadId ? options.publicThread(agentId, threadId) : null;
        const own = publicThread === null || publicThread === agent(agentId)?.threadId;
        return options
          .interrupt(agentId, turnId, own ? undefined : publicThread)
          .pipe(
            Effect.catchCause((cause) =>
              Effect.sync(() => logger.warn("A guardrail stop failed.", { agentId, cause: toLogValue(cause) })),
            ),
          );
      }),
    scheduleDrain: (agentId) => options.scheduleDrain(agentId),
    generateCheap: (prompt) => options.generateCheap(prompt),
    notifyOwner: (agentId, title, detail) => {
      try {
        options.ownerAway?.hold({ agentId, kind: "fyi", title, detail });
      } catch (error) {
        logger.warn("A guardrail notice could not be held for the owner.", { agentId, error: toLogValue(error) });
      }
    },
    alertOwner: (agentId, category) => {
      options.ownerAway?.alert({ agentId, category });
    },
    noteAgent: (agentId, text) => options.noteAgent(agentId, text),
    recordTrust: (entry) => options.recordTrust(entry),
    failoverTargets: (target, allowApiKey) => {
      const models = options.models();
      const choices: AgentModelChoice[] = [];
      if (target.provider === "claude") {
        for (const model of codexFailoverModels(models)) choices.push({ provider: "codex", model });
        if (allowApiKey)
          choices.push({ provider: "claude", model: target.model, providerAccountId: CLAUDE_API_KEY_ACCOUNT_ID });
      }
      // A Codex agent stays on Codex: Codex spends the account's credits by itself once the plan is used
      // up, so its order is the Codex plan, then the Codex credits.
      return choices.filter((choice) => options.modelReady(choice));
    },
    changed: () => options.changed(),
  };
}
