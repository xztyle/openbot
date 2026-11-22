import { type BrowserTakeoverRequest, CHANNEL_CHATS_CAPABILITY } from "@openbot/contracts/ipc";
import { WORKSPACE_CAPABILITY } from "@openbot/contracts/team-protocol/workspace-v1";
import { createWorkspaceLinkUrl } from "@openbot/contracts/workspace-links";
import { Bot, CheckCheck, Search, Settings, Store, toast } from "@openbot/ui";
import { modelNameOf } from "@openbot/ui/components/model-name";
import { computeSidebarAgentStates } from "@openbot/ui/features/sidebar/sidebar-agent-states";
import type { WorkspaceMenuItem } from "@openbot/ui/features/workspace/workspace-types";
import { useText } from "@openbot/ui/text";
import { createEffect, createMemo, onCleanup, type ParentProps } from "solid-js";
import { useLayout } from "../../layout";
import { useNavigation } from "../../navigation";
import { useTurns } from "../../turns";
import { useAuth } from "../account/account-context";
import { useAgentActions } from "../agents/agent-actions";
import { agentThreadAttention } from "../agents/agent-thread-attention";
import { useAgents } from "../agents/agents-context";
import { agentsPort } from "../agents/agents-port";
import { needsYouItems, withAttentionItems } from "../agents/needs-you";
import { useBrowserTabs } from "../browser/browser-context";
import { useChannels } from "../channels/channels-context";
import { hostMessagingApi } from "../connectors/host-messaging-port";
import { localMessagingApi } from "../connectors/messaging-connector";
import { useConversation } from "../conversation/conversation-context";
import { hostEfficiencyCalls } from "../efficiency/efficiency-port";
import { hostPortfolioCalls } from "../portfolio/portfolio-port";
import { desktopChatCardCalls } from "../portfolio/WorkspaceChatCard";
import { WorkspaceRoutineFlows } from "../routine-flows/WorkspaceRoutineFlows";
import { desktopForkRequest, serverHasForkOwnerRoutes } from "../servers/desktop-fork-request";
import { serverRoleCanAdminister } from "../servers/server-capabilities";
import { useServerScope } from "../servers/server-scope";
import { useServerSettings } from "../servers/server-settings";
import { useServerSwitch } from "../servers/server-switch";
import { useServers } from "../servers/servers-context";
import { useSettings } from "../settings/settings-context";
import { desktopStorageHygieneCalls, serverHasStorageHygiene } from "../storage-hygiene/storage-hygiene-port";
import { isReaderAuthor } from "../team/reader-identity";
import { usePresence } from "../team/team-context";
import { hostTrustCalls } from "../trust/trust-port";
import { useUsage } from "../usage/usage-context";
import { createAgentMailboxesStore } from "./agent-mailboxes-store";
import { createConnectorAccessStore } from "./connector-access-store";
import { createOwnerAwayStore } from "./owner-away-store";
import { workspaceAttention } from "./workspace-attention";
import { WorkspaceProvider } from "./workspace-context";
import { createWorkspaceController, desktopMessageLink } from "./workspace-controller";
import { workspacePersonName } from "./workspace-model";
import { desktopArtifactThumbnailUrl } from "./workspace-sources";
import { createWorkspaceSupport } from "./workspace-support";

/**
 * Whether the desktop shows the workspace: the server has channels and the workspace routes, the
 * user did not pick the classic sidebar, and the Routines view is not on.
 */
export function useDesktopWorkspaceMode() {
  const channels = useChannels();
  const { activeServer, activeServerSupportsCapability } = useServers();
  const supported = createWorkspaceSupport({
    live: () =>
      channels.supported() &&
      activeServerSupportsCapability(CHANNEL_CHATS_CAPABILITY) &&
      (activeServer()?.kind === "local" || activeServerSupportsCapability(WORKSPACE_CAPABILITY)),
    serverId: () => activeServer()?.id,
    reconnecting: () => {
      const state = activeServer()?.state;
      return state === "connecting" || state === "offline";
    },
  });
  return {
    supported,
    // The workspace is the only layout. A server that connects shows it before it says what it
    // serves; only a server without the workspace (an older version) keeps the agent sidebar.
    on: () => supported() || activeServer()?.state === "connecting",
  };
}

/** The desktop workspace: its environment comes from the app's contexts. */
export function DesktopWorkspaceProvider(props: ParentProps) {
  const { t } = useText();
  const channels = useChannels();
  const layout = useLayout();
  const scope = useServerScope();
  const { activeServer, activeServerId, activeServerSupportsCapability } = useServers();
  const { agentList, activeAgent, userHiddenAgentIds, openAgentSetup, updateAgent, modelOptions } = useAgents();
  const { editAgent, deleteAgent } = useAgentActions();
  const { selectAgent, setGlobalSearchVisibility } = useNavigation();
  const { openServerSettings } = useServerSettings();
  const { setSkillsMarketplaceOpen } = useSettings();
  const { teamPresence, currentTeamMember } = usePresence();
  const { centralAuth } = useAuth();
  const { unreadReplies, recentReplies, markAllAgentMessagesRead, sendMessage } = useConversation();
  const usage = useUsage();
  const { activeTurns, queues, failedTurns, usageLimits, pendingPrompts, approvals, attentionItems } = useTurns();
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
  /** Every request that waits for the reader on this server: the host's list, and the ones this window holds. */
  const needsYou = createMemo(() =>
    needsYouItems({
      items: attentionItems(),
      prompts: Object.values(pendingPrompts()).flatMap((event) => (event?.type === "prompt" ? [event] : [])),
      approvals: approvals(),
      takeovers: takeovers(),
    }),
  );
  const agentStates = createMemo(() =>
    computeSidebarAgentStates({
      agentIds: agentList().map((agent) => agent.id),
      activeTurns: activeTurns(),
      queues: queues(),
      unreadReplies: unreadReplies(),
      recentReplies: recentReplies(),
      // A request that only the host's list names (the snapshot holds four) marks its agent too.
      ...withAttentionItems(
        agentThreadAttention({ agents: agentList(), pendingPrompts: pendingPrompts(), approvals: approvals() }),
        needsYou(),
        agentList(),
        t,
      ),
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
    return items;
  });
  const chatCardCalls = desktopChatCardCalls(() => activeServerId());
  // The owner views of a joined fork host (Today's decisions and guardrails, Money's budgets, Reviews,
  // Knowledge, Portfolio and Trust) send the browser client's routes through main.
  const forkRequest = desktopForkRequest(() => activeServerId());
  const efficiencyCalls = hostEfficiencyCalls(() => forkRequest);
  const portfolioCalls = hostPortfolioCalls(() => forkRequest);
  const trustCalls = hostTrustCalls(() => forkRequest);
  const forkOwner = () => serverHasForkOwnerRoutes(activeServer());
  // Quiet hours, focus and "When you're back", the MCP access links and the agents' mailboxes of the
  // owner, as the web client has them. The app in front tells the host so, as a browser tab does.
  const ownerRoutes = () => (scope.loaded() && forkOwner() ? forkRequest : undefined);
  const ownerAway = createOwnerAwayStore({
    request: ownerRoutes,
    enabled: () => ownerRoutes() !== undefined,
    hostId: () => activeServerId(),
    onWelcome: (welcome) =>
      toast(t("workspace.away.welcome", welcome), {
        action: { label: t("workspace.away.welcomeShow"), onClick: () => controller.openView("activity") },
      }),
  });
  const connectorAccess = createConnectorAccessStore({
    request: ownerRoutes,
    enabled: () => ownerRoutes() !== undefined,
  });
  const agentMailboxes = createAgentMailboxesStore({
    request: ownerRoutes,
    enabled: () => ownerRoutes() !== undefined,
  });
  const controller = createWorkspaceController({
    channels,
    agents: agentList,
    modelName: (provider, model) => modelNameOf(modelOptions(), provider, model),
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
    deleteAgent: (agentId) => deleteAgent(agentId),
    agentRuntime: () => ({ queues: queues(), failedTurns: failedTurns() }),
    setAgentManager: (agentId, managerId) => updateAgent(agentId, { reportsToAgentId: managerId }),
    inviteTeammates: serverRoleCanAdminister(activeServer())
      ? () => {
          const server = activeServer();
          if (server) openServerSettings(server.id, null, "members");
        }
      : undefined,
    openApps: serverRoleCanAdminister(activeServer())
      ? () => {
          const server = activeServer();
          if (server) openServerSettings(server.id, null, "connectors");
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
    saveWorkspaceSettings: (settings) => window.openbot.hostAdmin.setWorkspaceSettings(settings, activeServerId()),
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
    needsYou,
    localHost: local,
    openBrowserTab: (tabId) => activateBrowserTab(tabId),
    secrets: () => local() || serverRoleCanAdminister(activeServer()),
    // Owners and admins answer cards, as on the host; a joined server without the routes has none.
    chatCards: () => (local() || serverRoleCanAdminister(activeServer()) ? chatCardCalls : undefined),
    storageHygiene: () => {
      const server = activeServer();
      return serverHasStorageHygiene(server) ? desktopStorageHygieneCalls(() => server.id) : undefined;
    },
    openStorageRules: () => {
      const server = activeServer();
      if (server) openServerSettings(server.id, null, "storage");
    },
    ownerAway,
    connectorAccess,
    agentMailboxes,
    efficiency: () => (forkOwner() ? efficiencyCalls : undefined),
    portfolio: () => (forkOwner() ? portfolioCalls : undefined),
    trust: () => (forkOwner() ? trustCalls : undefined),
    openUsage: () => usage.openUsage(activeServerId(), null),
    // The command bar's "Ask Chief…": the owner's message in the agent's main chat, as its composer sends it.
    sendToAgent: async (agentId, text) => {
      const result = await sendMessage(text, [], null, { agentId, serverId: activeServerId() }, crypto.randomUUID());
      if ("error" in result) throw new Error(result.error);
    },
    storageKey: () => `${accountId() ?? "local"}:${activeServerId()}`,
    phone: () => false,
    // The desktop has no address bar: the view and the thread of the last session come back.
    rememberPlace: true,
    routines: {
      // The canvas says itself when a server does not serve routine flows.
      available: () => true,
      agentId: () => activeAgent()?.id ?? null,
      selectAgent: (agentId) => void selectAgent(agentId),
      pane: (actions) => <WorkspaceRoutineFlows onOpenAgent={actions.openAgent} />,
    },
  });
  // Routines from the page rail open the workspace's Routines view; the agent sidebar is gone.
  createEffect(
    () => layout.sidebarView() === "routines",
    (routines) => {
      if (!routines) return;
      layout.setSidebarView("agents");
      controller.openView("routines");
    },
  );
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
  // The Dock or taskbar icon counts what the web tab title counts. Main takes it only from the main
  // window, and a closed workspace clears it. A memo, because an effect runs again each time its
  // source runs, also with the same value: the unread state changes many times a second while agents
  // stream, and every run was an IPC call and a trace line.
  const badgeCount = createMemo(() => workspaceAttention(controller).count);
  createEffect(badgeCount, (count) => void window.openbot.notifications.setBadgeCount(count).catch(() => undefined));
  onCleanup(() => void window.openbot.notifications.setBadgeCount(0).catch(() => undefined));
  return <WorkspaceProvider controller={controller}>{props.children}</WorkspaceProvider>;
}
