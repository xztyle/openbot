/*
 * The agent mailboxes, as the web client reads them from the host (`agent-mailboxes-v1`, under
 * `fork-host-v1`): the business addresses bound to agents and the link to the mail Worker. Only the
 * owner and the admins have it. It is read when the Secrets view opens, not on a timer.
 */
import {
  AGENT_MAILBOXES_ROUTES,
  type AgentMailboxesState,
  type AgentMailboxInput,
  decodeAgentMailboxesState,
  decodeAgentMailSecret,
} from "@openbot/contracts/team-protocol/agent-mailboxes-v1";
import type { TeamApiRequest } from "@openbot/team-client/team-api-requests";
import { createSignal } from "solid-js";

export interface AgentMailboxesStore {
  /** The state, or null before the first read and on a host without it. */
  state: () => AgentMailboxesState | null;
  refresh: () => Promise<void>;
  save: (input: AgentMailboxInput) => Promise<void>;
  remove: (id: string) => Promise<void>;
  setWorker: (workerUrl: string) => Promise<void>;
  /** A new mail secret, shown once. */
  newSecret: () => Promise<string>;
}

export interface AgentMailboxesStoreInput {
  request: () => TeamApiRequest | undefined;
  /** The host is online, has `fork-host-v1`, and the reader is its owner or an admin. */
  enabled: () => boolean;
}

export function createAgentMailboxesStore(input: AgentMailboxesStoreInput): AgentMailboxesStore {
  const [state, setState] = createSignal<AgentMailboxesState | null>(null);
  const [unsupported, setUnsupported] = createSignal(false);

  function available(): TeamApiRequest | null {
    const request = input.request();
    return request && input.enabled() && !unsupported() ? request : null;
  }

  async function call(path: string, body: Record<string, string> = {}): Promise<void> {
    const request = available();
    if (!request) return;
    try {
      setState(await request("POST", path, decodeAgentMailboxesState, body));
    } catch (error) {
      // A host without the routes answers 404: it has none of this, and the client asks no more.
      if (error instanceof Error && "reference" in error && error.reference === "http/404") setUnsupported(true);
      throw error;
    }
  }

  return {
    state,
    refresh: () => call(AGENT_MAILBOXES_ROUTES.state).catch(() => undefined),
    save: ({ id, address, agentId, mode, displayName }) =>
      call(AGENT_MAILBOXES_ROUTES.save, {
        address,
        agentId,
        mode,
        ...(id ? { id } : {}),
        ...(displayName ? { displayName } : {}),
      }),
    remove: (id) => call(AGENT_MAILBOXES_ROUTES.remove, { id }),
    setWorker: (workerUrl) => call(AGENT_MAILBOXES_ROUTES.worker, { workerUrl }),
    newSecret: async () => {
      const request = available();
      if (!request) throw new Error("unsupported");
      const created = await request("POST", AGENT_MAILBOXES_ROUTES.secret, decodeAgentMailSecret, {});
      setState(created.state);
      return created.secret;
    },
  };
}
