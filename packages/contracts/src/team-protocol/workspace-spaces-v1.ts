// Optional spaces wire contract of this fork, under `fork-host-v1`.
//
// What it adds, recorded here because freezing it makes it permanent:
//
// - `POST /v1/workspace/spaces` `{}` answers `{ spaces, agents, channels }`. A space is `{ id, name
//   (1-60), slug, icon (null or 1-32), hue (null or an avatar hue), position }`, in order. `agents`
//   and `channels` (5000 each) are `{ id, spaceId }`: the space of each agent and channel that the
//   member sees. A DM with one agent is in the space of that agent. An id that a client cannot find
//   in either list, or a space id that it does not know, is in `general`.
// - `POST /v1/workspace/spaces/action` with an action answers the same, and `createdSpaceId` after a
//   `create`. An action is `{ kind: "create", name, icon?, hue? }`, `{ kind: "update", spaceId,
//   name?, icon?, hue? }`, `{ kind: "delete", spaceId, moveTo? }` (never `general`; without
//   `moveTo`, only an empty space), `{ kind: "reorder", spaceIds }` (every space once), `{ kind:
//   "move", spaceId, agentIds?, channelIds? }`, or `{ kind: "place-channel", spaceId, channelId }`
//   (a channel that the client creates next). Only an owner or an admin sends one; a refused action
//   answers 409 with the reason.
// - `POST /v1/workspace/spaces/create-agent` `{ spaceId, agent }`, where `agent` is the body of
//   `POST /v1/agents`, creates the agent in that space before its first turn and answers
//   `{ agentId }`. The member needs what `POST /v1/agents` needs. A client then reads the agents again.
//
// - The event `workspace-spaces-changed` (`{}` beside its type): a space or the space of an agent or
//   a channel changed. A client reads the spaces again. An older client ignores it.
//
// A fork host built before these routes answers 404; a client then shows one space, General, and
// does not offer to make others. A present malformed value fails closed. The bounds are written out:
// this file must not move with an IPC limit.
import { isDynamicRecord } from "../runtime-values";
import {
  type AdminDecoder,
  adminRoute,
  count,
  empty,
  fields,
  identifier,
  list,
  nullable,
  type OptionalRouteCodec,
  oneOf,
  string,
} from "./admin-wire";
import { FORK_HOST_CAPABILITY } from "./fork-host-v1";

export const WORKSPACE_SPACES_CAPABILITY = FORK_HOST_CAPABILITY;

export const WORKSPACE_SPACES_ROUTES = {
  read: "/v1/workspace/spaces",
  action: "/v1/workspace/spaces/action",
  createAgent: "/v1/workspace/spaces/create-agent",
} as const;

const HUES = [0, 30, 55, 100, 150, 185, 215, 245, 280, 320];
const hue: AdminDecoder = (value) => {
  if (typeof value !== "number" || !HUES.includes(value)) throw new Error("Invalid space hue.");
  return value;
};
const name: AdminDecoder = (value) => {
  const text = string(60)(value);
  if (typeof text !== "string" || text.trim().length === 0) throw new Error("Invalid space name.");
  return text;
};
const icon: AdminDecoder = (value) => {
  const text = string(32)(value);
  if (text === "") throw new Error("Invalid space icon.");
  return text;
};
const ids = list(identifier, 5_000);
const space = fields({
  id: identifier,
  name,
  slug: identifier,
  icon: nullable(icon),
  hue: nullable(hue),
  position: count,
});
const item = fields({ id: identifier, spaceId: identifier });
const spacesFields = { spaces: list(space, 100), agents: list(item, 5_000), channels: list(item, 5_000) };
const look = { icon: nullable(icon), hue: nullable(hue) };

/** The actions, by `kind`. `variant` is keyed by `kind` too, so it is written out here. */
const ACTIONS: Record<string, AdminDecoder> = {
  create: fields({ kind: oneOf("create"), name }, look),
  update: fields({ kind: oneOf("update"), spaceId: identifier }, { name, ...look }),
  delete: fields({ kind: oneOf("delete"), spaceId: identifier }, { moveTo: identifier }),
  reorder: fields({ kind: oneOf("reorder"), spaceIds: list(identifier, 100) }),
  move: fields({ kind: oneOf("move"), spaceId: identifier }, { agentIds: ids, channelIds: ids }),
  "place-channel": fields({ kind: oneOf("place-channel"), spaceId: identifier, channelId: identifier }),
};
const action: AdminDecoder = (value) => {
  const decode = isDynamicRecord(value) && typeof value.kind === "string" ? ACTIONS[value.kind] : undefined;
  if (!decode) throw new Error("Invalid space action.");
  return decode(value);
};

const agent = fields(
  {
    name: string(80),
    description: string(2_000),
    avatarSeed: string(128),
    avatarHue: nullable(hue),
    initialMessage: string(100_000),
  },
  { provider: string(128), model: string(256), reasoningEffort: string(64) },
);

export const WORKSPACE_SPACES_CODECS: ReadonlyMap<string, OptionalRouteCodec> = new Map([
  [WORKSPACE_SPACES_ROUTES.read, adminRoute(empty, fields(spacesFields))],
  [WORKSPACE_SPACES_ROUTES.action, adminRoute(action, fields(spacesFields, { createdSpaceId: identifier }))],
  [
    WORKSPACE_SPACES_ROUTES.createAgent,
    adminRoute(fields({ spaceId: identifier, agent }), fields({ agentId: identifier })),
  ],
]);

export const WORKSPACE_SPACES_CHANGED_EVENT = "workspace-spaces-changed";

export interface WorkspaceSpacesChangedEvent {
  type: typeof WORKSPACE_SPACES_CHANGED_EVENT;
}

/** The spaces event in `value`, or null for any other event. It carries nothing else. */
export function workspaceSpacesEvent(value: unknown): WorkspaceSpacesChangedEvent | null {
  if (!isDynamicRecord(value) || value.type !== WORKSPACE_SPACES_CHANGED_EVENT) return null;
  return { type: WORKSPACE_SPACES_CHANGED_EVENT };
}
