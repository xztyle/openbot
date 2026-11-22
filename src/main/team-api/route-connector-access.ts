import { isOneOf, isString } from "@openbot/contracts/runtime-values";
import {
  CONNECTOR_ACCESS_CAPABILITY,
  CONNECTOR_ACCESS_ROUTES,
  CONNECTOR_INBOX_SCHEMES,
} from "@openbot/contracts/team-protocol/connector-access-v1";
import { sourceText } from "@openbot/i18n/source";
import { Effect, Result } from "effect";
import type { ConnectorAccess } from "../connector-access";
import { OwnerMcpTokenLimit } from "../owner-mcp-tokens";
import { WebhookInboxGone, WebhookInboxSecretMissing } from "../webhook-inbox";
import { HttpError } from "./http-error";
import type { RouteOutcome, TeamApiRequestContext } from "./request-context";
import { readJson, requireAdmin } from "./request-helpers";

/** The value of `effect`, or its own failure thrown, so a refusal keeps its type. */
async function run<A, E>(effect: Effect.Effect<A, E>): Promise<A> {
  const result = await Effect.runPromise(Effect.result(effect));
  if (Result.isFailure(result)) throw result.failure;
  return result.success;
}

const ROUTES: ReadonlySet<string> = new Set(Object.values(CONNECTOR_ACCESS_ROUTES));

/**
 * The MCP access tokens and the webhook inbox senders (`connector-access-v1.ts`, under
 * `fork-host-v1`). Only the owner and the admins: a token sends messages as the owner.
 */
export async function routeConnectorAccess(
  context: TeamApiRequestContext,
  access: ConnectorAccess | undefined,
): Promise<RouteOutcome> {
  const { method, url, capabilities, request, json, member } = context;
  if (method !== "POST" || !ROUTES.has(url.pathname)) return "unmatched";
  if (!access || !capabilities.has(CONNECTOR_ACCESS_CAPABILITY))
    throw new HttpError(404, sourceText("error.team.routeNotFound"));
  requireAdmin(member);
  // `readJson` has already run the body through the connector-access wire codec.
  const body = await readJson(request);
  try {
    if (url.pathname === CONNECTOR_ACCESS_ROUTES.state) return json(200, access.state());
    if (url.pathname === CONNECTOR_ACCESS_ROUTES.createToken)
      return json(200, await run(access.createToken(isString(body.label) ? body.label : "")));
    if (url.pathname === CONNECTOR_ACCESS_ROUTES.revokeToken) {
      if (!isString(body.id)) throw new HttpError(400, sourceText("error.team.requestFailed"));
      return json(200, await run(access.revokeToken(body.id)));
    }
    const { routeId, scheme, secret } = body;
    if (!isString(routeId) || !isOneOf(CONNECTOR_INBOX_SCHEMES, scheme))
      throw new HttpError(400, sourceText("error.team.requestFailed"));
    return json(200, await run(access.configureInbox({ routeId, scheme, ...(isString(secret) ? { secret } : {}) })));
  } catch (error) {
    if (error instanceof OwnerMcpTokenLimit || error instanceof WebhookInboxSecretMissing)
      throw new HttpError(409, error.message);
    if (error instanceof WebhookInboxGone) throw new HttpError(404, error.message);
    throw error;
  }
}
