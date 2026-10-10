import {
  decodeEventCheckDiscoverCheckInput,
  decodeEventCheckTemplateAdoptInput,
  decodeEventCheckTemplateDiscoverInput,
  decodeEventCheckTemplateInstallInput,
} from "@openbot/contracts/event-check-templates";
import { decodeEventCheckTarget } from "@openbot/contracts/event-checks";
import {
  EVENT_CHECK_TEMPLATES_CAPABILITY,
  EVENT_CHECK_TEMPLATES_CODECS,
  EVENT_CHECK_TEMPLATES_ROUTES,
} from "@openbot/contracts/team-protocol/event-check-templates-v1";
import { sourceText } from "@openbot/i18n/source";
import { runCauseEffect } from "../../backend/effect-boundary";
import { EventCheckRefusal } from "../../backend/event-check-refusal";
import type { EventCheckScheduler } from "../../backend/event-check-scheduler";
import { memberActor } from "../../backend/security-actor";
import { HttpError } from "./http-error";
import type { RouteOutcome, TeamApiRequestContext } from "./request-context";
import { readJson, requireAdmin } from "./request-helpers";

export async function routeEventCheckTemplates(
  context: TeamApiRequestContext,
  checks?: EventCheckScheduler,
): Promise<RouteOutcome> {
  const codec = EVENT_CHECK_TEMPLATES_CODECS.get(context.url.pathname);
  if (context.method !== "POST" || !codec) return "unmatched";
  requireAdmin(context.member);
  if (!checks?.templatesSupported || !context.capabilities.has(EVENT_CHECK_TEMPLATES_CAPABILITY))
    throw new HttpError(400, sourceText("error.backend.eventCheckUnsupported"));
  const body = codec.request(await readJson(context.request));
  let result: unknown;
  switch (context.url.pathname) {
    case EVENT_CHECK_TEMPLATES_ROUTES.list:
      result = await runCauseEffect(checks.templateList());
      break;
    case EVENT_CHECK_TEMPLATES_ROUTES.install:
      result = await runCauseEffect(
        checks.templateInstall(decodeEventCheckTemplateInstallInput(body), memberActor(context.member)),
      );
      break;
    case EVENT_CHECK_TEMPLATES_ROUTES.update:
      result = await runCauseEffect(checks.templateUpdate(decodeEventCheckTarget(body), memberActor(context.member)));
      break;
    case EVENT_CHECK_TEMPLATES_ROUTES.adopt:
      result = await runCauseEffect(
        checks.templateAdopt(decodeEventCheckTemplateAdoptInput(body), memberActor(context.member)),
      );
      break;
    case EVENT_CHECK_TEMPLATES_ROUTES.discover:
    case EVENT_CHECK_TEMPLATES_ROUTES.discoverCheck:
      // The body can hold private values the user typed. Only its decoded fields are used, and a
      // failure answers with a fixed text: a refusal's message, never program output.
      try {
        result = await runCauseEffect(
          context.url.pathname === EVENT_CHECK_TEMPLATES_ROUTES.discover
            ? checks.templateDiscover(decodeEventCheckTemplateDiscoverInput(body), memberActor(context.member))
            : checks.discoverCheck(decodeEventCheckDiscoverCheckInput(body), memberActor(context.member)),
        );
      } catch (error) {
        if (error instanceof EventCheckRefusal) throw new HttpError(400, error.message);
        throw error;
      }
      break;
    default:
      return "unmatched";
  }
  const encoded = codec.response(200, result);
  if (encoded !== null && typeof encoded !== "object")
    throw new HttpError(400, sourceText("error.backend.eventCheckFailed"));
  return context.json(200, encoded);
}
