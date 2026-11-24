import {
  decodeReopenApproval,
  decodeTrustAuditQuery,
  decodeTrustPolicySave,
  TRUST_CONTROL_CAPABILITY,
  TRUST_CONTROL_ROUTES,
} from "@openbot/contracts/team-protocol/trust-control-v1";
import { runCauseEffect } from "../../backend/effect-boundary";
import type { TrustService } from "../../backend/trust/trust-service";
import { HttpError } from "./http-error";
import type { RouteOutcome, TeamApiRequestContext } from "./request-context";
import { readJson, requireAdmin } from "./request-helpers";

const ROUTES: ReadonlySet<string> = new Set(Object.values(TRUST_CONTROL_ROUTES));

/**
 * The trust and control routes of this fork (`trust-control-v1.ts`, under `fork-host-v1`): the
 * policy, its save, and the audit trail. Only the owner and the admins may read or change them.
 */
export async function routeTrustControl(context: TeamApiRequestContext, trust?: TrustService): Promise<RouteOutcome> {
  const { url } = context;
  if (context.method !== "POST" || !ROUTES.has(url.pathname)) return "unmatched";
  requireAdmin(context.member);
  if (!trust || !context.capabilities.has(TRUST_CONTROL_CAPABILITY))
    throw new HttpError(404, "This host has no trust policy.");
  const body = await readJson(context.request);
  if (url.pathname === TRUST_CONTROL_ROUTES.policy) return context.json(200, trust.view());
  if (url.pathname === TRUST_CONTROL_ROUTES.savePolicy) {
    let policy: ReturnType<typeof decodeTrustPolicySave>["policy"];
    try {
      policy = decodeTrustPolicySave(body).policy;
    } catch {
      throw new HttpError(400, "Invalid trust policy.");
    }
    const view = await runCauseEffect(
      trust.savePolicy(policy, { id: context.member.id, name: context.member.name ?? context.member.username }),
    );
    return context.json(200, view);
  }
  if (url.pathname === TRUST_CONTROL_ROUTES.approvals) return context.json(200, trust.approvalsView());
  if (url.pathname === TRUST_CONTROL_ROUTES.reopenApproval) {
    let id: string;
    try {
      id = decodeReopenApproval(body).id;
    } catch {
      throw new HttpError(400, "Invalid approval id.");
    }
    if (!(await trust.reopenApproval(id))) throw new HttpError(409, "This decision can no longer be reopened.");
    return context.json(200, trust.approvalsView());
  }
  return context.json(200, { entries: trust.audit.query(decodeTrustAuditQuery(body)) });
}
