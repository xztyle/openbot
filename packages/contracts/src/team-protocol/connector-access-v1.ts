// Optional connector-access wire contract of this fork, under `fork-host-v1`.
//
// What it adds, recorded here because freezing it makes it permanent: the owner's access tokens for
// the Atelier MCP endpoint and the senders of the webhook inboxes, both served by the host's
// connector gateway.
//
// - `POST /v1/owner/connectors` `{}` answers the state: `{ gateway: { listening (boolean),
//   publicUrl (2048 or null) }, tokens, inboxes }`. `tokens` holds at most 10 items `{ id (128),
//   label (60), createdAt (epoch ms), lastUsedAt (epoch ms or null) }`. `inboxes` holds at most 256
//   items `{ routeId (128), ownerKind: "agent" | "channel", ownerId (128), ownerName (200),
//   routineName (200), spaceId (128), scheme: "openbot" | "stripe" | "hotmart" | "youtube", hasSecret
//   (boolean), lastEventAt (epoch ms or null), lastStatus (count or null) }`.
// - `/v1/owner/connectors/token/create` `{ label (60) }` answers `{ state, token (128), url (2048 or
//   null) }`: the only time the token exists outside the host. `url` is the MCP address with the
//   token as its last path segment, for a chat app that takes only a URL.
// - `/v1/owner/connectors/token/revoke` `{ id }` and `/v1/owner/connectors/inbox` `{ routeId, scheme,
//   secret? (512) }` answer the state.
//
// Only the owner and the admins may use the routes; any other member gets 403. A fork host built
// before these routes answers 404, so a client fails closed there and shows nothing of it. Widening
// any of it needs a new route.
import { type DynamicRecord, isBoolean, isDynamicRecord, isNumber, isOneOf, isString } from "../runtime-values";
import {
  adminRoute,
  boolean,
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

export const CONNECTOR_ACCESS_CAPABILITY = FORK_HOST_CAPABILITY;

export const CONNECTOR_ACCESS_ROUTES = {
  state: "/v1/owner/connectors",
  createToken: "/v1/owner/connectors/token/create",
  revokeToken: "/v1/owner/connectors/token/revoke",
  inbox: "/v1/owner/connectors/inbox",
} as const;

export const CONNECTOR_INBOX_SCHEMES = ["openbot", "stripe", "hotmart", "youtube"] as const;
export type ConnectorInboxScheme = (typeof CONNECTOR_INBOX_SCHEMES)[number];
export const CONNECTOR_TOKEN_LABEL_LIMIT = 60;
export const CONNECTOR_INBOX_SECRET_LIMIT = 512;

export interface ConnectorToken {
  id: string;
  label: string;
  createdAt: number;
  lastUsedAt: number | null;
}

export interface ConnectorInbox {
  routeId: string;
  ownerKind: "agent" | "channel";
  ownerId: string;
  ownerName: string;
  routineName: string;
  spaceId: string;
  scheme: ConnectorInboxScheme;
  hasSecret: boolean;
  lastEventAt: number | null;
  lastStatus: number | null;
}

export interface ConnectorAccessState {
  gateway: { listening: boolean; publicUrl: string | null };
  tokens: ConnectorToken[];
  inboxes: ConnectorInbox[];
}

export interface CreatedConnectorToken {
  state: ConnectorAccessState;
  token: string;
  url: string | null;
}

const token = fields({
  id: identifier,
  label: string(CONNECTOR_TOKEN_LABEL_LIMIT),
  createdAt: count,
  lastUsedAt: nullable(count),
});
const inbox = fields({
  routeId: identifier,
  ownerKind: oneOf("agent", "channel"),
  ownerId: identifier,
  ownerName: string(200),
  routineName: string(200),
  spaceId: identifier,
  scheme: oneOf(...CONNECTOR_INBOX_SCHEMES),
  hasSecret: boolean,
  lastEventAt: nullable(count),
  lastStatus: nullable(count),
});
const state = fields({
  gateway: fields({ listening: boolean, publicUrl: nullable(string(2_048)) }),
  tokens: list(token, 10),
  inboxes: list(inbox, 256),
});

export const CONNECTOR_ACCESS_CODECS: ReadonlyMap<string, OptionalRouteCodec> = new Map([
  [CONNECTOR_ACCESS_ROUTES.state, adminRoute(empty, state)],
  [
    CONNECTOR_ACCESS_ROUTES.createToken,
    adminRoute(
      fields({ label: string(CONNECTOR_TOKEN_LABEL_LIMIT) }),
      fields({ state, token: string(128), url: nullable(string(2_048)) }),
    ),
  ],
  [CONNECTOR_ACCESS_ROUTES.revokeToken, adminRoute(fields({ id: identifier }), state)],
  [
    CONNECTOR_ACCESS_ROUTES.inbox,
    adminRoute(
      fields(
        { routeId: identifier, scheme: oneOf(...CONNECTOR_INBOX_SCHEMES) },
        { secret: string(CONNECTOR_INBOX_SECRET_LIMIT) },
      ),
      state,
    ),
  ],
]);

const finite = (value: unknown): number | null => (isNumber(value) && Number.isFinite(value) ? value : null);
const text = (value: unknown): string => (isString(value) ? value : "");
const records = (value: unknown): DynamicRecord[] =>
  Array.isArray(value) ? value.flatMap((item: unknown) => (isDynamicRecord(item) ? [item] : [])) : [];

/** The state in its wire shape, as a client reads it. Throws on a malformed one. */
export function decodeConnectorAccessState(value: unknown): ConnectorAccessState {
  const decoded = state(value);
  if (!isDynamicRecord(decoded) || !isDynamicRecord(decoded.gateway)) throw new Error("Invalid connector state.");
  return {
    gateway: {
      listening: isBoolean(decoded.gateway.listening) && decoded.gateway.listening,
      publicUrl: isString(decoded.gateway.publicUrl) ? decoded.gateway.publicUrl : null,
    },
    tokens: records(decoded.tokens).map((item) => ({
      id: text(item.id),
      label: text(item.label),
      createdAt: finite(item.createdAt) ?? 0,
      lastUsedAt: finite(item.lastUsedAt),
    })),
    inboxes: records(decoded.inboxes).map((item) => ({
      routeId: text(item.routeId),
      ownerKind: item.ownerKind === "channel" ? "channel" : "agent",
      ownerId: text(item.ownerId),
      ownerName: text(item.ownerName),
      routineName: text(item.routineName),
      spaceId: text(item.spaceId),
      scheme: isOneOf(CONNECTOR_INBOX_SCHEMES, item.scheme) ? item.scheme : "openbot",
      hasSecret: item.hasSecret === true,
      lastEventAt: finite(item.lastEventAt),
      lastStatus: finite(item.lastStatus),
    })),
  };
}

/** The answer of a token create, as a client reads it. Throws on a malformed one. */
export function decodeCreatedConnectorToken(value: unknown): CreatedConnectorToken {
  if (!isDynamicRecord(value) || !isString(value.token)) throw new Error("Invalid connector token.");
  return {
    state: decodeConnectorAccessState(value.state),
    token: value.token,
    url: isString(value.url) ? value.url : null,
  };
}
