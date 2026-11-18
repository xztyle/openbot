import {
  parseWorkspaceFollowThreadInput,
  parseWorkspaceMarkUnreadInput,
  parseWorkspaceReadThreadInput,
  parseWorkspaceThreadStatesInput,
} from "@openbot/contracts/ipc";
import {
  WORKSPACE_READ_STATE_CAPABILITY,
  WORKSPACE_READ_STATE_ROUTES,
} from "@openbot/contracts/team-protocol/workspace-read-state-v1";
import { sourceText } from "@openbot/i18n/source";
import type { ChannelService } from "../../backend/channel-service";
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

const NOT_FOUND = [
  "error.backend.channelNotFound",
  "error.backend.channelThreadNotFound",
  "error.backend.channelMessageNotFound",
] as const;

/** A channel, a thread or a message that this member cannot see is not found, as on the channel routes. */
export function found<T>(read: () => T): T {
  try {
    return read();
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (NOT_FOUND.some((key) => message === sourceText(key))) throw new HttpError(404, message);
    throw error;
  }
}

/**
 * The read state routes of this fork (`workspace-read-state-v1.ts`, under `fork-host-v1`): the thread
 * states of the member of the session, their reads and follows, and mark unread. The member reads and changes
 * only their own state, in channels they can see; the id comes from the session, never the body.
 */
export async function routeWorkspaceReadState(
  context: TeamApiRequestContext,
  channels: ChannelService | undefined,
): Promise<RouteOutcome> {
  const { method, url, capabilities, member, request, json } = context;
  if (method !== "POST" || !Object.values(WORKSPACE_READ_STATE_ROUTES).some((route) => route === url.pathname))
    return "unmatched";
  if (!capabilities.has(WORKSPACE_READ_STATE_CAPABILITY))
    throw new HttpError(400, sourceText("error.team.workspaceUnsupported"));
  if (!channels) throw new HttpError(400, sourceText("error.team.channelsUnsupported"));
  const viewer = requestChannelViewer(context);
  // `readJson` has already run the body through the read state wire codec.
  const body = await readJson(request);
  const actor = { id: member.id };
  switch (url.pathname) {
    case WORKSPACE_READ_STATE_ROUTES.threadStates: {
      const input = parsed(parseWorkspaceThreadStatesInput, body);
      return json(
        200,
        found(() => channels.threadStates(input, viewer)),
      );
    }
    case WORKSPACE_READ_STATE_ROUTES.readThread: {
      const input = parsed(parseWorkspaceReadThreadInput, body);
      return json(
        200,
        found(() => channels.readThread(input, actor, viewer)),
      );
    }
    case WORKSPACE_READ_STATE_ROUTES.markUnread: {
      const input = parsed(parseWorkspaceMarkUnreadInput, body);
      return json(
        200,
        found(() => channels.markUnread(input, actor, viewer)),
      );
    }
    default: {
      const input = parsed(parseWorkspaceFollowThreadInput, body);
      return json(
        200,
        found(() => channels.followThread(input, actor, viewer)),
      );
    }
  }
}
