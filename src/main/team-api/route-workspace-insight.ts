import {
  parseWorkspaceInsightAction,
  parseWorkspaceInsightInput,
  parseWorkspaceWhySlowInput,
} from "@openbot/contracts/ipc";
import {
  WORKSPACE_INSIGHT_CAPABILITY,
  WORKSPACE_INSIGHT_ROUTES,
} from "@openbot/contracts/team-protocol/workspace-insight-v1";
import { sourceText } from "@openbot/i18n/source";
import { Effect, Result } from "effect";
import { InsightRefused, type InsightService } from "../../backend/insight/insight-service";
import { HttpError } from "./http-error";
import type { RouteOutcome, TeamApiRequestContext } from "./request-context";
import { readJson, requireAdmin } from "./request-helpers";

function parsed<T>(parse: (value: unknown) => T, value: unknown): T {
  try {
    return parse(value);
  } catch {
    throw new HttpError(400, "Invalid insight request.");
  }
}

/** Runs an insight operation; a refused change answers 409 with its reason. */
export async function runInsight<A>(operation: Effect.Effect<A, unknown>): Promise<A> {
  const result = await Effect.runPromise(Effect.result(operation));
  if (Result.isSuccess(result)) return result.success;
  if (result.failure instanceof InsightRefused) throw new HttpError(409, result.failure.message);
  throw result.failure instanceof Error ? result.failure : new Error("The insight operation failed.");
}

/**
 * The insight routes of this fork (`workspace-insight-v1.ts`, under `fork-host-v1`). The goals,
 * money, costs and briefing are the owner's and the admins': the money and every agent's cost are
 * in them. The timeline of a request is for any member who sees the agent.
 */
export async function routeWorkspaceInsight(
  context: TeamApiRequestContext,
  insight: InsightService | null | undefined,
  hiddenAgentIds: ReadonlySet<string>,
): Promise<RouteOutcome> {
  const { method, url, capabilities, member, request, json } = context;
  if (method !== "POST" || !Object.values(WORKSPACE_INSIGHT_ROUTES).some((route) => route === url.pathname))
    return "unmatched";
  if (!capabilities.has(WORKSPACE_INSIGHT_CAPABILITY) || !insight)
    throw new HttpError(400, sourceText("error.team.workspaceUnsupported"));
  // `readJson` has already run the body through the workspace-insight wire codec.
  const body = await readJson(request);
  if (url.pathname === WORKSPACE_INSIGHT_ROUTES.whySlow) {
    const input = parsed(parseWorkspaceWhySlowInput, body);
    if (hiddenAgentIds.has(input.agentId) || context.agentLevel(input.agentId) === "none")
      throw new HttpError(404, sourceText("error.agent.gone"));
    return json(200, insight.whySlow(input));
  }
  requireAdmin(member);
  if (url.pathname === WORKSPACE_INSIGHT_ROUTES.read)
    return json(200, await runInsight(insight.read(parsed(parseWorkspaceInsightInput, body))));
  return json(200, await runInsight(insight.apply(parsed(parseWorkspaceInsightAction, body))));
}
