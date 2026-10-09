import { isDynamicRecord } from "@openbot/contracts/runtime-values";
import {
  SECURITY_AUDIT_CAPABILITY,
  SECURITY_AUDIT_CODECS,
  SECURITY_AUDIT_MAX_ROWS,
  SECURITY_AUDIT_ROUTES,
} from "@openbot/contracts/team-protocol/security-audit-v1";
import { sourceText } from "@openbot/i18n/source";
import type { SecurityAuditLog } from "../../backend/security-audit-log";
import { HttpError } from "./http-error";
import type { RouteOutcome, TeamApiRequestContext } from "./request-context";
import { readJson, requireAdmin } from "./request-helpers";

/** The newest rows of the security audit file, for an owner or admin. Frozen by `security-audit-v1`. */
export async function routeSecurityAudit(
  context: TeamApiRequestContext,
  audit?: Pick<SecurityAuditLog, "read">,
): Promise<RouteOutcome> {
  const codec = SECURITY_AUDIT_CODECS.get(context.url.pathname);
  if (context.method !== "POST" || !codec || context.url.pathname !== SECURITY_AUDIT_ROUTES.list) return "unmatched";
  requireAdmin(context.member);
  if (!audit || !context.capabilities.has(SECURITY_AUDIT_CAPABILITY))
    throw new HttpError(400, sourceText("error.backend.eventCheckUnsupported"));
  const body = codec.request(await readJson(context.request));
  const asked = isDynamicRecord(body) && typeof body.limit === "number" ? body.limit : 50;
  const limit = Math.max(1, Math.min(asked, SECURITY_AUDIT_MAX_ROWS));
  const answer = codec.response(200, { rows: audit.read(limit) });
  if (answer === null || typeof answer !== "object")
    throw new HttpError(400, sourceText("error.backend.eventCheckFailed"));
  return context.json(200, answer);
}
