import {
  decodeEventCheckEnvironmentInput,
  decodeEventCheckInput,
  decodeEventCheckTarget,
} from "@openbot/contracts/event-checks";
import { isDynamicRecord } from "@openbot/contracts/runtime-values";
import {
  EVENT_CHECK_API_CAPABILITY,
  EVENT_CHECK_API_CODECS,
  EVENT_CHECK_API_ROUTES,
} from "@openbot/contracts/team-protocol/event-check-api-v1";
import { sourceText } from "@openbot/i18n/source";
import { runCauseEffect } from "../../backend/effect-boundary";
import type { EventCheckScheduler } from "../../backend/event-check-scheduler";
import { HttpError } from "./http-error";
import type { RouteOutcome, TeamApiRequestContext } from "./request-context";
import { readJson, requireAdmin } from "./request-helpers";
export async function routeEventCheckApi(
  context: TeamApiRequestContext,
  checks?: EventCheckScheduler,
): Promise<RouteOutcome> {
  const codec = EVENT_CHECK_API_CODECS.get(context.url.pathname);
  if (context.method !== "POST" || !codec) return "unmatched";
  requireAdmin(context.member);
  if (!checks?.apiSupported || !context.capabilities.has(EVENT_CHECK_API_CAPABILITY))
    throw new HttpError(400, sourceText("error.backend.eventCheckUnsupported"));
  const body = codec.request(await readJson(context.request));
  if (!isDynamicRecord(body) || typeof body.agentId !== "string")
    throw new HttpError(400, sourceText("error.backend.eventCheckFailed"));
  let result: unknown;
  switch (context.url.pathname) {
    case EVENT_CHECK_API_ROUTES.environment:
      result = await runCauseEffect(checks.environment(decodeEventCheckTarget(body)));
      break;
    case EVENT_CHECK_API_ROUTES.setEnvironment:
      result = await runCauseEffect(checks.setEnvironment(decodeEventCheckEnvironmentInput(body)));
      break;
    case EVENT_CHECK_API_ROUTES.test:
      result = await runCauseEffect(checks.test(decodeEventCheckTarget(body)));
      break;
    case EVENT_CHECK_API_ROUTES.list:
      result = await runCauseEffect(checks.list({ agentId: body.agentId }));

      break;
    case EVENT_CHECK_API_ROUTES.accounts:
      result = await runCauseEffect(checks.accounts({ agentId: body.agentId }));
      break;
    case EVENT_CHECK_API_ROUTES.save:
      result = await runCauseEffect(checks.save(decodeEventCheckInput(body)));
      break;
    case EVENT_CHECK_API_ROUTES.tools:
      if (typeof body.connectionId !== "string") throw new HttpError(400, sourceText("error.mcp.chatDenied"));
      result = await runCauseEffect(checks.tools({ agentId: body.agentId, connectionId: body.connectionId }));
      break;
    case EVENT_CHECK_API_ROUTES.remove:
      await runCauseEffect(checks.remove(decodeEventCheckTarget(body)));
      result = null;
      break;
    case EVENT_CHECK_API_ROUTES.history:
      result = await runCauseEffect(checks.history(decodeEventCheckTarget(body)));
      break;
    case EVENT_CHECK_API_ROUTES.checkNow:
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
