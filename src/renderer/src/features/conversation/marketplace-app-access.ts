import type { McpChatSnapshot } from "@openbot/contracts/team-protocol/mcp-chat-v1";
import { isPluginAppConfig } from "@openbot/ui/features/settings/marketplace-plugins";
import { createEffect, createSignal, createStore } from "solid-js";
import type { MarketplaceCalls } from "../settings/marketplace-calls";
import { MARKETPLACE_PLUGINS } from "../settings/marketplace-plugin-catalog";

/**
 * Where a Marketplace app stands for the open chat, as far as the host can say.
 *
 * `available`: no account of the app is on the host. `disabled`: accounts exist and every one is
 * turned off. `off`: an account is on, and this agent's chat has no access to it. `allowed`: the chat
 * can use an account. `unknown`: the answer is not here yet, or the host does not tell this client.
 */
export type MarketplaceAppAccessState = "unknown" | "available" | "disabled" | "off" | "allowed";

/** What a chat card of a suggested app reads. The card never grants anything: a click opens the app's page. */
export interface MarketplaceAppAccess {
  state: (appId: string) => MarketplaceAppAccessState;
  /** Starts reading what the cards need. A card calls it when it shows. */
  watch: () => void;
}

interface Read {
  /** The host and agent the answer is for. */
  key: string;
  /** The accounts of catalog apps, by app. Nothing else of a row is kept: a row holds credentials. */
  accounts: { slug: string; id: string; enabled: boolean }[];
  /** Null when the host has no per-chat limit, so every agent has every account that is on. */
  chat: McpChatSnapshot | null;
}

/**
 * Reads the host's MCP servers and, where the host limits apps per chat, the grants of the open
 * agent's chat. Both reads need an administrator, so a failed read is "unknown", never a guess. The
 * answer is read again when `refresh` runs, such as after the Marketplace or Apps for this chat closed.
 */
export function createMarketplaceAppAccess(options: {
  calls: () => MarketplaceCalls;
  /** The host that holds the apps. Absent: nothing to read. */
  serverId: () => string | undefined;
  agentId: () => string | undefined;
}): MarketplaceAppAccess & { refresh: () => void } {
  const [watched, setWatched] = createSignal(false);
  const [version, setVersion] = createSignal(0);
  const [read, setRead] = createStore<{ value: Read | null }>({ value: null });
  let requests = 0;
  const keyOf = (serverId: string, agentId: string) => `${serverId}\u0000${agentId}`;

  createEffect(
    () => {
      const serverId = options.serverId();
      const agentId = options.agentId();
      return watched() && serverId && agentId ? ([serverId, agentId, version()] as const) : null;
    },
    (inputs) => {
      if (!inputs) return;
      const [serverId, agentId] = inputs;
      const request = ++requests;
      const calls = options.calls();
      const chat = calls.chatApps?.(serverId);
      void Promise.all([
        calls.mcp.listMcpServers(serverId),
        chat ? chat.get({ kind: "agent", id: agentId }) : Promise.resolve(null),
      ]).then(
        ([servers, snapshot]) => {
          if (request !== requests) return;
          const accounts = servers.flatMap((row) => {
            const plugin = MARKETPLACE_PLUGINS.find((candidate) =>
              candidate.apps.some((app) => isPluginAppConfig(row, app)),
            );
            return plugin ? [{ slug: plugin.slug, id: row.id, enabled: row.enabled }] : [];
          });
          setRead((draft) => {
            draft.value = { key: keyOf(serverId, agentId), accounts, chat: snapshot };
          });
        },
        () => {
          if (request === requests)
            setRead((draft) => {
              draft.value = null;
            });
        },
      );
    },
  );

  return {
    watch: () => setWatched(true),
    refresh: () => setVersion((current) => current + 1),
    state: (appId) => {
      const answer = read.value;
      const serverId = options.serverId();
      const agentId = options.agentId();
      if (!MARKETPLACE_PLUGINS.some((plugin) => plugin.slug === appId)) return "unknown";
      if (!answer || !serverId || !agentId || answer.key !== keyOf(serverId, agentId)) return "unknown";
      const rows = answer.accounts.filter((row) => row.slug === appId);
      if (rows.length === 0) return "available";
      const on = rows.filter((row) => row.enabled);
      if (on.length === 0) return "disabled";
      if (!answer.chat) return "allowed";
      const chat = answer.chat;
      return on.some((row) => chat.grants.some((grant) => grant.connectionId === row.id)) ? "allowed" : "off";
    },
  };
}
