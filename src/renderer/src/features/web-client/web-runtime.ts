import {
  assertSupportedAttachmentName,
  attachmentFileExtension,
  supportedAttachmentExtensions,
} from "@openbot/contracts/attachment-files";
import type {
  AccountUsage,
  AgentEvent,
  AgentStatus,
  AttachmentSummary,
  AvatarImageInput,
  BrowserLiveViewEvent,
  BrowserNavigateInput,
  BrowserOpenInput,
  BrowserPreview,
  BrowserTab,
  CancelQueuedMessageInput,
  ClientAgentModelOption,
  ClientAgentSummary,
  ConversationPage,
  ConversationReadState,
  ConversationSearchPage,
  CreateAgentInput,
  DuplicateAgentResult,
  EditQueuedMessageInput,
  HiddenAgentsSnapshot,
  InvitePreview,
  QueueSnapshot,
  ReorderQueueInput,
  RespondToApprovalInput,
  RespondToBrowserSecretInput,
  RespondToBrowserTakeoverInput,
  RespondToPromptInput,
  Routine,
  RoutineRun,
  SetAgentHiddenInput,
  SetMessageReactionInput,
  SidebarLayoutAction,
  SidebarLayoutSnapshot,
  SteerQueuedMessageInput,
  TeamInviteSummary,
  TeamMemberSummary,
  TeamRealtimeEvent,
  TestRoutineInput,
  UpdateAgentInput,
  UpdateQueuedMessageInput,
  UpdateRoutineInput,
  WorkspaceDirectory,
} from "@openbot/contracts/ipc";
import {
  canAdministerServer,
  decodeCreatedSpaceAgent,
  decodeWorkspaceDirectory,
  isAccountUsage,
  isAgentStatus,
  isClientAgentModelOption,
  isClientAgentSummary,
  isConversationMessage,
  isConversationReadState,
  isConversationWithReadState,
  isQueuedMessageReceipt,
  isQueueSnapshot,
  isSidebarLayoutSnapshot,
  isTeamPresenceSnapshot,
} from "@openbot/contracts/ipc";
import { guardedListDecoder, optionalHistoryExtent, requiredString } from "@openbot/contracts/ipc-decoding";
import { isDynamicRecord, isNumber, isString } from "@openbot/contracts/runtime-values";
import { TEAM_API_ROUTES } from "@openbot/contracts/team-api-routes";
import { AGENT_QUEUES_ROUTE } from "@openbot/contracts/team-protocol/agent-queues-v1";
import {
  ATTACHMENT_PREVIEWS_CAPABILITY,
  attachmentPreviewRoute,
} from "@openbot/contracts/team-protocol/attachment-previews-v1";
import {
  BROWSER_PAGE_STATE_CAPABILITY,
  BROWSER_PAGE_STATE_ROUTES,
  decodeBrowserPageStateSnapshot,
} from "@openbot/contracts/team-protocol/browser-page-state-v1";
import {
  BROWSER_USER_CONTROL_CAPABILITY,
  BROWSER_USER_CONTROL_ROUTES,
  decodeBrowserUserControlSnapshot,
} from "@openbot/contracts/team-protocol/browser-user-control-v1";
import {
  type BrowserViewViewport,
  decodeBrowserViewInputValue,
  TEAM_BROWSER_VIEW_CLIPBOARD_CAPABILITY,
  TEAM_BROWSER_VIEW_FRAME_POINT_CAPABILITY,
  TEAM_BROWSER_VIEW_VIEWPORT_CAPABILITY,
} from "@openbot/contracts/team-protocol/browser-view-v1";
import {
  TEAM_BROWSER_NAVIGATION_CAPABILITY,
  TEAM_TEXT_ATTACHMENTS_CAPABILITY,
} from "@openbot/contracts/team-protocol/current";
import {
  FILE_TICKET_ROUTES,
  type FileTicket,
  type FileTicketSource,
} from "@openbot/contracts/team-protocol/file-tickets-v1";
import { FOCUS_USE_ROUTES } from "@openbot/contracts/team-protocol/focus-use-v1";
import { PROVIDER_ACCOUNTS_CAPABILITY } from "@openbot/contracts/team-protocol/provider-accounts-v1";
import { ROUTINE_FLOWS_CAPABILITY } from "@openbot/contracts/team-protocol/routine-flows-v1";
import { type TeamProtocolSupportV1, teamProtocolUpdateDirection } from "@openbot/contracts/team-protocol/v1";
import { TEAM_PROTOCOL_V2_MAX_FILE_BYTES, type TeamProtocolV2Json } from "@openbot/contracts/team-protocol/v2";
import { TEAM_PROTOCOL_V3 } from "@openbot/contracts/team-protocol/v3";
import { decodeTeamProtocolSupportV7Base } from "@openbot/contracts/team-protocol/v7-base";
import {
  WORKSPACE_DIRECTORY_CAPABILITY,
  WORKSPACE_DIRECTORY_ROUTES,
} from "@openbot/contracts/team-protocol/workspace-directory-v1";
import { workspaceArtifactThumbnailRoute } from "@openbot/contracts/team-protocol/workspace-fleet-v1";
import {
  WORKSPACE_SPACES_CAPABILITY,
  WORKSPACE_SPACES_ROUTES,
} from "@openbot/contracts/team-protocol/workspace-spaces-v1";
import { WORKSPACE_CAPABILITY } from "@openbot/contracts/team-protocol/workspace-v1";
import { runTeamEffect } from "@openbot/team-client";
import { bytesToBase64 } from "@openbot/team-client/base64";
import { createRemoteBrowserView, type RemoteBrowserView } from "@openbot/team-client/browser-view";
import { verifyEd25519Base64Url } from "@openbot/team-client/ed25519";
import {
  RemoteDirectoryError,
  RemoteTeamDirectoryClient,
  type RemoteTeamHost,
  type RemoteTeamInvite,
  type RemoteTeamMember,
} from "@openbot/team-client/remote-directory";
import {
  createRemoteTeamPeer,
  MOBILE_ATTACHMENT_BYTES,
  type RemoteFileUpload,
  type RemoteTeamConnectionUpdate,
} from "@openbot/team-client/remote-peer";
import {
  isRemoteReadRequest,
  type RemoteRequestFailure,
  remoteRequestFailure,
  remoteWorkspaceReadTimeout,
} from "@openbot/team-client/remote-recovery";
import { listHiddenAgents, setAgentHidden, setAgentProviderAccount } from "@openbot/team-client/team-admin-requests";
import {
  cancelQueuedMessage,
  deleteAgent,
  discardAttachmentDraft,
  interruptAgentTurn,
  reorderQueue,
  respondToBrowserSecret,
  respondToBrowserTakeover,
  steerQueuedMessage,
  type TeamApiRequest,
  type TeamChannelsApi,
  type TeamRoutineFlowsApi,
  teamAgentRoutinesApi,
  teamChannelsApi,
  teamRoutineFlowsApi,
  updateQueuedMessage,
  uploadAttachmentDraft,
} from "@openbot/team-client/team-api-requests";
import type { BrowserViewRuntime } from "@openbot/ui/features/browser/BrowserLiveView";
import { currentText } from "@openbot/ui/text";
import { referenceFrom } from "@openbot/user-errors";
import { Effect } from "effect";
import { activeSpace } from "../../active-space";
import type { ServerAdminPort } from "../servers/servers-port";
import {
  createWebHostConnections,
  type WebHostConnections,
  type WebHostNotice,
  WebHostRequestError,
} from "./web-host-connections";
import { acquireWebHostLock, openWebHostChannel, type WebHostState, webTabInstanceId } from "./web-host-lock";

/**
 * How long a request that the connection lost waits for the connection to come back before it fails.
 * A host restart, such as for an update, takes about ten seconds; a lost network path recovers in less.
 */
const REQUEST_RECONNECT_WAIT_MS = 25_000;
/** The pause before a lost request is sent again while the peer still says it is online. */
const RESEND_PAUSE_MS = 1_000;

/**
 * The host controls of the connected host. The host answers the Team API routes, and the account
 * service answers the member and invitation routes; both refuse a `member`, so the UI gate is not
 * the only one.
 */
export interface WebAdminRuntime {
  request: TeamApiRequest;
  team: ServerAdminPort;
}

export interface WebFile {
  name: string;
  mimeType: string;
  base64: string;
}

export interface WebWorkspaceRuntime {
  admin?: WebAdminRuntime;
  /** The status connections of the hosts that this tab has not opened. */
  hosts?: WebHostConnections;
  browser: BrowserViewRuntime;
  browserTabs(): Promise<BrowserTab[]>;
  browserPreview?: (tabId: string) => Promise<BrowserPreview>;
  openBrowserTab(input: BrowserOpenInput): Promise<BrowserTab>;
  navigateBrowserTab(input: BrowserNavigateInput): Promise<void>;
  reloadBrowserTab(tabId: string): Promise<void>;
  /** Behind `browser-page-state`. */
  stopBrowserTab(tabId: string): Promise<void>;
  closeBrowserTab(tabId: string): Promise<void>;
  /** Behind `browser-user-control`: the owning agent waits on the tab until the release. */
  takeBrowserControl(tabId: string): Promise<void>;
  releaseBrowserControl(tabId: string): Promise<void>;
  respondToBrowserSecret?: (input: RespondToBrowserSecretInput) => Promise<void>;
  getSidebarLayout?: () => Promise<SidebarLayoutSnapshot>;
  mutateSidebarLayout?: (action: SidebarLayoutAction) => Promise<SidebarLayoutSnapshot>;
  /** The host's channel routes. A channel page arrives without host file URLs. */
  channels?: TeamChannelsApi;
  /** The team member this connection signs in as, which is how the host names this reader's messages. */
  currentMemberId?: () => Promise<string>;
  respondToTakeover(input: RespondToBrowserTakeoverInput): Promise<void>;
  listHosts(): Promise<RemoteTeamHost[]>;
  /** Ends this account's membership of a host. The account service refuses the owner. */
  leaveHost(hostId: string, membershipId: string): Promise<void>;
  removeOwnedHost?: (hostId: string) => Promise<void>;
  previewInvite(url: string): Promise<InvitePreview>;
  acceptInvite(url: string): Promise<RemoteTeamHost>;
  connect(host: RemoteTeamHost): Promise<string[]>;
  disconnect(): Promise<void>;
  listAgents(): Promise<ClientAgentSummary[]>;
  conversation(agentId: string, before?: string): Promise<ConversationPage>;
  /** The page of an agent's conversation around one message, or the newest page from an older host. */
  conversationAround?: (agentId: string, messageId: string) => Promise<ConversationPage>;
  /** Marks this member's messages from the agent read through `throughMessageId`, or all when it is null. */
  markRead(agentId: string, throughMessageId: string | null): Promise<ConversationReadState>;
  /**
   * Marks the whole conversation unread for this member: the host's read cursor has no value for "only
   * the last message". Needs the `conversation-unread` capability.
   */
  markUnread(agentId: string): Promise<ConversationReadState>;
  /** This member's read state for each agent, keyed by agent id. Invalid entries are left out. */
  conversationReads(): Promise<Record<string, ConversationReadState>>;
  /**
   * The browser saw the network come back. The open connection renews its path, and each status
   * connection that waits to retry tries again now. Nothing is resent.
   */
  networkRestored?(): void;
  /**
   * Fails the requests that wait for a reconnect. The recovery owner calls it when its own connect
   * attempt loses the connection: its reads must fail so that the next attempt can start.
   */
  abandonReconnectWaits?(): void;
  /** Asks the host to send its runtime snapshot again, after events were lost. */
  requestRuntimeSnapshot?(): void;
  /**
   * Replaces a connection whose events stopped while the host still worked. The workspace stays
   * online, and the connection update with `resync` follows.
   */
  replaceConnection?(reason: "event-stall"): void;
  /** Tells a hosted server that this tab has focus. Send it only to a host with `focus-use-v1`. */
  focusUse(): Promise<void>;
  /** Resolves to the conversation message the host stored: the delivery id of the receipt. */
  send(
    agentId: string,
    text: string,
    attachmentDraftIds: string[],
    replyToMessageId?: string | null,
    clientMessageId?: string,
  ): Promise<string>;
  stop(agentId: string, turnId: string): Promise<void>;
  /** Sends which agent this member is writing to, or `null`. It does nothing while the host is offline. */
  setTyping(agentId: string | null, typing: boolean): void;
  queue(agentId: string): Promise<QueueSnapshot>;
  /** Every queue the member can see, in one read (`agent-queues-v1`). A host without it answers 404. */
  queues?(): Promise<QueueSnapshot[]>;
  editQueue(input: EditQueuedMessageInput): Promise<QueueSnapshot>;
  cancelQueued(input: CancelQueuedMessageInput): Promise<void>;
  steerQueued(input: SteerQueuedMessageInput): Promise<void>;
  updateQueued(input: UpdateQueuedMessageInput): Promise<void>;
  reorderQueue(input: ReorderQueueInput): Promise<void>;
  approve(input: RespondToApprovalInput): Promise<void>;
  answer(input: RespondToPromptInput): Promise<void>;
  upload(file: File): Promise<AttachmentSummary>;
  cancelUpload(): Promise<void>;
  /**
   * Discards an upload. An upload of another host than the open one is discarded when this tab opens
   * that host again: its id never goes to another host.
   */
  discard(attachmentId: string, hostId?: string): Promise<void>;
  /**
   * Names the uploads that the sends not yet stored hold, such as a failed send that waits for Retry.
   * A change of host keeps them, so that Retry on the person's return still has its files.
   */
  holdDrafts?(held: () => ReadonlySet<string>): void;
  download(attachmentId: string): Promise<WebFile>;
  /**
   * A small copy of an image attachment for inline display (`attachment-previews-v1`), or the
   * original when the host makes no copy. `null` when the host has no such route.
   */
  attachmentPreview?(attachmentId: string): Promise<WebFile | null>;
  /** The image that the host drew of a workspace artifact's page, at its `thumbnailVersion`. */
  artifactThumbnail?(artifactId: string, version: string): Promise<WebFile>;
  /**
   * A link that the browser downloads from the host's own download address, so a file of any size
   * streams to disk and not through the connection. `null` when the host has none.
   */
  fileLink(source: FileTicketSource): Promise<FileTicket | null>;
  /** A file under the host's shared folder. */
  sharedFile(path: string): Promise<WebFile>;
  /** A file in one agent's workspace on the host. */
  workspaceFile(agentId: string, path: string): Promise<WebFile>;
  /** A folder in one agent's workspace on the host. */
  workspaceDirectory(agentId: string, path: string): Promise<WorkspaceDirectory>;
  /** The routine canvas routes. Each call refuses while the host does not serve `routine-flows-v1`. */
  routineFlows?: TeamRoutineFlowsApi;
  /** Changes an agent routine, such as its instruction. */
  updateRoutine?: (input: UpdateRoutineInput) => Promise<Routine>;
  /** Runs an agent routine now. */
  testRoutine?: (input: TestRoutineInput) => Promise<RoutineRun>;
  /** The agents that a user hid on the host. Any member can call it on a host with `agent-hidden-v1`. */
  listHiddenAgents?: () => Promise<HiddenAgentsSnapshot>;
  /** Hides or restores an agent, and returns the host's hidden list. Needs `agent-hidden-v1`. */
  setAgentHidden?: (input: SetAgentHiddenInput) => Promise<HiddenAgentsSnapshot>;
  react(input: SetMessageReactionInput): Promise<void>;
  setAvatar(agentId: string, image: AvatarImageInput | null): Promise<void>;
  models(): Promise<ClientAgentModelOption[]>;
  status(): Promise<AgentStatus>;
  accountUsage?: () => Promise<AccountUsage>;
  createAgent(input: CreateAgentInput): Promise<ClientAgentSummary>;
  duplicateAgent(agentId: string): Promise<DuplicateAgentResult>;
  updateAgent(input: UpdateAgentInput): Promise<void>;
  deleteAgent(agentId: string): Promise<void>;
  /** Searches one agent's conversation, or every conversation on the host when `agentId` is not set. */
  search(agentId: string | undefined, query: string, cursor?: string): Promise<ConversationSearchPage>;
  /**
   * `sessionsEnded`: the account service already ended this account's remote sessions, as sign-out
   * does. The browser then sends no end request, which the revoked cookie would only have refused.
   */
  dispose(options?: { sessionsEnded?: boolean }): Promise<void>;
}

export interface WebRuntimeEvents {
  connection(update: RemoteTeamConnectionUpdate): void;
  accessDenied?(hostId: string, error: WebHostConnectionError): void;
  event(hostId: string, event: AgentEvent | TeamRealtimeEvent): void;
  accountChanged(): Promise<void>;
  /** The state of a host this tab has not opened. */
  hostState?(hostId: string, state: WebHostState): void;
  /** A host that this tab has not opened revoked its session. */
  hostSessionRevoked?(): void;
  /** An event of a host this tab has not opened that a notification can show. */
  hostNotice?(hostId: string, event: WebHostNotice, agents: ClientAgentSummary[]): void;
}

/** The host speaks no Team API protocol that this web build speaks. The workspace shows it in full. */
export class WebHostIncompatibleError extends Error {
  readonly code: "client_update_required" | "host_update_required";
  readonly hostAppVersion: string;
  readonly hostProtocol: TeamProtocolSupportV1["protocol"];

  constructor(support: TeamProtocolSupportV1, code: WebHostIncompatibleError["code"]) {
    super(currentText().t("webClient.error.incompatible"));
    this.code = code;
    this.hostAppVersion = support.appVersion;
    this.hostProtocol = support.protocol;
  }
}

export class WebHostConnectionError extends Error {
  /** The code a user can copy, such as `http/401`. */
  readonly reference: string | null;

  constructor(
    readonly code: "identity_changed" | "authentication_required" | "access_ended",
    reference: string | null = null,
  ) {
    super(
      currentText().t(code === "identity_changed" ? "webClient.error.identityChanged" : "webClient.error.accessEnded"),
    );
    this.reference = reference;
  }
}

interface WebConnectionDependencies {
  createPeer: typeof createRemoteTeamPeer;
  acquireHostLock: typeof acquireWebHostLock;
  /** The channel between the tabs of the account. Without one, this tab keeps no status connections. */
  openHostChannel?: (accountId: string) => BroadcastChannel | null;
}

/** Pin after directory validation and before connecting. Never silently replace a saved identity. */
function pinWebHostKey(accountId: string, host: RemoteTeamHost): void {
  const key = `openbot.web.host-key:${accountId}:${host.hostId}`;
  const pinned = localStorage.getItem(key);
  if (pinned && pinned !== host.devicePublicKey) throw new WebHostConnectionError("identity_changed");
  localStorage.setItem(key, host.devicePublicKey);
}

export function createWebWorkspaceRuntime(
  accountId: string,
  events: WebRuntimeEvents,
  accountFetch: typeof fetch,
  dependencies: WebConnectionDependencies = {
    // A browser on a computer takes a file up to the protocol limit; a phone keeps the 10 MB default.
    createPeer: (actions) => createRemoteTeamPeer(actions, { downloadLimitBytes: TEAM_PROTOCOL_V2_MAX_FILE_BYTES }),
    acquireHostLock: acquireWebHostLock,
    openHostChannel: openWebHostChannel,
  },
): WebWorkspaceRuntime {
  const directory = new RemoteTeamDirectoryClient({
    apiUrl: window.location.origin,
    authentication: { kind: "browser" },
    fetch: accountFetch,
    // `bun run dev:api` serves this page and the account service from `http://localhost:<port>`.
    inviteLinks: { allowLocalDevelopmentApiUrl: import.meta.env.DEV },
    verifyHostKeySignature: verifyEd25519Base64Url,
    // Each tab has its own remote session, so the host keeps a peer for each tab that opens it.
    clientInstanceId: webTabInstanceId,
    hostKeys: {
      get: async (id) => localStorage.getItem(`openbot.web.host-key:${accountId}:${id}`),
      set: async (id, key) => localStorage.setItem(`openbot.web.host-key:${accountId}:${id}`, key),
    },
  });
  let sessionsEnded = false;
  const sessionActions = {
    getBootstrap: async (id: string, key: string, sessionId: string | null) => {
      try {
        return await runTeamEffect(directory.createBootstrap(id, key, sessionId));
      } catch (error) {
        // The reference keeps 401 apart from 403 and names the account service code, such as `session_inactive`.
        if (error instanceof RemoteDirectoryError && (error.status === 401 || error.status === 403))
          events.connection({
            hostId: id,
            state: "offline",
            message: null,
            code: "session_revoked",
            ...(error.reference ? { reference: error.reference } : {}),
          });
        throw error;
      }
    },
    endSession: async (id: string) => {
      if (!sessionsEnded) await runTeamEffect(directory.endSession(id));
    },
  };
  /** The host of a connect attempt that Signal holds until the host is online. */
  let waitingHostId: string | null = null;
  const peer = dependencies.createPeer(
    {
      current: {
        ...sessionActions,
        onConnectionUpdate: async (update) => {
          // A `connecting` update without `hostOffline`, such as a `rate_limited` reply, does not end the hold.
          if (update.hostOffline) waitingHostId = update.hostId;
          else if (update.state !== "connecting") waitingHostId = null;
          peerOnline = update.state === "online";
          wakeConnectionWaiters();
          if (update.state !== "online") {
            browserView.disconnect(update.message ?? undefined);
            const releaseGeneration = liveViewGeneration + 1;
            void releaseLiveView().finally(() => {
              if (liveViewGeneration === releaseGeneration) browserView.disconnect();
            });
          }
          events.connection(update);
        },
        onHostStreamData: (data) => browserView.receive(data),
        onTeamEvent: async (id, event) => events.event(id, event),
        onAccountProfileChanged: events.accountChanged,
      },
    },
    { waitForHost: true },
  );
  let releaseHostLock: (() => void) | null = null;
  let openedHostId: string | null = null;
  const hostChannel = dependencies.openHostChannel?.(accountId) ?? null;
  const hosts = hostChannel
    ? createWebHostConnections({
        accountId,
        channel: hostChannel,
        actions: sessionActions,
        createPeer: dependencies.createPeer,
        acquireHostLock: dependencies.acquireHostLock,
        pinHostKey: (host) => pinWebHostKey(accountId, host),
        onState: (hostId, state) => events.hostState?.(hostId, state),
        onSessionRevoked: () => events.hostSessionRevoked?.(),
        // Without a listener, the status connections read no agent list.
        ...(events.hostNotice
          ? {
              onNotice: (hostId: string, event: WebHostNotice, agents: ClientAgentSummary[]) =>
                events.hostNotice?.(hostId, event, agents),
            }
          : {}),
      })
    : undefined;
  let connecting: Promise<unknown> | null = null;
  let disposed = false;
  let generation = 0;
  /**
   * Changes only when the requests go to another host, or to none. A reconnect to the same host, such
   * as the check of a healthy peer after an event reset, keeps it: an answer of that host is still its
   * answer, and a write that it did must not read as failed.
   */
  let hostGeneration = 0;
  let generationHostId: string | null = null;
  function noteRequestHost(hostId: string | null): void {
    if (hostId === generationHostId) return;
    generationHostId = hostId;
    hostGeneration += 1;
  }
  let uploadGeneration = 0;
  let capabilities: string[] = [];
  /** The hosts that answered 404 for a preview: a fork host built before `attachment-previews-v1`. */
  const previewsMissing = new Set<string | null>();
  let connectedHost: RemoteTeamHost | null = null;
  const duplicateOperationIds = new Map<string, string>();
  const completedDraftIdsByHost = new Map<string, Set<string>>();
  const draftCleanupRetryHosts = new Set<string>();
  let heldDrafts: () => ReadonlySet<string> = () => new Set();
  /** The composer backup that each queue edit retains on its host, by host and edit. */
  const retainedEditDrafts = new Map<string, string[]>();
  const retainedEditKey = (hostId: string, editId: string) => `${hostId}\u0000${editId}`;
  function trackCompletedDraft(id: string, hostId = openedHostId): void {
    if (!hostId) return;
    // The released API has no draft listing. A request that commits before returning cannot be
    // recovered if its response is lost, so only returned identifiers enter this cleanup set.
    let ids = completedDraftIdsByHost.get(hostId);
    if (!ids) {
      ids = new Set<string>();
      completedDraftIdsByHost.set(hostId, ids);
    }
    ids.add(id);
  }
  function removeCompletedDrafts(idsToRemove: string[], hostId = openedHostId): void {
    if (!hostId) return;
    const ids = completedDraftIdsByHost.get(hostId);
    if (!ids) return;
    for (const id of idsToRemove) ids.delete(id);
    if (!ids.size) {
      completedDraftIdsByHost.delete(hostId);
      draftCleanupRetryHosts.delete(hostId);
    }
  }
  /** `keepHeld` keeps the uploads of pending sends for a later return. Only the end of the page drops them. */
  async function discardCompletedDrafts(hostId = openedHostId, keepHeld = true): Promise<void> {
    if (!hostId || openedHostId !== hostId) return;
    const ids = completedDraftIdsByHost.get(hostId);
    if (!ids?.size) {
      draftCleanupRetryHosts.delete(hostId);
      return;
    }
    const held = keepHeld ? heldDrafts() : new Set<string>();
    for (const id of [...ids]) {
      if (openedHostId !== hostId) {
        draftCleanupRetryHosts.add(hostId);
        return;
      }
      if (held.has(id)) {
        draftCleanupRetryHosts.add(hostId);
        continue;
      }
      try {
        await Effect.runPromise(discardAttachmentDraft(teamApi, id).pipe(Effect.mapError((error) => error.cause)));
        ids.delete(id);
        if (!ids.size) completedDraftIdsByHost.delete(hostId);
      } catch {
        // Cleanup is best effort. Keep an unconfirmed draft for a same-host reconnect;
        // never send its identifier to another host.
        draftCleanupRetryHosts.add(hostId);
      }
    }
    if (!completedDraftIdsByHost.has(hostId)) draftCleanupRetryHosts.delete(hostId);
  }
  /** Whether the peer of the opened host reported `online` last. */
  let peerOnline = false;
  /** Counts disconnects and abandoned waits. A request that waits for a reconnect stops waiting at one. */
  let closedConnections = 0;
  /** Requests that wait for the connection to come back. Each one returns true when it is done waiting. */
  const connectionWaiters = new Set<() => boolean>();
  function wakeConnectionWaiters(): void {
    for (const waiter of [...connectionWaiters]) if (waiter()) connectionWaiters.delete(waiter);
  }
  /**
   * Waits until the connection to `hostId` is online again. False when the page closes, the person
   * disconnects or opens another host, or the wait ends first. Between two recovery attempts no host
   * is opened; that is not a change of host. The recovery owner reconnects; this only waits for it.
   */
  function waitForConnection(hostId: string | null, closed: number, waitMs: number): Promise<boolean> {
    const settled = (): boolean | null =>
      disposed || !hostId || closed !== closedConnections || (openedHostId !== null && openedHostId !== hostId)
        ? false
        : peerOnline && openedHostId === hostId
          ? true
          : null;
    // The peer still says online while it restarts its ICE path, and sends no update for it. A short
    // pause gives the path time; the caller asks again while its wait lasts.
    if (settled() === true)
      return new Promise((resolve) =>
        setTimeout(() => resolve(settled() !== false), Math.min(waitMs, RESEND_PAUSE_MS)),
      );
    return new Promise((resolve) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const check = (): boolean => {
        const value = settled();
        if (value === null) return false;
        clearTimeout(timer);
        resolve(value);
        return true;
      };
      if (check()) return;
      connectionWaiters.add(check);
      timer = setTimeout(() => {
        connectionWaiters.delete(check);
        resolve(false);
      }, waitMs);
    });
  }
  /**
   * A request that the connection lost is sent again after the connection comes back: a request that
   * never left at all, or a read, which the host can answer twice. A write that the host can have done
   * is not sent again, and an upload keeps its own retry. All attempts share one wait. A read that got
   * no answer in time goes once more at once: one lost or late answer is not a failure that the reader
   * must see.
   */
  async function request(method: string, path: string, body: TeamProtocolV2Json = {}, upload?: RemoteFileUpload) {
    const requestHostId = openedHostId;
    const closed = closedConnections;
    const deadline = Date.now() + REQUEST_RECONNECT_WAIT_MS;
    let timeoutResent = false;
    for (;;) {
      try {
        return await requestOnce(method, path, body, upload);
      } catch (error) {
        // The compatibility read is the probe that tells whether the connection works. It never waits.
        if (!(error instanceof WebHostRequestError) || upload !== undefined || path === TEAM_API_ROUTES.compatibility)
          throw error;
        if (error.timedOutRead && !timeoutResent) {
          timeoutResent = true;
          continue;
        }
        if (!error.resend) throw error;
        const waitMs = deadline - Date.now();
        if (waitMs <= 0 || !(await waitForConnection(requestHostId, closed, waitMs))) throw error;
      }
    }
  }
  async function requestOnce(method: string, path: string, body: TeamProtocolV2Json, upload?: RemoteFileUpload) {
    if (disposed) throw new Error(currentText().t("webClient.error.connectionClosed"));
    const current = hostGeneration;
    const requestHostId = openedHostId;
    const timeoutMs =
      method === "GET" && path === TEAM_API_ROUTES.me ? 15_000 : remoteWorkspaceReadTimeout(method, path);
    const result = await peer.execute({
      id: crypto.randomUUID(),
      type: "request",
      method,
      path,
      body,
      ...(upload === undefined ? {} : { upload }),
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
    });
    const failure = remoteRequestFailure(result);
    const read = isRemoteReadRequest(method, path);
    // A request that the connection lost waits for the reconnect, so its failure is the connection's,
    // not a host change.
    const lost = failure?.kind === "unsent" || (read && failure?.kind === "connection");
    if (!lost && (disposed || hostGeneration !== current))
      throw new Error(currentText().t("webClient.error.hostChanged"));
    const membershipRead = method === "GET" && path === TEAM_API_ROUTES.me;
    // An action can be forbidden while membership remains valid. Confirm access before clearing drafts.
    if (result.status === 403 && !membershipRead) {
      await request("GET", TEAM_API_ROUTES.me);
      if (disposed || hostGeneration !== current) throw new Error(currentText().t("webClient.error.hostChanged"));
    }
    if (result.status === 401 || (result.status === 403 && membershipRead)) {
      const error = new WebHostConnectionError(
        result.status === 401 ? "authentication_required" : "access_ended",
        referenceFrom("http", result.status),
      );
      if (requestHostId) events.accessDenied?.(requestHostId, error);
      throw error;
    }
    if (failure)
      throw new WebHostRequestError(
        requestFailureText(failure, read, result.error),
        result.reference ?? null,
        lost && requestHostId !== null,
        failure.kind === "unsent" || failure.kind === "connection" || failure.kind === "timeout",
        false,
        read && failure.kind === "timeout",
      );
    if ((result.status ?? 500) >= 400)
      throw new WebHostRequestError(
        hostRefusal(result.status, result.body) ?? currentText().t("webClient.error.requestIncomplete"),
        result.status === undefined ? (result.reference ?? null) : referenceFrom("http", result.status),
        false,
        false,
        result.status !== undefined && result.status < 500,
      );
    return result.body;
  }
  // The shared Team API requests decode their own responses. A declaration, like `request`, so the
  // draft cleanup above can reach it.
  async function teamApi<T>(
    method: string,
    path: string,
    decode: (value: unknown) => T,
    body?: TeamProtocolV2Json,
    upload?: RemoteFileUpload,
  ): Promise<T> {
    return decode(await request(method, path, body, upload));
  }
  function requireHost(): RemoteTeamHost {
    if (!connectedHost) throw new Error(currentText().t("webClient.error.hostNotConnected"));
    return connectedHost;
  }
  async function listMembers(): Promise<TeamMemberSummary[]> {
    return (await runTeamEffect(directory.listMembers(requireHost().hostId))).map(toTeamMember);
  }
  const admin: WebAdminRuntime = {
    request: teamApi,
    team: {
      async getPresence() {
        const value = await request("GET", TEAM_API_ROUTES.team.presence);
        if (!isTeamPresenceSnapshot(value)) throw new Error(currentText().t("error.remote.invalidData"));
        return value;
      },
      listMembers,
      async listInvites() {
        return (await runTeamEffect(directory.listInvites(requireHost().hostId)))
          .filter((invite) => invite.revokedAt === null)
          .map(toTeamInvite);
      },
      async createInvite(input) {
        const host = requireHost();
        const invite = input.email
          ? await runTeamEffect(directory.sendInviteEmail(host, { role: input.role, email: input.email }))
          : await runTeamEffect(directory.createInvite(host, input));
        return {
          id: invite.inviteId,
          role: input.role,
          expiresAt: new Date(invite.expiresAt).toISOString(),
          usedAt: null,
          email: input.email ?? null,
          permanent: input.permanent ?? false,
          useCount: 0,
          inviteUrl: invite.inviteUrl,
        };
      },
      // The account service returns nothing useful, so the member is read back. The read before the
      // change refuses an owner, as the desktop does.
      async updateMember(input) {
        const hostId = requireHost().hostId;
        const current = (await listMembers()).find((member) => member.id === input.memberId);
        if (!current || current.role === "owner") throw new Error(currentText().t("webClient.error.memberNotFound"));
        if (input.disabled) await runTeamEffect(directory.leaveHost(hostId, input.memberId));
        else
          await runTeamEffect(
            directory.updateMember(hostId, input.memberId, input.role ?? current.role, input.disabled === false),
          );
        const updated = (await listMembers()).find((member) => member.id === input.memberId);
        if (!updated) throw new Error(currentText().t("webClient.error.memberNotFound"));
        return updated;
      },
      removeMember: (memberId) => runTeamEffect(directory.leaveHost(requireHost().hostId, memberId)),
      revokeInvite: (inviteId) => runTeamEffect(directory.revokeInvite(inviteId)),
    },
  };
  const channels = teamChannelsApi(teamApi, { supportsWorkspace: () => capabilities.includes(WORKSPACE_CAPABILITY) });
  /** The routine flow routes, sent only to a host that negotiated them. */
  async function routineFlowsRequest<T>(
    method: string,
    path: string,
    decode: (value: unknown) => T,
    body?: TeamProtocolV2Json,
  ): Promise<T> {
    if (!capabilities.includes(ROUTINE_FLOWS_CAPABILITY))
      throw new Error(currentText().t("error.team.routineFlowsUnsupported"));
    return teamApi(method, path, decode, body);
  }
  const routineFlows = teamRoutineFlowsApi(routineFlowsRequest);
  const agentRoutines = teamAgentRoutinesApi(teamApi);
  /** The page size the next view asks for, from the view that starts it. */
  let liveViewViewport: BrowserViewViewport | null = null;
  const holdsViewport = () => capabilities.includes(TEAM_BROWSER_VIEW_VIEWPORT_CAPABILITY);
  const browserView = createRemoteBrowserView(
    (data) => peer.sendHostStreamData(data),
    request,
    () => capabilities.includes(TEAM_BROWSER_VIEW_FRAME_POINT_CAPABILITY),
    () => capabilities.includes(TEAM_BROWSER_VIEW_CLIPBOARD_CAPABILITY),
    () => ({ cursor: false, contextMenu: false, viewport: holdsViewport() ? liveViewViewport : null }),
  );
  let liveView: RemoteBrowserView | null = null;
  let liveViewGeneration = 0;
  async function releaseLiveView(): Promise<void> {
    liveViewGeneration += 1;
    const current = liveView;
    liveView = null;
    if (current) {
      await runTeamEffect(current.close()).catch(() => undefined);
    } else {
      // Also cancel an open request that has not installed its session yet.
      browserView.disconnect();
    }
  }
  const viewListeners = new Set<(event: BrowserLiveViewEvent) => void>();
  const emitView = (event: BrowserLiveViewEvent) => {
    for (const listener of viewListeners) listener(event);
  };
  async function connectHost(host: RemoteTeamHost): Promise<string[]> {
    try {
      await peer.cancelUpload().catch(() => undefined);
      const switchingHost = openedHostId !== host.hostId;
      const retryDraftCleanup = switchingHost && draftCleanupRetryHosts.has(host.hostId);
      if (switchingHost) await discardCompletedDrafts();
      await releaseLiveView();
      browserView.disconnect();
      if (switchingHost) {
        await peer.execute({ id: crypto.randomUUID(), type: "disconnect" });
        peerOnline = false;
        releaseHostLock?.();
        releaseHostLock = null;
        openedHostId = null;
        // This tab's own status connection gives the host up first.
        await hosts?.select(host.hostId);
        // This tab connects with its own session, so other tabs can have the host open too. The lock
        // only makes this tab speak for the host's state to the tabs that have not opened it.
        const release = await dependencies.acquireHostLock(accountId, host.hostId).catch(() => null);
        if (disposed) {
          release?.();
          throw new Error(currentText().t("webClient.error.connectionClosed"));
        }
        releaseHostLock = release;
        openedHostId = host.hostId;
        hosts?.holdSelected(host.hostId, release !== null);
      }
      const current = ++generation;
      noteRequestHost(host.hostId);
      connectedHost = host;
      pinWebHostKey(accountId, host);
      const result = await peer.execute({
        id: crypto.randomUUID(),
        type: "connect",
        hostId: host.hostId,
        hostPublicKey: host.devicePublicKey,
      });
      if (!result.ok || disposed || current !== generation)
        throw new WebHostRequestError(
          currentText().t("webClient.error.connectionUnavailable"),
          result.ok ? null : (result.reference ?? null),
        );
      const support = decodeTeamProtocolSupportV7Base(await request("GET", TEAM_API_ROUTES.compatibility));
      const updateDirection = teamProtocolUpdateDirection(
        { minimum: TEAM_PROTOCOL_V3, maximum: TEAM_PROTOCOL_V3 },
        support.protocol,
      );
      if (updateDirection) throw new WebHostIncompatibleError(support, updateDirection);
      capabilities = support.capabilities;
      if (retryDraftCleanup) await discardCompletedDrafts(host.hostId);
      return capabilities;
    } catch (error) {
      capabilities = [];
      connectedHost = null;
      try {
        await peer.execute({ id: crypto.randomUUID(), type: "disconnect" });
        peerOnline = false;
      } finally {
        releaseHostLock?.();
        releaseHostLock = null;
        openedHostId = null;
        hosts?.holdSelected(host.hostId, false);
      }
      throw error;
    }
  }
  return {
    admin,
    ...(hosts ? { hosts } : {}),
    browser: {
      liveViewHoldsViewport: holdsViewport,
      async startLiveView(tabId, options) {
        const currentGeneration = ++liveViewGeneration;
        liveViewViewport = options?.viewport ?? null;
        const next = await runTeamEffect(
          browserView.open(
            tabId,
            (frame) => emitView({ type: "frame", tabId, ...frame }),
            (reason) =>
              emitView({ type: "stopped", tabId, reason: reason || currentText().t("webClient.error.viewEnded") }),
            (copied) => emitView({ ...copied, tabId }),
          ),
        );
        if (currentGeneration !== liveViewGeneration) {
          await runTeamEffect(next.close()).catch(() => undefined);
          throw new Error(currentText().t("webClient.error.viewChanged"));
        }
        liveView = next;
      },
      async stopLiveView() {
        await releaseLiveView();
      },
      async sendLiveViewInput(input) {
        if (liveView) await runTeamEffect(liveView.input(decodeBrowserViewInputValue(input)));
      },
      onLiveViewEvent(listener) {
        viewListeners.add(listener);
        return () => {
          viewListeners.delete(listener);
        };
      },
    },
    async browserTabs() {
      const value = await request("GET", TEAM_API_ROUTES.browser.tabs);
      if (!Array.isArray(value)) throw new Error(currentText().t("error.remote.invalidData"));
      // The frozen tab list has no field for a person's control or the history state, so the host
      // answers on their own routes.
      const held = capabilities.includes(BROWSER_USER_CONTROL_CAPABILITY)
        ? new Set(decodeBrowserUserControlSnapshot(await request("POST", BROWSER_USER_CONTROL_ROUTES.state, {})).tabIds)
        : new Set<string>();
      const pageStates = capabilities.includes(BROWSER_PAGE_STATE_CAPABILITY)
        ? new Map(
            decodeBrowserPageStateSnapshot(await request("POST", BROWSER_PAGE_STATE_ROUTES.state, {})).tabs.map(
              ({ tabId, ...state }) => [tabId, state],
            ),
          )
        : new Map<string, { canGoBack: boolean; canGoForward: boolean }>();
      return value.map(decodeWebBrowserTab).map((tab) => ({
        ...tab,
        ...(held.has(tab.id) ? { userControl: true as const } : {}),
        ...pageStates.get(tab.id),
      }));
    },
    async openBrowserTab(input) {
      return decodeWebBrowserTab(await request("POST", TEAM_API_ROUTES.browser.open, { ...input }));
    },
    async navigateBrowserTab(input) {
      if (!("url" in input)) {
        await request("POST", TEAM_API_ROUTES.browser.navigate, { ...input });
        return;
      }
      // An older host has no route that moves an existing tab to an address; the browser store
      // opens a new tab for it instead.
      if (!capabilities.includes(TEAM_BROWSER_NAVIGATION_CAPABILITY))
        throw new Error(currentText().t("error.backend.browserNavigateUnsupported"));
      await request("POST", TEAM_API_ROUTES.browser.load, { ...input });
    },
    async reloadBrowserTab(tabId) {
      await request("POST", TEAM_API_ROUTES.browser.reload, { tabId });
    },
    async stopBrowserTab(tabId) {
      if (!capabilities.includes(BROWSER_PAGE_STATE_CAPABILITY))
        throw new Error(currentText().t("error.backend.browserStopUnsupported"));
      decodeBrowserPageStateSnapshot(await request("POST", BROWSER_PAGE_STATE_ROUTES.stop, { tabId }));
    },
    async closeBrowserTab(tabId) {
      await request("POST", TEAM_API_ROUTES.browser.close, { tabId });
    },
    async takeBrowserControl(tabId) {
      if (!capabilities.includes(BROWSER_USER_CONTROL_CAPABILITY))
        throw new Error(currentText().t("error.backend.browserUserControlUnsupported"));
      decodeBrowserUserControlSnapshot(await request("POST", BROWSER_USER_CONTROL_ROUTES.take, { tabId }));
    },
    async releaseBrowserControl(tabId) {
      if (!capabilities.includes(BROWSER_USER_CONTROL_CAPABILITY))
        throw new Error(currentText().t("error.backend.browserUserControlUnsupported"));
      decodeBrowserUserControlSnapshot(await request("POST", BROWSER_USER_CONTROL_ROUTES.release, { tabId }));
    },
    async browserPreview(tabId) {
      return decodeWebBrowserPreview(await request("POST", TEAM_API_ROUTES.browser.preview, { tabId }));
    },
    async getSidebarLayout() {
      const value = await request("GET", TEAM_API_ROUTES.sidebarLayout.state);
      if (!isSidebarLayoutSnapshot(value)) throw new Error(currentText().t("error.remote.invalidData"));
      return value;
    },
    async mutateSidebarLayout(action) {
      const value = await request("POST", TEAM_API_ROUTES.sidebarLayout.actions, { ...action });
      if (!isSidebarLayoutSnapshot(value)) throw new Error(currentText().t("error.remote.invalidData"));
      return value;
    },
    channels: {
      ...channels,
      async readChannel(input) {
        const page = await channels.readChannel(input);
        // A host file URL must not reach the browser; attachments are downloaded through the host.
        return {
          ...page,
          messages: page.messages.map((entry) => {
            const attachments = entry.message.attachments;
            if (!attachments) return entry;
            return {
              ...entry,
              message: {
                ...entry.message,
                attachments: attachments.map((attachment) => ({ ...attachment, previewUrl: null })),
              },
            };
          }),
        };
      },
      async channelCommand(command) {
        const channel = await channels.channelCommand(command);
        if (command.type === "send") removeCompletedDrafts(command.attachmentDraftIds);
        return channel;
      },
    },
    async currentMemberId() {
      const value = await request("GET", TEAM_API_ROUTES.me);
      if (!isDynamicRecord(value)) throw new Error(currentText().t("error.remote.invalidData"));
      return requiredString(value, "id");
    },
    respondToBrowserSecret: (input) =>
      Effect.runPromise(respondToBrowserSecret(teamApi, input).pipe(Effect.mapError((error) => error.cause))),
    respondToTakeover: (input) =>
      Effect.runPromise(respondToBrowserTakeover(teamApi, input).pipe(Effect.mapError((error) => error.cause))),
    listHosts: () => runTeamEffect(directory.listHosts()),
    leaveHost: (hostId, membershipId) => runTeamEffect(directory.leaveHost(hostId, membershipId)),
    async removeOwnedHost(hostId) {
      const response = await accountFetch(`/api/browser/v2/remote/hosts/${encodeURIComponent(hostId)}`, {
        method: "DELETE",
        credentials: "same-origin",
        headers: { "X-OpenBot-Browser": "1", "Content-Type": "application/json" },
        signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok) throw new Error(currentText().t("server.settings.actionFailed"));
    },
    async previewInvite(url) {
      const value = await runTeamEffect(directory.previewInvite(url));
      return {
        serverId: value.hostId,
        serverName: value.hostName,
        apiHostname: new URL(url).hostname,
        role: value.role,
        expiresAt: new Date(value.expiresAt).toISOString(),
        emailBound: value.emailBound,
        permanent: value.expiresAt === 0,
      };
    },
    acceptInvite: (url) => runTeamEffect(directory.acceptInvite(url)),
    async connect(host) {
      // An attempt that waits for an offline host has no deadline, so another host replaces it.
      if (connecting && waitingHostId !== null && waitingHostId !== host.hostId) {
        const previous = connecting;
        await peer.execute({ id: crypto.randomUUID(), type: "disconnect" });
        peerOnline = false;
        await previous.catch(() => undefined);
      }
      if (connecting || disposed) throw new Error(currentText().t("webClient.error.connectionChanging"));
      const attempt = connectHost(host);
      connecting = attempt;
      try {
        return await attempt;
      } finally {
        if (connecting === attempt) {
          connecting = null;
          waitingHostId = null;
        }
      }
    },
    async disconnect() {
      const hostForCleanup = openedHostId;
      closedConnections += 1;
      wakeConnectionWaiters();
      try {
        await peer.cancelUpload().catch(() => undefined);
        await discardCompletedDrafts(hostForCleanup);
        generation += 1;
        noteRequestHost(null);
        await releaseLiveView();
        browserView.disconnect();
        await peer.execute({ id: crypto.randomUUID(), type: "disconnect" });
        peerOnline = false;
      } finally {
        releaseHostLock?.();
        releaseHostLock = null;
        openedHostId = null;
        connectedHost = null;
        void hosts?.select(null);
      }
    },
    async listAgents() {
      return guardedListDecoder(isClientAgentSummary, "agents")(await request("GET", TEAM_API_ROUTES.agents.all));
    },
    async conversation(id, before) {
      if (!capabilities.includes("conversation-pagination")) {
        return decodeWebConversationSnapshot(await request("GET", TEAM_API_ROUTES.agent.conversation(id)));
      }
      const query = new URLSearchParams({ limit: "50", ...(before ? { before } : {}) });
      return decodeWebConversationPage(await request("GET", `${TEAM_API_ROUTES.agent.conversationPage(id)}?${query}`));
    },
    async conversationAround(id, messageId) {
      if (!capabilities.includes("conversation-pagination"))
        return decodeWebConversationSnapshot(await request("GET", TEAM_API_ROUTES.agent.conversation(id)));
      const query = new URLSearchParams({ limit: "50", around: messageId });
      return decodeWebConversationPage(await request("GET", `${TEAM_API_ROUTES.agent.conversationPage(id)}?${query}`));
    },
    async markRead(id, throughMessageId) {
      const value = await request("POST", TEAM_API_ROUTES.agent.conversationRead(id), { throughMessageId });
      if (!isConversationReadState(value)) throw new Error(currentText().t("error.remote.invalidData"));
      return value;
    },
    async markUnread(id) {
      const value = await request("POST", TEAM_API_ROUTES.agent.conversationUnread(id), {});
      if (!isConversationReadState(value)) throw new Error(currentText().t("error.remote.invalidData"));
      return value;
    },
    async focusUse() {
      await request("POST", FOCUS_USE_ROUTES.ping);
    },
    async conversationReads() {
      const value = await request("GET", TEAM_API_ROUTES.agents.conversationReads);
      const reads: Record<string, ConversationReadState> = {};
      if (!isDynamicRecord(value)) return reads;
      for (const [agentId, state] of Object.entries(value)) {
        if (isConversationReadState(state)) reads[agentId] = state;
      }
      return reads;
    },
    async react(input) {
      await request("POST", TEAM_API_ROUTES.agent.reactions(input.agentId), {
        messageId: input.messageId,
        emoji: input.emoji,
      });
    },
    async setAvatar(agentId, image) {
      if (!image) {
        await request("DELETE", TEAM_API_ROUTES.agent.avatar(agentId));
        return;
      }
      await request(
        "PUT",
        TEAM_API_ROUTES.agent.avatar(agentId),
        {},
        { name: "avatar", mimeType: image.mimeType, base64: bytesToBase64(image.bytes) },
      );
    },
    async send(id, text, attachmentDraftIds, replyToMessageId = null, clientMessageId) {
      const result = await request("POST", TEAM_API_ROUTES.agent.messages(id), {
        text,
        attachmentDraftIds,
        replyToMessageId,
        // The host uses this browser's zone for a routine the agent creates from the message.
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        // A host with `message-client-id-v1` answers a retry with the first receipt.
        ...(clientMessageId ? { clientMessageId } : {}),
      });
      if (!isQueuedMessageReceipt(result)) throw new Error(currentText().t("webClient.error.sendUnconfirmed"));
      removeCompletedDrafts(attachmentDraftIds);
      return result.deliveries[0]?.id ?? result.messageId;
    },
    stop: (id, turnId) =>
      Effect.runPromise(interruptAgentTurn(teamApi, id, turnId).pipe(Effect.mapError((error) => error.cause))),
    queue: (id) => teamApi("GET", TEAM_API_ROUTES.agent.queue(id), (value) => queueSnapshot(id, value)),
    queues: () => teamApi("GET", AGENT_QUEUES_ROUTE, queueSnapshots),
    async editQueue({ agentId, ...edit }) {
      const snapshot = await teamApi(
        "POST",
        TEAM_API_ROUTES.agent.queueEdit(agentId),
        (value) => queueSnapshot(agentId, value),
        edit,
      );
      // The edit owns these drafts now: a retained composer backup waits for Cancel or Save, and a
      // saved message holds its new files. A change of host must not discard them as leftover uploads.
      if ((edit.action === "retain-attachments" || edit.action === "save") && edit.attachmentDraftIds)
        removeCompletedDrafts(edit.attachmentDraftIds);
      if (!openedHostId) return snapshot;
      const key = retainedEditKey(openedHostId, edit.editId);
      if (edit.action === "retain-attachments") retainedEditDrafts.set(key, edit.attachmentDraftIds);
      else if (edit.action === "cancel" || edit.action === "save") {
        // Cancel and Save put the backup back in the composer, so its files are uploads not sent again.
        const saved = new Set(edit.action === "save" ? edit.attachmentDraftIds : []);
        for (const id of retainedEditDrafts.get(key) ?? []) if (!saved.has(id)) trackCompletedDraft(id);
        retainedEditDrafts.delete(key);
      }
      return snapshot;
    },
    cancelQueued: (input) =>
      Effect.runPromise(cancelQueuedMessage(teamApi, input).pipe(Effect.mapError((error) => error.cause))),
    steerQueued: (input) =>
      Effect.runPromise(steerQueuedMessage(teamApi, input).pipe(Effect.mapError((error) => error.cause))),
    updateQueued: (input) =>
      Effect.runPromise(updateQueuedMessage(teamApi, input).pipe(Effect.mapError((error) => error.cause))),
    reorderQueue: (input) =>
      Effect.runPromise(reorderQueue(teamApi, input).pipe(Effect.mapError((error) => error.cause))),
    async approve(input) {
      await request("POST", TEAM_API_ROUTES.respond.approval, { ...input });
    },
    async answer(input) {
      await request("POST", TEAM_API_ROUTES.respond.prompt, { ...input });
    },
    async upload(file) {
      const uploadHostGeneration = generation;
      const currentUpload = ++uploadGeneration;
      assertSupportedAttachmentName(file.name);
      const extension = attachmentFileExtension(file.name);
      const supported = supportedAttachmentExtensions({
        eml: capabilities.includes("eml-attachments"),
        media: capabilities.includes("media-attachments"),
        text: capabilities.includes(TEAM_TEXT_ATTACHMENTS_CAPABILITY),
        zip: capabilities.includes("zip-attachments"),
      });
      if (extension && !supported.includes(extension)) throw new Error(currentText().t("webClient.error.fileType"));
      if (file.size > MOBILE_ATTACHMENT_BYTES) throw new Error(currentText().t("error.remote.attachmentTooLarge"));
      const bytes = new Uint8Array(await file.arrayBuffer());
      if (currentUpload !== uploadGeneration || uploadHostGeneration !== generation)
        throw new Error(currentText().t("webClient.error.uploadCancelled"));
      const mimeType = file.type || "application/octet-stream";
      const value = await Effect.runPromise(
        uploadAttachmentDraft(teamApi, { name: file.name, mimeType, base64: bytesToBase64(bytes) }).pipe(
          Effect.mapError((error) => error.cause),
        ),
      );
      if (currentUpload !== uploadGeneration) {
        if (uploadHostGeneration === generation)
          await Effect.runPromise(
            discardAttachmentDraft(teamApi, value.id).pipe(Effect.mapError((error) => error.cause)),
          );
        throw new Error(currentText().t("webClient.error.uploadCancelled"));
      }
      trackCompletedDraft(value.id, uploadHostGeneration === generation ? openedHostId : null);
      // The host names the draft's preview with the desktop `openbot-attachment:` scheme.
      return { ...value, previewUrl: null };
    },
    setTyping(agentId, typing) {
      peer.setTyping(agentId, typing);
    },
    replaceConnection(reason) {
      peer.replace(reason);
    },
    requestRuntimeSnapshot() {
      peer.requestRuntimeSnapshot();
    },
    abandonReconnectWaits() {
      closedConnections += 1;
      wakeConnectionWaiters();
    },
    networkRestored() {
      peer.networkRestored();
      hosts?.networkRestored();
    },
    async cancelUpload() {
      uploadGeneration += 1;
      await peer.cancelUpload();
    },
    async discard(id, hostId) {
      if (hostId !== undefined && hostId !== openedHostId) {
        trackCompletedDraft(id, hostId);
        draftCleanupRetryHosts.add(hostId);
        return;
      }
      await Effect.runPromise(discardAttachmentDraft(teamApi, id).pipe(Effect.mapError((error) => error.cause)));
      removeCompletedDrafts([id]);
    },
    holdDrafts(held) {
      heldDrafts = held;
    },
    async download(id) {
      return decodeWebFile(await request("GET", TEAM_API_ROUTES.attachment(id)));
    },
    async attachmentPreview(id) {
      if (!capabilities.includes(ATTACHMENT_PREVIEWS_CAPABILITY) || previewsMissing.has(openedHostId)) return null;
      try {
        return decodeWebFile(await request("GET", attachmentPreviewRoute(id)));
      } catch (error) {
        // A fork host built before the route answers 404 for every preview: the next ones skip it.
        if (error instanceof WebHostRequestError && error.refused && error.reference === referenceFrom("http", 404)) {
          previewsMissing.add(openedHostId);
          return null;
        }
        throw error;
      }
    },
    async artifactThumbnail(artifactId, version) {
      const query = new URLSearchParams({ v: version });
      return decodeWebFile(await request("GET", `${workspaceArtifactThumbnailRoute(artifactId)}?${query}`));
    },
    async fileLink(source) {
      try {
        return decodeFileTicket(
          await request("POST", FILE_TICKET_ROUTES.create, {
            kind: source.kind,
            attachmentId: source.kind === "attachment" ? source.attachmentId : null,
            agentId: source.kind === "workspace" ? source.agentId : null,
            path: source.kind === "attachment" ? null : source.path,
          }),
        );
      } catch {
        // No download address, or an older host: the file comes through the connection, which also
        // reports a missing file in its own words.
        return null;
      }
    },
    async sharedFile(path) {
      const query = new URLSearchParams({ path });
      return decodeWebFile(await request("GET", `${TEAM_API_ROUTES.sharedFiles}?${query}`));
    },
    async workspaceFile(agentId, path) {
      // The released URL spells the agent `botId`.
      const query = new URLSearchParams({ botId: agentId, path });
      return decodeWebFile(await request("GET", `${TEAM_API_ROUTES.workspaceFiles}?${query}`));
    },
    async workspaceDirectory(agentId, path) {
      if (!capabilities.includes(WORKSPACE_DIRECTORY_CAPABILITY))
        throw new Error(currentText().t("error.team.workspaceDirectoryUnsupported"));
      return decodeWorkspaceDirectory(await request("POST", WORKSPACE_DIRECTORY_ROUTES.list, { agentId, path }));
    },
    routineFlows,
    updateRoutine: agentRoutines.updateRoutine,
    testRoutine: agentRoutines.testRoutine,
    listHiddenAgents: () => runTeamEffect(listHiddenAgents(teamApi).pipe(Effect.mapError((error) => error.cause))),
    setAgentHidden: (input) =>
      runTeamEffect(setAgentHidden(teamApi, input).pipe(Effect.mapError((error) => error.cause))),
    async models() {
      return guardedListDecoder(
        isClientAgentModelOption,
        "models",
      )(await request("GET", TEAM_API_ROUTES.agents.models));
    },
    async status() {
      const value = await request("GET", TEAM_API_ROUTES.agents.status);
      if (!isAgentStatus(value)) throw new Error(currentText().t("error.remote.invalidData"));
      return value;
    },
    async accountUsage() {
      const value = await request("GET", TEAM_API_ROUTES.agents.usage);
      if (!isAccountUsage(value)) throw new Error(currentText().t("error.remote.invalidData"));
      return value;
    },
    async createAgent(input) {
      // A new agent starts in the space that the workspace shows, unless the caller names one.
      const { spaceId = activeSpace(), ...agent } = input;
      // A host with spaces makes the agent in its space before the first turn. Another one has only General.
      if (spaceId !== undefined && capabilities.includes(WORKSPACE_SPACES_CAPABILITY)) {
        const { agentId } = decodeCreatedSpaceAgent(
          await request("POST", WORKSPACE_SPACES_ROUTES.createAgent, { spaceId, agent: { ...agent } }),
        );
        const agents = guardedListDecoder(
          isClientAgentSummary,
          "agents",
        )(await request("GET", TEAM_API_ROUTES.agents.all));
        const created = agents.find((candidate) => candidate.id === agentId);
        if (!created) throw new Error(currentText().t("error.remote.invalidData"));
        return created;
      }
      const value = await request("POST", TEAM_API_ROUTES.agents.all, { ...agent });
      if (!isClientAgentSummary(value)) throw new Error(currentText().t("error.remote.invalidData"));
      return value;
    },
    async duplicateAgent(agentId) {
      if (!capabilities.includes("agent-duplication")) throw new Error(currentText().t("webClient.error.duplication"));
      const operationKey = `${openedHostId ?? ""}\0${agentId}`;
      const operationId = duplicateOperationIds.get(operationKey) ?? crypto.randomUUID();
      duplicateOperationIds.set(operationKey, operationId);
      const value = await request("POST", TEAM_API_ROUTES.agent.duplicate(agentId), { operationId });
      if (!isDynamicRecord(value) || !isClientAgentSummary(value.agent) || !isSidebarLayoutSnapshot(value.layout))
        throw new Error(currentText().t("error.remote.invalidData"));
      duplicateOperationIds.delete(operationKey);
      return { agent: value.agent, layout: value.layout } satisfies DuplicateAgentResult;
    },
    async updateAgent(input) {
      // The released agent route ignores the account, so it goes on `provider-accounts-v1` after the
      // profile: a provider change there returns the agent to the new provider's own sign-in.
      // Backup models stay on the host computer: the Team API does not carry them.
      const { providerAccountId, backupModels: _backupModels, leaveUsageLimit: _leaveUsageLimit, ...profile } = input;
      if (providerAccountId !== undefined && !capabilities.includes(PROVIDER_ACCOUNTS_CAPABILITY))
        throw new Error(currentText().t("error.team.providersUnsupported"));
      await request("PATCH", TEAM_API_ROUTES.agent.one(input.agentId), { ...profile });
      if (providerAccountId === undefined) return;
      await runTeamEffect(
        setAgentProviderAccount(teamApi, { agentId: input.agentId, accountId: providerAccountId }).pipe(
          Effect.mapError((error) => error.cause),
        ),
      );
    },
    async deleteAgent(agentId) {
      if (connectedHost && !canAdministerServer(connectedHost.role))
        throw new Error(currentText().t("error.team.membersCannotDeleteAgents"));
      await Effect.runPromise(deleteAgent(teamApi, agentId).pipe(Effect.mapError((error) => error.cause)));
    },
    async search(agentId, query, cursor) {
      const params = new URLSearchParams({
        ...(agentId ? { botId: agentId } : {}),
        q: query,
        limit: "50",
        ...(cursor ? { cursor } : {}),
      });
      const value = await request("GET", `${TEAM_API_ROUTES.messages.search}?${params}`);
      if (
        !isDynamicRecord(value) ||
        !Array.isArray(value.results) ||
        typeof value.total !== "number" ||
        (value.nextCursor !== null && typeof value.nextCursor !== "string")
      )
        throw new Error(currentText().t("error.remote.invalidData"));
      const results = value.results.map((item) => {
        if (!isDynamicRecord(item) || typeof item.agentId !== "string" || !isConversationMessage(item.message))
          throw new Error(currentText().t("error.remote.invalidData"));
        return { agentId: item.agentId, message: item.message };
      });
      return { results, total: value.total, nextCursor: value.nextCursor };
    },
    async dispose(options) {
      if (options?.sessionsEnded) sessionsEnded = true;
      // The pending sends end with the page, so their uploads go too.
      await discardCompletedDrafts(openedHostId, false);
      await releaseLiveView();
      browserView.disconnect();
      viewListeners.clear();
      disposed = true;
      wakeConnectionWaiters();
      generation += 1;
      connectedHost = null;
      duplicateOperationIds.clear();
      try {
        await Promise.all([peer.dispose(), hosts?.dispose()]);
      } finally {
        releaseHostLock?.();
        releaseHostLock = null;
        hostChannel?.close();
      }
    },
  };
}

function decodeWebFile(value: unknown): WebFile {
  if (!isDynamicRecord(value)) throw new Error(currentText().t("error.remote.invalidData"));
  const base64 = requiredString(value, "base64");
  // A browser on a computer takes a file up to the protocol limit, the same limit the peer applies.
  // The decoded size comes from the length: `atob` would copy a file of 100 MB only to measure it.
  const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0;
  if ((base64.length / 4) * 3 - padding > TEAM_PROTOCOL_V2_MAX_FILE_BYTES)
    throw new Error(currentText().t("error.remote.attachmentTooLarge"));
  return {
    name: requiredString(value, "name"),
    mimeType: requiredString(value, "mimeType"),
    base64,
  };
}

function decodeFileTicket(value: unknown): FileTicket {
  if (!isDynamicRecord(value)) throw new Error(currentText().t("error.remote.invalidData"));
  const url = requiredString(value, "url");
  if (!url.startsWith("https://")) throw new Error(currentText().t("error.remote.invalidData"));
  const { size, expiresAt } = value;
  if (typeof size !== "number" || typeof expiresAt !== "number")
    throw new Error(currentText().t("error.remote.invalidData"));
  return { url, name: requiredString(value, "name"), size, expiresAt };
}

/**
 * The words for a request that failed on the way to the host or on the host. A refusal keeps the
 * host's reason. A request that the host did not get, or a read, says that the connection dropped,
 * so a short reconnect does not tell the reader to refresh. Only a write whose result is unknown, or
 * a host failure, keeps the advice to refresh before trying again.
 */
function requestFailureText(failure: RemoteRequestFailure, read: boolean, error: string | undefined): string {
  const { t } = currentText();
  if (failure.kind === "host")
    return failure.status !== null && failure.status < 500
      ? (hostRefusal(failure.status, { error }) ?? t("webClient.error.requestIncomplete"))
      : t("webClient.error.requestIncomplete");
  if (failure.kind === "unsent" || (read && failure.kind === "connection"))
    return t("webClient.error.connectionInterrupted");
  if (read && failure.kind === "timeout") return t("webClient.error.timeout");
  return t("webClient.error.requestIncomplete");
}

/** The host's own reason for a refusal. It redacts it; a server failure keeps the generic text. */
function hostRefusal(status: number | undefined, body: unknown): string | null {
  if (status === undefined || status < 400 || status >= 500) return null;
  if (!isDynamicRecord(body) || !isString(body.error) || !body.error.trim()) return null;
  const text = body.error.trim();
  return text.length > 300 ? `${text.slice(0, 299)}…` : text;
}

function toTeamMember(member: RemoteTeamMember): TeamMemberSummary {
  return {
    id: member.membershipId,
    username: member.email,
    email: member.email,
    name: member.name,
    avatarUrl: member.avatarUrl ?? null,
    role: member.role,
    createdAt: new Date(member.createdAt ?? 0).toISOString(),
    disabled: member.status !== "active",
  };
}

function toTeamInvite(invite: RemoteTeamInvite): TeamInviteSummary {
  return {
    id: invite.inviteId,
    role: invite.role,
    expiresAt: new Date(invite.expiresAt).toISOString(),
    usedAt: invite.usedAt === null ? null : new Date(invite.usedAt).toISOString(),
    email: invite.email,
    permanent: invite.permanent,
    useCount: invite.useCount,
  };
}

function queueSnapshots(value: unknown): QueueSnapshot[] {
  if (!isDynamicRecord(value) || !Array.isArray(value.queues) || !value.queues.every(isQueueSnapshot))
    throw new Error(currentText().t("app.errorStatus.queueLoad"));
  return value.queues;
}

function queueSnapshot(agentId: string, value: unknown): QueueSnapshot {
  if (!isQueueSnapshot(value) || value.agentId !== agentId)
    throw new Error(currentText().t("app.errorStatus.queueLoad"));
  return value;
}

function decodeWebBrowserTab(tab: unknown): BrowserTab {
  if (
    !isDynamicRecord(tab) ||
    typeof tab.loading !== "boolean" ||
    (tab.ownerThreadId !== null && typeof tab.ownerThreadId !== "string") ||
    (tab.ownerAgentId !== null && typeof tab.ownerAgentId !== "string")
  )
    throw new Error(currentText().t("error.remote.invalidData"));
  return {
    id: requiredString(tab, "id"),
    title: requiredString(tab, "title"),
    url: requiredString(tab, "url"),
    loading: tab.loading,
    ownerThreadId: tab.ownerThreadId,
    ownerAgentId: tab.ownerAgentId,
  };
}

function decodeWebBrowserPreview(value: unknown): BrowserPreview {
  if (
    !isDynamicRecord(value) ||
    !isString(value.dataUrl) ||
    value.dataUrl.length > 2_000_000 ||
    !/^data:image\/jpeg;base64,[A-Za-z0-9+/]+={0,2}$/.test(value.dataUrl) ||
    !isNumber(value.width) ||
    !Number.isSafeInteger(value.width) ||
    value.width < 1 ||
    value.width > 960 ||
    !isNumber(value.height) ||
    !Number.isSafeInteger(value.height) ||
    value.height < 1 ||
    value.height > 600
  )
    throw new Error(currentText().t("error.remote.invalidData"));
  return { dataUrl: value.dataUrl, width: value.width, height: value.height };
}

function decodeWebConversationSnapshot(value: unknown): ConversationPage {
  if (!isConversationWithReadState(value)) throw new Error(currentText().t("error.remote.invalidData"));
  return { ...value, references: {}, pageInfo: { hasOlder: false, olderCursor: null } };
}

function decodeWebConversationPage(value: unknown): ConversationPage {
  if (
    !isConversationWithReadState(value) ||
    !isDynamicRecord(value) ||
    !isDynamicRecord(value.pageInfo) ||
    typeof value.pageInfo.hasOlder !== "boolean" ||
    (value.pageInfo.olderCursor !== null && typeof value.pageInfo.olderCursor !== "string") ||
    (value.pageInfo.hasOlder && !value.pageInfo.olderCursor) ||
    !isDynamicRecord(value.references)
  )
    throw new Error(currentText().t("error.remote.invalidData"));
  const references: ConversationPage["references"] = {};
  for (const [id, message] of Object.entries(value.references)) {
    if (!isConversationMessage(message)) throw new Error(currentText().t("error.remote.invalidData"));
    references[id] = message;
  }
  return {
    ...value,
    references,
    pageInfo: {
      hasOlder: value.pageInfo.hasOlder,
      olderCursor: value.pageInfo.olderCursor,
      // history-extent-v1: the host sends the unloaded length only when it was negotiated.
      ...optionalHistoryExtent(value.pageInfo),
    },
  };
}
