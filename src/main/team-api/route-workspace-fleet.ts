import { readFile } from "node:fs/promises";
import {
  parseWorkspaceAgentExchangeInput,
  parseWorkspaceAgentPairsInput,
  parseWorkspaceArtifactsInput,
  parseWorkspaceDecisionsInput,
  parseWorkspaceFleetInput,
  parseWorkspaceSecretInput,
  parseWorkspaceSecretSaveInput,
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
import { readJson, requireAdmin } from "./request-helpers";
import { requestChannelViewer } from "./route-workspace";

const SECRET_ROUTES: ReadonlySet<string> = new Set([
  WORKSPACE_FLEET_ROUTES.secrets,
  WORKSPACE_FLEET_ROUTES.secretRead,
  WORKSPACE_FLEET_ROUTES.secretSave,
  WORKSPACE_FLEET_ROUTES.secretRemove,
]);

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
  agents: Pick<TeamApiAgents, "workspace" | "secrets">,
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
  if (SECRET_ROUTES.has(url.pathname)) {
    // The keys go to agents that every member may run, and their values are the server's: owner and admins.
    requireAdmin(context.member);
    if (url.pathname === WORKSPACE_FLEET_ROUTES.secrets) return json(200, await agents.secrets.list());
    if (url.pathname === WORKSPACE_FLEET_ROUTES.secretRead)
      return json(200, await agents.secrets.read(parsed(parseWorkspaceSecretInput, body)));
    if (url.pathname === WORKSPACE_FLEET_ROUTES.secretSave)
      await agents.secrets.save(parsed(parseWorkspaceSecretSaveInput, body));
    else await agents.secrets.remove(parsed(parseWorkspaceSecretInput, body));
    return json(200, {});
  }
  if (url.pathname === WORKSPACE_FLEET_ROUTES.fleet)
    return json(200, agents.workspace.fleet(parsed(parseWorkspaceFleetInput, body), visible));
  if (url.pathname === WORKSPACE_FLEET_ROUTES.agentPairs)
    return json(200, agents.workspace.agentPairs(parsed(parseWorkspaceAgentPairsInput, body), visible));
  if (url.pathname === WORKSPACE_FLEET_ROUTES.agentExchange) {
    const input = parsed(parseWorkspaceAgentExchangeInput, body);
    // An agent that this member cannot see is not found, as a channel they cannot see is not.
    if (!input.agentIds.every(visible)) throw new HttpError(404, sourceText("error.backend.channelNotFound"));
    return json(200, agents.workspace.agentExchange(input, visible));
  }
  const viewer = requestChannelViewer(context);
  if (url.pathname === WORKSPACE_FLEET_ROUTES.steps) {
    const input = parsed(parseWorkspaceStepsInput, body);
    return json(
      200,
      found(() => agents.workspace.steps(input, viewer)),
    );
  }
  // Any member who sees the channel reads its decisions, as they read its messages.
  if (url.pathname === WORKSPACE_FLEET_ROUTES.decisions) {
    const input = parsed(parseWorkspaceDecisionsInput, body);
    return json(
      200,
      found(() => agents.workspace.decisions(input, viewer)),
    );
  }
  const input = parsed(parseWorkspaceArtifactsInput, body);
  return json(
    200,
    found(() => agents.workspace.artifacts(input, viewer, visible)),
  );
}
