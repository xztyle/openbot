import { decodeWorkspaceSidebarPrefs, type WorkspaceSidebarPrefs } from "@openbot/contracts/ipc";
import {
  WORKSPACE_SIDEBAR_CAPABILITY,
  WORKSPACE_SIDEBAR_ROUTES,
} from "@openbot/contracts/team-protocol/workspace-sidebar-v1";
import { sourceText } from "@openbot/i18n/source";
import { runCauseEffect } from "../../backend/effect-boundary";
import type { TeamApiWorkspaceSidebar } from "./dependencies";
import { HttpError } from "./http-error";
import type { RouteOutcome, TeamApiRequestContext } from "./request-context";
import { readJson } from "./request-helpers";

function parsedSidebar(value: unknown): WorkspaceSidebarPrefs {
  try {
    return decodeWorkspaceSidebarPrefs(value);
  } catch {
    throw new HttpError(400, "Invalid workspace request.");
  }
}

/**
 * The sidebar routes of this fork (`workspace-sidebar-v1.ts`, under `fork-host-v1`): the order and
 * the mutes of the member of the session. The member comes from the session, never from the body.
 */
export async function routeWorkspaceSidebar(
  context: TeamApiRequestContext,
  sidebar: TeamApiWorkspaceSidebar | undefined,
): Promise<RouteOutcome> {
  const { method, url, capabilities, member, request, json } = context;
  if (method !== "POST" || !Object.values(WORKSPACE_SIDEBAR_ROUTES).some((route) => route === url.pathname))
    return "unmatched";
  if (!capabilities.has(WORKSPACE_SIDEBAR_CAPABILITY) || !sidebar)
    throw new HttpError(400, sourceText("error.team.workspaceUnsupported"));
  // `readJson` has already run the body through the workspace-sidebar wire codec.
  const body = await readJson(request);
  if (url.pathname === WORKSPACE_SIDEBAR_ROUTES.read) return json(200, { sidebar: sidebar.get(member.id) });
  const saved = await runCauseEffect(sidebar.set(member.id, parsedSidebar(body)));
  return json(200, { sidebar: saved });
}
