/*
 * The connector gateway settings, as the web client reads them from the host (`connector-access-v1`,
 * under `fork-host-v1`): the owner's MCP access links and who sends to each webhook routine. Only the
 * owner and the admins have it. It is read when the Secrets view opens, not on a timer.
 */
import {
  CONNECTOR_ACCESS_ROUTES,
  type ConnectorAccessState,
  type ConnectorInboxScheme,
  decodeConnectorAccessState,
  decodeCreatedConnectorToken,
} from "@openbot/contracts/team-protocol/connector-access-v1";
import type { TeamApiRequest } from "@openbot/team-client/team-api-requests";
import { createSignal } from "solid-js";

export interface ConnectorAccessStore {
  /** The state, or null before the first read and on a host without it. */
  state: () => ConnectorAccessState | null;
  refresh: () => Promise<void>;
  createToken: (label: string) => Promise<{ token: string; url: string | null }>;
  revokeToken: (id: string) => Promise<void>;
  setSender: (input: { routeId: string; scheme: ConnectorInboxScheme; secret?: string }) => Promise<void>;
}

export interface ConnectorAccessStoreInput {
  request: () => TeamApiRequest | undefined;
  /** The host is online, has `fork-host-v1`, and the reader is its owner or an admin. */
  enabled: () => boolean;
}

export function createConnectorAccessStore(input: ConnectorAccessStoreInput): ConnectorAccessStore {
  const [state, setState] = createSignal<ConnectorAccessState | null>(null);
  const [unsupported, setUnsupported] = createSignal(false);

  function available(): TeamApiRequest | null {
    const request = input.request();
    return request && input.enabled() && !unsupported() ? request : null;
  }

  /*
   * Each call counts one, and the state of an older call does not replace a newer one's: the read of
   * an opening view that answered after a save showed the list from before it.
   */
  let calls = 0;
  let shown = 0;
  const show = (mine: number, next: ConnectorAccessState) => {
    if (mine <= shown) return;
    shown = mine;
    setState(next);
  };

  async function call(path: string, body: Record<string, string> = {}): Promise<void> {
    const request = available();
    if (!request) return;
    const mine = ++calls;
    try {
      show(mine, await request("POST", path, decodeConnectorAccessState, body));
    } catch (error) {
      // A host without the routes answers 404: it has none of this, and the client asks no more.
      if (error instanceof Error && "reference" in error && error.reference === "http/404") setUnsupported(true);
      throw error;
    }
  }

  return {
    state,
    refresh: () => call(CONNECTOR_ACCESS_ROUTES.state).catch(() => undefined),
    createToken: async (label) => {
      const request = available();
      if (!request) throw new Error("unsupported");
      const mine = ++calls;
      const created = await request("POST", CONNECTOR_ACCESS_ROUTES.createToken, decodeCreatedConnectorToken, {
        label,
      });
      show(mine, created.state);
      return { token: created.token, url: created.url };
    },
    revokeToken: (id) => call(CONNECTOR_ACCESS_ROUTES.revokeToken, { id }),
    setSender: ({ routeId, scheme, secret }) =>
      call(CONNECTOR_ACCESS_ROUTES.inbox, { routeId, scheme, ...(secret ? { secret } : {}) }),
  };
}
