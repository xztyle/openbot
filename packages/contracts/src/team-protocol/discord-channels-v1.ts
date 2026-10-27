// Optional Discord channel routes of this fork's host, under `fork-host-v1`.
//
// What it grants: an owner or admin of a server reads and sets which agent answers in each Discord
// server that the host connected, which agent answers in each of its channels, and in which channels
// OpenBot answers every message without a mention. The admin also lists the server's text channels
// to choose from; the host asks Discord for them through Signal. A member cannot use any route;
// `requireAdmin` on the host is the only gate. A fork host built before these routes answers 404,
// so the client fails closed.
import { adminRoute, boolean, fields, identifier, list, nullable, type OptionalRouteCodec, string } from "./admin-wire";
import { FORK_HOST_CAPABILITY } from "./fork-host-v1";

export const DISCORD_CHANNELS_CAPABILITY = FORK_HOST_CAPABILITY;

export const DISCORD_CHANNELS_ROUTES = {
  config: "/v1/admin/connectors/discord/channel-config",
  channels: "/v1/admin/connectors/discord/channels",
  update: "/v1/admin/connectors/discord/channel-config/update",
} as const;

const workspace = fields({ workspaceId: identifier });
const setting = fields({ channelId: identifier, agentId: nullable(identifier), answerAll: boolean });
const config = fields({ serverAgentId: nullable(identifier), channels: list(setting, 500) });

export const DISCORD_CHANNELS_CODECS: ReadonlyMap<string, OptionalRouteCodec> = new Map([
  [DISCORD_CHANNELS_ROUTES.config, adminRoute(workspace, config)],
  [
    DISCORD_CHANNELS_ROUTES.channels,
    adminRoute(workspace, fields({ channels: list(fields({ id: identifier, name: string(100) }), 500) })),
  ],
  [
    DISCORD_CHANNELS_ROUTES.update,
    adminRoute(
      fields({ workspaceId: identifier, serverAgentId: nullable(identifier), channels: list(setting, 500) }),
      config,
    ),
  ],
]);
