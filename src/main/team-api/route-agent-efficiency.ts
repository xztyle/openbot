import {
  parseDecidePlaybookProposalInput,
  parseDecideReviewProposalInput,
  parseImportRolePlaybookInput,
  parsePerformanceReviewsInput,
  parseRemoveRolePlaybookInput,
  parseRunReviewInput,
  parseSaveRolePlaybookInput,
  parseSetAgentsSleepingInput,
} from "@openbot/contracts/agent-efficiency";
import {
  AGENT_EFFICIENCY_CAPABILITY,
  AGENT_EFFICIENCY_ROUTES,
} from "@openbot/contracts/team-protocol/agent-efficiency-v1";
import { sourceText } from "@openbot/i18n/source";
import { runCauseEffect } from "../../backend/effect-boundary";
import type { TeamApiAgents } from "./dependencies";
import { HttpError } from "./http-error";
import type { RouteOutcome, TeamApiRequestContext } from "./request-context";
import { readJson, requireAdmin } from "./request-helpers";

function parsed<T>(parse: (value: unknown) => T, value: unknown): T {
  try {
    return parse(value);
  } catch {
    throw new HttpError(400, "Invalid request.");
  }
}

/** A refusal of the request itself, such as a playbook name that exists, answers 409 with its text. */
async function refused<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof HttpError) throw error;
    const message = error instanceof Error ? error.message : String(error);
    throw new HttpError(409, message.slice(0, 500) || "The request was refused.");
  }
}

/**
 * The sleep, model savings, review and playbook routes of this fork (`agent-efficiency-v1.ts`, under
 * `fork-host-v1`). They change or read every agent of the server, so they are for owners and admins.
 */
export async function routeAgentEfficiency(
  context: TeamApiRequestContext,
  agents: TeamApiAgents,
  hiddenAgentIds: ReadonlySet<string>,
): Promise<RouteOutcome> {
  const { method, url, capabilities, member, request, json } = context;
  if (method !== "POST" || !Object.values(AGENT_EFFICIENCY_ROUTES).some((route) => route === url.pathname))
    return "unmatched";
  const { setAgentsSleeping, modelSavings, playbooks, reviews } = agents;
  if (!capabilities.has(AGENT_EFFICIENCY_CAPABILITY) || !setAgentsSleeping || !modelSavings || !playbooks || !reviews)
    throw new HttpError(400, sourceText("error.team.workspaceUnsupported"));
  requireAdmin(member);
  // `readJson` has already run the body through the wire codec.
  const body = await readJson(request);
  const visible = (agentId: string) => !hiddenAgentIds.has(agentId);
  switch (url.pathname) {
    case AGENT_EFFICIENCY_ROUTES.sleep: {
      const input = parsed(parseSetAgentsSleepingInput, body);
      if (input.target.kind !== "space" && !visible(input.target.id)) throw new HttpError(404, "Unknown agent.");
      const result = await refused(() => runCauseEffect(setAgentsSleeping.call(agents, input)));
      return json(200, {
        changedAgentIds: result.changedAgentIds.filter(visible),
        sleepingAgentIds: result.sleepingAgentIds.filter(visible),
      });
    }
    case AGENT_EFFICIENCY_ROUTES.modelSavings:
      return json(200, modelSavings.call(agents));
    case AGENT_EFFICIENCY_ROUTES.reviews: {
      const input = parsed(parsePerformanceReviewsInput, body);
      if (input.enabled !== undefined) await runCauseEffect(reviews.setEnabled(input.enabled));
      const page = await runCauseEffect(reviews.list(input));
      return json(200, { reviews: page.reviews.filter((review) => visible(review.agentId)), enabled: page.enabled });
    }
    case AGENT_EFFICIENCY_ROUTES.runReview: {
      const input = parsed(parseRunReviewInput, body);
      if (!visible(input.agentId)) throw new HttpError(404, "Unknown agent.");
      return json(200, { review: await refused(() => runCauseEffect(reviews.run(input.agentId))) });
    }
    case AGENT_EFFICIENCY_ROUTES.decideReview: {
      const input = parsed(parseDecideReviewProposalInput, body);
      return json(200, await refused(() => runCauseEffect(reviews.decide(input))));
    }
    case AGENT_EFFICIENCY_ROUTES.playbooks:
      return json(200, await runCauseEffect(playbooks.snapshot()));
    case AGENT_EFFICIENCY_ROUTES.savePlaybook: {
      const input = parsed(parseSaveRolePlaybookInput, body);
      return json(200, await refused(() => runCauseEffect(playbooks.save(input))));
    }
    case AGENT_EFFICIENCY_ROUTES.importPlaybook: {
      const input = parsed(parseImportRolePlaybookInput, body);
      if (!visible(input.agentId)) throw new HttpError(404, "Unknown agent.");
      return json(200, await refused(() => runCauseEffect(playbooks.importFromAgent(input))));
    }
    case AGENT_EFFICIENCY_ROUTES.removePlaybook: {
      const input = parsed(parseRemoveRolePlaybookInput, body);
      return json(200, await refused(() => runCauseEffect(playbooks.remove(input.id))));
    }
    default: {
      const input = parsed(parseDecidePlaybookProposalInput, body);
      return json(200, await refused(() => runCauseEffect(playbooks.decide(input))));
    }
  }
}
