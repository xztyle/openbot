import { decodeEventCheckInput, decodeEventCheckTarget } from "@openbot/contracts/event-checks";
import { isDynamicRecord } from "@openbot/contracts/runtime-values";
import { EVENT_CHECK_API_CAPABILITY } from "@openbot/contracts/team-protocol/event-check-api-v1";
import {
  EVENT_CHECKS_CAPABILITY,
  EVENT_CHECKS_CODECS,
  EVENT_CHECKS_ROUTES,
} from "@openbot/contracts/team-protocol/event-checks-v1";
import { sourceText } from "@openbot/i18n/source";
import { runCauseEffect } from "../../backend/effect-boundary";
import type { EventCheckScheduler } from "../../backend/event-check-scheduler";
import { HttpError } from "./http-error";
import type { RouteOutcome, TeamApiRequestContext } from "./request-context";
import { readJson, requireAdmin } from "./request-helpers";
import { routeEventCheckApi } from "./route-event-check-api";
export async function routeEventChecks(
  context: TeamApiRequestContext,
  checks?: EventCheckScheduler,
): Promise<RouteOutcome> {
  if ((await routeEventCheckApi(context, checks)) === "handled") return "handled";
  const codec = EVENT_CHECKS_CODECS.get(context.url.pathname);
  if (context.method !== "POST" || !codec) return "unmatched";
  requireAdmin(context.member);
  if (!checks?.supported || !context.capabilities.has(EVENT_CHECKS_CAPABILITY))
    throw new HttpError(400, sourceText("error.backend.eventCheckUnsupported"));
  const body = codec.request(await readJson(context.request));
  if (!isDynamicRecord(body) || typeof body.agentId !== "string")
    throw new HttpError(400, sourceText("error.backend.eventCheckFailed"));
  if (
    [EVENT_CHECKS_ROUTES.remove, EVENT_CHECKS_ROUTES.history, EVENT_CHECKS_ROUTES.checkNow].some(
      (path) => path === context.url.pathname,
    )
  ) {
    const target = decodeEventCheckTarget(body);
    const check = (await runCauseEffect(checks.list({ agentId: target.agentId }))).find(
      (entry) => entry.id === target.id,
    );
    if (check?.source.kind !== "mcp") throw new HttpError(400, sourceText("error.backend.eventCheckUnsupported"));
  }
  let result: unknown;
  switch (context.url.pathname) {
    case EVENT_CHECKS_ROUTES.list:
      result = (await runCauseEffect(checks.list({ agentId: body.agentId }))).filter(
        (check) => check.source.kind === "mcp",
      );
      break;
    case EVENT_CHECKS_ROUTES.accounts:
      result = await runCauseEffect(checks.accounts({ agentId: body.agentId }));
      break;
    case EVENT_CHECKS_ROUTES.save:
      result = await runCauseEffect(checks.save(decodeEventCheckInput(body)));
      break;
    case EVENT_CHECKS_ROUTES.tools:
      if (typeof body.connectionId !== "string") throw new HttpError(400, sourceText("error.mcp.chatDenied"));
      result = await runCauseEffect(checks.tools({ agentId: body.agentId, connectionId: body.connectionId }));
      break;
    case EVENT_CHECKS_ROUTES.remove:
      await runCauseEffect(checks.remove(decodeEventCheckTarget(body)));
      result = null;
      break;
    case EVENT_CHECKS_ROUTES.history:
      result = await runCauseEffect(checks.history(decodeEventCheckTarget(body)));
      break;
    case EVENT_CHECKS_ROUTES.checkNow:
      result = await runCauseEffect(checks.checkNow(decodeEventCheckTarget(body)));
      break;
    default:
      return "unmatched";
  }
  const encoded = codec.response(200, result);
  if (encoded !== null && typeof encoded !== "object")
    throw new HttpError(400, sourceText("error.backend.eventCheckFailed"));
  return context.json(200, encoded);
}

export function eventCheckCapability(capability: string, checks?: EventCheckScheduler): boolean | undefined {
  if (capability === EVENT_CHECK_API_CAPABILITY) return checks?.apiSupported === true;
  if (capability === EVENT_CHECKS_CAPABILITY) return checks?.supported === true;
  return undefined;
}
