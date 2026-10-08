import {
  decodeMcpChatSnapshot,
  MCP_CHAT_ROUTES,
  type McpChatGrant,
  type McpChatSnapshot,
  type McpChatTarget,
} from "@openbot/contracts/team-protocol/mcp-chat-v1";
import type { TeamApiRequest } from "@openbot/team-client/team-api-requests";
import { useText } from "@openbot/ui/text";
import { createStore } from "solid-js";

interface ChatAppsState {
  open: boolean;
  loading: boolean;
  loaded: boolean;
  busy: boolean;
  error: string | null;
  snapshot: McpChatSnapshot;
}
export function createWebChatApps(request: () => TeamApiRequest) {
  const { t, errorMessage } = useText();
  const [state, setState] = createStore<ChatAppsState>({
    open: false,
    loading: false,
    loaded: false,
    busy: false,
    error: null,
    snapshot: { grants: [], connections: [] },
  });
  let target: McpChatTarget | null = null;
  let pinnedRequest: TeamApiRequest | null = null;
  let generation = 0;
  async function open(chat: McpChatTarget) {
    target = chat;
    pinnedRequest = request();
    const started = ++generation;
    setState((draft) => {
      draft.open = true;
      draft.loading = true;
      draft.loaded = false;
      draft.error = null;
      draft.snapshot = { grants: [], connections: [] };
    });
    try {
      const snapshot = await pinnedRequest("POST", MCP_CHAT_ROUTES.get, decodeMcpChatSnapshot, { target: { ...chat } });
      if (started === generation)
        setState((draft) => {
          draft.snapshot = snapshot;
          draft.loading = false;
          draft.loaded = true;
        });
    } catch (error) {
      if (started === generation)
        setState((draft) => {
          draft.error = errorMessage(error, t("mcp.chat.failed"));
          draft.loading = false;
        });
    }
  }
  function onMode(connectionId: string, mode: McpChatGrant["mode"] | "off") {
    const grants = state.snapshot.grants.filter((grant) => grant.connectionId !== connectionId);
    if (mode !== "off") grants.push({ connectionId, mode });
    setState((draft) => {
      draft.snapshot.grants = grants;
    });
  }
  async function save() {
    if (!target || !pinnedRequest || state.busy || state.loading || !state.loaded) return;
    setState((draft) => {
      draft.busy = true;
      draft.error = null;
    });
    try {
      await pinnedRequest("POST", MCP_CHAT_ROUTES.save, decodeMcpChatSnapshot, {
        target: { ...target },
        grants: state.snapshot.grants.map((grant) => ({ ...grant })),
      });
      setState((draft) => {
        draft.open = false;
        draft.busy = false;
      });
    } catch (error) {
      setState((draft) => {
        draft.error = errorMessage(error, t("mcp.chat.failed"));
        draft.busy = false;
      });
    }
  }
  return {
    state,
    open,
    onMode,
    save,
    close: () => {
      ++generation;
      setState((draft) => {
        draft.open = false;
      });
    },
  };
}
