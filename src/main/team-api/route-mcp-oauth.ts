import { isDynamicRecord, isString } from "@openbot/contracts/runtime-values";
import {
  MCP_OAUTH_CAPABILITY,
  MCP_OAUTH_CODECS,
  MCP_OAUTH_ROUTES,
} from "@openbot/contracts/team-protocol/mcp-oauth-v1";
import { sourceText } from "@openbot/i18n/source";
import { runCauseEffect } from "../../backend/effect-boundary";
import type { RemoteMcpSignIn } from "../remote-mcp-sign-in";
import { HttpError } from "./http-error";
import type { RouteOutcome, TeamApiRequestContext } from "./request-context";
import { readJson, requireAdmin } from "./request-helpers";

export async function routeMcpOAuth(context: TeamApiRequestContext, signIn?: RemoteMcpSignIn): Promise<RouteOutcome> {
  const { method, url, capabilities, member, sessionId, sessionExpiresAt, request, json } = context;
  const codec = MCP_OAUTH_CODECS.get(url.pathname);
  if (method !== "POST" || !codec) return "unmatched";
  if (!signIn || !capabilities.has(MCP_OAUTH_CAPABILITY))
    throw new HttpError(400, sourceText("error.team.mcpOAuthUnsupported"));
  requireAdmin(member);
  const body = codec.request(await readJson(request));
  if (!isDynamicRecord(body)) throw new HttpError(400, "Invalid MCP sign-in request.");
  const owner = `${member.id}:${sessionId}`;
  if (url.pathname === MCP_OAUTH_ROUTES.start) {
    if (!isString(body.url) || !isString(body.redirectUrl) || !isString(body.accountId))
      throw new HttpError(400, "Invalid MCP sign-in start.");
    return json(
      200,
      await runCauseEffect(
        signIn.start(
          owner,
          { url: body.url, redirectUrl: body.redirectUrl, accountId: body.accountId },
          sessionExpiresAt,
        ),
      ),
    );
  }
  if (!isString(body.attemptId)) throw new HttpError(400, "Invalid MCP sign-in attempt.");
  if (url.pathname === MCP_OAUTH_ROUTES.status) return json(200, signIn.status(owner, body.attemptId));
  if (url.pathname === MCP_OAUTH_ROUTES.cancel) await runCauseEffect(signIn.cancel(owner, body.attemptId));
  else {
    if (!isString(body.state) || !isString(body.code)) throw new HttpError(400, "Invalid MCP sign-in return.");
    signIn.complete(owner, { attemptId: body.attemptId, state: body.state, code: body.code });
  }
  return json(200, {});
}
