import {
  decodeGuardrailPolicySave,
  decodeGuardrailResume,
  GUARDRAILS_CAPABILITY,
  GUARDRAILS_ROUTES,
} from "@openbot/contracts/team-protocol/guardrails-v1";
import { runCauseEffect } from "../../backend/effect-boundary";
import type { GuardrailsService } from "../../backend/guardrails/guardrails-service";
import { HttpError } from "./http-error";
import type { RouteOutcome, TeamApiRequestContext } from "./request-context";
import { readJson, requireAdmin } from "./request-helpers";

const ROUTES: ReadonlySet<string> = new Set(Object.values(GUARDRAILS_ROUTES));

/**
 * The guardrails routes of this fork (`guardrails-v1.ts`, under `fork-host-v1`): the view, the policy
 * save and the resume of a pause. Only the owner and the admins may read or change them.
 */
export async function routeGuardrails(
  context: TeamApiRequestContext,
  guardrails?: GuardrailsService,
): Promise<RouteOutcome> {
  const { url } = context;
  if (context.method !== "POST" || !ROUTES.has(url.pathname)) return "unmatched";
  requireAdmin(context.member);
  if (!guardrails || !context.capabilities.has(GUARDRAILS_CAPABILITY))
    throw new HttpError(404, "This host has no guardrails.");
  const body = await readJson(context.request);
  if (url.pathname === GUARDRAILS_ROUTES.view) return context.json(200, guardrails.view());
  if (url.pathname === GUARDRAILS_ROUTES.savePolicy) {
    let policy: ReturnType<typeof decodeGuardrailPolicySave>["policy"];
    try {
      policy = decodeGuardrailPolicySave(body).policy;
    } catch {
      throw new HttpError(400, "Invalid guardrails policy.");
    }
    return context.json(200, await runCauseEffect(guardrails.savePolicy(policy)));
  }
  let resume: ReturnType<typeof decodeGuardrailResume>;
  try {
    resume = decodeGuardrailResume(body);
  } catch {
    throw new HttpError(400, "Invalid guardrails resume.");
  }
  guardrails.resume(resume.scope, resume.id, context.member.name ?? context.member.username);
  return context.json(200, guardrails.view());
}
