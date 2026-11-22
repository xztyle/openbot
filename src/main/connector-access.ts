import type { EventRoutineOwner } from "@openbot/contracts/ipc-events";
import type {
  ConnectorAccessState,
  ConnectorInboxScheme,
  CreatedConnectorToken,
} from "@openbot/contracts/team-protocol/connector-access-v1";
import { Effect } from "effect";
import type { ConnectorGateway } from "./connector-gateway";
import type { OwnerMcpTokens } from "./owner-mcp-tokens";
import type { WebhookInbox } from "./webhook-inbox";

export interface ConnectorAccessOptions {
  gateway: Pick<ConnectorGateway, "listening" | "publicUrl">;
  tokens: OwnerMcpTokens;
  inbox: Pick<WebhookInbox, "list" | "configure">;
  /** The webhook routines' routes, with their routine names. */
  routes: () => { routeId: string; owner: EventRoutineOwner; name: string }[];
  ownerName: (owner: EventRoutineOwner) => string;
  ownerSpaceId: (owner: EventRoutineOwner) => string;
}

/**
 * Settings of the connector gateway for the owner (`connector-access-v1`): the MCP access tokens and
 * who sends to each webhook routine's inbox.
 */
export class ConnectorAccess {
  readonly #options: ConnectorAccessOptions;

  constructor(options: ConnectorAccessOptions) {
    this.#options = options;
  }

  state(): ConnectorAccessState {
    const { gateway, tokens, inbox, routes, ownerName, ownerSpaceId } = this.#options;
    const settings = new Map(inbox.list().map((item) => [item.routeId, item]));
    return {
      gateway: { listening: gateway.listening(), publicUrl: gateway.publicUrl() },
      tokens: tokens.list(),
      inboxes: routes()
        .slice(0, 256)
        .map((route) => {
          const setting = settings.get(route.routeId);
          return {
            routeId: route.routeId,
            ownerKind: route.owner.kind,
            ownerId: route.owner.id,
            ownerName: ownerName(route.owner).slice(0, 200),
            routineName: route.name.slice(0, 200),
            spaceId: ownerSpaceId(route.owner),
            scheme: setting?.scheme ?? "openbot",
            hasSecret: setting?.hasSecret ?? false,
            lastEventAt: setting?.lastEventAt ?? null,
            lastStatus: setting?.lastStatus ?? null,
          };
        }),
    };
  }

  readonly createToken = Effect.fn("ConnectorAccess.createToken")(function* (this: ConnectorAccess, label: string) {
    const { token } = yield* this.#options.tokens.create(label);
    const base = this.#options.gateway.publicUrl();
    const created: CreatedConnectorToken = { state: this.state(), token, url: base ? `${base}/mcp/${token}` : null };
    return created;
  }).bind(this);

  readonly revokeToken = Effect.fn("ConnectorAccess.revokeToken")(function* (this: ConnectorAccess, id: string) {
    yield* this.#options.tokens.revoke(id);
    return this.state();
  }).bind(this);

  readonly configureInbox = Effect.fn("ConnectorAccess.configureInbox")(function* (
    this: ConnectorAccess,
    input: { routeId: string; scheme: ConnectorInboxScheme; secret?: string },
  ) {
    yield* this.#options.inbox.configure(input);
    return this.state();
  }).bind(this);
}
