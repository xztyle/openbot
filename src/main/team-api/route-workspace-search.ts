import { parseWorkspaceSearchInput } from "@openbot/contracts/ipc";
import {
  WORKSPACE_SEARCH_CAPABILITY,
  WORKSPACE_SEARCH_ROUTES,
} from "@openbot/contracts/team-protocol/workspace-search-v1";
import { sourceText } from "@openbot/i18n/source";
import type { ChannelService } from "../../backend/channel-service";
import { runCauseEffect } from "../../backend/effect-boundary";
import { HttpError } from "./http-error";
import type { RouteOutcome, TeamApiRequestContext } from "./request-context";
import { readJson } from "./request-helpers";
import { requestChannelViewer } from "./route-workspace";

/**
 * The message search route of this fork (`workspace-search-v1.ts`, under `fork-host-v1`): the
 * messages of the channels, groups and DMs that the member of the session can see. An agent hidden
 * from this peer did not write any of them.
 */
export async function routeWorkspaceSearch(
  context: TeamApiRequestContext,
  channels: ChannelService | undefined,
  hiddenAgentIds: ReadonlySet<string>,
): Promise<RouteOutcome> {
  const { method, url, capabilities, request, json } = context;
  if (method !== "POST" || url.pathname !== WORKSPACE_SEARCH_ROUTES.search) return "unmatched";
  if (!capabilities.has(WORKSPACE_SEARCH_CAPABILITY))
    throw new HttpError(400, sourceText("error.team.workspaceUnsupported"));
  if (!channels) throw new HttpError(400, sourceText("error.team.channelsUnsupported"));
  // `readJson` has already run the body through the search wire codec.
  const body = await readJson(request);
  let input: ReturnType<typeof parseWorkspaceSearchInput>;
  try {
    input = parseWorkspaceSearchInput(body);
  } catch {
    throw new HttpError(400, "Invalid workspace request.");
  }
  return json(200, await runCauseEffect(channels.search.search(input, requestChannelViewer(context), hiddenAgentIds)));
}
