import { decodeClaudeContextSetting } from "@openbot/contracts/ipc";
import { CLAUDE_CONTEXT_CAPABILITY, CLAUDE_CONTEXT_ROUTES } from "@openbot/contracts/team-protocol/claude-context-v1";
import { sourceText } from "@openbot/i18n/source";
import { runCauseEffect } from "../../backend/effect-boundary";
import type { TeamApiAdmin } from "./dependencies";
import { HttpError } from "./http-error";
import type { RouteOutcome, TeamApiRequestContext } from "./request-context";
import { readJson, requireAdmin } from "./request-helpers";

/** What this server's Claude agents load into each request, read and set from a joined server. Frozen by `claude-context-v1`. */
export async function routeClaudeContext(
  context: TeamApiRequestContext,
  admin: TeamApiAdmin | undefined,
): Promise<RouteOutcome> {
  const { method, url, capabilities, member, request, json } = context;
  if (
    method !== "POST" ||
    (url.pathname !== CLAUDE_CONTEXT_ROUTES.settings && url.pathname !== CLAUDE_CONTEXT_ROUTES.update)
  )
    return "unmatched";
  const setting = admin?.claudeContext;
  if (!setting || !capabilities.has(CLAUDE_CONTEXT_CAPABILITY))
    throw new HttpError(400, sourceText("error.team.claudeContextUnsupported"));
  requireAdmin(member);
  const body = await readJson(request);
  if (url.pathname === CLAUDE_CONTEXT_ROUTES.settings) return json(200, setting.get());
  let next: ReturnType<typeof decodeClaudeContextSetting>;
  try {
    next = decodeClaudeContextSetting(body);
  } catch {
    throw new HttpError(400, "A Claude context setting is required.");
  }
  return json(200, await runCauseEffect(setting.set(next)));
}
