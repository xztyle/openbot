import { type BrowserTakeoverRequest, CHANNEL_CHATS_CAPABILITY } from "@openbot/contracts/ipc";
import { WORKSPACE_CAPABILITY } from "@openbot/contracts/team-protocol/workspace-v1";
import { createWorkspaceLinkUrl } from "@openbot/contracts/workspace-links";
import { Bot, CheckCheck, PanelLeft, Search, Settings, Store, Workflow } from "@openbot/ui";
import { computeSidebarAgentStates } from "@openbot/ui/features/sidebar/sidebar-agent-states";
import type { WorkspaceMenuItem } from "@openbot/ui/features/workspace/workspace-types";
import { useText } from "@openbot/ui/text";
import { createEffect, createMemo, type ParentProps } from "solid-js";
import { useLayout } from "../../layout";
import { useNavigation } from "../../navigation";
import { useTurns } from "../../turns";
import { useAuth } from "../account/account-context";
import { useAgentActions } from "../agents/agent-actions";
import { agentThreadAttention } from "../agents/agent-thread-attention";
import { useAgents } from "../agents/agents-context";
import { agentsPort } from "../agents/agents-port";
import { useBrowserTabs } from "../browser/browser-context";
import { useChannels } from "../channels/channels-context";
import { hostMessagingApi } from "../connectors/host-messaging-port";
import { localMessagingApi } from "../connectors/messaging-connector";
import { useConversation } from "../conversation/conversation-context";
import { serverRoleCanAdminister } from "../servers/server-capabilities";
import { useServerScope } from "../servers/server-scope";
import { useServerSettings } from "../servers/server-settings";
import { useServerSwitch } from "../servers/server-switch";
import { useServers } from "../servers/servers-context";
import { useSettings } from "../settings/settings-context";
import { desktopStorageHygieneCalls, serverHasStorageHygiene } from "../storage-hygiene/storage-hygiene-port";
import { isReaderAuthor } from "../team/reader-identity";
import { usePresence } from "../team/team-context";
import { WorkspaceProvider } from "./workspace-context";
import { createWorkspaceController, desktopMessageLink } from "./workspace-controller";
import { setWorkspaceClassic, workspaceClassic } from "./workspace-mode";
import { workspacePersonName } from "./workspace-model";
import { desktopArtifactThumbnailUrl } from "./workspace-sources";

/**
 * Whether the desktop shows the workspace: the server has channels and the workspace routes, the
 * user did not pick the classic sidebar, and the Routines view is not on.
 */
export function useDesktopWorkspaceMode() {
  const channels = useChannels();
  const layout = useLayout();
  const { activeServer, activeServerSupportsCapability } = useServers();
  const supported = () =>
    channels.supported() &&
    activeServerSupportsCapability(CHANNEL_CHATS_CAPABILITY) &&
    (activeServer()?.kind === "local" || activeServerSupportsCapability(WORKSPACE_CAPABILITY));
  return {
    supported,
    on: () => supported() && !workspaceClassic() && layout.sidebarView() !== "routines",
  };
}

/** The desktop workspace: its environment comes from the app's contexts. */
export function DesktopWorkspaceProvider(props: ParentProps) {
  const { t } = useText();
  const channels = useChannels();
  const layout = useLayout();
  const scope = useServerScope();
  const { activeServer, activeServerId, activeServerSupportsCapability } = useServers();
  const { agentList, activeAgent, userHiddenAgentIds, openAgentSetup } = useAgents();
  const { editAgent } = useAgentActions();
  const { selectAgent, setGlobalSearchVisibility } = useNavigation();
  const { openServerSettings } = useServerSettings();
  const { setSkillsMarketplaceOpen } = useSettings();
  const { teamPresence, currentTeamMember } = usePresence();
  const { centralAuth } = useAuth();
  const { unreadReplies, recentReplies, markAllAgentMessagesRead } = useConversation();
  const { activeTurns, queues, failedTurns, usageLimits, pendingPrompts, approvals } = useTurns();
  const accountId = () => {
    const state = centralAuth();
    return state.status === "signed_in" ? state.user.id : null;
  };
  const local = () => activeServer()?.kind === "local";
  const { activateBrowserTab } = useBrowserTabs();
  const takeovers = createMemo(() => {
    const requests: BrowserTakeoverRequest[] = [];
    for (const event of Object.values(pendingPrompts()))
      if (event?.type === "browser-takeover-requested") requests.push(event.request);
    return requests;
  });
  const reader = createMemo(() => {
    const state = centralAuth();
    const member = currentTeamMember();
    const id = member?.id ?? (local() && accountId() ? `local-user:${accountId()}` : null);
    const server = activeServer();
    return {
      id,
      // The member's name, else the account's, as the account menu names it; the start of the email last.
      name: workspacePersonName({
        name: member?.name?.trim() || (state.status === "signed_in" ? state.user.name : null),
        email: member?.email ?? (state.status === "signed_in" ? state.user.email : null),
        username: member?.username,
      }),
      avatarUrl: (state.status === "signed_in" ? state.user.avatarUrl : null) ?? member?.avatarUrl ?? null,
      role: local() ? ("owner" as const) : (server?.role ?? "member"),
    };
  });
  const agentStates = createMemo(() =>
    computeSidebarAgentStates({
      agentIds: agentList().map((agent) => agent.id),
      activeTurns: activeTurns(),
      queues: queues(),
      unreadReplies: unreadReplies(),
      recentReplies: recentReplies(),
      ...agentThreadAttention({ agents: agentList(), pendingPrompts: pendingPrompts(), approvals: approvals() }),
      failedTurns: failedTurns(),
      usageLimits: usageLimits(),
    }),
  );
  const menu = createMemo((): WorkspaceMenuItem[] => {
    const server = activeServer();
    const items: WorkspaceMenuItem[] = [
      {
        id: "search",
        label: t("workspace.app.menu.search"),
        icon: <Search aria-hidden="true" />,
        onSelect: () => setGlobalSearchVisibility(true),
      },
      {
        id: "new-agent",
        label: t("workspace.app.menu.newAgent"),
        icon: <Bot aria-hidden="true" />,
        onSelect: () => {
          channels.close();
          openAgentSetup();
        },
      },
      {
        id: "marketplace",
        label: t("workspace.app.menu.marketplace"),
        icon: <Store aria-hidden="true" />,
        onSelect: () => setSkillsMarketplaceOpen(true),
      },
      {
        id: "routines",
        label: t("workspace.app.menu.routines"),
        icon: <Workflow aria-hidden="true" />,
        onSelect: () => layout.setSidebarView("routines"),
      },
      {
        id: "mark-read",
        label: t("workspace.app.menu.markAllRead"),
        icon: <CheckCheck aria-hidden="true" />,
        onSelect: () => {
          void markAllAgentMessagesRead();
          void channels.markAllRead();
        },
      },
    ];
    if (server)
      items.push({
        id: "server-settings",
        label: t("workspace.app.menu.serverSettings"),
        icon: <Settings aria-hidden="true" />,
        onSelect: () => openServerSettings(server.id, null),
      });
    items.push({
      id: "classic",
      label: t("workspace.app.menu.classic"),
      icon: <PanelLeft aria-hidden="true" />,
      onSelect: () => setWorkspaceClassic(true),
    });
    return items;
  });
  const controller = createWorkspaceController({
    channels,
    agents: agentList,
    hiddenAgentIds: userHiddenAgentIds,
    agentStates,
    people: () =>
      teamPresence()
        .members.filter((member) => !member.disabled)
        .map((member) => ({
          id: member.id,
          name: workspacePersonName(member),
          avatarUrl: member.avatarUrl ?? null,
          role: member.role,
          online: member.online,
        })),
    reader,
    isReader: (id) =>
      isReaderAuthor(id, {
        memberId: currentTeamMember()?.id ?? null,
        accountUserId: accountId(),
        onOwnComputer: local(),
      }),
    agentDmIsMainChat: () => reader().role === "owner",
    activeAgentId: () => activeAgent()?.id ?? null,
    openAgentChat: (agentId) => void selectAgent(agentId),
    openAgentSettings: (agentId) => editAgent(agentId),
    createAgent: () => {
      channels.close();
      openAgentSetup();
    },
    inviteTeammates: serverRoleCanAdminister(activeServer())
      ? () => {
          const server = activeServer();
          if (server) openServerSettings(server.id, null, "members");
        }
      : undefined,
    serverName: () => activeServer()?.name ?? t("sidebar.topbar.localServer"),
    connectionReady: () => scope.loaded(),
    menu,
    onHostEvent: (listener) => agentsPort().agent.onEvent(listener),
    approvals,
    messaging: () => {
      const server = activeServer();
      if (!server) return undefined;
      if (server.kind === "local") return localMessagingApi();
      return activeServerSupportsCapability("connectors-v1") && serverRoleCanAdminister(server)
        ? hostMessagingApi(() => server.id)
        : undefined;
    },
    workspaceSettings: () => window.openbot.hostAdmin.getWorkspaceSettings(activeServerId()),
    hostId: () => activeServerId() ?? null,
    artifactThumbnailUrl: (record) => {
      const server = activeServer();
      return server ? desktopArtifactThumbnailUrl(server.id, server.kind === "local", record) : undefined;
    },
    // The desktop has no page address; its link opens in this app.
    messageLink: (channelId, messageId, threadRootId) => {
      const serverId = activeServerId();
      return serverId ? desktopMessageLink(serverId, channelId, threadRootId ?? messageId) : null;
    },
    takeovers,
    localHost: local,
    openBrowserTab: (tabId) => activateBrowserTab(tabId),
    storageHygiene: () => {
      const server = activeServer();
      return serverHasStorageHygiene(server) ? desktopStorageHygieneCalls(() => server.id) : undefined;
    },
    openStorageRules: () => {
      const server = activeServer();
      if (server) openServerSettings(server.id, null, "storage");
    },
    storageKey: () => `${accountId() ?? "local"}:${activeServerId()}`,
    phone: () => false,
  });
  // A message link opened from outside the app: the scope of another server switched here, and
  // the link opens once the channel list is in. A channel the reader cannot see is not in the list,
  // so the link does nothing. With the classic sidebar the channel opens in the channel view.
  const workspaceMode = useDesktopWorkspaceMode();
  const { pendingWorkspaceLink, setPendingWorkspaceLink } = useServerSwitch();
  createEffect(
    () => {
      const link = pendingWorkspaceLink();
      return link && link.hostId === activeServerId() && channels.state.listed ? link : null;
    },
    (link) => {
      if (!link) return;
      setPendingWorkspaceLink(null);
      if (workspaceMode.on()) controller.openLink(createWorkspaceLinkUrl(link));
      else if (channels.state.channels.some((channel) => channel.id === link.channelId))
        void channels.open(link.channelId);
    },
  );
  return <WorkspaceProvider controller={controller}>{props.children}</WorkspaceProvider>;
}
