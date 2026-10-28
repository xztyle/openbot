import {
  type ChannelCommand,
  decodeWorkspaceSettings,
  isWorkspaceChannelCommand,
  parseChannelCommand,
  parseChannelRead,
  parseWorkspaceActivityInput,
} from "@openbot/contracts/ipc";
import { WORKSPACE_CAPABILITY, WORKSPACE_ROUTES } from "@openbot/contracts/team-protocol/workspace-v1";
import { sourceText } from "@openbot/i18n/source";
import type { ChannelService } from "../../backend/channel-service";
import { type ChannelViewer, channelViewer } from "../../backend/channel-visibility";
import { runCauseEffect } from "../../backend/effect-boundary";
import type { TeamApiAdmin } from "./dependencies";
import { HttpError } from "./http-error";
import type { RouteOutcome, TeamApiRequestContext } from "./request-context";
import { readJson, requireAdmin, requireAgentLevel } from "./request-helpers";

/** The person of a Team API request as a channel reader: the authenticated member, never an id from the body. */
export function requestChannelViewer(context: Pick<TeamApiRequestContext, "member">): ChannelViewer {
  return channelViewer(context.member.id, context.member.role);
}

/**
 * The agents a workspace command brings into a channel. The member needs `chat` for each one, as
 * for a channel save that adds it, and an agent hidden from this peer does not exist for it.
 */
function requireChatForAgents(
  context: TeamApiRequestContext,
  input: ChannelCommand,
  channels: ChannelService,
  hiddenAgentIds: ReadonlySet<string>,
): void {
  const agentIds =
    input.type === "create" || input.type === "invite"
      ? input.members.map((member) => member.agentId)
      : input.type === "open-dm"
        ? input.agentIds
        : input.type === "set-member" || input.type === "remove"
          ? input.type === "remove"
            ? input.agentIds
            : [input.agentId]
          : [];
  const stored = new Set(
    input.type !== "create" && input.type !== "open-dm" && channels.store.exists(input.channelId)
      ? channels.store.get(input.channelId).members.map((member) => member.agentId)
      : [],
  );
  for (const agentId of agentIds) {
    if (hiddenAgentIds.has(agentId)) throw new HttpError(404, sourceText("error.team.agentNotFound"));
    // Removing an agent or changing how it answers needs `chat` only for an agent the channel has.
    if ((input.type === "invite" || input.type === "create" || input.type === "open-dm") && stored.has(agentId))
      continue;
    requireAgentLevel(context, agentId, "chat");
  }
}

/**
 * The workspace routes of this fork (`workspace-v1.ts`, under `fork-host-v1`): the workspace channel
 * commands, the page of one thread, the activity of the member, and the workspace settings.
 */
export async function routeWorkspace(
  context: TeamApiRequestContext,
  channels: ChannelService | undefined,
  admin: TeamApiAdmin | undefined,
  hiddenAgentIds: ReadonlySet<string> = new Set(),
): Promise<RouteOutcome> {
  const { method, url, capabilities, member, request, json } = context;
  if (method !== "POST" || !Object.values(WORKSPACE_ROUTES).some((route) => route === url.pathname)) return "unmatched";
  if (!capabilities.has(WORKSPACE_CAPABILITY)) throw new HttpError(400, sourceText("error.team.workspaceUnsupported"));
  if (url.pathname === WORKSPACE_ROUTES.settings || url.pathname === WORKSPACE_ROUTES.settingsUpdate) {
    const settings = admin?.workspaceSettings;
    if (!settings) throw new HttpError(400, sourceText("error.team.workspaceUnsupported"));
    requireAdmin(member);
    const body = await readJson(request);
    if (url.pathname === WORKSPACE_ROUTES.settings) return json(200, settings.get());
    return json(200, await runCauseEffect(settings.set(decodeWorkspaceSettings(body))));
  }
  if (!channels) throw new HttpError(400, sourceText("error.team.channelsUnsupported"));
  const viewer = requestChannelViewer(context);
  // `readJson` has already run the body through the workspace wire codec.
  const body = await readJson(request);
  if (url.pathname === WORKSPACE_ROUTES.activity) {
    const activity = channels.workspaceActivity(parseWorkspaceActivityInput(body), viewer);
    // An agent hidden from this peer does not exist for it, so it did nothing here either.
    return json(200, {
      items: activity.items.filter((item) => item.actor.kind !== "agent" || !hiddenAgentIds.has(item.actor.id)),
      threads: activity.threads,
    });
  }
  if (url.pathname === WORKSPACE_ROUTES.thread) {
    const input = parseChannelRead(body);
    if (!input.threadRootId) throw new HttpError(400, "Provide a thread.");
    return json(200, channels.read(input, viewer));
  }
  const input = parseChannelCommand(body);
  if (!isWorkspaceChannelCommand(input)) throw new HttpError(400, "Use the channel command route.");
  requireChatForAgents(context, input, channels, hiddenAgentIds);
  return json(
    200,
    await runCauseEffect(
      channels.command(input, { id: member.id, name: member.name ?? member.username }, undefined, viewer),
    ),
  );
}
