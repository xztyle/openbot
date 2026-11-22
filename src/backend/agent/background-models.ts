import { type AgentModelOption, type AgentProviderId, defaultProviderModel } from "@openbot/contracts/ipc";
import { modelTier } from "./model-policy";

/**
 * The models of the host's background helpers that work beside an agent: the independent grader of
 * its Motion tickets, and the sub-agents of a wide research run. Each answers candidates in order;
 * the caller takes the first whose provider starts.
 */

type Listed = readonly AgentModelOption[];

function usable(models: Listed, provider: AgentProviderId): AgentModelOption[] {
  return models.filter((model) => model.provider === provider && !model.id.includes("["));
}

/** The newest listed model of a tier, by id. */
function newest(models: Listed, provider: AgentProviderId, tier: "small" | "medium" | "large") {
  return usable(models, provider)
    .filter((model) => modelTier(model.id) === tier)
    .sort((left, right) => right.id.localeCompare(left.id))[0];
}

function providerDefault(models: Listed, provider: AgentProviderId): AgentModelOption | undefined {
  const listed = usable(models, provider);
  return listed.find((model) => model.id === defaultProviderModel(provider)) ?? listed[0];
}

/**
 * Who grades a ticket of `agent`. An ordinary ticket: the workspace's cheap gate model. An important
 * one (high priority or about money): the other vendor, so the grader does not share the worker's
 * blind spots - Codex for a Claude agent and Claude for any other - and when that vendor is not
 * there, a Claude model other than the agent's own. Last, the default model of the agent's provider.
 */
export function reviewJudgeCandidates(
  agent: { provider: AgentProviderId; model: string },
  important: boolean,
  models: Listed,
  gate: { provider: string; model: string },
): AgentModelOption[] {
  const out: AgentModelOption[] = [];
  const add = (model: AgentModelOption | undefined) => {
    if (model && !out.some((entry) => entry.provider === model.provider && entry.id === model.id)) out.push(model);
  };
  if (important) {
    if (agent.provider === "codex") add(newest(models, "claude", "medium") ?? providerDefault(models, "claude"));
    else add(providerDefault(models, "codex"));
    const ownTier = agent.provider === "claude" ? modelTier(agent.model) : null;
    const fallbackTier = ownTier === "medium" ? "large" : "medium";
    const other = (model: AgentModelOption | undefined) => (model && model.id !== agent.model ? model : undefined);
    add(other(newest(models, "claude", fallbackTier)));
    add(other(newest(models, "claude", fallbackTier === "medium" ? "large" : "medium")));
  }
  add(models.find((model) => model.provider === gate.provider && model.id === gate.model));
  add(newest(models, "claude", "small"));
  // A host with one vendor only: the agent's own provider still grades in a fresh context.
  add(providerDefault(models, agent.provider));
  return out;
}

/** The models of a wide research run: Claude Haiku or Sonnet, else Codex's own default. */
export function fanoutCandidates(tier: "small" | "medium", models: Listed): AgentModelOption[] {
  const out = [newest(models, "claude", tier), newest(models, "claude", tier === "small" ? "medium" : "small")];
  out.push(providerDefault(models, "codex"));
  return out.filter((model): model is AgentModelOption => model !== undefined);
}
