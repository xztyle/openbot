import { readFile } from "node:fs/promises";
import {
  parseWorkspaceArtifactsInput,
  parseWorkspaceFleetInput,
  parseWorkspaceStepsInput,
} from "@openbot/contracts/ipc";
import {
  WORKSPACE_FLEET_CAPABILITY,
  WORKSPACE_FLEET_ROUTES,
  workspaceArtifactThumbnailId,
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
 * hidden from this peer; a channel shows when the member can see it. The thumbnail of an artifact
 * answers only for an artifact that the artifact list would show this member.
 */
export async function routeWorkspaceFleet(
  context: TeamApiRequestContext,
  agents: Pick<TeamApiAgents, "workspace">,
  hiddenAgentIds: ReadonlySet<string> = new Set(),
): Promise<RouteOutcome> {
  const { method, url, capabilities, request, response, json } = context;
  const visible = (agentId: string) => !hiddenAgentIds.has(agentId) && context.agentLevel(agentId) !== "none";
  const thumbnailId = method === "GET" ? workspaceArtifactThumbnailId(url.pathname) : null;
  if (thumbnailId !== null) {
    if (!capabilities.has(WORKSPACE_FLEET_CAPABILITY))
      throw new HttpError(400, sourceText("error.team.workspaceUnsupported"));
    const version = url.searchParams.get("v") ?? "";
    const thumbnail = version
      ? agents.workspace.artifactThumbnail(thumbnailId, version, requestChannelViewer(context), visible)
      : null;
    const bytes = thumbnail ? await readFile(thumbnail.path).catch(() => null) : null;
    if (!thumbnail || !bytes) throw new HttpError(404, sourceText("error.team.workspaceThumbnailNotFound"));
    response.writeHead(200, {
      "Content-Type": thumbnail.mimeType,
      "Content-Length": String(bytes.length),
      "Cache-Control": "private, max-age=31536000, immutable",
      "X-Content-Type-Options": "nosniff",
    });
    response.end(bytes);
    return "handled";
  }
  if (method !== "POST" || !Object.values(WORKSPACE_FLEET_ROUTES).some((route) => route === url.pathname))
    return "unmatched";
  if (!capabilities.has(WORKSPACE_FLEET_CAPABILITY))
    throw new HttpError(400, sourceText("error.team.workspaceUnsupported"));
  // `readJson` has already run the body through the workspace-fleet wire codec.
  const body = await readJson(request);
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
