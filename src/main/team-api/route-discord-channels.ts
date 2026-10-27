import { parseDiscordChannelConfig } from "@openbot/contracts/ipc";
import {
  DISCORD_CHANNELS_CAPABILITY,
  DISCORD_CHANNELS_ROUTES,
} from "@openbot/contracts/team-protocol/discord-channels-v1";
import { sourceText } from "@openbot/i18n/source";
import { runCauseEffect } from "../../backend/effect-boundary";
import type { TeamApiConnectors } from "./dependencies";
import { HttpError } from "./http-error";
import type { RouteOutcome, TeamApiRequestContext } from "./request-context";
import { readJson, requireAdmin, stringField } from "./request-helpers";

const ROUTES: ReadonlySet<string> = new Set(Object.values(DISCORD_CHANNELS_ROUTES));

/**
 * Which agent answers in each Discord server of this host and in each of its channels, read and set
 * from a joined server (`discord-channels-v1.ts`, under `fork-host-v1`). `requireAdmin` runs on every
 * route.
 */
export async function routeDiscordChannels(
  context: TeamApiRequestContext,
  connectors: TeamApiConnectors | undefined,
): Promise<RouteOutcome> {
  const { method, url, capabilities, member, request, json } = context;
  if (method !== "POST" || !ROUTES.has(url.pathname)) return "unmatched";
  if (!connectors || !capabilities.has(DISCORD_CHANNELS_CAPABILITY))
    throw new HttpError(400, sourceText("error.team.discordChannelsUnsupported"));
  requireAdmin(member);
  const body = await readJson(request);
  const { messaging } = connectors;
  const workspaceId = stringField(body, "workspaceId", false, 128);
  switch (url.pathname) {
    case DISCORD_CHANNELS_ROUTES.config:
      return json(200, await runCauseEffect(messaging.discordChannelConfig(workspaceId)));
    case DISCORD_CHANNELS_ROUTES.channels:
      return json(200, await runCauseEffect(messaging.listDiscordChannels(workspaceId)));
    default: {
      const config = parseDiscordChannelConfig({ serverAgentId: body.serverAgentId, channels: body.channels });
      if (!config) throw new HttpError(400, "The Discord channel settings are invalid.");
      return json(200, await runCauseEffect(messaging.setDiscordChannelConfig({ workspaceId, ...config })));
    }
  }
}
