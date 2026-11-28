// @vitest-environment node
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GuardrailChainChoice, GuardrailPolicy } from "@openbot/contracts/guardrails";
import type { AgentModelChoice, AgentModelOption, AgentReasoningEffort } from "@openbot/contracts/ipc";
import { Effect } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isPlanLimitDiagnostic, isUsageLimitDiagnostic } from "../agent/provider-diagnostics";
import { GuardrailEventLog } from "./guardrail-event-log";
import { codexFailoverModels } from "./guardrails-runtime";
import { type GuardrailAgent, type GuardrailsRuntime, GuardrailsService } from "./guardrails-service";
import type { MeterAccount } from "./subscription-meter";

const NOW = Date.UTC(2026, 10, 25, 12, 0, 0);
const IN_THREE_HOURS = NOW / 1000 + 3 * 3600;

function model(id: string, efforts: AgentReasoningEffort[]): AgentModelOption {
  return {
    provider: "codex",
    id,
    name: id,
    description: "",
    defaultReasoningEffort: "medium",
    supportedReasoningEfforts: efforts,
  };
}

/** The Codex models that the live host listed on 2026-11-25, in Codex's own order. */
const CODEX_MODELS = [
  model("gpt-6-luna", ["low", "medium", "high", "xhigh", "max"]),
  model("gpt-5.6-terra", ["low", "medium", "high", "xhigh", "max"]),
  model("gpt-5.6-luna", ["low", "medium", "high", "xhigh", "max"]),
];

const OPUS: GuardrailAgent = {
  id: "agent-opus",
  name: "Opus agent",
  provider: "claude",
  model: "claude-opus-5-5",
  threadId: "thread-opus",
};

const CODEX_AGENT: GuardrailAgent = {
  id: "agent-codex",
  name: "Codex agent",
  provider: "codex",
  model: "gpt-6-luna",
  threadId: "thread-codex",
};

function window(usedPercent: number) {
  return { usedPercent, windowDurationMins: 300, resetsAt: IN_THREE_HOURS };
}

interface Accounts {
  claudeUsed: number;
  codexUsed: number;
  codexCredits: { hasCredits: boolean; unlimited: boolean; balance: number | null } | null;
  codexOrdinaryAllowed?: boolean;
}

describe("the subscription failover", () => {
  let directory: string;
  let service: GuardrailsService;
  let accounts: Accounts;
  let notices: string[];

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "guardrails-failover-"));
    accounts = { claudeUsed: 40, codexUsed: 10, codexCredits: null };
    notices = [];
    service = new GuardrailsService({
      file: join(directory, "guardrails-v1.json"),
      events: new GuardrailEventLog(join(directory, "events")),
      now: () => NOW,
    });
    const meterAccounts = (): MeterAccount[] => [
      {
        provider: "claude",
        accountId: "default",
        pooled: false,
        inUse: true,
        windows: [window(accounts.claudeUsed)],
        agents: 1,
      },
      {
        provider: "codex",
        accountId: "default",
        pooled: false,
        inUse: false,
        windows: [window(accounts.codexUsed)],
        credits: accounts.codexCredits,
        ordinaryUsageAllowed: accounts.codexOrdinaryAllowed,
        resetCredits: 1,
        agents: 0,
      },
    ];
    const runtime: GuardrailsRuntime = {
      agents: () => [OPUS, CODEX_AGENT],
      spaceOf: () => "space",
      dailyTotals: () => [],
      turnTotals: () => null,
      costsSince: () => new Map(),
      meterAccounts,
      agentAccount: (agentId) =>
        agentId === OPUS.id
          ? { provider: "claude", accountId: "default" }
          : agentId === CODEX_AGENT.id
            ? { provider: "codex", accountId: "default" }
            : null,
      turnTask: () => [],
      steer: () => Effect.succeed(false),
      interrupt: () => Effect.void,
      scheduleDrain: () => undefined,
      generateCheap: () => Effect.succeed(""),
      notifyOwner: (_agentId, title) => {
        notices.push(title);
      },
      alertOwner: () => undefined,
      noteAgent: () => undefined,
      recordTrust: () => undefined,
      // As the host builds them: Codex's default model first, then the newest.
      failoverTargets: (agent, _allowApiKey, chain): AgentModelChoice[] =>
        chain?.length
          ? chain.map((step) => ({ provider: step.provider, model: step.model }))
          : agent.provider === "claude"
            ? codexFailoverModels(CODEX_MODELS).map((id) => ({ provider: "codex", model: id }))
            : [],
      changed: () => undefined,
    };
    service.connect(runtime);
  });

  afterEach(() => {
    service.dispose();
    rmSync(directory, { recursive: true, force: true });
  });

  it("moves an Opus agent to Codex's default model after the Claude CLI's usage-limit error", () => {
    // The Claude CLI's own words when the plan window is spent. The host holds the model on them.
    const cliError = "You've hit your session limit · resets 8:40pm";
    expect(isUsageLimitDiagnostic(cliError)).toBe(true);
    expect(isPlanLimitDiagnostic(cliError)).toBe(true);

    // The meter still shows room, so only the real limit moves the agent, not a forecast.
    expect(service.failoverChoice(OPUS)).toBeNull();
    expect(service.failoverChoice(OPUS, { limited: true })).toEqual({ provider: "codex", model: "gpt-6-luna" });
    expect(service.view().steps).toEqual([
      { agentId: OPUS.id, step: "claude" },
      { agentId: CODEX_AGENT.id, step: "codex-plan" },
    ]);
  });

  it("moves at 100% on the meter, and not before", async () => {
    expect(service.policy().failover).toMatchObject({ thresholdPercent: 100, tiers: ["medium", "large"] });
    accounts.claudeUsed = 99;
    expect(service.failoverChoice(OPUS)).toBeNull();
    accounts.claudeUsed = 100;
    // A saved policy reads the meter again at once.
    await Effect.runPromise(service.savePolicy({ ...service.policy() }));
    expect(service.failoverChoice(OPUS)).toEqual({ provider: "codex", model: "gpt-6-luna" });
  });

  it("counts a Codex plan that is used up as usable while credits remain", async () => {
    accounts.claudeUsed = 100;
    // As the live account reads: Codex says the plan's own usage is no longer allowed.
    accounts.codexUsed = 60;
    accounts.codexOrdinaryAllowed = false;
    accounts.codexCredits = { hasCredits: true, unlimited: false, balance: 62_424.27 };
    await Effect.runPromise(service.savePolicy({ ...service.policy() }));

    const codex = service.view().meter.find((row) => row.provider === "codex");
    expect(codex).toMatchObject({
      nearlyExhausted: false,
      onCredits: true,
      creditsLeft: true,
      creditBalance: 62_424,
      resetCredits: 1,
    });
    expect(service.failoverChoice(OPUS, { limited: true })).toEqual({ provider: "codex", model: "gpt-6-luna" });
    // A Codex agent stays on Codex at its own limit and runs on the credits: it never moves to Claude.
    expect(service.failoverChoice(CODEX_AGENT, { limited: true })).toBeNull();
    expect(service.view().steps).toEqual([
      { agentId: OPUS.id, step: "codex-credits" },
      { agentId: CODEX_AGENT.id, step: "codex-credits" },
    ]);
    expect(notices).toEqual([]);
  });

  it("keeps the agent waiting and tells the owner once when nothing is left", async () => {
    accounts.claudeUsed = 100;
    accounts.codexUsed = 100;
    accounts.codexCredits = { hasCredits: false, unlimited: false, balance: 0 };
    await Effect.runPromise(service.savePolicy({ ...service.policy() }));

    const codex = service.view().meter.find((row) => row.provider === "codex");
    expect(codex).toMatchObject({ nearlyExhausted: true, onCredits: false, creditsLeft: false });
    expect(service.failoverChoice(OPUS, { limited: true })).toBeNull();
    expect(service.failoverChoice(OPUS, { limited: true })).toBeNull();
    expect(notices).toEqual(["Opus agent has no subscription left"]);
    expect(service.view().steps).toEqual([
      { agentId: OPUS.id, step: "none" },
      { agentId: CODEX_AGENT.id, step: "none" },
    ]);
  });
});

describe("the Codex model of a failover", () => {
  it("is Codex's default model for every tier, else the newest listed model", () => {
    expect(codexFailoverModels(CODEX_MODELS)[0]).toBe("gpt-6-luna");
    expect(codexFailoverModels(CODEX_MODELS.filter((option) => option.id !== "gpt-6-luna"))[0]).toBe("gpt-5.6-terra");
  });
});

describe("the fallback order and the provider switch", () => {
  let directory: string;
  let service: GuardrailsService;
  let codexUsed = 10;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "guardrails-chain-"));
    codexUsed = 10;
    service = new GuardrailsService({
      file: join(directory, "guardrails-v1.json"),
      events: new GuardrailEventLog(join(directory, "events")),
      now: () => NOW,
    });
    service.connect({
      agents: () => [OPUS, CODEX_AGENT],
      spaceOf: () => "space",
      dailyTotals: () => [],
      turnTotals: () => null,
      costsSince: () => new Map(),
      meterAccounts: (): MeterAccount[] => [
        { provider: "claude", accountId: "default", pooled: false, inUse: true, windows: [window(100)], agents: 1 },
        {
          provider: "codex",
          accountId: "default",
          pooled: false,
          inUse: false,
          windows: [window(codexUsed)],
          agents: 0,
        },
      ],
      agentAccount: (id) => ({ provider: id === OPUS.id ? "claude" : "codex", accountId: "default" }),
      turnTask: () => [],
      steer: () => Effect.succeed(false),
      interrupt: () => Effect.void,
      scheduleDrain: () => undefined,
      generateCheap: () => Effect.succeed(""),
      notifyOwner: () => undefined,
      alertOwner: () => undefined,
      noteAgent: () => undefined,
      recordTrust: () => undefined,
      failoverTargets: (agent, _allowApiKey, chain): AgentModelChoice[] =>
        chain?.length
          ? chain.map((step) => ({ provider: step.provider, model: step.model }))
          : agent.provider === "claude"
            ? [{ provider: "codex", model: "gpt-6-luna" }]
            : [],
      changed: () => undefined,
    });
  });

  afterEach(() => {
    service.dispose();
    rmSync(directory, { recursive: true, force: true });
  });

  const save = (patch: Partial<GuardrailPolicy>) =>
    Effect.runPromise(service.savePolicy({ ...service.policy(), ...patch }));
  const codex = (model: string): GuardrailChainChoice => ({ provider: "codex", model });

  it("uses the order of the main model, else the default order, else the built-in one", async () => {
    expect(service.failoverChoice(OPUS)).toEqual(codex("gpt-6-luna"));
    await save({ failover: { ...service.policy().failover, chains: { default: [codex("gpt-5.6-terra")] } } });
    expect(service.failoverChoice(OPUS)).toEqual(codex("gpt-5.6-terra"));
    await save({
      failover: {
        ...service.policy().failover,
        chains: { default: [codex("gpt-5.6-terra")], byModel: { [OPUS.model]: [codex("gpt-5.6-luna")] } },
      },
    });
    expect(service.failoverChoice(OPUS)).toEqual(codex("gpt-5.6-luna"));
  });

  it("treats a provider that is off as out, and skips a target on it", async () => {
    await save({ disabledProviders: [{ provider: "codex" }] });
    expect(service.failoverChoice(OPUS)).toBeNull();
    await save({ disabledProviders: [{ provider: "claude", spaceId: "space" }] });
    expect(service.failoverChoice(CODEX_AGENT)).toBeNull();
    expect(service.failoverChoice(OPUS)).toEqual(codex("gpt-6-luna"));
    await save({ disabledProviders: [{ provider: "claude", spaceId: "other" }] });
    expect(service.holdsReturn(OPUS.id, { provider: "claude", model: OPUS.model })).toBe(false);
  });

  it("brings the provider back when the time passes, and is back after the expiry", async () => {
    await save({ disabledProviders: [{ provider: "codex", until: new Date(NOW + 60_000).toISOString() }] });
    expect(service.failoverChoice(OPUS)).toBeNull();
    await save({ disabledProviders: [{ provider: "codex", until: new Date(NOW - 60_000).toISOString() }] });
    expect(service.failoverChoice(OPUS)).toEqual(codex("gpt-6-luna"));
  });
});
