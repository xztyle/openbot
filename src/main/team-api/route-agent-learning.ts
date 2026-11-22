import {
  parseAgentIdInput,
  parseDecideLearningInput,
  parseDecideQueueEntryInput,
  parseForgetConversationInput,
  parseLearningReviewsInput,
  parseRemoveSpaceKnowledgeInput,
  parseRollbackInput,
  parseSpaceKnowledgeInput,
} from "@openbot/contracts/agent-learning";
import { isDynamicRecord } from "@openbot/contracts/runtime-values";
import { AGENT_EFFICIENCY_CAPABILITY } from "@openbot/contracts/team-protocol/agent-efficiency-v1";
import { AGENT_LEARNING_ROUTES } from "@openbot/contracts/team-protocol/agent-learning-v1";
import { sourceText } from "@openbot/i18n/source";
import { Effect, Result } from "effect";
import { decisionQueue } from "../../backend/agent-learning/decision-queue";
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

/** Runs the effect; a failure, or the error that a typed failure wraps, answers 409 with its text. */
async function refused<A>(effect: Effect.Effect<A, unknown>): Promise<A> {
  let failure: unknown;
  try {
    const result = await Effect.runPromise(Effect.result(effect));
    if (Result.isSuccess(result)) return result.success;
    failure = result.failure;
  } catch (error) {
    failure = error;
  }
  if (failure instanceof HttpError) throw failure;
  const inner = isDynamicRecord(failure) && failure.cause instanceof Error ? failure.cause : failure;
  const message = inner instanceof Error ? inner.message : String(inner);
  throw new HttpError(409, message.slice(0, 500) || "The request was refused.");
}

/**
 * The learning routes of this fork (`agent-learning-v1.ts`, under `fork-host-v1`): the review items of
 * the nightly cleanup and the task lessons, the decision queue of every proposal, each agent's settings
 * history and its rollback, the knowledge of each space and the forget of one chat. Owners and admins.
 */
export async function routeAgentLearning(
  context: TeamApiRequestContext,
  agents: TeamApiAgents,
  hiddenAgentIds: ReadonlySet<string>,
): Promise<RouteOutcome> {
  const { method, url, capabilities, member, request, json } = context;
  if (method !== "POST" || !Object.values(AGENT_LEARNING_ROUTES).some((route) => route === url.pathname))
    return "unmatched";
  const { learning, settingsHistory, rollbackSettings, forgetConversation, playbooks, reviews } = agents;
  if (
    !capabilities.has(AGENT_EFFICIENCY_CAPABILITY) ||
    !learning ||
    !settingsHistory ||
    !rollbackSettings ||
    !forgetConversation
  )
    throw new HttpError(400, sourceText("error.team.workspaceUnsupported"));
  requireAdmin(member);
  const body = await readJson(request);
  const visible = (agentId: string | null) => agentId === null || !hiddenAgentIds.has(agentId);
  const requireVisible = (agentId: string) => {
    if (!visible(agentId)) throw new HttpError(404, "Unknown agent.");
  };
  switch (url.pathname) {
    case AGENT_LEARNING_ROUTES.reviews: {
      const input = parsed(parseLearningReviewsInput, body);
      const page = await refused(learning.list(input));
      return json(200, { items: page.items.filter((item) => visible(item.agentId)), settings: page.settings });
    }
    case AGENT_LEARNING_ROUTES.decide: {
      const input = parsed(parseDecideLearningInput, body);
      return json(200, { item: await refused(learning.decide(input)) });
    }
    case AGENT_LEARNING_ROUTES.dream: {
      const input = parsed(parseAgentIdInput, body);
      requireVisible(input.agentId);
      return json(200, { items: await refused(learning.dreamAgent(input.agentId, true)) });
    }
    case AGENT_LEARNING_ROUTES.queue: {
      const items = await refused(learning.pending());
      const snapshot = playbooks ? await refused(playbooks.snapshot()) : null;
      const page = reviews ? await refused(reviews.list({ pendingOnly: true })) : { reviews: [] };
      const entries = decisionQueue({
        items,
        playbooks: snapshot,
        reviews: page.reviews,
        agentSpace: (agentId) => learning.spaceOf(agentId),
        agentName: (agentId) => learning.agentName(agentId),
      });
      return json(200, { entries: entries.filter((entry) => visible(entry.agentId)) });
    }
    case AGENT_LEARNING_ROUTES.decideQueue: {
      const input = parsed(parseDecideQueueEntryInput, body);
      const separator = input.id.indexOf(":");
      const source = input.id.slice(0, separator);
      const id = input.id.slice(separator + 1);
      if (source === "learning")
        await refused(learning.decide({ itemId: id, decision: input.decision === "approve" ? "accept" : "dismiss" }));
      else if (source === "playbook") {
        if (!playbooks) throw new HttpError(400, sourceText("error.team.workspaceUnsupported"));
        await refused(playbooks.decide({ proposalId: id, decision: input.decision }));
      } else {
        if (!reviews) throw new HttpError(400, sourceText("error.team.workspaceUnsupported"));
        await refused(reviews.decide({ reviewId: id, decision: input.decision }));
      }
      return json(200, { ok: true });
    }
    case AGENT_LEARNING_ROUTES.history: {
      const input = parsed(parseAgentIdInput, body);
      requireVisible(input.agentId);
      return json(200, { checkpoints: await refused(settingsHistory.list(input.agentId)) });
    }
    case AGENT_LEARNING_ROUTES.rollback: {
      const input = parsed(parseRollbackInput, body);
      const checkpoint = await refused(settingsHistory.get(input.checkpointId));
      if (!checkpoint) throw new HttpError(404, "Unknown checkpoint.");
      requireVisible(checkpoint.agentId);
      const result = await refused(agents.rollbackSettings?.(input.checkpointId) ?? Effect.succeed(null));
      if (!result) throw new HttpError(409, "Nothing changed.");
      return json(200, { checkpoint: result });
    }
    case AGENT_LEARNING_ROUTES.knowledge: {
      const input = parsed(parseSpaceKnowledgeInput, body);
      return json(200, await refused(learning.knowledge.snapshot(input.spaceId, input.query)));
    }
    case AGENT_LEARNING_ROUTES.removeKnowledge: {
      const input = parsed(parseRemoveSpaceKnowledgeInput, body);
      await refused(learning.knowledge.remove(input));
      return json(200, await refused(learning.knowledge.snapshot(input.spaceId)));
    }
    default: {
      const input = parsed(parseForgetConversationInput, body);
      requireVisible(input.agentId);
      return json(200, await refused(agents.forgetConversation?.(input) ?? Effect.die("unsupported")));
    }
  }
}
