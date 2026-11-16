import {
  supportsTeamSemanticTags,
  TEAM_CHANNEL_ATTENTION_CAPABILITY,
  TEAM_HISTORY_EXTENT_CAPABILITY,
  TEAM_PROMPT_MULTI_SELECT_CAPABILITY,
  TEAM_SUBAGENTS_CAPABILITY,
  TEAM_UI_BLOCKS_CAPABILITY,
} from "@openbot/contracts/team-protocol/current";
import { teamHttpCodec } from "@openbot/contracts/team-protocol/http-codecs";
import { teamSideRouteCodec } from "@openbot/contracts/team-protocol/side-routes";
import { WORKSPACE_CAPABILITY } from "@openbot/contracts/team-protocol/workspace-v1";
import { hiddenAgentView, legacyProviderView } from "./provider-visibility";

/** What a Team API response is encoded against: the request's route, protocol and capabilities. */
export interface TeamResponseRoute {
  method: string;
  path: string;
  protocol: number;
  capabilities: ReadonlySet<string>;
  /** The agents this member may not see; null before the request was authenticated. */
  hiddenAgentIds?: ReadonlySet<string> | null;
}

/**
 * The body of a JSON response, as the negotiated protocol encodes it: the projection that hides
 * agents and providers, then the frozen codec of the protocol or of a side route. A codec that
 * cannot describe the value throws. The main thread and the database read worker (which encodes a
 * chat page off the main thread) both encode with this function, so a body does not depend on
 * where it was made. Imports only the contracts.
 */
export function encodeTeamResponseBody(route: TeamResponseRoute, status: number, value: object | null): string {
  const options = {
    preserveSemanticTags: supportsTeamSemanticTags(route.capabilities),
    historyExtent: route.capabilities.has(TEAM_HISTORY_EXTENT_CAPABILITY),
    channelAttention: route.capabilities.has(TEAM_CHANNEL_ATTENTION_CAPABILITY),
    workspace: route.capabilities.has(WORKSPACE_CAPABILITY),
    uiBlocks: route.capabilities.has(TEAM_UI_BLOCKS_CAPABILITY),
    subagents: route.capabilities.has(TEAM_SUBAGENTS_CAPABILITY),
    promptMultiSelect: route.capabilities.has(TEAM_PROMPT_MULTI_SELECT_CAPABILITY),
  };
  const visibleValue =
    status < 400 && route.hiddenAgentIds
      ? route.protocol < 4
        ? legacyProviderView(value, route.hiddenAgentIds)
        : hiddenAgentView(
            value,
            route.hiddenAgentIds,
            route.protocol < 5 ? 4 : route.protocol < 6 ? 5 : route.protocol < 7 ? 6 : route.protocol < 8 ? 7 : 8,
          )
      : value;
  const sideRoute = teamSideRouteCodec(route.path);
  return sideRoute
    ? JSON.stringify(sideRoute.response(route.path, status, visibleValue, options))
    : teamHttpCodec(route.protocol).encodeResponse(route.method, route.path, status, visibleValue, options);
}
