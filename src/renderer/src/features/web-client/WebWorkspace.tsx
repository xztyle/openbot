import { isKnownAgentProvider } from "@openbot/contracts/agent-providers";
import type { AppAppearance } from "@openbot/contracts/app-appearance";
import type { AppLanguage } from "@openbot/contracts/app-language";
import { HOSTED_SERVER_CONTACT_URL } from "@openbot/contracts/hosted-servers";
import {
  type AddedAgent,
  type AgentProviderId,
  type AgentStatus,
  type AppInfo,
  CHANNEL_CHATS_CAPABILITY,
  type ChannelSummary,
  type ClientAgentModelOption,
  canAdministerServer,
  decodeAgentBackupModelSettings,
  decodeAgentHostSettings,
  decodeAgentTaskLimitSettings,
  isBackgroundAgent,
  type ServerConnectionState,
  type ServerSummary,
} from "@openbot/contracts/ipc";
import { AGENT_BACKUP_MODELS_ROUTES } from "@openbot/contracts/team-protocol/agent-backup-models-v1";
import { AGENT_HOST_SETTINGS_ROUTES } from "@openbot/contracts/team-protocol/agent-host-settings-v1";
import { AGENT_IMPORT_CAPABILITY } from "@openbot/contracts/team-protocol/agent-import-v1";
import { AGENT_TASK_LIMIT_ROUTES } from "@openbot/contracts/team-protocol/agent-task-limit-v1";
import { AGENT_TASKS_CAPABILITY } from "@openbot/contracts/team-protocol/agent-tasks-v1";
import { BROWSER_PROFILES_CAPABILITY } from "@openbot/contracts/team-protocol/browser-profiles-v1";
import { CONNECTORS_CAPABILITY } from "@openbot/contracts/team-protocol/connectors-v1";
import { CONTEXT_RESET_CAPABILITY } from "@openbot/contracts/team-protocol/context-reset-v1";
import { AGENT_HIDDEN_CAPABILITY, TEAM_AGENT_CREATE_MODEL_CAPABILITY } from "@openbot/contracts/team-protocol/current";
import { DISCORD_ACCESS_CAPABILITY } from "@openbot/contracts/team-protocol/discord-access-v1";
import {
  EVENT_CHECK_API_CAPABILITY,
  EVENT_CHECK_DELIVERY_CAPABILITY,
} from "@openbot/contracts/team-protocol/event-check-api-v1";
import { EVENT_CHECKS_CAPABILITY } from "@openbot/contracts/team-protocol/event-checks-v1";
import { EVENTS_CAPABILITY } from "@openbot/contracts/team-protocol/events-v1";
import { HOST_RELEASE_CAPABILITY } from "@openbot/contracts/team-protocol/host-release-v1";
import { HOSTED_SITES_CAPABILITY } from "@openbot/contracts/team-protocol/hosted-sites-v1";
import { MCP_CHAT_CAPABILITY } from "@openbot/contracts/team-protocol/mcp-chat-v1";
import { MCP_SIGN_IN_CAPABILITY } from "@openbot/contracts/team-protocol/mcp-sign-in-v1";
import { ROUTINE_FLOWS_CAPABILITY } from "@openbot/contracts/team-protocol/routine-flows-v1";
import { ROUTINE_RECOVERY_CAPABILITY } from "@openbot/contracts/team-protocol/routine-recovery-v1";
import { SIDE_QUESTION_CAPABILITY } from "@openbot/contracts/team-protocol/side-question-v1";
import { SIGN_IN_RELAY_CAPABILITY } from "@openbot/contracts/team-protocol/sign-in-relay-v1";
import { WEBHOOK_TESTS_CAPABILITY } from "@openbot/contracts/team-protocol/webhook-tests-v1";
import { resolveLocale } from "@openbot/i18n";
import { runTeamEffect } from "@openbot/team-client";
import { channelForThread } from "@openbot/team-client/channel-notifications";
import {
  cancelHostUpdate,
  checkHostForUpdate,
  checkHostRelease,
  clearStorage,
  deleteHostedSite,
  deleteStoredFile,
  getAgentAdminSettings,
  getHostAgentAccess,
  getHostAgentMemoryLimit,
  getHostPromptCacheTtl,
  getHostReleaseStatus,
  getHostTimezone,
  getHostUpdateStatus,
  getStorageUsage,
  listHostedSites,
  setHostAgentAccess,
  setHostAgentMemoryLimit,
  setHostPromptCacheTtl,
  setHostTimezone,
  setHostUpdateSettings,
  startHostUpdate,
  updateAgentAdminSettings,
} from "@openbot/team-client/team-admin-requests";
import { clearAgentContext, type TeamApiRequest } from "@openbot/team-client/team-api-requests";
import { classifyFailure } from "@openbot/telemetry";
import {
  Bot,
  Button,
  CheckCheck,
  hasVisibleToasts,
  PanelLeft,
  Search,
  Settings,
  Store,
  toast,
  Workflow,
} from "@openbot/ui";
import { accountUsageProviderRows } from "@openbot/ui/features/account/account-usage-view";
import { computeAgentAvatarMoods } from "@openbot/ui/features/agents/agent-avatar-mood";
import { createFirstAgentDraft, type FirstAgentDraft } from "@openbot/ui/features/agents/FirstAgentSetup";
import { BillingDialog } from "@openbot/ui/features/billing/BillingDialog";
import { createBillingStore } from "@openbot/ui/features/billing/billing-store";
import { LicenseSection } from "@openbot/ui/features/billing/LicenseSection";
import { createLicenseStore } from "@openbot/ui/features/billing/license-store";
import { unloadedHistory } from "@openbot/ui/features/conversation/ChatScrollRail";
import type { DiagramModelChoice } from "@openbot/ui/features/diagrams/DiagramNewAgentCard";
import { LeaveServerDialog } from "@openbot/ui/features/servers/LeaveServerDialog";
import { RestartServerDialog } from "@openbot/ui/features/servers/RestartServerDialog";
import type { ServerActionCallbacks } from "@openbot/ui/features/servers/ServerActionItems";
import {
  ConversationLoadNotice,
  ServerConnectionNotice,
  ServerPanelLoadNotice,
  serverWorkspacePhase,
} from "@openbot/ui/features/servers/ServerConnectionNotice";
import { ServerRail } from "@openbot/ui/features/servers/ServerRail";
import { ChatAppsDialog } from "@openbot/ui/features/settings/ChatAppsDialog";
import type { SettingsPagePlacement } from "@openbot/ui/features/settings/SettingsDialogShell";
import { createSettingsHostedServersStore } from "@openbot/ui/features/settings/stores/hosted-servers-store";
import { Sidebar } from "@openbot/ui/features/sidebar/Sidebar";
import { SidebarCommunityCard } from "@openbot/ui/features/sidebar/SidebarCommunityCard";
import {
  computeSidebarAgentStates,
  sidebarAgentWaits,
  sidebarChannelWaits,
} from "@openbot/ui/features/sidebar/sidebar-agent-states";
import type { SidebarView } from "@openbot/ui/features/sidebar/sidebar-types";
import { PageRail, type PageRailPage } from "@openbot/ui/features/window/PageRail";
import { useText } from "@openbot/ui/text";
import { Effect } from "effect";
import {
  createEffect,
  createMemo,
  createSignal,
  Loading,
  lazy,
  Match,
  onCleanup,
  onSettled,
  Show,
  Switch,
  untrack,
} from "solid-js";
// Copying a selection with a formula in it gives its LaTeX source, as on desktop.
import "katex/contrib/copy-tex";
import { WORKSPACE_CAPABILITY } from "@openbot/contracts/team-protocol/workspace-v1";
import { teamMemberName } from "@openbot/ui/features/team/TeamPersonAvatar";
import { actionToast } from "../../action-toast";
import { desktopAnalytics } from "../../analytics";
import { toAgentMessage } from "../../app-message-projection";
import { ProviderSignInDialogs } from "../../components/ProviderSignInDialogs";
import { globalSearchShortcutLabel, isGlobalSearchShortcut, keyboardShortcuts } from "../../global-search-shortcut";
import { LayoutProvider, useLayout } from "../../layout";
import { AgentUsagePanel, RoutineFlowsCanvas, ScheduleView, ServerOnboarding, TasksView } from "../../lazy-views";
import { PlatformProvider } from "../../platform";
import { currentDevicePlatform } from "../../send-shortcut-preference";
import { WorkspaceFrame } from "../../WorkspaceFrame";
import {
  ChannelCreateOverlay,
  GlobalSearchOverlay,
  JoinServerOverlay,
  MarketplaceOverlay,
  ServerSettingsOverlay,
  SharedAgentInstallOverlay,
} from "../../WorkspaceOverlayViews";
import { createUsageRefreshPoll } from "../account/usage-refresh-poll";
import { type NewAgentDraft, newAgentInput } from "../agents/agent-create-input";
import { type CreationPreference, resolveCreationModel } from "../agents/agent-creation-model";
import { claimErrorToast, readableAgentError } from "../agents/agent-error-text";
import { withHostAccountUsage, withHostProfileAccount } from "../agents/host-provider-accounts";
import { createRemoteAgentAdmin, updateRemoteAgent } from "../agents/remote-agent-admin";
import type { ServerBrowserProfilesOptions } from "../browser/ServerBrowserProfilesPanel";
import { createBrowserProfilesStore } from "../browser/stores/browser-profiles-store";
import { ChannelErrorNotice } from "../channels/ChannelConversationParts";
import { createChannelConversation } from "../channels/channel-conversation";
import { readChannelSelection, writeChannelSelection } from "../channels/channel-selection";
import { ChannelsControllerProvider } from "../channels/channels-context";
import { createChannelsController } from "../channels/channels-controller";
import { globalSearchChannels } from "../channels/global-search-channels";
import { createConnectorRegistry, createConnectorSet } from "../connectors/connector-registry";
import { hostMessagingApi } from "../connectors/host-messaging-port";
import { Conversation } from "../conversation/Conversation";
import { clearStoredQueueEdit } from "../conversation/composer-draft";
import {
  accountComposerDraftsKey,
  readStoredComposerDrafts,
  writeComposerDraftsOnChange,
} from "../conversation/composer-draft-storage";
import { createServerConversationState, createStableConversationState } from "../conversation/conversation-controller";
import { ConversationControllerProvider } from "../conversation/conversation-controller-context";
import { composerDraftKey } from "../conversation/conversation-keys";
import type { AgentSettingsRequest } from "../conversation/conversation-types";
import { createMarketplaceAppAccess } from "../conversation/marketplace-app-access";
import { webEventRoutinesApi } from "../conversation/routine-webhooks-api";
import {
  teammateRequestsFor,
  teammateRequestViews,
  toastTeammateAnswerError,
  withTeammateAttention,
} from "../conversation/teammate-requests";
import type { FilesPort } from "../files/files-port";
import { hostSetupProviderProps } from "../onboarding/host-setup-provider-props";
import { createRoutineTimezonePrompt } from "../schedule/routine-timezone-prompt";
import type { ScheduleRoutine } from "../schedule/SchedulePanel";
import { AddServerOverlay, type AddServerResume } from "../servers/AddServerOverlay";
import {
  createHostedUpsellOffline,
  HostedServerUpsell,
  hostedUpsellRoutineCreated,
  routineMadeThisSession,
} from "../servers/hosted-server-upsell-controller";
import type { HostMemoryLimitCalls } from "../servers/ServerMemoryLimitSetting";
import type { HostAgentAccessCalls } from "../servers/ServerRolesSection";
import type { ServerHostedSitesOptions, ServerSettingsSection } from "../servers/ServerSettingsModal";
import type { HostTimezoneCalls } from "../servers/ServerTimezoneSetting";
import type { HostUpdateCalls } from "../servers/ServerUpdatePanel";
import {
  remoteAdminServer,
  remoteUpdateServer,
  serverCanAdminister,
  serverRoleCanAdminister,
} from "../servers/server-capabilities";
import { createServerConnectionToast } from "../servers/server-connection-toast";
import {
  offerServerUpdate,
  ServerUpdateDialogHost,
  serverUpdateBadge,
  showServerUpdate,
} from "../servers/server-update-flow";
import { licenseContactUs, trackLicenseEvent } from "../settings/license-analytics";
import type { HostPromptCacheTtlCalls } from "../settings/provider-prompt-cache";
import { createCommunityCardVisibility } from "../sidebar/community-card";
import { hostStorageHygieneCalls, serverHasStorageHygiene } from "../storage-hygiene/storage-hygiene-port";
import { isReaderAuthor } from "../team/reader-identity";
import { RailHelpMenu } from "../window/RailHelpMenu";
import { ServerSettingsPageTitle, SettingsPageFrame } from "../window/SettingsPageFrame";
import type { SettingsKind, WindowPage } from "../window/window-page-context";
import { WorkspaceSidebarPane } from "../workspace/WorkspaceSidebarPane";
import { WorkspaceAgentFrame, WorkspaceChrome, WorkspaceMain } from "../workspace/WorkspaceView";
import { WorkspaceViewButton } from "../workspace/WorkspaceViewButton";
import { WorkspaceProvider } from "../workspace/workspace-context";
import { createWorkspaceController } from "../workspace/workspace-controller";
import { setWorkspaceClassic, workspaceClassic } from "../workspace/workspace-mode";
import { WebAgentSettings } from "./WebAgentSettings";
import { WebConnectComputer } from "./WebConnectComputer";
import { WebMobileNavigation, type WebMobilePane } from "./WebMobileNavigation";
import { createWebAccountCalls } from "./web-account";
import { createWebAccountUsage } from "./web-account-usage";
import { createWebAgentImportCalls } from "./web-agent-import";
import { openWebLink } from "./web-attachments";
import { createWebBillingCalls, createWebLicenseCalls } from "./web-billing";
import { webBitwardenConnectorPort } from "./web-bitwarden-connector";
import { createWebChannelsPort } from "./web-channels-runtime";
import { createWebChatApps } from "./web-chat-apps";
import { createWebChatHistory, type WebChatHistoryEntry } from "./web-chat-history";
import { createWebWorkspace, type WebRuntimeFactory } from "./web-client-context";
import { createWebConversationRuntime } from "./web-conversation-runtime";
import { createWebConversationView } from "./web-conversation-view";
import { createWebFileSaver } from "./web-file-download";
import { webGitHubConnectorPort } from "./web-github-connector";
import { createWebHostedServers } from "./web-hosted-server-state";
import { createWebAgentTemplateCalls, createWebMarketplaceCalls } from "./web-marketplace";
import { webHostMessaging } from "./web-messaging-connector";
import { createWebServerNotifications } from "./web-notification-preferences";
import { createWebNotificationRouting } from "./web-notification-routing";
import { requestWebNotificationPermission } from "./web-notifications";
import { webOnePasswordConnectorPort } from "./web-onepassword-connector";
import { createWebPaneHistory } from "./web-pane-history";
import { createWebProviderSettings, openWebDestination } from "./web-provider-admin";
import { createWebPush, webPushPreferences } from "./web-push";
import { webRoutineFlowsHost } from "./web-routine-flows";
import { webScheduleSource } from "./web-schedule";
import { createWebServerSettings } from "./web-server-settings";
import { webTasksSource } from "./web-tasks";
import { createWebUsagePort } from "./web-usage-port";

const CONNECTING_STATUS: AgentStatus = {
  phase: "starting",
  cliVersion: null,
  auth: { kind: "unknown" },
  capabilities: { chat: "unavailable", browser: "unavailable", computerUse: "unavailable" },
  message: null,
  fullAccess: true,
};
/**
 * What the web client reports as its build. The browser has no main process to ask, and the web frame
 * uses the macOS geometry.
 */
const WEB_APP_INFO: AppInfo = { name: "OpenBot", version: "web", platform: "darwin", variant: "production" };
/** Below this width the web shows one pane at a time; see `web-client.css`. */
const PHONE_QUERY = "(max-width: 720px)";
/** The account whose queue edit the browser may hold under `QUEUE_EDIT_STORAGE_KEY`. */
const QUEUE_EDIT_ACCOUNT_KEY = "openbot.web.queue-edit-account";

function newAgentAvatar(): Pick<FirstAgentDraft, "avatarSeed" | "avatarHue"> {
  const { avatarSeed, avatarHue } = createFirstAgentDraft();
  return { avatarSeed, avatarHue };
}

/** The pages of the connected host that cover the conversation. */
type HostPageView = "usage" | "schedule" | "tasks";

type WebWorkspaceProps = {
  accountId: string;
  accountEmail?: string;
  accountName?: string | null;
  accountAvatarUrl?: string | null;
  accountFetch: typeof fetch;
  onSessionCheck: () => Promise<void>;
  /** True when the account session has ended, so closing sends no remote session end. */
  accountSessionEnded?: () => boolean;
  onLogout: () => Promise<void>;
  createRuntime?: WebRuntimeFactory | undefined;
  /** A shared agent that a `/app?agent=<id>` link named. The dialog installs it only on a press. */
  agentTemplateId?: string | null;
  onAgentTemplateClose?: () => void;
  /** An invitation that a `/app` link named. The join dialog opens on it and still asks before it joins. */
  inviteUrl?: string | null;
  onInviteClose?: () => void;
  /** A plugin listing that a `/app?plugin=<slug>` link named. The marketplace opens on it. */
  pluginSlug?: string | null;
  onPluginSlugConsumed?: () => void;
  /** True on a return from the Stripe Customer Portal. The Billing dialog opens on it. */
  billingReturn?: boolean;
  onBillingReturnConsumed?: () => void;
  /** The server of a return from Stripe Checkout. The add server dialog opens on its progress. */
  hostingReturn?: AddServerResume | null;
  onHostingReturnConsumed?: () => void;
  /** The chat that a notification link named, `/app?host=<id>&chat=<id>`. It opens once the host is connected. */
  chatLink?: { hostId: string; agentId: string } | null;
  onChatLinkConsumed?: () => void;
  /** The interface language this browser keeps. Account settings change it. */
  language: AppLanguage;
  onChangeLanguage: (language: AppLanguage) => void;
  /** The theme this browser keeps. Account settings change it. */
  appearance: AppAppearance;
  onChangeAppearance: (appearance: AppAppearance) => void;
};

const WebAccountSettings = lazy(() => import("./WebAccountSettings"));

export function WebWorkspace(props: WebWorkspaceProps) {
  return (
    <PlatformProvider appInfo={WEB_APP_INFO}>
      <LayoutProvider>
        <WebWorkspaceFrame {...props} />
      </LayoutProvider>
    </PlatformProvider>
  );
}

function WebWorkspaceFrame(props: WebWorkspaceProps) {
  const text = useText();
  const { t, sourceText } = text;
  const layout = useLayout();
  const [status, setStatus] = createSignal<AgentStatus>(CONNECTING_STATUS);
  const [models, setModels] = createSignal<ClientAgentModelOption[]>([]);
  /**
   * Each model read takes the next number. A list is shown only when no later read has been shown,
   * so a slow first read cannot replace the list that a ready status read again. A host change marks
   * every number up to now as shown, so a list read for the previous host is dropped.
   */
  let modelsRequest = 0;
  let modelsShown = 0;
  function showModels(request: number, list: ClientAgentModelOption[]): void {
    if (request <= modelsShown) return;
    modelsShown = request;
    setModels(list);
  }
  const workspace = createWebWorkspace(props, {
    onStatus: (next) => {
      setStatus(next);
      // As in the desktop app: a ready status can follow a provider sign-in or a new endpoint, so
      // the models are read again.
      if (next.phase !== "ready") return;
      const request = ++modelsRequest;
      workspace.runtime.models().then(
        (list) => showModels(request, list),
        () => undefined,
      );
    },
  });
  const notifications = createWebServerNotifications(props.accountId);
  // A stored queue edit holds message text of the account that opened it. Another account must not restore it.
  try {
    if (window.localStorage.getItem(QUEUE_EDIT_ACCOUNT_KEY) !== props.accountId) clearStoredQueueEdit();
    window.localStorage.setItem(QUEUE_EDIT_ACCOUNT_KEY, props.accountId);
  } catch {
    clearStoredQueueEdit();
  }
  /** As on desktop: the host shows the other members which agent this account is writing to. */
  function setTyping(agentId: string, typing: boolean): void {
    workspace.runtime.setTyping(typing ? agentId : null, typing);
  }
  // The same controller as `createConversationController`, but its drafts are stored under this account's
  // key, so a reload, an evicted tab or an expired session does not lose unsent text.
  const controller = {
    ...createStableConversationState({ onTypingChange: setTyping }),
    ...createServerConversationState(),
  };
  const draftsKey = accountComposerDraftsKey(props.accountId);
  const storedDrafts = readStoredComposerDrafts(draftsKey);
  // After the first render: a signal that a component body writes would run the body again.
  onSettled(() => {
    // A restored queue edit keeps its own draft for the chat that it holds.
    controller.setDrafts((current) => ({ ...storedDrafts.agents, ...current }));
    controller.setChannelDrafts(storedDrafts.channels);
  });
  const draftStorage = writeComposerDraftsOnChange(
    {
      drafts: controller.drafts,
      channelDrafts: controller.channelDrafts,
      editingAgentId: controller.editingAgentId,
      editingServerId: controller.editingServerId,
      editingDraftBackup: controller.editingDraftBackup,
      unsentTexts: controller.pendingSends.unsentTexts,
    },
    draftsKey,
  );
  /**
   * Releases an open queue edit on the connected host first, so its message can run after sign-out.
   * When the host does not confirm, the stored edit stays for this account, which can release it after sign-in.
   */
  async function signOut() {
    const agentId = controller.editingAgentId();
    const deliveryId = controller.editingDeliveryId();
    const editId = controller.editingEditId();
    if (
      agentId &&
      deliveryId &&
      editId &&
      workspace.state.status === "online" &&
      controller.editingServerId() === workspace.state.host?.hostId
    ) {
      try {
        await workspace.runtime.editQueue({ agentId, action: "cancel", deliveryId, editId });
        // The controller stores an open edit when it closes. Clear it first, so sign-out leaves no text.
        controller.setEditingEditId(null);
        clearStoredQueueEdit();
      } catch {
        // Sign-out continues with the edit stored.
      }
    }
    await props.onLogout();
    // After the sign-out: a sign-out that fails keeps the account, so it keeps its drafts too.
    draftStorage.discard();
  }
  /** The host list was read and holds no computer to connect to. */
  const noHost = () => !workspace.state.host && (workspace.state.hostsLoaded || Boolean(workspace.state.hostsError));
  const hostOffline = () => !noHost() && !workspace.state.workspaceLoaded;
  // A host that restarts into an update drops the connection on purpose. That error is not news.
  const hostUpdating = () => workspace.state.hostRestart?.state === "restarting";
  createServerConnectionToast(() => {
    const host = workspace.state.host;
    return host
      ? {
          id: host.hostId,
          name: host.name,
          ready: workspace.state.status === "online",
          quiet: Boolean(
            !workspace.state.workspaceLoaded ||
              workspace.state.hostedSleep ||
              workspace.state.hostRestart?.state === "restarting" ||
              workspace.state.incompatibility,
          ),
        }
      : null;
  });
  // A solid effect runs its body for each new compute result, and the compute result is a new object each
  // time. The body compares with the last values itself: a retry that replaces the host object, or a
  // window focus that reads the host list again, must not clear what the user typed.
  let resetRevocation = workspace.state.revocationRevision;
  /** Undefined until the effect ran once; null while no host is open. */
  let resetHostId: string | null | undefined;
  createEffect(
    () => ({ host: workspace.state.host?.hostId ?? null, revocation: workspace.state.revocationRevision }),
    ({ host, revocation }) => {
      const revoked = revocation !== resetRevocation;
      // The first host of the page is no change: drafts that the browser restored belong to it.
      const hostChanged = resetHostId !== undefined && resetHostId !== null && host !== resetHostId;
      resetRevocation = revocation;
      resetHostId = host;
      controller.setComposerErrors({});
      controller.setConversationErrors({});
      if (!revoked && !hostChanged) return;
      controller.setChannelDrafts({});
      // A queue edit holds its message on its host until Save or Cancel. Keep the edit and its draft
      // after a reload or a host change, so the user can release the hold on that host.
      const editAgentId = untrack(controller.editingAgentId);
      const editServerId = untrack(controller.editingServerId);
      if (!revoked && editAgentId && editServerId) {
        const key = composerDraftKey({ agentId: editAgentId, serverId: editServerId });
        controller.setDrafts((drafts) => (drafts[key] ? { [key]: drafts[key] } : {}));
        return;
      }
      clearStoredQueueEdit();
      controller.setDrafts({});
      controller.setEditingDraftBackup(null);
      controller.setEditingOriginalAttachmentIds([]);
      controller.setEditingPendingSave(null);
      controller.setEditingAgentId(null);
      controller.setEditingServerId(null);
      controller.setEditingEditId(null);
      controller.setEditingDeliveryId(null);
    },
  );
  const [joinOpen, setJoinOpen] = createSignal(false);
  const hostedServers = createWebHostedServers({
    accountFetch: props.accountFetch,
    hosts: () => workspace.state.hosts,
    hostingReturn: () => props.hostingReturn,
    onHostingReturnConsumed: () => props.onHostingReturnConsumed?.(),
    onJoin: () => setJoinOpen(true),
  });
  const [creating, setCreating] = createSignal(false);
  /** The new agent form's avatar. The first-agent row in an empty sidebar shows it. */
  const [agentAvatar, setAgentAvatar] = createSignal(newAgentAvatar());
  const [mobilePane, setMobilePane] = createSignal<WebMobilePane>("conversation");
  const [settingsRequest, setSettingsRequest] = createSignal<AgentSettingsRequest | null>(null);
  const account = createMemo(() => ({
    id: props.accountId,
    email: props.accountEmail ?? "",
    name: props.accountName ?? null,
    avatarUrl: props.accountAvatarUrl ?? null,
  }));
  const accountCalls = createWebAccountCalls(props.accountFetch, props.onSessionCheck);
  const [accountSettingsOpen, setAccountSettingsOpen] = createSignal(false);
  /** The settings pages stay mounted after their first open, so a closed page gives the focus back, as on desktop. */
  const [accountSettingsLoaded, setAccountSettingsLoaded] = createSignal(false);
  const [serverSettingsLoaded, setServerSettingsLoaded] = createSignal(false);
  const usageReading = createWebAccountUsage({
    workspace,
    status,
    t,
  });
  /** The opened host has its own connection. Another host shows its status connection, as on mobile. */
  function hostState(hostId: string): ServerConnectionState {
    if (hostId === workspace.state.host?.hostId) return workspace.state.status;
    const state = workspace.state.hostStates[hostId];
    // Without status connections (no BroadcastChannel), nothing will report this host.
    if (!workspace.runtime.hosts) return "offline";
    return !state || state === "unknown" ? "connecting" : state;
  }
  const servers = createMemo<ServerSummary[]>(() =>
    workspace.orderedHosts().map((host) => {
      const active = host.hostId === workspace.state.host?.hostId;
      const incompatibility =
        active && workspace.state.incompatibility?.hostId === host.hostId ? workspace.state.incompatibility : null;
      const notice = notifications.state(host.hostId);
      return {
        id: host.hostId,
        name: host.name,
        kind: "remote",
        role: host.role,
        apiUrl: null,
        logoUrl: host.logoKey
          ? `/api/browser/v2/remote/hosts/${encodeURIComponent(host.hostId)}/logo?v=${encodeURIComponent(host.logoKey)}`
          : null,
        active,
        state: incompatibility ? "incompatible" : hostState(host.hostId),
        // Only the opened host has a known sleep state.
        hostedSleep: active ? workspace.state.hostedSleep : null,
        hostedIssue: active ? workspace.state.hostedIssue : null,
        hostedStart: active ? workspace.state.hostedStart : null,
        notificationsMuted: notice.muted,
        notificationsMutedUntil: notice.mutedUntil,
        notificationLevel: notice.level,
        remoteDesktopAvailable: false,
        ...(host.memberLimit === undefined ? {} : { memberLimit: host.memberLimit }),
        ...(host.hosted === undefined ? {} : { hosted: host.hosted }),
        compatibility: {
          localAppVersion: "web",
          hostAppVersion: incompatibility?.hostAppVersion ?? null,
          localProtocol: { minimum: 3, maximum: 3 },
          hostProtocol: incompatibility?.hostProtocol ?? null,
          negotiatedProtocol: incompatibility ? null : 3,
          capabilities: workspace.state.capabilities,
        },
        issue: incompatibility
          ? { code: incompatibility.code, message: incompatibility.message, retryable: true }
          : null,
      };
    }),
  );
  const server = createMemo(() => servers().find((item) => item.active));
  const blockedServer = createMemo(() => {
    const current = server();
    return current?.state === "incompatible" ? current : null;
  });
  /**
   * A web build that is older than its host, or a connection that no retry can fix, ends only with a new
   * page. The cached page can be that old build, so the notice offers a reload.
   */
  const reloadSuggested = () => {
    if (noHost() || workspace.state.status === "online") return false;
    if (blockedServer()) return workspace.state.incompatibility?.code === "client_update_required";
    // The full-screen notice of a workspace that never loaded has its own actions.
    return (
      workspace.state.workspaceLoaded &&
      workspace.state.recovery?.phase === "suspended" &&
      !workspace.state.hostedSleep &&
      !workspace.state.hostedIssue
    );
  };
  // A phone shows the sidebar as a full pane, so it is never compact there.
  const phoneQuery = window.matchMedia?.(PHONE_QUERY);
  const [phone, setPhone] = createSignal(phoneQuery?.matches ?? false);
  onSettled(() => {
    const update = (event: MediaQueryListEvent) => setPhone(event.matches);
    phoneQuery?.addEventListener("change", update);
    return () => phoneQuery?.removeEventListener("change", update);
  });
  const compact = () => !phone() && layout.leftPanelCompact();
  // On a phone the back button goes from a chat to the list of agents, as in a native app. It also closes
  // a dialog, the settings or a host page that covers the pane, before it leaves the pane.
  const paneHistory = createWebPaneHistory({
    pane: mobilePane,
    setPane: setMobilePane,
    closeOverlay: closeOverlays,
  });
  createEffect(phone, (onPhone) => {
    if (onPhone) paneHistory.start();
    else paneHistory.stop();
  });
  createEffect(mobilePane, (pane) => paneHistory.sync(pane));
  onCleanup(paneHistory.stop);
  /** The Usage, Schedule or Tasks page of the connected host. As on desktop, it follows a host switch. */
  const [hostPage, setHostPage] = createSignal<{ view: HostPageView; trigger: HTMLElement | null } | null>(null);
  /** Only the connected host answers, so another host is connected first, as for its settings. */
  async function openHostPage(serverId: string, view: HostPageView, trigger: HTMLElement | null) {
    if (server()?.id !== serverId) {
      const host = workspace.state.hosts.find((item) => item.hostId === serverId);
      if (!host) return;
      chatHistory.userOpensServer(serverId);
      await workspace.connect(host);
      if (server()?.id !== serverId) return;
    }
    setMobilePane("conversation");
    setAccountSettingsOpen(false);
    serverSettings.setOpen(false);
    setHostPage({ view, trigger });
  }
  function closeHostPage() {
    const trigger = hostPage()?.trigger;
    setHostPage(null);
    queueMicrotask(() => {
      if (trigger?.isConnected) trigger.focus({ preventScroll: true });
    });
  }
  const usageCalls = createWebUsagePort(workspace, hostRequest, servers);
  async function openNotified(hostId: string, agentId: string) {
    setMobilePane("conversation");
    if (hostId !== workspace.state.host?.hostId) {
      const host = workspace.state.hosts.find((item) => item.hostId === hostId);
      if (!host) return;
      // The first chat of the server does not take the entry of the chat on screen.
      chatHistory.userOpens({ hostId, kind: "agent", id: agentId });
      await workspace.connect(host);
    }
    if (workspace.state.host?.hostId === hostId && workspace.state.agents.some((agent) => agent.id === agentId))
      await select(agentId);
  }
  // The host sends push notifications to this browser when the user turned them on for that host.
  const push = createWebPush({
    accountId: props.accountId,
    hostId: () => workspace.state.host?.hostId ?? null,
    online: () => workspace.state.status === "online",
    capabilities: () => workspace.state.capabilities,
    request: () => workspace.runtime.admin?.request,
    notificationState: notifications.state,
    locale: () => resolveLocale(props.language, navigator.language),
    onOpenChat: (hostId, agentId) => void openNotified(hostId, agentId),
  });
  onSettled(() => push.listen());
  // The host knows only what this browser told it, so a new level, a mute or a language goes to it.
  createEffect(
    () => {
      const hostId = workspace.state.host?.hostId;
      return {
        online: workspace.state.status === "online",
        choices: hostId
          ? JSON.stringify(
              webPushPreferences(notifications.state(hostId), resolveLocale(props.language, navigator.language)),
            )
          : "",
      };
    },
    ({ online }) => {
      if (online) void push.sync();
    },
  );
  // A notification that opened the app names a chat. It opens once that host is connected.
  createEffect(
    () => ({
      link: props.chatLink,
      hostsLoaded: workspace.state.hostsLoaded,
      hostId: workspace.state.host?.hostId,
      loaded: workspace.state.workspaceLoaded,
    }),
    ({ link, hostsLoaded, hostId, loaded }) => {
      if (!link || !hostsLoaded) return;
      if (hostId === link.hostId && loaded) {
        props.onChatLinkConsumed?.();
        void openNotified(link.hostId, link.agentId);
      } else if (hostId !== link.hostId) {
        if (workspace.state.hosts.some((host) => host.hostId === link.hostId)) selectServer(link.hostId);
        else props.onChatLinkConsumed?.();
      }
    },
  );
  async function openNotifiedChannel(hostId: string, channelId: string) {
    setMobilePane("conversation");
    chatHistory.userOpens({ hostId, kind: "channel", id: channelId });
    if (hostId !== workspace.state.host?.hostId) {
      const host = workspace.state.hosts.find((item) => item.hostId === hostId);
      if (!host) return;
      await workspace.connect(host);
    }
    if (workspace.state.host?.hostId === hostId) await channels.open(channelId);
  }
  const { setMuted, setNotificationLevel, notifyChannelReplies } = createWebNotificationRouting({
    workspace,
    notifications,
    t,
    onOpen: (hostId, agentId) => void openNotified(hostId, agentId),
    pushes: push.pushes,
    onOpenChannel: (hostId, channelId) => void openNotifiedChannel(hostId, channelId),
    // Only the open host has a channel list. A prompt of another host names the agent only.
    channelForThread: (hostId, threadId) =>
      hostId === workspace.state.host?.hostId
        ? channelForThread(
            untrack(() => channels.state.channels),
            threadId,
          )
        : null,
  });
  const [searchOpen, setSearchOpen] = createSignal(false);
  const communityCard = createCommunityCardVisibility();
  const [messageFocusRequest, setMessageFocusRequest] = createSignal<{
    agentId: string;
    messageId: string;
    nonce: number;
  } | null>(null);
  onSettled(() => {
    const toggleSearch = (event: KeyboardEvent) => {
      if (!isGlobalSearchShortcut(event)) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      setSearchOpen((open) => !open);
    };
    window.addEventListener("keydown", toggleSearch);
    return () => window.removeEventListener("keydown", toggleSearch);
  });
  async function searchAllMessages(query: string, cursor?: string) {
    if (workspace.state.status !== "online") return { results: [], nextCursor: null };
    const page = await workspace.runtime.search(undefined, query, cursor);
    return {
      results: page.results.map((result) => ({
        agentId: result.agentId,
        message: toAgentMessage(result.message, result.agentId),
      })),
      total: page.total,
      nextCursor: page.nextCursor,
    };
  }
  /** Opens an agent at one message, for a global search result and a stored file's message. */
  async function openMessage(agentId: string, messageId: string) {
    setMobilePane("conversation");
    await workspace.run(async () => {
      await select(agentId);
      if (workspace.state.selectedId !== agentId) return;
      await workspace.openSearchMessage(messageId);
      setMessageFocusRequest({ agentId, messageId, nonce: Date.now() });
    });
  }
  /** The admin requests of the connected host. A call for another server is refused, not redirected. */
  function hostRequest(serverId?: string): TeamApiRequest {
    const admin = workspace.runtime.admin;
    const current = untrack(server);
    if (!admin || !current || (serverId !== undefined && serverId !== current.id))
      throw new Error(t("webClient.error.connectServerFirst"));
    const pinnedId = current.id;
    return (method, path, decode, body) => {
      if (untrack(server)?.id !== pinnedId) throw new Error(t("webClient.error.connectServerFirst"));
      return admin.request(method, path, decode, body);
    };
  }
  // The events routes answer only an owner or admin. A member keeps the released routine routes.
  const eventsEnabled = () =>
    workspace.state.capabilities.includes(EVENTS_CAPABILITY) && canAdministerServer(workspace.state.host?.role);
  // The same owner or admin reads and saves `missedPolicy` and the missed-run history on such a host.
  const routineRecoveryEnabled = () =>
    eventsEnabled() && workspace.state.capabilities.includes(ROUTINE_RECOVERY_CAPABILITY);
  // The same owner or admin asks such a host to send a test event to a webhook routine.
  const webhookTestsEnabled = () => eventsEnabled() && workspace.state.capabilities.includes(WEBHOOK_TESTS_CAPABILITY);
  const providerAdmin = createWebProviderSettings({
    server: () => (workspace.runtime.admin ? server() : undefined),
    request: hostRequest,
    status,
    setStatus,
    readStatus: () => workspace.runtime.status(),
    browser: workspace.runtime.browser,
    agents: () => workspace.profiles(),
  });
  const providerSettings = providerAdmin.settings;
  /** The usage of the providers' own sign-ins, with that of the host's other accounts. */
  const accountUsage = () => withHostAccountUsage(usageReading.accountUsage(), providerAdmin.hostAccounts.limits());
  /** The plan limits of each provider account, for the rings of the rail. */
  const usageRows = createMemo(() => accountUsageProviderRows(accountUsage(), providerAdmin.status().providers, text));
  // As on desktop. The first reading for a target comes from `createWebAccountUsage`.
  createUsageRefreshPoll({
    target: () => (usageReading.usageReady() ? usageReading.usageTargetKey() : null),
    refreshAtStart: false,
    refresh: () => {
      void providerAdmin.hostAccounts.refreshUsage().catch(() => undefined);
      void usageReading.refreshUsage().catch(() => undefined);
    },
  });
  const connectFromComposer = (provider: AgentProviderId) =>
    providerSettings()?.connection?.connect(provider, "composer");
  /** Whether the composer's sign-in notice can connect the agent's provider from this tab. */
  const composerSignIn = () => {
    const provider = conversationAgent()?.provider;
    return (
      provider !== undefined &&
      isKnownAgentProvider(provider) &&
      (providerSettings()?.connection?.connectKind(provider) ?? null) !== null
    );
  };
  const runtime = createWebConversationRuntime(
    workspace.runtime,
    () => workspace.state.host?.hostId ?? "",
    workspace.runtime.admin ? () => hostRequest() : undefined,
    workspace.onHostEvent,
    eventsEnabled,
    () =>
      workspace.state.capabilities.includes("agent-session-settings-v1") &&
      canAdministerServer(workspace.state.host?.role),
    () =>
      workspace.state.capabilities.includes(SIGN_IN_RELAY_CAPABILITY) &&
      canAdministerServer(workspace.state.host?.role),
    routineRecoveryEnabled,
    () => workspace.state.capabilities.includes(SIDE_QUESTION_CAPABILITY),
    webhookTestsEnabled,
    () => workspace.state.capabilities.includes(BROWSER_PROFILES_CAPABILITY),
    () => eventsEnabled() && workspace.state.capabilities.includes(EVENT_CHECKS_CAPABILITY),
    () => workspace.state.capabilities.includes(EVENT_CHECK_API_CAPABILITY),
    () => workspace.state.capabilities.includes(EVENT_CHECK_DELIVERY_CAPABILITY),
  );
  const remoteAgentAdmin = createRemoteAgentAdmin(
    () => {
      const current = server();
      const agent = workspace.selected();
      return current && agent ? { server: current, agentId: agent.id, updatedAt: agent.updatedAt ?? null } : null;
    },
    () => ({
      getAgentHostSettings: (agentId, serverId) =>
        hostRequest(serverId)("POST", AGENT_HOST_SETTINGS_ROUTES.settings, decodeAgentHostSettings, { agentId }),
      updateAgentHostSettings: (input, serverId) =>
        hostRequest(serverId)("POST", AGENT_HOST_SETTINGS_ROUTES.update, decodeAgentHostSettings, { ...input }),
      getAgentBackupModels: (agentId, serverId) =>
        hostRequest(serverId)("POST", AGENT_BACKUP_MODELS_ROUTES.settings, decodeAgentBackupModelSettings, {
          agentId,
        }),
      updateAgentBackupModels: ({ agentId, backupModels }, serverId) =>
        hostRequest(serverId)("POST", AGENT_BACKUP_MODELS_ROUTES.update, decodeAgentBackupModelSettings, {
          agentId,
          backupModels: backupModels && {
            automatic: backupModels.automatic,
            order: backupModels.order.map(({ provider, model, providerAccountId }) => {
              const choice: Record<string, string> = { provider, model };
              if (providerAccountId !== undefined) choice.providerAccountId = providerAccountId;
              return choice;
            }),
          },
        }),
      getAgentTaskLimit: (agentId, serverId) =>
        hostRequest(serverId)("POST", AGENT_TASK_LIMIT_ROUTES.settings, decodeAgentTaskLimitSettings, { agentId }),
      updateAgentTaskLimit: ({ agentId, taskLimit }, serverId) =>
        hostRequest(serverId)("POST", AGENT_TASK_LIMIT_ROUTES.update, decodeAgentTaskLimitSettings, {
          agentId,
          taskLimit,
        }),
      getAgentAdminSettings: (agentId, serverId) =>
        runTeamEffect(
          getAgentAdminSettings(hostRequest(serverId), agentId).pipe(Effect.mapError((error) => error.cause)),
        ),
      updateAgentAdminSettings: (input, serverId) =>
        runTeamEffect(
          updateAgentAdminSettings(hostRequest(serverId), input).pipe(Effect.mapError((error) => error.cause)),
        ),
    }),
  );
  /** The Team API agent summary has no access, so the agent shows the host's answer. */
  const conversationAgent = createMemo(() => {
    const selected = workspace.selected();
    const host = providerAdmin.hostAccounts.host();
    const agent = selected && host ? withHostProfileAccount(selected, host) : selected;
    const settings = remoteAgentAdmin.settings();
    const automation = remoteAgentAdmin.automation();
    const backupModels = remoteAgentAdmin.backupModels();
    const usageLimitReturn = remoteAgentAdmin.usageLimitReturn();
    const taskLimit = remoteAgentAdmin.taskLimit();
    return agent
      ? {
          ...agent,
          ...(settings ? { access: settings.access } : {}),
          ...(automation === undefined ? {} : { allowAutomation: automation }),
          ...(backupModels ? { backupModels } : {}),
          ...(usageLimitReturn ? { usageLimitReturn } : {}),
          ...(typeof taskLimit === "number" ? { taskLimit } : {}),
        }
      : agent;
  });
  const serverSettings = createWebServerSettings({
    server,
    admin: () => workspace.runtime.admin,
    presence: () => workspace.state.presence,
    refreshHosts: () => workspace.refreshHosts(),
    relaySupported: () => workspace.state.capabilities.includes(SIGN_IN_RELAY_CAPABILITY),
  });
  /** The page in the card, as on desktop. The compatibility screen wins over the host pages, so its Retry stays in reach. */
  const page = createMemo<WindowPage>(() => {
    if (serverSettings.state.open && server()) return "server-settings";
    if (accountSettingsOpen()) return "settings";
    const host = hostPage();
    return host && server() && !blockedServer() ? host.view : "agents";
  });
  /** Whether a page other than the agents covers the conversation. A message there is not seen. */
  const pageCovered = () => page() !== "agents";
  /**
   * As on desktop: the Tasks page shows in the middle pane, and wins over the other panes. The agent list
   * is hidden each time the page opens, until the user shows it. A row of the list closes the page, as
   * each row calls `showAgents`.
   */
  const tasksOpen = () => page() === "tasks";
  const [tasksAgentsOpen, setTasksAgentsOpen] = createSignal(false);
  createEffect(page, (next) => {
    if (next !== "tasks") setTasksAgentsOpen(false);
  });
  /** The list stays while a connection screen covers the page: the screen does not span the sidebar. */
  const tasksAgentsHidden = () =>
    tasksOpen() &&
    !tasksAgentsOpen() &&
    workspace.state.status === "online" &&
    !workspace.state.panelsFailed &&
    !hostOffline() &&
    !blockedServer();
  /** Shows the agents and closes the other pages. */
  function showAgents() {
    setAccountSettingsOpen(false);
    serverSettings.setOpen(false);
    setHostPage(null);
  }
  function openAccountSettings() {
    // On a phone the page shows in the conversation pane.
    setMobilePane("conversation");
    setHostPage(null);
    serverSettings.setOpen(false);
    setAccountSettingsLoaded(true);
    setAccountSettingsOpen(true);
  }
  /** The elements of the settings page that the settings panel shows in. The page sets them. */
  const [settingsMounts, setSettingsMounts] = createSignal<SettingsPagePlacement | undefined>();
  /** Where the panel of a settings page shows, or nothing while that page is not on screen. */
  function settingsPlacement(kind: SettingsKind): SettingsPagePlacement | undefined {
    const mounts = settingsMounts();
    if (!mounts || page() !== (kind === "personal" ? "settings" : "server-settings")) return undefined;
    return mounts;
  }
  const scheduleSource = webScheduleSource(workspace, hostRequest);
  const tasksSource = webTasksSource(workspace, hostRequest);
  const tasksSupported = () => workspace.state.capabilities.includes(AGENT_TASKS_CAPABILITY);
  const marketplaceCalls = createWebMarketplaceCalls(
    props.accountFetch,
    hostRequest,
    () => workspace.state.capabilities,
  );
  // The host's connectors, for an owner or admin. The web client has no computer of its own.
  const connectorTarget = createMemo(() => remoteAdminServer(server(), CONNECTORS_CAPABILITY));
  const githubPort = webGitHubConnectorPort(() => hostRequest());
  const onePasswordPort = webOnePasswordConnectorPort(() => hostRequest());
  const bitwardenPort = webBitwardenConnectorPort(() => hostRequest());
  const webMessaging = webHostMessaging(hostRequest, () =>
    workspace.state.capabilities.includes(DISCORD_ACCESS_CAPABILITY),
  );
  onCleanup(webMessaging.dispose);
  const connectors = createConnectorRegistry(server, {
    computer: {},
    server: createConnectorSet(
      {
        github: () => githubPort,
        onePassword: () => onePasswordPort,
        bitwarden: () => bitwardenPort,
        messaging: hostMessagingApi(
          () => connectorTarget()?.id,
          () => webMessaging.api,
        ),
      },
      { agents: workspace.profiles, hostName: () => server()?.name },
    ),
  });
  /** The app that a suggestion card opens in Marketplace. A plugin link from the address comes in props. */
  const [suggestedApp, setSuggestedApp] = createSignal<{ appId: string; connect: boolean } | null>(null);
  const agentTemplateCalls = createWebAgentTemplateCalls(props.accountFetch, hostRequest);
  const [marketplaceOpen, setMarketplaceOpen] = createSignal(false);
  // A sign-in can change in another tab, so each window reads the connectors again when it opens.
  createEffect(
    () => marketplaceOpen() || serverSettings.state.open,
    (open) => {
      if (open) connectors.reload();
    },
  );
  // Which app accounts each chat may use, for an owner or admin of a host with chat permissions.
  const chatApps = createWebChatApps(hostRequest);
  const chatAppsSupported = () =>
    workspace.runtime.admin !== undefined && workspace.state.capabilities.includes(MCP_CHAT_CAPABILITY);
  /* What the host holds of a suggested app, so its card tells whether this chat can use it. */
  const appAccess = createMarketplaceAppAccess({
    calls: () => marketplaceCalls,
    serverId: () => (workspace.runtime.admin ? server()?.id : undefined),
    agentId: () => workspace.state.selectedId ?? undefined,
  });
  /* Connecting an app, allowing it or turning it off happens in these two windows. */
  createEffect(
    () => marketplaceOpen() || chatApps.state.open,
    (open, previous) => {
      if (previous && !open) appAccess.refresh();
    },
  );
  // A link opens its overlay once it has arrived, which can be after sign-in.
  createEffect(
    () => props.inviteUrl,
    (inviteUrl) => {
      if (inviteUrl) setJoinOpen(true);
    },
  );
  createEffect(
    () => props.pluginSlug,
    (slug) => {
      if (slug) setMarketplaceOpen(true);
    },
  );
  const [billingOpen, setBillingOpen] = createSignal(false);
  const billingCalls = createWebBillingCalls(props.accountFetch);
  const billing = createBillingStore(() => billingCalls, billingOpen);
  const licenseCalls = createWebLicenseCalls(props.accountFetch);
  const license = createLicenseStore(() => licenseCalls, billingOpen, trackLicenseEvent);
  // The web client has no Hosted servers settings, so a server whose plan ended is renewed or deleted in Billing.
  const billingHostedServers = createSettingsHostedServersStore(
    {
      get open() {
        return billingOpen();
      },
      hostedServersApi: hostedServers.calls,
    },
    billingOpen,
  );
  /** Billing holds the hosted servers on the web, so the server menu deletes a server there. */
  function deleteHostedServer(serverId: string): void {
    setBillingOpen(true);
    billingHostedServers.requestDeleteById(serverId);
  }
  /** The joined server that the leave confirmation asks about, and the element that asked. */
  const [leaveRequest, setLeaveRequest] = createSignal<{
    hostId: string;
    trigger: HTMLElement | null;
    removeOwned?: boolean;
  } | null>(null);
  const leaveServer = createMemo(() => servers().find((item) => item.id === leaveRequest()?.hostId) ?? null);
  // A server that leaves the list in another way ends the request, so it does not open again on a rejoin.
  createEffect(
    () => leaveRequest() !== null && leaveServer() === null,
    (gone) => {
      if (gone) setLeaveRequest(null);
    },
  );
  async function leaveHost(): Promise<void> {
    const host = workspace.state.hosts.find((item) => item.hostId === leaveRequest()?.hostId);
    if (!host) return;
    if (leaveRequest()?.removeOwned) await workspace.removeOwnedHost(host);
    else await workspace.leaveHost(host);
  }
  /** The hosted server that the restart confirmation asks about, and the element that asked. */
  const [restartRequest, setRestartRequest] = createSignal<{ hostId: string; trigger: HTMLElement | null } | null>(
    null,
  );
  const restartServer = createMemo(() => servers().find((item) => item.id === restartRequest()?.hostId) ?? null);
  createEffect(
    () => restartRequest() !== null && restartServer() === null,
    (gone) => {
      if (gone) setRestartRequest(null);
    },
  );
  async function restartHost(): Promise<void> {
    const hostId = restartRequest()?.hostId;
    if (hostId) await hostedServers.calls.restart(hostId);
  }
  createEffect(
    () => props.billingReturn,
    (billingReturn) => {
      if (!billingReturn) return;
      setBillingOpen(true);
      props.onBillingReturnConsumed?.();
    },
  );
  const saveFile = createWebFileSaver();
  const storageHygieneCalls = hostStorageHygieneCalls(() => hostRequest());
  const storageCalls: FilesPort = {
    agent: { listAgents: () => workspace.runtime.listAgents() },
    storage: {
      // The host names previews with the desktop `openbot-attachment:` scheme, as it does in chat.
      getUsage: async (input, serverId) => {
        const usage = await runTeamEffect(
          getStorageUsage(hostRequest(serverId), input).pipe(Effect.mapError((error) => error.cause)),
        );
        return { ...usage, files: usage.files.map((file) => ({ ...file, previewUrl: null })) };
      },
      deleteFile: (input, serverId) =>
        runTeamEffect(deleteStoredFile(hostRequest(serverId), input).pipe(Effect.mapError((error) => error.cause))),
      clear: (input, serverId) =>
        runTeamEffect(clearStorage(hostRequest(serverId), input).pipe(Effect.mapError((error) => error.cause))),
      // A stored file is an attachment. The browser has no app to open it in, so it downloads.
      openFile: async (input, serverId) => {
        hostRequest(serverId);
        saveFile(await workspace.runtime.download(input.fileId));
      },
    },
  };
  const hostedSiteCalls: ServerHostedSitesOptions["api"] = {
    list: async (serverId) =>
      runTeamEffect(listHostedSites(hostRequest(serverId)).pipe(Effect.mapError((error) => error.cause))),
    delete: async ({ siteId }, serverId) =>
      runTeamEffect(deleteHostedSite(hostRequest(serverId), siteId).pipe(Effect.mapError((error) => error.cause))),
  };
  const agentImportCalls = createWebAgentImportCalls({
    request: hostRequest,
    listAgents: () => workspace.runtime.listAgents(),
    saveFile,
  });
  const memberUpdateAccess = () => !serverRoleCanAdminister(server());
  const hostUpdateCalls: HostUpdateCalls = {
    getReleaseStatus: async (serverId) =>
      workspace.state.capabilities.includes(HOST_RELEASE_CAPABILITY)
        ? runTeamEffect(getHostReleaseStatus(hostRequest(serverId)).pipe(Effect.mapError((error) => error.cause)))
        : null,
    checkRelease: async (serverId) =>
      runTeamEffect(checkHostRelease(hostRequest(serverId)).pipe(Effect.mapError((error) => error.cause))),
    getUpdateStatus: async (serverId) =>
      runTeamEffect(
        getHostUpdateStatus(hostRequest(serverId), memberUpdateAccess()).pipe(Effect.mapError((error) => error.cause)),
      ),
    checkForUpdate: async (serverId) =>
      runTeamEffect(
        checkHostForUpdate(hostRequest(serverId), memberUpdateAccess()).pipe(Effect.mapError((error) => error.cause)),
      ),
    startUpdate: async (restart, serverId) =>
      runTeamEffect(
        startHostUpdate(hostRequest(serverId), restart, memberUpdateAccess()).pipe(
          Effect.mapError((error) => error.cause),
        ),
      ),
    cancelUpdate: async (serverId) =>
      runTeamEffect(cancelHostUpdate(hostRequest(serverId)).pipe(Effect.mapError((error) => error.cause))),
    setUpdateSettings: async (settings, serverId) =>
      runTeamEffect(
        setHostUpdateSettings(hostRequest(serverId), settings).pipe(Effect.mapError((error) => error.cause)),
      ),
  };
  const hostTimezoneCalls: HostTimezoneCalls = {
    getTimezone: async (serverId) =>
      runTeamEffect(getHostTimezone(hostRequest(serverId)).pipe(Effect.mapError((error) => error.cause))),
    setTimezone: async (timezone, serverId) =>
      runTeamEffect(setHostTimezone(hostRequest(serverId), timezone).pipe(Effect.mapError((error) => error.cause))),
  };
  const hostMemoryLimitCalls: HostMemoryLimitCalls = {
    getAgentMemoryLimit: async (serverId) =>
      runTeamEffect(getHostAgentMemoryLimit(hostRequest(serverId)).pipe(Effect.mapError((error) => error.cause))),
    setAgentMemoryLimit: async (limit, serverId) =>
      runTeamEffect(
        setHostAgentMemoryLimit(hostRequest(serverId), limit).pipe(Effect.mapError((error) => error.cause)),
      ),
  };
  const hostPromptCacheTtlCalls: HostPromptCacheTtlCalls = {
    getPromptCacheTtl: async (serverId) =>
      runTeamEffect(getHostPromptCacheTtl(hostRequest(serverId)).pipe(Effect.mapError((error) => error.cause))),
    setPromptCacheTtl: async (ttl, serverId) =>
      runTeamEffect(setHostPromptCacheTtl(hostRequest(serverId), ttl).pipe(Effect.mapError((error) => error.cause))),
  };
  const hostAgentAccessCalls: HostAgentAccessCalls = {
    getAgentAccess: async (serverId) =>
      runTeamEffect(getHostAgentAccess(hostRequest(serverId)).pipe(Effect.mapError((error) => error.cause))),
    setAgentAccess: async (change, serverId) =>
      runTeamEffect(setHostAgentAccess(hostRequest(serverId), change).pipe(Effect.mapError((error) => error.cause))),
  };
  const [serverSettingsSection, setServerSettingsSection] = createSignal<ServerSettingsSection | null>(null);
  async function openServerSettings(
    serverId: string,
    trigger: HTMLElement | null,
    section: ServerSettingsSection | null = null,
  ): Promise<void> {
    if (server()?.id !== serverId || workspace.state.status !== "online") {
      const host = workspace.state.hosts.find((item) => item.hostId === serverId);
      if (!host) return;
      if (server()?.id !== serverId) chatHistory.userOpensServer(serverId);
      await workspace.connect(host);
      if (server()?.id !== serverId || workspace.state.status !== "online") return;
    }
    setServerSettingsSection(section);
    setMobilePane("conversation");
    setHostPage(null);
    setAccountSettingsOpen(false);
    setServerSettingsLoaded(true);
    serverSettings.open(trigger);
  }
  /** The server items of the rail and of the server menu. */
  const serverActionCallbacks = {
    onOpenSettings: (serverId, trigger) => void openServerSettings(serverId, trigger),
    onSetMuted: setMuted,
    onSetNotificationLevel: setNotificationLevel,
    onLeave: (hostId, trigger) => setLeaveRequest({ hostId, trigger }),
    onRemove: (hostId, trigger) => setLeaveRequest({ hostId, trigger, removeOwned: true }),
    canRemove: (serverId) =>
      Boolean(workspace.runtime.removeOwnedHost) && hostedServers.loaded() && !hostedServers.isHosted(serverId),
    onDelete: deleteHostedServer,
    canDelete: hostedServers.isHosted,
    onRestart: (hostId, trigger) => setRestartRequest({ hostId, trigger }),
    canRestart: hostedServers.isHosted,
  } satisfies ServerActionCallbacks;
  // Each time the user enters a host that has a new version, the update dialog opens. A reconnect does not offer again.
  let entry: { id: string; offered: boolean } | null = null;
  createEffect(
    () => {
      const current = server();
      return current ? { id: current.id, online: current.state === "online" } : null;
    },
    (current) => {
      if (current?.id !== entry?.id) {
        entry = current ? { id: current.id, offered: false } : null;
        void offerServerUpdate(null);
      }
      if (!current?.online || !entry || entry.offered) return;
      entry.offered = true;
      const active = untrack(server);
      void offerServerUpdate(
        active && remoteUpdateServer(active)
          ? {
              serverId: active.id,
              name: active.name,
              canManage: serverRoleCanAdminister(active),
              calls: hostUpdateCalls,
            }
          : null,
      );
    },
  );
  const channelsPort = createWebChannelsPort(
    workspace.runtime,
    workspace.onHostEvent,
    () => workspace.state.host?.hostId ?? "",
    eventsEnabled,
    routineRecoveryEnabled,
    webhookTestsEnabled,
  );
  const channelsSupported = () =>
    workspace.state.status === "online" &&
    workspace.state.capabilities.includes(CHANNEL_CHATS_CAPABILITY) &&
    Boolean(workspace.runtime.channels);
  /** As on desktop: the Routines view shows the open agent's canvas, on a host that serves it. */
  const routinesSupported = () => workspace.state.capabilities.includes(ROUTINE_FLOWS_CAPABILITY);
  const routinesView = () => routinesSupported() && layout.sidebarView() === "routines";
  /** The Routines view lists only agents: a channel has no routine canvas. */
  const channelsListed = () => channelsSupported() && !routinesView();
  const savedChannelId = () => {
    const hostId = workspace.state.host?.hostId;
    return hostId ? (readChannelSelection()[props.accountId]?.[hostId] ?? null) : null;
  };
  // On a small screen the sidebar pane covers the chat, and so does the usage report. A covered
  // message was not seen.
  const canMarkRead = () => document.hasFocus() && mobilePane() === "conversation" && !pageCovered() && !routinesView();
  /** The channel list before the newest one, for the reader it was read for. A reply notifies once. */
  let channelBaseline: { scope: string; channels: ChannelSummary[] } | null = null;
  const channels = createChannelsController({
    port: () => channelsPort,
    agents: workspace.profiles,
    // A host switch and a revoked session start the list again. A dropped connection does not: the
    // open channel and its draft stay, and the controller reads the list again when the host is back.
    scopeKey: () => `${workspace.state.host?.hostId ?? ""}:${workspace.state.revocationRevision}`,
    readSelection: savedChannelId,
    writeSelection: (channelId) => {
      const hostId = workspace.state.host?.hostId;
      if (hostId) writeChannelSelection(props.accountId, hostId, channelId);
    },
    supported: channelsSupported,
    deletionSupported: () => canAdministerServer(workspace.state.host?.role),
    beforeOpen: () => {
      setCreating(false);
      // Not `showAgents`: the list restores the saved channel after a host connects, and that must
      // not close the settings of the host that the user opened.
      setHostPage(null);
      setMessageFocusRequest(null);
    },
    canMarkRead,
    onList: (list, scope) => {
      const hostId = workspace.state.host?.hostId;
      const previous = channelBaseline?.scope === scope ? channelBaseline.channels : null;
      channelBaseline = { scope, channels: list };
      if (hostId) notifyChannelReplies(hostId, previous, list);
    },
  });
  onCleanup(
    workspace.onHostEvent((event) => {
      // The live message events keep the open page; a change they carried reads the list only.
      if (event.type === "channels-changed") void channels.changed(event.channelId, event.revision);
      else if (event.type === "runtime-snapshot") void channels.refresh();
    }),
  );
  // As on desktop: an agent's error is the banner above its composer, and the newest one replaces
  // the last. An error with no agent is a toast, once per text in 30 seconds. The host redacts the
  // message before it sends it.
  onCleanup(
    workspace.onHostEvent((event) => {
      if (event.type !== "error") return;
      const serverId = server()?.id;
      if (event.agentId && serverId) {
        const key = composerDraftKey({ agentId: event.agentId, serverId });
        controller.setConversationErrors((current) => ({ ...current, [key]: readableAgentError(event.message) }));
        return;
      }
      const description = readableAgentError(event.message);
      if (claimErrorToast(description))
        toast.error(t("webClient.error.hostReported"), {
          ...{ description },
          report: { operation: "other", source: "system", cause_code: "unknown" },
        });
    }),
  );
  const channelOpen = () => channels.state.selectedId !== null;
  const createSupported = () => workspace.state.status === "online" && workspace.state.host !== null;
  /** A host with no agents. The first-agent form opens there by itself, as in the desktop app. */
  const firstAgent = () => workspace.state.agentsLoaded && workspace.profiles().length === 0 && createSupported();
  /** An open channel still takes the pane, as a channel closes the desktop form. */
  const agentFormOpen = () => creating() || (firstAgent() && !channelOpen());
  const agentChatOpen = () =>
    !tasksOpen() &&
    !agentFormOpen() &&
    !channelOpen() &&
    !noHost() &&
    !hostOffline() &&
    !routinesView() &&
    // In the workspace, the agent chat is the owner's DM with that agent.
    (!workspaceOn() || ws.route().kind === "agent");
  /**
   * The provider that a server's provider step chose, by server. In memory only, as on desktop: the
   * saved setup choice is of the desktop computer, not of the server.
   */
  const [serverSetupChoices, setServerSetupChoices] = createSignal<Record<string, CreationPreference>>({});
  const serverSetupChoice = () => {
    const id = server()?.id;
    return id ? (serverSetupChoices()[id] ?? null) : null;
  };
  /**
   * A server with no agents shows the provider step before the first-agent form, for an account that
   * can sign its host in. OpenBot includes no AI subscription, so an agent made first could not
   * answer. A member and an older host open the form as before.
   */
  const serverOnboarding = () =>
    agentFormOpen() && firstAgent() && serverSetupChoice() === null ? providerSettings() : undefined;
  // The host reports the new agent before the create call returns. Hold the form open until the
  // save is done, so the new-agent avatar still changes after it.
  createEffect(firstAgent, (first) => {
    if (first && !untrack(channelOpen)) setCreating(true);
  });
  const chatHistoryEntries = createWebChatHistory({
    current: () => {
      const hostId = workspace.state.host?.hostId;
      if (!hostId || page() !== "agents" || agentFormOpen()) return null;
      const channelId = channels.state.selectedId;
      if (channelId) return { hostId, kind: "channel", id: channelId };
      const agentId = workspace.state.selectedId;
      return agentId ? { hostId, kind: "agent", id: agentId } : null;
    },
    // On a phone the back button moves between the panes (`paneHistory`), so a chat gets no entry of
    // its own there, and a step back does not open another chat.
    open: (entry) => !untrack(phone) && openHistoryChat(entry),
  });
  const chatHistory = {
    userOpens(entry: WebChatHistoryEntry): void {
      if (!untrack(phone)) chatHistoryEntries.userOpens(entry);
    },
    userOpensServer(hostId: string): void {
      if (!untrack(phone)) chatHistoryEntries.userOpensServer(hostId);
    },
    reopen: chatHistoryEntries.reopen,
  };
  /** Gives the chat that the user opens on the connected server its own history entry. */
  function userOpensChat(kind: WebChatHistoryEntry["kind"], id: string): void {
    const hostId = workspace.state.host?.hostId;
    if (hostId) chatHistory.userOpens({ hostId, kind, id });
  }
  const webhookRoutines = webEventRoutinesApi(
    (...args) => hostRequest()(...args),
    routineRecoveryEnabled,
    webhookTestsEnabled,
  );
  // Asks to move the connected host's routines after this device's time zone changed.
  createRoutineTimezonePrompt(() => {
    const current = server();
    if (current?.state !== "online" || !workspace.runtime.admin || !eventsEnabled()) return [];
    return [
      {
        id: current.id,
        name: current.name,
        calendar: (input) => scheduleSource.calendar(input, current.id),
        events: webhookRoutines,
        timezone: serverCanAdminister(current, "host-timezone-v1") ? hostTimezoneCalls : undefined,
      },
    ];
  });
  const routineFlowsHost = webRoutineFlowsHost(workspace.runtime, workspace.onHostEvent, () =>
    eventsEnabled() ? webhookRoutines : undefined,
  );
  /** The host's Providers settings, which an owner or admin of the host can open. */
  const openProviderSettings = (trigger: HTMLElement) => {
    const current = server();
    if (current) void openServerSettings(current.id, trigger, "providers");
  };
  // The Browser profiles section, for an owner or admin of a host with `browser-profiles-v1`. One
  // store per host, so the list of the last host never shows for the next.
  // The store follows the host id, so a new summary of the same host keeps the loaded list.
  const browserProfileHostId = createMemo(() => {
    const current = server();
    return serverCanAdminister(current, BROWSER_PROFILES_CAPABILITY) ? current?.id : undefined;
  });
  const browserProfiles = createMemo(() => {
    const calls = runtime.browserProfiles;
    return calls && browserProfileHostId() !== undefined ? createBrowserProfilesStore(() => calls) : undefined;
  });
  const browserProfileSettings = createMemo((): ServerBrowserProfilesOptions | undefined => {
    const store = browserProfiles();
    return store ? { store, listAgents: async () => workspace.profiles() } : undefined;
  });
  const openBrowserProfileSettings = (trigger: HTMLElement) => {
    const current = server();
    if (current) void openServerSettings(current.id, trigger, "browser-profiles");
  };
  /** A new agent on the canvas starts on the model the agent form would pick. */
  const newAgentModels = createMemo((): DiagramModelChoice | undefined => {
    if (!workspace.state.capabilities.includes(TEAM_AGENT_CREATE_MODEL_CAPABILITY)) return undefined;
    const initial = resolveCreationModel(serverSetupChoice(), models(), status());
    return initial
      ? { options: models(), status: status(), initial, customProviders: providerSettings()?.customProviders }
      : undefined;
  });
  async function createCanvasAgent(draft: NewAgentDraft): Promise<{ id: string }> {
    const created = await workspace.runtime.createAgent(
      newAgentInput(draft, workspace.state.capabilities.includes(TEAM_AGENT_CREATE_MODEL_CAPABILITY)),
    );
    await workspace.refresh();
    return created;
  }
  /* A channel can open while the Routines view is on: from search or a restored selection. Its row
   * must be in the list, so the list goes back to the agents view. */
  createEffect(
    () => routinesView() && channelOpen(),
    (channelOpenInRoutines) => {
      if (channelOpenInRoutines) layout.setSidebarView("agents");
    },
  );
  const readState = () => workspace.conversation()?.page?.readState;
  // Keyed on the newest loaded message, not on the read state: the host can count a message that
  // this page has not loaded yet, and marking the same message again would not clear it. Focus
  // coming back reads the page again.
  createEffect(
    () =>
      (readState()?.unreadCount ?? 0) > 0 && !agentFormOpen() && !channelOpen() && canMarkRead()
        ? (workspace.conversation()?.page?.messages.at(-1)?.id ?? null)
        : null,
    (unread) => {
      if (unread)
        void workspace.markRead().catch(() =>
          toast.error(t("chat.unread.markReadFailed"), {
            report: { operation: "other", source: "system", cause_code: "unknown" },
          }),
        );
    },
  );
  const teammateRequestInput = createMemo(() => ({
    escalations: workspace.state.inputEscalations,
    agents: workspace.profiles(),
    prompts: workspace.state.prompts,
    approvals: workspace.state.approvals,
    takeovers: workspace.state.takeovers,
  }));
  /** The requests of the teammates that work for the open agent. Its chat answers them as theirs do. */
  const teammateRequests = createMemo(() =>
    workspace.state.status !== "online"
      ? []
      : teammateRequestViews(teammateRequestsFor(workspace.state.selectedId ?? undefined, teammateRequestInput()), {
          name: (agent) => agent?.name ?? t("chat.message.agentFallback"),
          answer: async (_agentId, requestId, answers) => {
            try {
              await workspace.answer({ requestId, answers });
              return true;
            } catch (error) {
              toastTeammateAnswerError(error);
              return false;
            }
          },
          // The card shows a failed answer itself.
          respondToApproval: async (_agentId, requestId, decision) => {
            await workspace.approve({ requestId, decision });
            return true;
          },
          open: (agentId) => {
            setMobilePane("conversation");
            void select(agentId);
          },
        }),
  );
  const sidebarActivity = createMemo(() => {
    // The agent conversation shows only the waits of the agent's own thread. A wait in a channel
    // thread stays out of "Needs you", because selecting the row cannot answer it.
    const agentThreads = new Map(workspace.state.agents.map((agent) => [agent.id, agent.threadId]));
    const inAgentThread = (item: { agentId: string; threadId?: string }) =>
      item.threadId !== undefined && agentThreads.get(item.agentId) === item.threadId;
    return {
      agentIds: workspace.state.agents.map((agent) => agent.id),
      activeTurns: Object.fromEntries(
        Object.entries(workspace.state.conversations).map(([id, conversation]) => [
          id,
          workspace.state.status === "online" ? (conversation.page?.activeTurnId ?? null) : null,
        ]),
      ),
      queues: workspace.state.queues,
      unreadReplies: { ...workspace.state.unreadCounts },
      recentReplies: { ...workspace.state.recentReplies },
      failedTurns: { ...workspace.state.failedTurns },
      // A teammate's request waits in the chat of the agent that gave it the work too, so that agent
      // goes to "Needs you": the user seldom opens the teammate's chat.
      ...withTeammateAttention(
        {
          // One wait per agent: a question replaces a browser takeover for the same agent.
          pendingPrompts: Object.fromEntries([
            ...workspace.state.takeovers
              .filter(inAgentThread)
              .map((request) => [request.agentId, { type: "browser-takeover-requested", request } as const] as const),
            ...workspace.state.prompts.filter(inAgentThread).map((prompt) => [prompt.agentId, prompt] as const),
          ]),
          pendingApprovals: Object.fromEntries(
            workspace.state.approvals.filter(inAgentThread).map((approval) => [approval.agentId, approval]),
          ),
        },
        teammateRequestInput(),
      ),
    };
  });
  const sidebarAgentStates = createMemo(() => computeSidebarAgentStates(sidebarActivity()));
  // A wait in a channel thread goes to the channel instead. Selecting the channel opens the view that answers it.
  const sidebarChannelWaitStates = createMemo(() =>
    sidebarChannelWaits({
      channels: channelsListed() ? channels.state.channels : [],
      prompts: workspace.state.prompts,
      takeovers: workspace.state.takeovers,
      approvals: workspace.state.approvals,
    }),
  );
  const agentWaits = createMemo(() => sidebarAgentWaits(sidebarActivity()));
  /**
   * The agents that wait for the user or have a new reply. The tab title and the Agents tab show it.
   * A new reply of a background teammate does not count: the user does not talk to it.
   */
  const attentionCount = createMemo(() => {
    const background = new Set(
      workspace
        .profiles()
        .filter(isBackgroundAgent)
        .map((agent) => agent.id),
    );
    return Object.entries(sidebarAgentStates()).filter(
      ([agentId, state]) => state.kind === "waiting" || (state.kind === "unread" && !background.has(agentId)),
    ).length;
  });
  const baseTitle = document.title;
  createEffect(attentionCount, (count) => {
    document.title = count > 0 ? t("webClient.title.attention", { count, title: baseTitle }) : baseTitle;
  });
  onCleanup(() => {
    document.title = baseTitle;
  });
  const sidebarAgentMoods = createMemo(() => computeAgentAvatarMoods(sidebarActivity()));
  const browserEnabled = createMemo(
    () =>
      workspace.state.status === "online" &&
      workspace.state.capabilities.includes("browser-control") &&
      workspace.state.capabilities.includes("browser-view"),
  );
  /** The host opens an MCP sign-in page in its own browser, and the live view shows it here. */
  const mcpSignInSupported = () =>
    workspace.state.capabilities.includes(SIGN_IN_RELAY_CAPABILITY) ||
    (workspace.state.capabilities.includes(MCP_SIGN_IN_CAPABILITY) &&
      workspace.state.capabilities.includes("browser-view"));
  const browserTakeover = createMemo(() => {
    const agent = workspace.selected();
    if (!agent) return undefined;
    return workspace.state.takeovers.find(
      (request) => request.agentId === agent.id && request.threadId === agent.threadId,
    );
  });
  const clearSelectedAgentContext = createMemo(() => {
    const agent = workspace.selected();
    if (!agent || !workspace.runtime.admin || !workspace.state.capabilities.includes(CONTEXT_RESET_CAPABILITY))
      return undefined;
    return () =>
      Effect.runPromise(clearAgentContext(hostRequest(), agent.id).pipe(Effect.mapError((error) => error.cause)));
  });
  const offlineUpsell = createHostedUpsellOffline(() => workspace.state.hostOffline);
  const view = createWebConversationView({
    workspace,
    remoteAgentAdmin,
    hidden: () => creating() || channelOpen(),
  });
  // A routine that an agent makes leaves a marker in its turn. The offer of a hosted server waits until that turn ends.
  // The marker does not tell whether the routine is paused; an agent makes an active routine unless told otherwise.
  createEffect(
    () => {
      const agentId = workspace.conversation()?.page?.agentId;
      if (!agentId) return [];
      return view.messages.flatMap((message) => {
        const marker = message.actionMarker;
        return message.turnId && marker?.kind === "routine-lifecycle" && marker.action === "created"
          ? [{ id: marker.routineId, name: marker.routineName, createdAt: marker.timestamp, agentId }]
          : [];
      });
    },
    (created) => {
      for (const routine of created) {
        if (routineMadeThisSession(routine.createdAt)) {
          hostedUpsellRoutineCreated({ id: routine.id, name: routine.name, agentId: routine.agentId });
        }
      }
    },
  );
  createEffect(
    () => workspace.state.error,
    (error) => {
      if (error)
        toast.error(sourceText(error.message), {
          // The toast shows the code of the failure that `report` kept.
          error,
          report: { operation: "other", source: "system", cause_code: classifyFailure(error.message) },
        });
    },
  );
  createEffect(
    () => workspace.state.host?.hostId,
    () => {
      usageReading.reset();
      view.reset();
      setCreating(false);
      modelsShown = ++modelsRequest;
      setModels([]);
      setStatus(CONNECTING_STATUS);
    },
  );
  createEffect(
    () => ({ status: workspace.state.agentStatus, models: workspace.state.models }),
    (value) => {
      if (value.status) setStatus(value.status);
      showModels(++modelsRequest, value.models);
    },
  );
  /** Opens the agent chat that the user picked. Browser Back goes to the chat before it. */
  function select(id: string) {
    userOpensChat("agent", id);
    return openAgentChat(id);
  }
  async function openAgentChat(id: string) {
    setCreating(false);
    showAgents();
    // A remounted conversation must not scroll again to a message that was picked before.
    setMessageFocusRequest(null);
    channels.close();
    await workspace.select(id);
  }
  /**
   * A channel that the user opens closes the pages. On a phone the sidebar shows while a page stays open
   * in the conversation pane. The automatic open after a host connects goes through `beforeOpen` only.
   */
  function openChannel(id: string, edit = false) {
    userOpensChat("channel", id);
    setMobilePane("conversation");
    showAgents();
    void (edit ? channels.editChannel(id) : channels.open(id));
  }
  async function openAddedAgent(agent: AddedAgent) {
    setMobilePane("conversation");
    await workspace.run(async () => {
      await workspace.refresh();
      await select(agent.id);
    });
  }
  /** The host a switch left, so the provider step of a new server can go back to it. */
  const [previousHostId, setPreviousHostId] = createSignal<string | null>(null);
  function selectServer(id: string) {
    if (workspace.state.host?.hostId !== id) chatHistory.userOpensServer(id);
    void connectServer(id);
  }
  async function connectServer(id: string): Promise<void> {
    const host = workspace.state.hosts.find((item) => item.hostId === id);
    if (!host) return;
    const current = workspace.state.host?.hostId;
    if (current && current !== id) setPreviousHostId(current);
    await workspace.connect(host);
  }
  /** Opens the chat of a browser history entry. False when its chat or its server is gone. */
  function openHistoryChat(entry: WebChatHistoryEntry): boolean {
    if (entry.hostId !== workspace.state.host?.hostId) {
      if (!workspace.state.hosts.some((host) => host.hostId === entry.hostId)) return false;
      setMobilePane("conversation");
      // The server opens the chat of the entry, not the channel that it saved.
      writeChannelSelection(props.accountId, entry.hostId, entry.kind === "channel" ? entry.id : null);
      showAgents();
      // Only the entry that is still open, after a later Back, Forward or click.
      void connectServer(entry.hostId).then(() => {
        const hostId = workspace.state.host?.hostId;
        chatHistory.reopen((pending) => pending.kind === "agent" && pending.hostId === hostId);
      });
      return true;
    }
    if (entry.kind === "channel") {
      if (!channels.state.channels.some((channel) => channel.id === entry.id && !channel.archived)) return false;
      setMobilePane("conversation");
      showAgents();
      void channels.open(entry.id);
      return true;
    }
    if (!workspace.state.agents.some((agent) => agent.id === entry.id)) return false;
    setMobilePane("conversation");
    void openAgentChat(entry.id);
    return true;
  }
  /** The server the provider step goes back to: the one open before, else any other on the rail. */
  const returnHostId = () => {
    const current = workspace.state.host?.hostId;
    const others = workspace.state.hosts.filter((item) => item.hostId !== current);
    return others.find((item) => item.hostId === previousHostId())?.hostId ?? others[0]?.hostId;
  };
  /** As on desktop: Agents and Routines show the same page; they set the list of the sidebar. */
  function showSidebarView(view: SidebarView) {
    showAgents();
    setMobilePane("workspace");
    // An open channel would stay in the middle with no row in the list.
    if (view === "routines") channels.close();
    layout.setSidebarView(view);
  }
  /**
   * Hides or restores an agent on the host. After a hide, a toast offers Undo. The open chat stays
   * open, as on the desktop.
   */
  function setAgentHidden(agentId: string, hidden: boolean): void {
    const agent = workspace.state.agents.find((candidate) => candidate.id === agentId);
    if (!agent) return;
    const toastId = `agent-hide-${workspace.state.host?.hostId ?? ""}-${agentId}`;
    void workspace.setAgentHidden(agentId, hidden).then(
      (sent) => {
        if (!sent) return;
        if (!hidden) {
          toast.dismiss(toastId);
          return;
        }
        toast(t("agent.hideUndo.title", { name: agent.name }), {
          id: toastId,
          action: { label: t("agent.hideUndo.action"), onClick: () => setAgentHidden(agentId, false) },
        });
      },
      (error: unknown) => {
        actionToast.error(t(hidden ? "agent.error.hideFailed" : "agent.error.restoreFailed"), {
          description: text.errorMessage(error, t("agent.error.hiddenFailed")),
          report: { operation: "agent", source: "action", cause_code: classifyFailure(error) },
        });
      },
    );
  }
  // The host refuses a member: a hidden agent stops for every member, as a deleted one does.
  const hideSupported = () =>
    workspace.state.status === "online" &&
    workspace.state.capabilities.includes(AGENT_HIDDEN_CAPABILITY) &&
    canAdministerServer(workspace.state.host?.role);
  function startCreate() {
    setMobilePane("conversation");
    channels.close();
    showAgents();
    setCreating(true);
  }
  /** The rail button of the page. The server settings open from the server menu, so no button is current. */
  const railPage = (): PageRailPage | null => {
    const current = page();
    if (current === "agents") return layout.sidebarView();
    return current === "server-settings" ? null : current;
  };
  /**
   * The Slack-style workspace: the main view on a host with channels and the workspace routes,
   * unless the reader chose the classic sidebar or opened the Routines view.
   */
  const workspaceSupported = () => channelsSupported() && workspace.state.capabilities.includes(WORKSPACE_CAPABILITY);
  const workspaceOn = () => workspaceSupported() && !workspaceClassic() && !routinesView();
  const workspaceMessaging = hostMessagingApi(
    () => connectorTarget()?.id,
    () => webMessaging.api,
  );
  const ws = createWorkspaceController({
    channels,
    agents: workspace.profiles,
    hiddenAgentIds: () => new Set(workspace.state.userHiddenAgents.map((agent) => agent.agentId)),
    agentStates: sidebarAgentStates,
    people: () =>
      (workspace.state.presence?.members ?? [])
        .filter((member) => !member.disabled)
        .map((member) => ({
          id: member.id,
          name: teamMemberName(member),
          avatarUrl: member.avatarUrl ?? null,
          role: member.role,
          online: member.online,
        })),
    reader: () => ({
      id: workspace.state.memberId,
      name: props.accountName ?? props.accountEmail ?? "",
      avatarUrl: props.accountAvatarUrl ?? null,
      role: workspace.state.host?.role ?? "member",
    }),
    isReader: (id) =>
      isReaderAuthor(id, { memberId: workspace.state.memberId, accountUserId: props.accountId, onOwnComputer: false }),
    agentDmIsMainChat: () => workspace.state.host?.role === "owner",
    activeAgentId: () => workspace.state.selectedId,
    openAgentChat: (agentId) => {
      setMobilePane("conversation");
      void select(agentId);
    },
    openAgentSettings: (agentId) => {
      setMobilePane("conversation");
      void select(agentId);
      setSettingsRequest({ agentId, nonce: Date.now() });
    },
    createAgent: () => startCreate(),
    inviteTeammates: canAdministerServer(workspace.state.host?.role)
      ? () => {
          const id = server()?.id;
          if (id) void openServerSettings(id, null, "members");
        }
      : undefined,
    serverName: () => workspace.state.host?.name ?? "OpenBot",
    connectionReady: () => workspace.state.status === "online",
    menu: () => {
      const id = server()?.id;
      return [
        {
          id: "search",
          label: t("workspace.app.menu.search"),
          icon: <Search aria-hidden="true" />,
          onSelect: () => setSearchOpen(true),
        },
        ...(createSupported()
          ? [
              {
                id: "new-agent",
                label: t("workspace.app.menu.newAgent"),
                icon: <Bot aria-hidden="true" />,
                onSelect: startCreate,
              },
            ]
          : []),
        {
          id: "marketplace",
          label: t("workspace.app.menu.marketplace"),
          icon: <Store aria-hidden="true" />,
          onSelect: () => setMarketplaceOpen(true),
        },
        ...(routinesSupported()
          ? [
              {
                id: "routines",
                label: t("workspace.app.menu.routines"),
                icon: <Workflow aria-hidden="true" />,
                onSelect: () => showSidebarView("routines"),
              },
            ]
          : []),
        {
          id: "mark-read",
          label: t("workspace.app.menu.markAllRead"),
          icon: <CheckCheck aria-hidden="true" />,
          onSelect: () => {
            void workspace.markAllRead().catch(() => undefined);
            void channels.markAllRead();
          },
        },
        ...(id
          ? [
              {
                id: "server-settings",
                label: t("workspace.app.menu.serverSettings"),
                icon: <Settings aria-hidden="true" />,
                onSelect: () => void openServerSettings(id, null),
              },
            ]
          : []),
        {
          id: "classic",
          label: t("workspace.app.menu.classic"),
          icon: <PanelLeft aria-hidden="true" />,
          onSelect: () => setWorkspaceClassic(true),
        },
      ];
    },
    onHostEvent: workspace.onHostEvent,
    approvals: () => workspace.state.approvals,
    takeovers: () => workspace.state.takeovers,
    hostId: () => workspace.state.host?.hostId ?? null,
    messaging: () => (connectorTarget() ? workspaceMessaging : undefined),
    workspaceSettings: () => serverSettings.workspaceSettings.getWorkspaceSettings(server()?.id ?? ""),
    storageHygiene: () => (serverHasStorageHygiene(server()) ? storageHygieneCalls : undefined),
    openStorageRules: () => {
      const id = server()?.id;
      if (id) void openServerSettings(id, null, "storage");
    },
    messageLink: (channelId, messageId, threadRootId) => {
      const hostId = workspace.state.host?.hostId;
      return hostId
        ? `${location.origin}${location.pathname}#ws=${encodeURIComponent(hostId)}/${channelId}/${threadRootId ?? messageId}`
        : null;
    },
    storageKey: () => `${props.accountId}:${workspace.state.host?.hostId ?? ""}`,
    phone,
    onPhonePaneChange: (pane) => setMobilePane(pane === "sidebar" ? "workspace" : "conversation"),
  });
  // The browser's Back and the page rail move between the list and the conversation on a phone.
  createEffect(mobilePane, (pane) => {
    if (pane === "workspace") ws.setPhonePane("sidebar");
    else if (untrack(() => ws.state.phonePane) === "sidebar") ws.setPhonePane("main");
  });
  // A copied message link: `#ws=<host>/<channel>/<message or thread root>` opens it once the host
  // has its channels.
  const linkedMessage = (() => {
    const match = /^#ws=([^/]+)\/([^/]+)\/([^/]+)$/u.exec(location.hash);
    return match
      ? { hostId: decodeURIComponent(match[1] ?? ""), channelId: match[2] ?? "", messageId: match[3] ?? "" }
      : null;
  })();
  let linkOpened = false;
  createEffect(
    () => workspaceOn() && workspace.state.host?.hostId === linkedMessage?.hostId && channels.state.channels.length > 0,
    (ready) => {
      if (!ready || linkOpened || !linkedMessage) return;
      linkOpened = true;
      history.replaceState(history.state, "", `${location.pathname}${location.search}`);
      if (!channels.state.channels.some((channel) => channel.id === linkedMessage.channelId)) return;
      ws.openChannel(linkedMessage.channelId);
      ws.openThread(linkedMessage.channelId, linkedMessage.messageId);
    },
  );
  // A phone opens the workspace on its list, as Slack does; a link to a message opens the message.
  let phoneListShown = false;
  createEffect(
    () => phone() && workspaceOn(),
    (start) => {
      if (!start || phoneListShown) return;
      phoneListShown = true;
      if (!linkedMessage && !props.chatLink) setMobilePane("workspace");
    },
  );
  /** The settings page on screen, if any. */
  const settingsKind = (): SettingsKind | null =>
    page() === "settings" ? "personal" : page() === "server-settings" ? "server" : null;
  /** As on desktop: a routine of the schedule opens in the settings of its agent or channel. */
  function openRoutine(routine: ScheduleRoutine): void {
    setMobilePane("conversation");
    if (routine.owner.kind === "channel") {
      // An open channel does not open again, so its settings would stay under the page.
      showAgents();
      // The channel settings hold its routines one step down.
      userOpensChat("channel", routine.owner.channelId);
      void channels.editChannel(routine.owner.channelId);
      return;
    }
    const agentId = routine.owner.agentId;
    void select(agentId);
    setSettingsRequest({ agentId, nonce: Date.now(), routine: { routineId: routine.id, name: routine.name } });
  }
  function createRoutine(agentId: string): void {
    setMobilePane("conversation");
    void select(agentId);
    setSettingsRequest({ agentId, nonce: Date.now(), routine: "new" });
  }
  /** As on desktop: the empty canvas opens the agent's chat with a new routine in its settings. */
  function createCanvasRoutine(agentId: string): void {
    layout.setSidebarView("agents");
    createRoutine(agentId);
  }
  /** Whether something covers the pane, so the history holds an entry for it. */
  const overlayOpen = () =>
    hostPage() !== null ||
    accountSettingsOpen() ||
    joinOpen() ||
    hostedServers.addServer() !== null ||
    billingOpen() ||
    marketplaceOpen() ||
    searchOpen() ||
    leaveRequest() !== null ||
    serverSettings.state.open ||
    chatApps.state.open ||
    Boolean(props.agentTemplateId);
  function closeOverlays(): void {
    if (hostPage() !== null) closeHostPage();
    setAccountSettingsOpen(false);
    if (joinOpen()) {
      setJoinOpen(false);
      props.onInviteClose?.();
    }
    if (hostedServers.addServer() !== null) hostedServers.closeAddServer();
    setBillingOpen(false);
    setMarketplaceOpen(false);
    setSearchOpen(false);
    setLeaveRequest(null);
    if (serverSettings.state.open) serverSettings.setOpen(false);
    if (chatApps.state.open) chatApps.close();
    if (props.agentTemplateId) props.onAgentTemplateClose?.();
  }
  createEffect(overlayOpen, (open) => paneHistory.syncOverlay(open));
  const unavailable = async (): Promise<never> => {
    throw new Error(t("webClient.error.desktopOnly"));
  };
  /** The agent chat, framed as a DM in the workspace. */
  const webConversation = () => (
    <Conversation
      headerActions={
        <Show when={chatAppsSupported()}>
          <Button
            variant="ghost"
            onClick={() => {
              const id = workspace.state.selectedId;
              if (id) void chatApps.open({ kind: "agent", id });
            }}
          >
            {t("mcp.chat.title")}
          </Button>
        </Show>
      }
      runtime={runtime}
      onOpenMarketplace={() => setMarketplaceOpen(true)}
      connectors={connectors}
      onOpenMarketplaceApp={(request) => {
        setSuggestedApp(request);
        setMarketplaceOpen(true);
      }}
      marketplaceAppAccess={appAccess}
      agentStatus={
        workspace.state.status === "online" && workspace.conversation()?.page
          ? providerAdmin.status()
          : CONNECTING_STATUS
      }
      accountUsage={accountUsage()}
      // As in the desktop app on a joined host: an owner or admin downloads the host's
      // providers, and Connect runs the provider's route for this tab.
      providerRuntimeStatuses={providerSettings()?.providerRuntimeStatuses}
      customProviders={providerSettings()?.customProviders}
      onDownloadProvider={providerSettings()?.onDownloadProvider}
      onCancelProviderDownload={providerSettings()?.onCancelProviderDownload}
      onConnectProvider={providerSettings() ? connectFromComposer : undefined}
      canConnectProvider={(provider) => (providerSettings()?.connection?.connectKind(provider) ?? null) !== null}
      onSignInProvider={composerSignIn() ? connectFromComposer : undefined}
      onManageProviders={providerSettings() ? openProviderSettings : undefined}
      onManageBrowserProfiles={browserProfiles() ? openBrowserProfileSettings : undefined}
      agent={conversationAgent()}
      agents={workspace.profiles()}
      modelOptions={models()}
      messages={view.messages}
      messageReferences={view.messageReferences()}
      missingMessageReferences={view.missingMessageReferences()}
      unreadCount={readState()?.unreadCount ?? 0}
      firstUnreadMessageId={readState()?.firstUnreadMessageId ?? null}
      loaded={Boolean(workspace.conversation()?.page)}
      hasOlder={workspace.conversation()?.page?.pageInfo.hasOlder}
      unloadedHistory={unloadedHistory(workspace.conversation()?.page?.pageInfo)}
      loadingOlder={workspace.conversation()?.loading}
      activeTurnId={workspace.conversation()?.page?.activeTurnId}
      activityDetail={
        workspace.state.selectedId ? workspace.state.progress[workspace.state.selectedId]?.detail : undefined
      }
      turnStepLines={workspace.stepLines()}
      skillsMarketplaceOpen={marketplaceOpen()}
      mcpSettingsOpen={serverSettings.state.open || marketplaceOpen()}
      globalOverlayOpen={
        joinOpen() || serverSettings.state.open || searchOpen() || marketplaceOpen() || hasVisibleToasts()
      }
      settingsRequest={settingsRequest()}
      messageFocusRequest={messageFocusRequest()}
      queue={workspace.state.selectedId ? workspace.state.queues[workspace.state.selectedId] : undefined}
      browserRuntime={workspace.runtime.browser}
      browserTabs={workspace.state.browserTabs}
      activeBrowserTabId={workspace.state.activeBrowserTabId}
      browserVisibilitySuspended={workspace.state.status !== "online" || pageCovered()}
      workspaceCovered={pageCovered() || hostOffline()}
      browserControlState={workspace.state.browserControlState}
      server={server()}
      presence={workspace.state.presence ?? { serverId: server()?.id ?? null, members: [], updatedAt: "" }}
      currentUserEmail={props.accountEmail ?? ""}
      isOwnSender={(senderId) =>
        isReaderAuthor(senderId, {
          memberId: workspace.state.memberId,
          accountUserId: props.accountId,
          onOwnComputer: false,
        })
      }
      browserEnabled={browserEnabled()}
      remoteDesktopEnabled={false}
      remoteDesktopSessionActive={false}
      remoteDesktopVisible={false}
      prompt={view.prompt()}
      promptUiBlock={view.promptUiBlock()}
      // The card stays in the state while the host is away, and shows again with the host's snapshot.
      approval={workspace.state.status === "online" ? view.approval() : undefined}
      browserTakeover={browserTakeover()}
      teammateRequests={teammateRequests()}
      onSelectAgent={(id) => {
        setMobilePane("conversation");
        void select(id);
      }}
      agentWaits={agentWaits()}
      onUpdateAgent={async (agentId, updates) => {
        await updateRemoteAgent(remoteAgentAdmin, { agentId, ...updates }, workspace.runtime.updateAgent);
        await workspace.refresh();
      }}
      onSetAgentAvatar={async (agentId, image) => {
        await workspace.runtime.setAvatar(agentId, image);
        await workspace.refresh();
      }}
      onSendMessage={async (text, attachments, replyTo, target, clientMessageId) => {
        // A sent prompt is what a notification later reports, so the browser asks here, from the user's action.
        requestWebNotificationPermission();
        const id = target?.agentId ?? workspace.state.selectedId;
        // A send for a host the user has left would reach the one they opened instead.
        if (!id || (target && target.serverId !== server()?.id))
          return { error: t("webClient.error.checkConversation") };
        return workspace.send(id, text, attachments, replyTo, clientMessageId);
      }}
      onMarkRead={workspace.markRead}
      onLoadOlder={() => void workspace.older()}
      onLoadLatest={workspace.refresh}
      onSearchMessages={async (query) => {
        const id = workspace.state.selectedId;
        if (!id) return { messageIds: [], total: 0 };
        const result = await workspace.runtime.search(id, query);
        return { messageIds: result.results.map((item) => item.message.id), total: result.total };
      }}
      onOpenSearchMessage={workspace.openSearchMessage}
      onTypingChange={setTyping}
      onAnswerPrompt={view.answerPrompt}
      onPromptResolutionPresented={(_agentId, turnId, requestId) => view.presentPromptResolution(turnId, requestId)}
      onRespondToApproval={view.respondToApproval}
      onAlwaysAllowApproval={view.alwaysAllowApproval()}
      agentAutoApproves={remoteAgentAdmin.autoApproves()}
      remoteBackupModelsLoaded={remoteAgentAdmin.backupModels() !== undefined}
      remoteTaskLimitLoaded={remoteAgentAdmin.taskLimit() !== undefined}
      onUpdateAgentPermissions={remoteAgentAdmin.settings() ? remoteAgentAdmin.update : undefined}
      onClearAgentContext={clearSelectedAgentContext()}
      onRespondToBrowserTakeover={(decision) => workspace.respondToBrowserTakeover(decision)}
      onCancelQueuedMessage={workspace.cancelQueued}
      onSteerQueuedMessage={workspace.steerQueued}
      onUpdateQueuedMessage={workspace.updateQueued}
      onReorderQueue={workspace.reorderQueue}
      onActivateBrowserTab={workspace.activateBrowserTab}
      onCloseBrowserTab={(tabId) => workspace.runtime.closeBrowserTab(tabId)}
      onOpenRemoteDesktop={unavailable}
      onStop={() => {
        const page = workspace.conversation()?.page;
        if (page?.activeTurnId) void workspace.run(() => workspace.runtime.stop(page.agentId, page.activeTurnId ?? ""));
      }}
    />
  );
  return (
    <ConversationControllerProvider controller={controller}>
      <ChatAppsDialog
        {...chatApps.state}
        onMode={chatApps.onMode}
        onSave={() => void chatApps.save()}
        onClose={chatApps.close}
      />
      <ChannelsControllerProvider controller={channels}>
        {/* As on desktop: the page rail sits at the left of the frame. */}
        <div class="app-window web-app-window">
          <PageRail
            hidden={false}
            logo={{ variant: "production", href: "/" }}
            current={railPage()}
            pinned={layout.railPinned()}
            onPinChange={layout.setRailPinned}
            usageRows={usageRows()}
            onAgents={() => showSidebarView("agents")}
            onRoutines={routinesSupported() ? () => showSidebarView("routines") : undefined}
            onTasks={
              tasksSupported()
                ? (button) => {
                    const id = server()?.id;
                    if (id) void openHostPage(id, "tasks", button);
                  }
                : undefined
            }
            onSchedule={(button) => {
              const id = server()?.id;
              if (id) void openHostPage(id, "schedule", button);
            }}
            onUsage={(button) => {
              const id = server()?.id;
              if (id) void openHostPage(id, "usage", button);
            }}
            onMarketplace={workspace.state.status === "online" ? () => setMarketplaceOpen(true) : undefined}
            onSettings={openAccountSettings}
            help={
              <RailHelpMenu
                version={null}
                onOpenWhatsNew={() => void openWebDestination("changelog")}
                onOpenLink={(destination) => void openWebDestination(destination)}
              />
            }
          />
          <WorkspaceFrame
            class="web-app-frame"
            data-web-mobile-pane={mobilePane()}
            compact={compact()}
            blockedServer={blockedServer()}
            initialLoading={hostOffline()}
            connection={
              <>
                <Show when={!noHost() && workspace.state.status !== "online" && !blockedServer()}>
                  <ServerConnectionNotice
                    name={workspace.state.host?.name ?? t("webClient.notice.findingHosts")}
                    initial={!workspace.state.workspaceLoaded}
                    issue={workspace.state.hostedIssue}
                    start={workspace.state.hostedStart}
                    updateVersion={workspace.state.hostRestart?.version ?? null}
                    detail={
                      workspace.state.hostedSleep !== "sleeping" && !workspace.state.hostedIssue && !hostUpdating()
                        ? (workspace.state.connectionError?.message ?? null)
                        : null
                    }
                    reference={
                      workspace.state.hostedSleep !== "sleeping" && !workspace.state.hostedIssue && !hostUpdating()
                        ? (workspace.state.connectionError?.reference ?? null)
                        : null
                    }
                    phase={serverWorkspacePhase({
                      hostedSleep: workspace.state.hostedSleep,
                      updating: hostUpdating(),
                      blocked: workspace.state.recovery?.phase === "suspended",
                      loading: workspace.state.status === "connecting",
                      hasContent: workspace.state.workspaceLoaded,
                    })}
                    remainingSeconds={
                      // A restarting host is asked at a short, flat interval, so no countdown is shown.
                      !workspace.state.hostRestart &&
                      (workspace.state.recovery?.phase === "waiting" || workspace.state.recovery?.phase === "cooldown")
                        ? workspace.state.recovery.remainingSeconds
                        : 0
                    }
                    // Retry stays available while the hosts load, so a wait without end has a way out.
                    busy={Boolean(workspace.state.host) && workspace.state.status === "connecting"}
                    onRetry={() =>
                      void workspace.run(workspace.state.host ? workspace.reconnect : workspace.refreshHosts)
                    }
                    onManage={() => setBillingOpen(true)}
                    upsell={offlineUpsell()}
                  />
                </Show>
                <Show when={reloadSuggested()}>
                  <section class="server-connection-notice" role="status">
                    <p class="server-connection-detail">{t("webClient.notice.reloadHint")}</p>
                    <div class="server-connection-actions">
                      <Button variant="outline" onClick={() => window.location.reload()}>
                        {t("webClient.notice.reload")}
                      </Button>
                    </div>
                  </section>
                </Show>
                <Show when={workspace.state.status === "online" && workspace.state.panelsFailed}>
                  <ServerPanelLoadNotice
                    busy={workspace.state.panelsLoading}
                    onRetry={() => void workspace.retryPanels()}
                  />
                </Show>
                <Show when={workspace.state.status === "online" && agentChatOpen()}>
                  <ConversationLoadNotice
                    name={workspace.selected()?.name ?? ""}
                    loading={!workspace.conversation()?.page && workspace.conversation()?.loading === true}
                    error={workspace.conversation()?.error ?? null}
                    onRetry={() => {
                      const id = workspace.state.selectedId;
                      if (id) void workspace.select(id);
                    }}
                  />
                </Show>
              </>
            }
            onRetryServer={(serverId) =>
              workspace.run(async () => {
                const host = workspace.state.hosts.find((item) => item.hostId === serverId);
                if (host) await workspace.connect(host);
              })
            }
            windowPage={page()}
            sidebarHidden={tasksAgentsHidden()}
            page={
              <Show
                when={page() === "usage" || page() === "schedule" ? server() : undefined}
                fallback={
                  <Show when={settingsKind()} keyed>
                    {(kind) => (
                      <SettingsPageFrame
                        heading={
                          kind === "personal" ? (
                            <h1 class="settings-page-title" tabindex={-1}>
                              {t("app.settingsPage.title")}
                            </h1>
                          ) : (
                            <Show when={server()}>{(target) => <ServerSettingsPageTitle server={target()} />}</Show>
                          )
                        }
                        onMounts={setSettingsMounts}
                        onEscape={showAgents}
                      />
                    )}
                  </Show>
                }
              >
                {(target) => (
                  <Switch
                    fallback={
                      <Loading>
                        <AgentUsagePanel
                          port={usageCalls}
                          serverId={target().id}
                          hostName={target().name}
                          onBack={closeHostPage}
                        />
                      </Loading>
                    }
                  >
                    <Match when={page() === "schedule"}>
                      <Loading>
                        <ScheduleView
                          serverId={target().id}
                          hostName={target().name}
                          onBack={closeHostPage}
                          source={scheduleSource}
                          agents={workspace.profiles()}
                          channels={channels.state.channels}
                          channelsSupported={channels.supported()}
                          onOpenAgent={(agentId) => {
                            setMobilePane("conversation");
                            void select(agentId);
                          }}
                          onOpenRoutine={openRoutine}
                          onCreateRoutine={createRoutine}
                        />
                      </Loading>
                    </Match>
                  </Switch>
                )}
              </Show>
            }
            left={
              <>
                <Show when={layout.serverRailVisible()}>
                  <ServerRail
                    servers={servers()}
                    onSelect={selectServer}
                    onReorder={workspace.reorderHosts}
                    onAdd={() => hostedServers.openAddServer("server_rail")}
                    addCreatesServer={hostedServers.available()}
                    {...serverActionCallbacks}
                  />
                </Show>
                <Show
                  when={workspaceOn()}
                  fallback={
                    <Sidebar
                      agentsConnecting={!noHost() && !workspace.state.agentsLoaded}
                      channels={channelsListed() ? channels.state.channels.filter((channel) => !channel.archived) : []}
                      deletedChannels={
                        channelsListed() ? channels.state.channels.filter((channel) => channel.archived) : []
                      }
                      activeChannelId={tasksOpen() ? null : channels.state.selectedId}
                      onSelectChannel={openChannel}
                      onEditChannel={(id) => openChannel(id, true)}
                      onDeleteChannel={channels.deletionSupported() ? channels.remove : undefined}
                      onRestoreChannel={channels.deletionSupported() ? channels.restore : undefined}
                      showingArchivedChannels={channelsListed() && channels.state.archived}
                      onToggleArchivedChannels={channelsListed() ? channels.toggleArchived : undefined}
                      onCreateChannel={channelsListed() ? channels.create : undefined}
                      onMarkAllRead={
                        workspace.state.status === "online"
                          ? () => {
                              void workspace.markAllRead().catch(() =>
                                actionToast.error(t("chat.unread.markReadFailed"), {
                                  report: { operation: "other", source: "action", cause_code: "unknown" },
                                }),
                              );
                              if (channelsSupported()) void channels.markAllRead();
                            }
                          : undefined
                      }
                      hasUnread={
                        workspace.profiles().some((agent) => (workspace.state.unreadCounts[agent.id] ?? 0) > 0) ||
                        channels.hasUnread()
                      }
                      view={layout.sidebarView()}
                      serverName={workspace.state.host?.name ?? "OpenBot"}
                      serverUpdate={(() => {
                        const id = server()?.id;
                        const badge = id ? serverUpdateBadge(id) : null;
                        return id && badge ? { ...badge, onOpen: () => void showServerUpdate(id) } : undefined;
                      })()}
                      serverMenu={{
                        servers: servers(),
                        view: layout.serverView(),
                        onViewChange: layout.setServerView,
                        onSelect: selectServer,
                        onAdd: () => hostedServers.openAddServer("server_rail"),
                        addCreatesServer: hostedServers.available(),
                        ...serverActionCallbacks,
                      }}
                      agents={workspace.profiles()}
                      activeAgentId={tasksOpen() || channelOpen() ? "" : (workspace.state.selectedId ?? "")}
                      people={[]}
                      directThreads={[]}
                      activeDirectMemberId={null}
                      agentStates={sidebarAgentStates()}
                      channelWaits={sidebarChannelWaitStates()}
                      agentMoods={sidebarAgentMoods()}
                      layout={workspace.state.sidebarLayout}
                      layoutMutable={
                        workspace.state.status === "online" && workspace.state.capabilities.includes("sidebar-layout")
                      }
                      collapsedSectionIds={workspace.preferences.collapsedSidebarSectionIds()}
                      onMutateLayout={workspace.mutateSidebarLayout}
                      sectionDuplicateSupported={
                        workspace.state.status === "online" &&
                        workspace.state.capabilities.includes("agent-duplication") &&
                        workspace.state.capabilities.includes("sidebar-layout")
                      }
                      duplicatingSectionIds={workspace.duplicatingSectionIds()}
                      onDuplicateSection={workspace.duplicateSection}
                      onToggleSection={workspace.preferences.toggleSidebarSection}
                      pinnedItems={workspace.preferences.pinnedSidebarItems()}
                      peopleOrder={[]}
                      onPin={workspace.preferences.pinSidebarItem}
                      onUnpin={workspace.preferences.unpinSidebarItem}
                      onReorderPinned={workspace.preferences.reorderPinnedSidebarItems}
                      onReorderPeople={() => {}}
                      onSelectAgent={(id) => {
                        setMobilePane("conversation");
                        void select(id);
                      }}
                      onSelectPerson={() => {}}
                      onCreateAgent={startCreate}
                      createSupported={createSupported()}
                      onEditAgent={(id) => {
                        setMobilePane("conversation");
                        void select(id);
                        setSettingsRequest({ agentId: id, nonce: Date.now() });
                      }}
                      duplicateSupported={
                        workspace.state.status === "online" &&
                        workspace.state.capabilities.includes("agent-duplication")
                      }
                      duplicatingAgentIds={new Set(workspace.state.duplicatingAgentIds)}
                      onMarkAgentUnread={
                        workspace.state.capabilities.includes("conversation-unread")
                          ? (agentId) => {
                              void workspace.markUnread(agentId).then(
                                () => toast.success(t("sidebar.agentMenu.markedUnread")),
                                () =>
                                  actionToast.error(t("sidebar.agentMenu.markUnreadFailed"), {
                                    report: { operation: "other", source: "action", cause_code: "unknown" },
                                  }),
                              );
                            }
                          : undefined
                      }
                      onDuplicateAgent={workspace.duplicateAgent}
                      deleteSupported={
                        workspace.state.status === "online" && canAdministerServer(workspace.state.host?.role)
                      }
                      marketplaceSupported={workspace.state.status === "online"}
                      onDeleteAgent={workspace.deleteAgent}
                      userHiddenAgents={workspace.state.userHiddenAgents}
                      onHideAgent={hideSupported() ? (agentId) => setAgentHidden(agentId, true) : undefined}
                      onRestoreAgent={hideSupported() ? (agentId) => setAgentHidden(agentId, false) : undefined}
                      compact={compact()}
                      onExpand={layout.expandSidebar}
                      onOpenSearch={() => setSearchOpen(true)}
                      searchShortcut={globalSearchShortcutLabel(currentDevicePlatform())}
                      onOpenMarketplace={() => setMarketplaceOpen(true)}
                      footer={
                        <>
                          <Show when={!communityCard.dismissed()}>
                            <SidebarCommunityCard
                              onJoinDiscord={() => void openWebDestination("discord")}
                              onFollowX={() => void openWebDestination("x")}
                              onDismiss={communityCard.dismiss}
                            />
                          </Show>
                          <Show when={workspaceSupported()}>
                            <WorkspaceViewButton
                              onOpen={() => {
                                setWorkspaceClassic(false);
                                layout.setSidebarView("agents");
                              }}
                            />
                          </Show>
                        </>
                      }
                      emptyAction={
                        firstAgent()
                          ? {
                              label: t("sidebar.empty.firstAgent"),
                              avatarSeed: agentAvatar().avatarSeed,
                              avatarHue: agentAvatar().avatarHue,
                              onSelect: startCreate,
                            }
                          : undefined
                      }
                    />
                  }
                >
                  <WorkspaceProvider controller={ws}>
                    <div class="sidebar ws-frame-sidebar">
                      <WorkspaceSidebarPane searchShortcut={globalSearchShortcutLabel(currentDevicePlatform())} />
                    </div>
                  </WorkspaceProvider>
                </Show>
                <WebMobileNavigation
                  hidden={workspaceOn()}
                  activePane={mobilePane()}
                  routines={routinesView()}
                  onChange={setMobilePane}
                  attentionCount={attentionCount()}
                />
              </>
            }
            after={
              <>
                <Show when={workspaceOn()}>
                  <WorkspaceProvider controller={ws}>
                    <WorkspaceChrome />
                  </WorkspaceProvider>
                </Show>
                <ServerUpdateDialogHost hosts={workspace.hostViews()} />
                <HostedServerUpsell
                  accountId={props.accountId}
                  canOffer={
                    hostedServers.available() &&
                    hostedServers.loaded() &&
                    !hostedServers.ownsHostedServer() &&
                    server()?.role === "owner" &&
                    server()?.hosted !== true
                  }
                  serverId={server()?.id ?? ""}
                  host={{ name: server()?.name ?? "" }}
                  busy={(agentId) => Boolean(workspace.state.conversations[agentId]?.page?.activeTurnId)}
                  openPlans={() => hostedServers.openAddServer("upsell")}
                  track={(action, entryPoint) =>
                    desktopAnalytics.track("hosted_server_upsell", { action, entry_point: entryPoint })
                  }
                />
                <AddServerOverlay
                  open={hostedServers.addServer() !== null}
                  entryPoint={hostedServers.addServer()?.entryPoint}
                  calls={hostedServers.calls}
                  servers={servers()}
                  onRefreshServers={workspace.retryHosts}
                  resume={hostedServers.addServer()?.resume}
                  onClose={hostedServers.closeAddServer}
                  onOpenServer={(serverId) => {
                    hostedServers.closeAddServer();
                    selectServer(serverId);
                  }}
                  onContactUs={() => window.location.assign(HOSTED_SERVER_CONTACT_URL)}
                  onJoinWithInvite={() => {
                    hostedServers.closeAddServer();
                    setJoinOpen(true);
                  }}
                  onManageServers={() => setBillingOpen(true)}
                />
                <JoinServerOverlay
                  open={joinOpen()}
                  inviteUrl={props.inviteUrl ?? ""}
                  accountEmail={props.accountEmail ?? ""}
                  onClose={() => {
                    setJoinOpen(false);
                    props.onInviteClose?.();
                  }}
                  onPreview={({ inviteUrl }) => workspace.runtime.previewInvite(inviteUrl)}
                  onJoin={({ inviteUrl }) => workspace.joinInvite(inviteUrl)}
                />
                <MarketplaceOverlay
                  open={marketplaceOpen()}
                  onOpenChange={setMarketplaceOpen}
                  calls={marketplaceCalls}
                  connectors={connectors}
                  server={server()}
                  agents={workspace.state.agents}
                  activeAgentId={workspace.state.selectedId ?? ""}
                  composerAvailable={status().phase === "ready" && !agentFormOpen()}
                  onOpenAgent={(agentId) => {
                    setMobilePane("conversation");
                    if (agentId !== workspace.state.selectedId) void select(agentId);
                    else {
                      // The agent is already loaded; only what covers its conversation closes.
                      userOpensChat("agent", agentId);
                      setCreating(false);
                      showAgents();
                      channels.close();
                    }
                  }}
                  onAgentInstalled={async (agent) => {
                    setMarketplaceOpen(false);
                    await openAddedAgent(agent);
                  }}
                  pluginSlug={suggestedApp()?.appId ?? props.pluginSlug}
                  pluginConnect={suggestedApp()?.connect ?? false}
                  onPluginSlugConsumed={() => {
                    if (suggestedApp()) setSuggestedApp(null);
                    else props.onPluginSlugConsumed?.();
                  }}
                />
                <Show when={accountSettingsLoaded()}>
                  <Loading>
                    <WebAccountSettings
                      open={accountSettingsOpen() && settingsPlacement("personal") !== undefined}
                      page={settingsPlacement("personal")}
                      onOpenChange={setAccountSettingsOpen}
                      account={account()}
                      calls={accountCalls}
                      language={props.language}
                      onChangeLanguage={props.onChangeLanguage}
                      appearance={props.appearance}
                      onChangeAppearance={props.onChangeAppearance}
                      onOpenBilling={() => setBillingOpen(true)}
                      onSignOut={signOut}
                      push={{
                        availability: push.availability(),
                        hostName: workspace.state.host?.name ?? "",
                        enabled: push.enabled(),
                        busy: push.busy(),
                        failure: push.failure(),
                        onChange: (enabled) => void (enabled ? push.enable() : push.disable()),
                      }}
                    />
                  </Loading>
                </Show>
                <SharedAgentInstallOverlay
                  templateId={props.agentTemplateId}
                  server={server()}
                  calls={agentTemplateCalls}
                  onOpenLink={(url) => void openWebLink(url)}
                  onClose={() => props.onAgentTemplateClose?.()}
                  onInstalled={openAddedAgent}
                />
                <Show when={serverSettingsLoaded() && server()}>
                  {(target) => (
                    <ServerSettingsOverlay
                      open={serverSettings.state.open && settingsPlacement("server") !== undefined}
                      page={settingsPlacement("server")}
                      restoreFocusTarget={serverSettings.restoreTarget()}
                      initialSection={serverSettingsSection()}
                      platform="darwin"
                      remoteDesktopSupported={false}
                      server={target()}
                      hostStatus={null}
                      connectors={connectors}
                      members={serverSettings.state.members}
                      invites={serverSettings.state.invites}
                      loading={serverSettings.state.loading}
                      loadError={serverSettings.state.error}
                      onRetry={serverSettings.refresh}
                      onSaveIdentity={serverSettings.saveIdentity}
                      onSetMuted={async (muted) => setMuted(target().id, muted)}
                      onSetNotificationLevel={async (level) => setNotificationLevel(target().id, level)}
                      // Publication and screen recording belong to the computer that runs the server.
                      onSetPublished={unavailable}
                      onCreateInvite={serverSettings.createInvite}
                      license={licenseCalls}
                      onContactUs={() => window.location.assign(HOSTED_SERVER_CONTACT_URL)}
                      onUpdateMember={serverSettings.updateMember}
                      onRemoveMember={serverSettings.removeMember}
                      onRevokeInvite={serverSettings.revokeInvite}
                      onOpenScreenRecordingSettings={unavailable}
                      onRecheckScreenRecording={unavailable}
                      mcpServers={serverSettings.state.mcp}
                      mcpLoadError={serverSettings.state.mcpError}
                      onMcpSectionShown={() => {
                        void serverSettings.refreshMcp();
                        if (mcpSignInSupported()) void serverSettings.refreshMcpSignIns().catch(() => undefined);
                      }}
                      onRetryMcpServers={() => void serverSettings.refreshMcp()}
                      onSaveMcpServer={async (config) => {
                        await serverSettings.saveMcpServer(config);
                        // A saved row can name an address the host is already signed in to.
                        if (mcpSignInSupported()) void serverSettings.refreshMcpSignIns().catch(() => undefined);
                      }}
                      onRemoveMcpServer={serverSettings.removeMcpServer}
                      onSetMcpServerEnabled={serverSettings.setMcpServerEnabled}
                      onTestMcpServer={serverSettings.testMcpServer}
                      // A host with `sign-in-relay-v1` signs in through this browser and a pasted address.
                      // An older host opens the page in its own browser, and the live view shows it here.
                      mcpSignIn={
                        mcpSignInSupported()
                          ? {
                              states: serverSettings.state.mcpSignIns,
                              remote: {
                                hostName: target().name,
                                runtime: workspace.runtime.browser,
                                clipboard: workspace.state.capabilities.includes("browser-view-clipboard"),
                                pages: serverSettings.state.mcpSignInPages,
                                relay: workspace.state.capabilities.includes(SIGN_IN_RELAY_CAPABILITY)
                                  ? {
                                      pages: serverSettings.state.mcpSignInRelays,
                                      paste: serverSettings.pasteMcpSignInRelay,
                                      open: serverSettings.openMcpSignInRelay,
                                    }
                                  : undefined,
                              },
                              start: serverSettings.signInMcpServer,
                              cancel: serverSettings.cancelMcpSignIn,
                              signOut: serverSettings.signOutMcpServer,
                              app: workspace.state.capabilities.includes("mcp-sign-in-app-v1")
                                ? {
                                    load: serverSettings.mcpSignInApp,
                                    save: serverSettings.saveMcpSignInApp,
                                    remove: serverSettings.removeMcpSignInApp,
                                  }
                                : undefined,
                            }
                          : undefined
                      }
                      storage={{
                        hostName: target().name,
                        calls: storageCalls,
                        hygiene: serverHasStorageHygiene(target()) ? storageHygieneCalls : undefined,
                        onOpenAgent: (agentId) => {
                          serverSettings.setOpen(false);
                          setMobilePane("conversation");
                          void select(agentId);
                        },
                        onShowMessage: (agentId, messageId) => {
                          serverSettings.setOpen(false);
                          void openMessage(agentId, messageId);
                        },
                      }}
                      // Every member lists; the host deletes only for an owner or admin.
                      hostedSites={
                        workspace.state.capabilities.includes(HOSTED_SITES_CAPABILITY)
                          ? { api: hostedSiteCalls, onOpenSite: (url) => void openWebLink(url) }
                          : undefined
                      }
                      providers={providerSettings()}
                      hostUpdate={{ calls: hostUpdateCalls }}
                      hostTimezone={{ calls: hostTimezoneCalls }}
                      hostMemoryLimit={{ calls: hostMemoryLimitCalls }}
                      hostPromptCacheTtl={{ calls: hostPromptCacheTtlCalls }}
                      agentAccess={{ calls: hostAgentAccessCalls, listAgents: () => workspace.runtime.listAgents() }}
                      workspaceSettings={{
                        calls: serverSettings.workspaceSettings,
                        catalog: () => ({ modelOptions: models(), agentStatus: status() }),
                      }}
                      browserProfiles={browserProfileSettings()}
                      // Any member imports into a host with `agent-import-v1`.
                      agentImport={
                        workspace.state.capabilities.includes(AGENT_IMPORT_CAPABILITY)
                          ? {
                              calls: agentImportCalls,
                              onOpenAgent: (agentId) => {
                                serverSettings.setOpen(false);
                                setMobilePane("conversation");
                                void select(agentId);
                              },
                              onClose: () => serverSettings.setOpen(false),
                            }
                          : undefined
                      }
                    />
                  )}
                </Show>
                <LeaveServerDialog
                  server={leaveServer()}
                  removeOwned={leaveRequest()?.removeOwned ?? false}
                  onClose={() => setLeaveRequest(null)}
                  onLeave={leaveHost}
                  restoreFocusTarget={leaveRequest()?.trigger}
                />
                <RestartServerDialog
                  server={restartServer()}
                  servers={servers()}
                  onClose={() => setRestartRequest(null)}
                  onRestart={restartHost}
                  restoreFocusTarget={restartRequest()?.trigger}
                />
                <BillingDialog
                  open={billingOpen()}
                  onOpenChange={setBillingOpen}
                  store={billing}
                  hostedServers={billingHostedServers}
                  license={
                    <LicenseSection
                      store={license}
                      onManagePayment={() => void billing.openPortal({ flow: "manage" })}
                      onContactUs={licenseContactUs(() => window.location.assign(HOSTED_SERVER_CONTACT_URL))}
                    />
                  }
                />
                <ChannelCreateOverlay />
                <GlobalSearchOverlay
                  open={searchOpen()}
                  agents={workspace.profiles()}
                  channels={channels.supported() ? globalSearchChannels(channels.state.channels) : undefined}
                  shortcuts={keyboardShortcuts(t, currentDevicePlatform(), "web")}
                  onSearchMessages={searchAllMessages}
                  onOpenChange={setSearchOpen}
                  onSelectAgent={(id) => {
                    setMobilePane("conversation");
                    void select(id);
                  }}
                  onSelectChannel={openChannel}
                  onSelectMessage={(agentId, messageId) => void openMessage(agentId, messageId)}
                />
              </>
            }
          >
            <Show when={tasksOpen() ? server() : undefined}>
              {(target) => (
                <Loading>
                  <TasksView
                    serverId={target().id}
                    hostName={target().name}
                    onBack={closeHostPage}
                    agentsOpen={!tasksAgentsHidden()}
                    onToggleAgents={() => setTasksAgentsOpen(tasksAgentsHidden())}
                    source={tasksSource}
                    agents={workspace.profiles()}
                    onOpenLink={(url) => void openWebLink(url)}
                    onAttachmentAction={(attachment) =>
                      void runtime.agent.openAttachment({ attachmentId: attachment.id, action: "download" })
                    }
                    approvals={workspace.state.approvals}
                    onRespondApproval={async (approval, decision) => {
                      await workspace.approve({ requestId: approval.requestId, decision });
                      return true;
                    }}
                  />
                </Loading>
              )}
            </Show>
            <Show when={tasksOpen() ? undefined : serverOnboarding()}>
              {(settings) => (
                <Loading>
                  <ServerOnboarding
                    serverName={server()?.name ?? ""}
                    setup={hostSetupProviderProps(settings())}
                    onContinue={(provider, model) => {
                      const id = server()?.id;
                      if (id)
                        setServerSetupChoices((current) => ({
                          ...current,
                          [id]: { preferredProvider: provider, preferredModel: model },
                        }));
                    }}
                    onClose={
                      returnHostId()
                        ? () => {
                            const id = returnHostId();
                            if (id) selectServer(id);
                          }
                        : undefined
                    }
                  />
                </Loading>
              )}
            </Show>
            <Show when={!tasksOpen() && agentFormOpen() && !serverOnboarding()}>
              <WebAgentSettings
                runtime={workspace.runtime}
                capabilities={workspace.state.capabilities}
                first={firstAgent()}
                preference={serverSetupChoice()}
                customProviders={providerSettings()?.customProviders}
                onManageProviders={providerSettings() ? openProviderSettings : undefined}
                liveModels={models()}
                liveStatus={status()}
                // A new form starts empty, with the avatar that the first-agent row showed.
                initialDraft={{ ...createFirstAgentDraft(), ...untrack(agentAvatar) }}
                onDraftChange={({ avatarSeed, avatarHue }) => setAgentAvatar({ avatarSeed, avatarHue })}
                onClose={() => setCreating(false)}
                onSaved={async () => {
                  await workspace.refresh();
                  setAgentAvatar(newAgentAvatar());
                  setCreating(false);
                }}
              />
            </Show>
            <Show when={workspaceOn() && !tasksOpen() && !agentFormOpen() && !noHost() && ws.route().kind !== "agent"}>
              <WorkspaceProvider controller={ws}>
                <WorkspaceMain />
              </WorkspaceProvider>
            </Show>
            <Show when={!workspaceOn() && !tasksOpen() && !agentFormOpen() && channelOpen()}>
              {/* Keyed by the channel: the view reads its channel once, so another channel opens a new view. */}
              <Show when={channels.state.selectedId} keyed>
                {(channelId) => {
                  const isOwnSender = (senderId: string) =>
                    isReaderAuthor(senderId, {
                      memberId: workspace.state.memberId,
                      accountUserId: props.accountId,
                      onOwnComputer: false,
                    });
                  const channelView = createChannelConversation({
                    channelId,
                    isOwnSender,
                    connectionReady: () => workspace.state.status === "online",
                    // The routines of a joined host go through its event API, which the channels port gives.
                    routines: {
                      localHost: () => false,
                      eventsServerId: () => undefined,
                      routineRecovery: () => false,
                      webhookTests: () => false,
                    },
                    approvals: () => workspace.state.approvals,
                    takeovers: () => workspace.state.takeovers,
                  });
                  return (
                    <Conversation
                      headerActions={
                        <Show when={chatAppsSupported()}>
                          <Button
                            variant="ghost"
                            onClick={() => {
                              const id = channels.state.selectedId;
                              if (id) void chatApps.open({ kind: "channel", id });
                            }}
                          >
                            {t("mcp.chat.title")}
                          </Button>
                        </Show>
                      }
                      runtime={runtime}
                      channel={channelView.source}
                      notice={<ChannelErrorNotice />}
                      connectors={connectors}
                      agentStatus={workspace.state.status === "online" ? providerAdmin.status() : CONNECTING_STATUS}
                      agent={undefined}
                      agents={workspace.profiles()}
                      mentionAgents={channelView.mentionAgents()}
                      modelOptions={[]}
                      messages={channelView.messages()}
                      unreadCount={channelView.unreadCount()}
                      firstUnreadMessageId={channelView.firstUnreadMessageId()}
                      loaded={channelView.loaded()}
                      hasOlder={channelView.hasOlder()}
                      unloadedHistory={channelView.unloadedHistory()}
                      activeTurnId={channelView.activeTurnId()}
                      skillsMarketplaceOpen={marketplaceOpen()}
                      mcpSettingsOpen={serverSettings.state.open || marketplaceOpen()}
                      globalOverlayOpen={
                        joinOpen() ||
                        serverSettings.state.open ||
                        searchOpen() ||
                        marketplaceOpen() ||
                        hasVisibleToasts()
                      }
                      settingsRequest={channelView.settingsRequest()}
                      messageFocusRequest={messageFocusRequest()}
                      queue={undefined}
                      browserRuntime={workspace.runtime.browser}
                      browserTabs={workspace.state.browserTabs}
                      activeBrowserTabId={workspace.state.activeBrowserTabId}
                      browserVisibilitySuspended={workspace.state.status !== "online" || pageCovered()}
                      workspaceCovered={pageCovered() || hostOffline()}
                      browserControlState={workspace.state.browserControlState}
                      server={server()}
                      presence={
                        workspace.state.presence ?? { serverId: server()?.id ?? null, members: [], updatedAt: "" }
                      }
                      currentUserEmail={props.accountEmail ?? ""}
                      isOwnSender={isOwnSender}
                      browserEnabled={browserEnabled()}
                      remoteDesktopEnabled={false}
                      remoteDesktopSessionActive={false}
                      remoteDesktopVisible={false}
                      prompt={channelView.prompt()}
                      promptUiBlock={channelView.promptUiBlock()}
                      approval={channelView.approval()}
                      browserTakeover={channelView.browserTakeover()}
                      onSelectAgent={(id) => {
                        setMobilePane("conversation");
                        void select(id);
                      }}
                      onUpdateAgent={async (agentId, updates) => {
                        await updateRemoteAgent(
                          remoteAgentAdmin,
                          { agentId, ...updates },
                          workspace.runtime.updateAgent,
                        );
                        await workspace.refresh();
                      }}
                      onSetAgentAvatar={async (agentId, image) => {
                        await workspace.runtime.setAvatar(agentId, image);
                        await workspace.refresh();
                      }}
                      onSendMessage={(text, attachments, replyTo, target, clientMessageId) => {
                        // A sent request is what a notification later reports, so the browser asks here, from the user's action.
                        requestWebNotificationPermission();
                        return channelView.onSendMessage(text, attachments, replyTo, target, clientMessageId);
                      }}
                      onMarkRead={channelView.onMarkRead}
                      onLoadOlder={channelView.onLoadOlder}
                      onTypingChange={() => {}}
                      onAnswerPrompt={channelView.onAnswerPrompt}
                      onRespondToApproval={channelView.onRespondToApproval}
                      onRespondToBrowserTakeover={channelView.onRespondToBrowserTakeover}
                      onCancelQueuedMessage={() => {}}
                      onSteerQueuedMessage={() => {}}
                      onUpdateQueuedMessage={() => Promise.resolve(false)}
                      onReorderQueue={() => {}}
                      onActivateBrowserTab={workspace.activateBrowserTab}
                      onCloseBrowserTab={(tabId) => workspace.runtime.closeBrowserTab(tabId)}
                      onOpenRemoteDesktop={unavailable}
                      onStop={channelView.onStop}
                    />
                  );
                }}
              </Show>
            </Show>
            <Show when={!agentFormOpen() && !channelOpen() && noHost()}>
              <WebConnectComputer
                loading={workspace.state.hostsLoading}
                failed={Boolean(workspace.state.hostsError)}
                reference={workspace.state.hostsError?.reference ?? null}
                onJoin={() => setJoinOpen(true)}
                onCreateServer={
                  // An account with a hosted server that is not a host yet, such as one that waits for payment,
                  // must not buy a second one from here.
                  hostedServers.available() && !hostedServers.ownsHostedServer()
                    ? () => hostedServers.openAddServer("empty_state")
                    : undefined
                }
                onRefresh={() => void workspace.run(workspace.refreshHosts)}
              />
            </Show>
            <Show
              when={!tasksOpen() && !agentFormOpen() && !channelOpen() && !noHost() && !hostOffline() && routinesView()}
            >
              {/* A host switch starts the canvas again, with that host's webhook relay status. */}
              <Show when={routineFlowsHost ? workspace.state.host?.hostId : undefined} keyed>
                {(_hostId) => (
                  <Show when={routineFlowsHost}>
                    {(host) => (
                      <Loading>
                        <RoutineFlowsCanvas
                          host={host()}
                          agent={conversationAgent()}
                          agents={workspace.profiles()}
                          newAgentModels={newAgentModels()}
                          createAgent={createCanvasAgent}
                          onCreateRoutine={createCanvasRoutine}
                        />
                      </Loading>
                    )}
                  </Show>
                )}
              </Show>
            </Show>
            <Show when={agentChatOpen()}>
              <Show when={workspaceOn() ? workspace.state.selectedId : null} fallback={webConversation()}>
                {(agentId) => (
                  <WorkspaceProvider controller={ws}>
                    <WorkspaceAgentFrame agentId={agentId()}>{webConversation()}</WorkspaceAgentFrame>
                  </WorkspaceProvider>
                )}
              </Show>
              <ProviderSignInDialogs api={providerSettings()?.connection} opener="composer" />
            </Show>
          </WorkspaceFrame>
        </div>
      </ChannelsControllerProvider>
    </ConversationControllerProvider>
  );
}
