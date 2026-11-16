import { parseWorkspaceSpaceAction, type WorkspaceSpaceAction } from "@openbot/contracts/ipc";
import { isDynamicRecord, isString } from "@openbot/contracts/runtime-values";
import {
  WORKSPACE_SPACES_CAPABILITY,
  WORKSPACE_SPACES_ROUTES,
} from "@openbot/contracts/team-protocol/workspace-spaces-v1";
import { sourceText } from "@openbot/i18n/source";
import { canSeeChannel } from "../../backend/channel-visibility";
import { runCauseEffect } from "../../backend/effect-boundary";
import { type SpaceViewer, spaceRejection } from "../../backend/spaces/space-service";
import type { TeamApiAgents, TeamApiSpaces } from "./dependencies";
import { HttpError } from "./http-error";
import type { RouteOutcome, TeamApiRequestContext } from "./request-context";
import { agentCreate, memberSender, readJson, requireAdmin } from "./request-helpers";
import { requestChannelViewer } from "./route-workspace";

function parsedAction(value: unknown): WorkspaceSpaceAction {
  try {
    return parseWorkspaceSpaceAction(value);
  } catch {
    throw new HttpError(400, "Invalid space action.");
  }
}

/**
 * The spaces routes of this fork (`workspace-spaces-v1.ts`, under `fork-host-v1`). Every member reads
 * the spaces and the space of each agent and channel they can see. Only an owner or an admin changes
 * them; a member may place a channel that they create next. A member who may create an agent may
 * create it in any space.
 */
export async function routeWorkspaceSpaces(
  context: TeamApiRequestContext,
  spaces: TeamApiSpaces | undefined,
  agents: Pick<TeamApiAgents, "createAgent">,
  hiddenAgentIds: ReadonlySet<string>,
): Promise<RouteOutcome> {
  const { method, url, capabilities, member, request, json } = context;
  if (method !== "POST" || !Object.values(WORKSPACE_SPACES_ROUTES).some((route) => route === url.pathname))
    return "unmatched";
  if (!capabilities.has(WORKSPACE_SPACES_CAPABILITY) || !spaces)
    throw new HttpError(400, sourceText("error.team.workspaceUnsupported"));
  // `readJson` has already run the body through the workspace-spaces wire codec.
  const body = await readJson(request);
  const channelViewer = requestChannelViewer(context);
  const viewer: SpaceViewer = {
    agent: (agentId) => !hiddenAgentIds.has(agentId) && context.agentLevel(agentId) !== "none",
    channel: (channelId) => {
      const channel = spaces.channel(channelId);
      return channel !== null && canSeeChannel(channel, channelViewer);
    },
  };
  if (url.pathname === WORKSPACE_SPACES_ROUTES.read) return json(200, spaces.service.snapshot(viewer));
  if (url.pathname === WORKSPACE_SPACES_ROUTES.createAgent) {
    if (!isDynamicRecord(body.agent) || !isString(body.spaceId))
      throw new HttpError(400, "A valid JSON object is required.");
    const input = { ...agentCreate(body.agent), spaceId: body.spaceId };
    const agent = await runCauseEffect(agents.createAgent(input, undefined, undefined, memberSender(member)));
    return json(201, { agentId: agent.id });
  }
  const action = parsedAction(body);
  // Any member may put a channel that they create next in a space; every other change is for owners and admins.
  if (action.kind !== "place-channel") requireAdmin(member);
  try {
    return json(200, await runCauseEffect(spaces.service.apply(action, viewer)));
  } catch (error) {
    const rejection = spaceRejection(error);
    if (rejection !== null) throw new HttpError(409, rejection);
    throw error;
  }
}
