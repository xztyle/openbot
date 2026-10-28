import {
  parseWorkspaceArtifactsInput,
  parseWorkspaceFleetInput,
  parseWorkspaceStepsInput,
} from "@openbot/contracts/ipc";
import {
  WORKSPACE_FLEET_CAPABILITY,
  WORKSPACE_FLEET_ROUTES,
} from "@openbot/contracts/team-protocol/workspace-fleet-v1";
import { sourceText } from "@openbot/i18n/source";
import type { TeamApiAgents } from "./dependencies";
import { HttpError } from "./http-error";
import type { RouteOutcome, TeamApiRequestContext } from "./request-context";
import { readJson } from "./request-helpers";
import { requestChannelViewer } from "./route-workspace";

function parsed<T>(parse: (value: unknown) => T, value: unknown): T {
  try {
    return parse(value);
  } catch {
    throw new HttpError(400, "Invalid workspace request.");
  }
}

/** A channel or a message that this member cannot see is not found, as on the channel routes. */
function found<T>(read: () => T): T {
  try {
    return read();
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (
      message === sourceText("error.backend.channelNotFound") ||
      message === sourceText("error.backend.channelMessageNotFound")
    )
      throw new HttpError(404, message);
    throw error;
  }
}

/**
 * The fleet, step trail and artifact routes of this fork (`workspace-fleet-v1.ts`, under
 * `fork-host-v1`). An agent shows when the member's roles give at least `view` on it and it is not
 * hidden from this peer; a channel shows when the member can see it.
 */
export async function routeWorkspaceFleet(
  context: TeamApiRequestContext,
  agents: Pick<TeamApiAgents, "workspace">,
  hiddenAgentIds: ReadonlySet<string> = new Set(),
): Promise<RouteOutcome> {
  const { method, url, capabilities, request, json } = context;
  if (method !== "POST" || !Object.values(WORKSPACE_FLEET_ROUTES).some((route) => route === url.pathname))
    return "unmatched";
  if (!capabilities.has(WORKSPACE_FLEET_CAPABILITY))
    throw new HttpError(400, sourceText("error.team.workspaceUnsupported"));
  // `readJson` has already run the body through the workspace-fleet wire codec.
  const body = await readJson(request);
  const visible = (agentId: string) => !hiddenAgentIds.has(agentId) && context.agentLevel(agentId) !== "none";
  if (url.pathname === WORKSPACE_FLEET_ROUTES.fleet)
    return json(200, agents.workspace.fleet(parsed(parseWorkspaceFleetInput, body), visible));
  const viewer = requestChannelViewer(context);
  if (url.pathname === WORKSPACE_FLEET_ROUTES.steps) {
    const input = parsed(parseWorkspaceStepsInput, body);
    return json(
      200,
      found(() => agents.workspace.steps(input, viewer)),
    );
  }
  const input = parsed(parseWorkspaceArtifactsInput, body);
  return json(
    200,
    found(() => agents.workspace.artifacts(input, viewer, visible)),
  );
}
