import { INPUT_LIMITS } from "@openbot/contracts/input-limits";
import type {
  AgentApproval,
  AgentEvent,
  AgentModelOption,
  AgentRuntimeApproval,
  AgentStatus,
  AgentSummary,
  AttachmentSummary,
  BrowserControlState,
  BrowserTab,
  BrowserTakeoverRequest,
  ConversationPage,
  HostedServerIssue,
  HostedServerSleep,
  QueueSnapshot,
  RespondToApprovalInput,
  RespondToPromptInput,
  SidebarLayoutAction,
  SidebarLayoutSnapshot,
  TeamPresenceSnapshot,
  TeamRealtimeEvent,
} from "@openbot/contracts/ipc";
import { TEAM_API_ROUTES } from "@openbot/contracts/team-api-routes";
import { cleanAgentMessageText } from "@openbot/team-client/agent-message-text";
import type { RemoteTeamHost } from "@openbot/team-client/remote-directory";
import { createRemoteConnectionRecovery, type RemoteRecoveryStatus } from "@openbot/team-client/remote-recovery";
import { reconcilePendingRequests } from "@openbot/team-client/runtime-attention";
import { currentText } from "@openbot/ui/text";
import { createEffect, createMemo, createSignal, createStore, onSettled } from "solid-js";
import { toAgentProfile } from "../../app-message-projection";
import {
  initialAgentId,
  readAgentSelection,
  webAgentSelectionKey,
  writeAgentSelection,
} from "../agents/agent-selection";
import { mergeConversationPage } from "../conversation/conversation-merge";
import { createSidebarPreferences } from "../sidebar/sidebar-preferences";
import { defaultSidebarLayout } from "../sidebar/sidebar-sections";
import { createHostRestartToasts } from "../updates/host-restart-toast";
import type { WebHostNotice } from "./web-host-connections";
import { createWebHostLifecycle } from "./web-host-lifecycle";
import type { WebHostState } from "./web-host-lock";
import { webNetworkFailureMessage } from "./web-network-error";
import {
  createWebWorkspaceRuntime,
  WebHostConnectionError,
  WebHostIncompatibleError,
  type WebRuntimeEvents,
  type WebWorkspaceRuntime,
} from "./web-runtime";
import { orderWebHosts, readWebServerOrder, writeWebServerOrder } from "./web-server-order";
import { readWebServerSelection, writeWebServerSelection } from "./web-server-selection";

interface WebConversation {
  page: ConversationPage | null;
  draft: string;
  attachments: AttachmentSummary[];
  loading: boolean;
  error?: string | null;
}
interface WebWorkspaceState {
  hosts: RemoteTeamHost[];
  host: RemoteTeamHost | null;
  agents: AgentSummary[];
  /** The host answered an agent list. Until then, an empty `agents` does not mean the host has none. */
  agentsLoaded: boolean;
  selectedId: string | null;
  conversations: Record<string, WebConversation>;
  /** The queues read from the host, by agent. Each agent's queue is read on connect and on each change. */
  queues: Record<string, QueueSnapshot>;
  approvals: Array<AgentApproval | AgentRuntimeApproval>;
  prompts: Array<Extract<AgentEvent, { type: "prompt" }>>;
  /** The latest progress detail of each agent's running turn. */
  progress: Record<string, { turnId: string; detail: string }>;
  /** The unread messages of each agent chat, from the host's read cursors. A missing agent has none. */
  unreadCounts: Record<string, number>;
  /** The agents that finished a reply while this page had no focus. A new turn or the user's look clears it. */
  recentReplies: Record<string, boolean>;
  /** The failed turn of each agent, from the host's runtime snapshot and the end of a turn. */
  failedTurns: Record<string, string>;
  takeovers: BrowserTakeoverRequest[];
  browserTabs: BrowserTab[];
  activeBrowserTabId: string | null;
  browserControlState: BrowserControlState;
  /** Who is on the connected host. Null until the host answers. */
  presence: TeamPresenceSnapshot | null;
  capabilities: string[];
  status: "connecting" | "online" | "offline";
  /**
   * The opened host is a hosted server that the account service stopped for no use (`sleeping`), or that
   * starts after the user's input (`waking`). Cleared when it is online again.
   */
  hostedSleep: HostedServerSleep | null;
  hostedIssue: HostedServerIssue | null;
  connectionError: string | null;
  recovery: RemoteRecoveryStatus | null;
  workspaceLoaded: boolean;
  panelsFailed: boolean;
  panelsLoading: boolean;
  agentStatus: AgentStatus | null;
  models: AgentModelOption[];
  /** The opened host said it restarts into an update (`host-update-v1`). Cleared when it is online again. */
  hostRestart: { state: "waiting" | "restarting"; version: string | null } | null;
  /** The state of each host that this tab has not opened, from its status connection. */
  hostStates: Record<string, WebHostState>;
  /** The last connection found that the host speaks no protocol this build speaks. */
  incompatibility: {
    hostId: string;
    code: WebHostIncompatibleError["code"];
    message: string;
    hostAppVersion: string;
    hostProtocol: { minimum: number; maximum: number };
  } | null;
  hostsLoaded: boolean;
  hostsLoading: boolean;
  hostsError: string | null;
  revocationRevision: number;
  error: string | null;
  busy: boolean;
  uploading: boolean;
  hiddenIds: string[];
  /** The team member this connection signs in as, once the host has answered. */
  memberId: string | null;
  duplicatingAgentIds: string[];
  sidebarLayout: SidebarLayoutSnapshot;
}

export type WebRuntimeFactory = (
  accountId: string,
  events: WebRuntimeEvents,
  accountFetch: typeof fetch,
) => WebWorkspaceRuntime;

/** Sets the unread count of one chat. A chat with nothing unread has no entry. */
function setUnread(draft: WebWorkspaceState, agentId: string, count: number): void {
  if (count > 0) draft.unreadCounts[agentId] = count;
  else delete draft.unreadCounts[agentId];
}

/** Events that change unread counts come in bursts. A read starts this long after the first. */
const READS_DELAY_MS = 1_000;
/** A page that was hidden for longer than this renews its connection path when it comes back. */
const BACKGROUND_REFRESH_MS = 10_000;
/**
 * A host that announced a restart into an update is away for about a minute. It gets one attempt in each
 * of these intervals (a flat wait, not the doubling wait of other outages) for as long as the restart
 * notice stays, which is `RESTART_NOTICE_MS` of the restart toast.
 */
const RESTART_RETRY_MIN_MS = 3_000;
const RESTART_RETRY_SPREAD_MS = 2_000;
const RESTART_RETRY_WINDOW_MS = 10 * 60_000;

export type WebWorkspace = ReturnType<typeof createWebWorkspace>;

export function createWebWorkspace(
  props: {
    accountId: string;
    accountFetch: typeof fetch;
    onSessionCheck: () => Promise<void>;
    /** Read when the workspace closes: true when its account session has ended. */
    accountSessionEnded?: () => boolean;
    createRuntime?: WebRuntimeFactory;
  },
  hooks: {
    /** A new agent status of the connected host, such as the end of a provider sign-in. */
    onStatus?: (status: AgentStatus) => void;
  } = {},
) {
  const [state, setState] = createStore<WebWorkspaceState>({
    hosts: [],
    host: null,
    agents: [],
    agentsLoaded: false,
    selectedId: null,
    conversations: {},
    queues: {},
    approvals: [],
    prompts: [],
    progress: {},
    unreadCounts: {},
    recentReplies: {},
    failedTurns: {},
    takeovers: [],
    browserTabs: [],
    activeBrowserTabId: null,
    browserControlState: { sessions: [] },
    presence: null,
    capabilities: [],
    status: "offline",
    hostedSleep: null,
    hostedIssue: null,
    connectionError: null,
    recovery: null,
    workspaceLoaded: false,
    panelsFailed: false,
    panelsLoading: false,
    agentStatus: null,
    models: [],
    hostRestart: null,
    hostStates: {},
    incompatibility: null,
    hostsLoaded: false,
    hostsLoading: false,
    hostsError: null,
    revocationRevision: 0,
    error: null,
    busy: false,
    uploading: false,
    hiddenIds: [],
    memberId: null,
    duplicatingAgentIds: [],
    sidebarLayout: defaultSidebarLayout(),
  });
  let generation = 0;
  let selectedId: string | null = null;
  let hostId: string | null = null;
  let disposed = false;
  let running = false;
  let pendingReload = false;
  let reloadPromise: Promise<void> | null = null;
  let hostsRefreshPromise: Promise<void> | null = null;
  /**
   * The hosts this account left. The leave revokes this session and takes the host out of the list;
   * neither is an error. An id stays until a list without its host arrives.
   */
  const leftHostIds = new Set<string>();
  let acceptedInvite: { inviteUrl: string; host: RemoteTeamHost } | null = null;
  /** Set when a revoked session connects again by itself; cleared when the host is online. */
  let revokedReconnect = false;
  /** The queue read in flight by agent. An event during a read asks for one more read. */
  const queueLoads = new Map<string, { generation: number; again: boolean }>();
  /** Counts queue snapshots from events by agent. A read that started before a newer snapshot is dropped. */
  const queueRevisions = new Map<string, number>();
  const readWrites = new Map<string, Promise<void>>();
  /** The unread read in flight, and the timer that waits to start the next one. */
  let readsLoad: { generation: number; again: boolean } | null = null;
  let readsTimer: ReturnType<typeof setTimeout> | undefined;
  /** The conversation reads in flight by agent, and the deltas that wait for them to finish. */
  const conversationReads = new Map<string, number>();
  const heldDeltas = new Map<string, Array<Extract<AgentEvent, { type: "conversation-delta" }>>>();
  const hostEventListeners = new Set<(event: AgentEvent | TeamRealtimeEvent) => void>();
  let connectionPromise: { hostId: string; opened: boolean; promise: Promise<void> } | null = null;
  let recoveryBlocked = false;
  /** When the opened host announced its restart, or null. Cleared with `state.hostRestart`. */
  let restartSince: number | null = null;
  let restartTimer: ReturnType<typeof setTimeout> | undefined;
  /**
   * True from the connection loss of the opened host until its workspace is loaded again. A store read
   * right after a write shows the old value, so the retry policy keeps its own copy.
   */
  let hostAway = false;
  /** The time the page was hidden, or null while it is visible. */
  let hiddenAt: number | null = null;
  /** The read of the host's state after a return from the background, or after a window focus. */
  let resyncPromise: Promise<void> | null = null;
  /** The agents whose queue was not read at the last resync. Selecting one of them reads it. */
  const staleQueues = new Set<string>();
  let recovery = makeRecovery();
  function makeRecovery() {
    return createRemoteConnectionRecovery(
      async () => {
        const host = state.host;
        if (!host || document.hidden) return;
        await attemptConnection(host);
        if (state.status !== "online") throw new Error(currentText().t("webClient.notice.connecting"));
      },
      () => {},
      (status) => {
        if (!disposed)
          setState((draft) => {
            draft.recovery = status;
          });
      },
    );
  }
  function recover() {
    if (disposed || !hostId || recoveryBlocked) return;
    // A host that restarts for an update comes back in a minute, so it is asked at a flat interval.
    if (hostAway && restartActive()) {
      scheduleRestartRetry(0);
      return;
    }
    recovery.offline();
    recovery.setActive(!document.hidden);
  }
  function restartActive(): boolean {
    return restartSince !== null && Date.now() - restartSince < RESTART_RETRY_WINDOW_MS;
  }
  function stopRestartRetry() {
    clearTimeout(restartTimer);
    restartTimer = undefined;
  }
  function scheduleRestartRetry(delay = RESTART_RETRY_MIN_MS + Math.random() * RESTART_RETRY_SPREAD_MS) {
    if (restartTimer !== undefined || disposed) return;
    restartTimer = setTimeout(() => {
      restartTimer = undefined;
      void retryRestartedHost();
    }, delay);
  }
  /** One attempt for a host that is restarting. A page in the background waits: `recover` runs on return. */
  async function retryRestartedHost() {
    const host = state.host;
    if (disposed || recoveryBlocked || !host || !hostAway || document.hidden) return;
    if (restartActive()) {
      try {
        await attemptConnection(host);
      } catch {
        // The next interval asks again.
      }
    }
    if (disposed || recoveryBlocked || !hostAway || hostId !== host.hostId) return;
    if (restartActive()) {
      scheduleRestartRetry();
      return;
    }
    // The host did not come back in time. It is offline as any other host, with the usual recovery.
    restartSince = null;
    setState((draft) => {
      draft.hostRestart = null;
    });
    recover();
  }
  const hostLifecycle = createWebHostLifecycle({
    accountFetch: props.accountFetch,
    hostId: () => hostId,
    disposed: () => disposed,
    status: () => state.status,
    hostedSleep: () => state.hostedSleep,
    setHostedSleep,
    setIssue: (issue) =>
      setState((draft) => {
        draft.hostedIssue = issue;
      }),
    suspend: () => {
      recoveryBlocked = true;
      recovery.suspend();
    },
    recover: () => {
      recoveryBlocked = false;
      recovery.refresh();
      recover();
    },
  });
  const hostNoticeListeners = new Set<(hostId: string, event: WebHostNotice, agents: AgentSummary[]) => void>();
  const runtime = (props.createRuntime ?? createWebWorkspaceRuntime)(
    props.accountId,
    {
      accountChanged: props.onSessionCheck,
      accessDenied(id, error) {
        if (!disposed && id === hostId) blockAccess(error);
      },
      hostNotice(id, event, agents) {
        if (disposed) return;
        for (const listener of hostNoticeListeners) listener(id, event, agents);
      },
      hostState(id, hostState) {
        if (!disposed)
          setState((draft) => {
            draft.hostStates[id] = hostState;
          });
      },
      hostSessionRevoked: () => void retryHosts(),
      connection(update) {
        if (disposed || update.hostId !== hostId) return;
        if (recoveryBlocked && update.state === "offline" && !update.code) return;
        // A host that announced a restart comes back by itself; a wake is only for a stopped server.
        const unavailable = update.state === "offline" && !update.code && !restartActive();
        if (update.state !== "online") hostAway = true;
        setState((draft) => {
          if (update.state !== "online") draft.status = update.state;
          if (update.state !== "online")
            draft.connectionError = currentText().t("server.connection.reconnecting", { name: draft.host?.name ?? "" });
          // The lifecycle shows the message of an unavailable host only when the host does not sleep or wake.
          if (update.code)
            draft.connectionError = currentText().t(
              update.code === "session_revoked"
                ? "webClient.error.accessEnded"
                : "server.compatibility.unsafeDataDescription",
            );
          if (update.state !== "online") {
            // The approvals and prompts stay: the host's snapshot replaces them when it is back, so a
            // short loss does not make a pending request disappear and come again.
            draft.progress = {};
            draft.takeovers = [];
            draft.browserControlState = { sessions: [] };
            draft.duplicatingAgentIds = [];
          }
        });
        if (update.state === "offline") generation += 1;
        if (update.code) {
          hostLifecycle.endSleep();
          recoveryBlocked = true;
          recovery.suspend();
        }
        if (update.code === "session_revoked") {
          clearRevokedWorkspace();
          const revokedHostId = hostId;
          const revokedGeneration = generation;
          const revokedConnection = connectionPromise?.promise;
          void props
            .onSessionCheck()
            .then(() => refreshHosts())
            .then(async () => {
              await revokedConnection?.catch(() => undefined);
              // A member or role change anywhere on the host revokes every session, this one
              // too. The directory still lists the host, so this account can connect again.
              // Try once: a second revocation before the host is online waits for Reconnect.
              // The directory copy has the new role; `state.host` keeps the role of the last connect.
              const host = state.hosts.find((listed) => listed.hostId === revokedHostId);
              if (disposed || revokedReconnect || hostId !== revokedHostId || generation !== revokedGeneration || !host)
                return;
              revokedReconnect = true;
              return connect({ ...host });
            })
            .catch(report);
          return;
        }
        if (unavailable) {
          const current = generation;
          void hostLifecycle.hostUnavailable(update.hostId, connectionPromise?.opened ?? false).then((retry) => {
            if (retry && !disposed && current === generation) recover();
          });
        } else if (restartSince !== null && update.state === "offline") recover();
        if (update.state === "online" && update.resync && !connectionPromise) recover();
      },
      event(id, event) {
        if (disposed || id !== hostId) return;
        for (const listener of hostEventListeners) listener(event);
        if (event.type === "team-presence")
          setState((draft) => {
            draft.presence = event.snapshot;
          });
        if (event.type === "host-restart") {
          restartSince = event.state === "none" ? null : (restartSince ?? Date.now());
          if (event.state === "none") stopRestartRetry();
          setState((draft) => {
            draft.hostRestart = event.state === "none" ? null : { state: event.state, version: event.version };
          });
        }
        if (event.type === "status") hooks.onStatus?.(event.status);
        if (event.type === "runtime-snapshot") {
          const { attentionComplete } = event.snapshot;
          setState((draft) => {
            draft.approvals = reconcilePendingRequests(
              draft.approvals,
              event.snapshot.pendingApprovals,
              attentionComplete,
            );
            draft.prompts = reconcilePendingRequests(
              draft.prompts,
              event.snapshot.pendingPrompts.map((prompt) => ({ ...prompt, type: "prompt" as const })),
              attentionComplete,
            );
            draft.takeovers = reconcilePendingRequests(
              draft.takeovers,
              event.snapshot.pendingBrowserTakeovers,
              attentionComplete,
            );
            draft.failedTurns = Object.fromEntries(
              event.snapshot.failedTurns.map((turn) => [turn.agentId, turn.turnId]),
            );
          });
        } else if (event.type === "prompt") {
          setState((draft) => {
            draft.prompts = [...draft.prompts.filter((item) => item.requestId !== event.requestId), event];
          });
        } else if (event.type === "approval") {
          setState((draft) => {
            draft.approvals = [
              ...draft.approvals.filter((item) => item.requestId !== event.approval.requestId),
              event.approval,
            ];
          });
        } else if (event.type === "agent-input-resolved") {
          setState((draft) => {
            draft.approvals = draft.approvals.filter((item) => String(item.requestId) !== String(event.requestId));
            draft.prompts = draft.prompts.filter((item) => String(item.requestId) !== String(event.requestId));
          });
        } else if (event.type === "turn-progress") {
          setState((draft) => {
            draft.progress[event.agentId] = { turnId: event.turnId, detail: cleanAgentMessageText(event.detail) };
          });
        } else if (event.type === "turn-started") {
          setState((draft) => {
            delete draft.progress[event.agentId];
            delete draft.recentReplies[event.agentId];
            delete draft.failedTurns[event.agentId];
          });
        } else if (event.type === "conversation-delta") {
          applyDelta(event);
        } else if (event.type === "turn-completed") {
          setState((draft) => {
            if (draft.progress[event.agentId]?.turnId === event.turnId) delete draft.progress[event.agentId];
            if (event.status === "failed") draft.failedTurns[event.agentId] = event.turnId;
            else delete draft.failedTurns[event.agentId];
            // As on desktop, a reply that ends while the page has focus is already seen.
            if (event.status === "completed" && !document.hasFocus()) draft.recentReplies[event.agentId] = true;
            draft.prompts = draft.prompts.filter(
              (item) =>
                item.agentId !== event.agentId || item.threadId !== event.threadId || item.turnId !== event.turnId,
            );
            draft.approvals = draft.approvals.filter(
              (item) =>
                item.agentId !== event.agentId || item.threadId !== event.threadId || item.turnId !== event.turnId,
            );
          });
        }
        // The open chat reads its own state with each page. Another chat only has the host's cursors.
        if (
          (event.type === "turn-completed" || event.type === "conversation-invalidated") &&
          event.agentId !== selectedId
        )
          scheduleReads();
        if (event.type === "conversation" && event.snapshot.agentId !== selectedId) scheduleReads();
        if (event.type === "conversation-page" && event.page.agentId !== selectedId) scheduleReads();
        if (event.type === "browser-takeover-requested")
          setState((draft) => {
            draft.takeovers = [
              ...draft.takeovers.filter((item) => item.requestId !== event.request.requestId),
              event.request,
            ];
          });
        if (event.type === "browser-takeover-resolved")
          setState((draft) => {
            draft.takeovers = draft.takeovers.filter((item) => String(item.requestId) !== String(event.requestId));
          });
        if (event.type === "browser-changed")
          setState((draft) => {
            draft.browserTabs = event.tabs;
            draft.activeBrowserTabId = event.activeTabId;
          });
        if (event.type === "browser-control-changed")
          setState((draft) => {
            draft.browserControlState = event.state;
          });
        if (event.type === "agents-changed") {
          reconcileAgents(event.agents);
          for (const agent of event.agents) if (!state.queues[agent.id]) loadQueue(agent.id);
        }
        if (event.type === "queue-changed") {
          const { snapshot } = event;
          queueRevisions.set(snapshot.agentId, (queueRevisions.get(snapshot.agentId) ?? 0) + 1);
          staleQueues.delete(snapshot.agentId);
          setState((draft) => {
            draft.queues[snapshot.agentId] = snapshot;
          });
        }
        if (event.type === "queue-invalidated" && state.agents.some((agent) => agent.id === event.agentId))
          loadQueue(event.agentId);
        if (event.type === "sidebar-layout-changed")
          setState((draft) => {
            if (event.layout.revision >= draft.sidebarLayout.revision) draft.sidebarLayout = event.layout;
          });
        // Only the opened chat reads its page. Another agent's event changes nothing that this page shows.
        const pageAgentId =
          event.type === "conversation"
            ? event.snapshot.agentId
            : event.type === "conversation-page"
              ? event.page.agentId
              : event.type === "conversation-invalidated" ||
                  event.type === "turn-started" ||
                  event.type === "turn-completed" ||
                  event.type === "prompt" ||
                  event.type === "agent-input-resolved"
                ? event.agentId
                : null;
        if (pageAgentId !== null && pageAgentId === selectedId) void refresh();
      },
    },
    props.accountFetch,
  );
  const preferences = createSidebarPreferences({
    scope: () => (state.host ? `${props.accountId}:${state.host.hostId}` : ""),
  });
  // The other tabs show the opened host with the state this tab has for it.
  createEffect(
    () => ({ id: state.host?.hostId, status: state.status }),
    ({ id, status }) => {
      if (id) runtime.hosts?.reportSelected(id, status);
    },
  );
  const [serverOrder, setServerOrder] = createSignal(readWebServerOrder(props.accountId));
  const orderedHosts = createMemo(() => orderWebHosts(state.hosts, serverOrder()));
  const profiles = createMemo(() => state.agents.map(toAgentProfile));
  const selected = createMemo(() => profiles().find((agent) => agent.id === state.selectedId));
  const conversation = createMemo(() => (state.selectedId ? state.conversations[state.selectedId] : undefined));

  function report(error: unknown) {
    if (!disposed)
      setState((draft) => {
        draft.error =
          webNetworkFailureMessage(error) ??
          (error instanceof Error ? error.message : currentText().t("webClient.error.requestFailed"));
      });
  }
  async function run(action: () => Promise<void>) {
    if (running) return;
    running = true;
    const current = generation;
    setState((draft) => {
      draft.busy = true;
      draft.error = null;
    });
    try {
      await action();
    } catch (error) {
      if (current === generation) report(error);
    } finally {
      running = false;
      if (!disposed)
        setState((draft) => {
          draft.busy = false;
        });
    }
  }
  async function readSidebarLayout(
    capabilities: readonly string[],
    agentIds: readonly string[] = [],
  ): Promise<SidebarLayoutSnapshot> {
    const read = runtime.getSidebarLayout;
    if (!capabilities.includes("sidebar-layout") || !read)
      return { ...defaultSidebarLayout(), agentOrder: [...agentIds] };
    return read();
  }
  function reconcileAgents(agents: AgentSummary[]): void {
    const ids = new Set(agents.map((agent) => agent.id));
    const nextSelected = selectedId && ids.has(selectedId) ? selectedId : null;
    selectedId = nextSelected;
    setState((draft) => {
      const removed = draft.agents.filter((agent) => !ids.has(agent.id)).map((agent) => agent.id);
      draft.agents = agents;
      draft.agentsLoaded = true;
      draft.hiddenIds = draft.hiddenIds.filter((id) => ids.has(id));
      draft.duplicatingAgentIds = draft.duplicatingAgentIds.filter((id) => ids.has(id));
      for (const id of removed) {
        delete draft.conversations[id];
        delete draft.queues[id];
        delete draft.progress[id];
        delete draft.unreadCounts[id];
        delete draft.recentReplies[id];
        delete draft.failedTurns[id];
      }
      if (nextSelected === null) draft.selectedId = null;
      // The layout also orders channels, so only the agents that left may be dropped from it.
      const gone = new Set(removed);
      draft.sidebarLayout = {
        ...draft.sidebarLayout,
        agentOrder: draft.sidebarLayout.agentOrder.filter((id) => !gone.has(id)),
        agentAssignments: Object.fromEntries(
          Object.entries(draft.sidebarLayout.agentAssignments).filter(([id]) => !gone.has(id)),
        ),
      };
    });
  }
  function refreshHosts(): Promise<void> {
    if (hostsRefreshPromise) return hostsRefreshPromise;
    const refreshGeneration = generation;
    const refreshHostId = hostId;
    const promise = (async () => {
      if (disposed) return;
      setState((draft) => {
        draft.hostsLoading = true;
        draft.hostsError = null;
      });
      try {
        const hosts = await runtime.listHosts();
        if (disposed) return;
        const activeGeneration = refreshGeneration === generation && refreshHostId === hostId;
        if (!activeGeneration) return;
        if (refreshHostId && !hosts.some((host) => host.hostId === refreshHostId)) {
          generation += 1;
          hostId = null;
          recovery.dispose();
          recovery = makeRecovery();
          hostLifecycle.endSleep();
          selectedId = null;
          restartSince = null;
          hostAway = false;
          stopRestartRetry();
          staleQueues.clear();
          setState((draft) => {
            draft.host = null;
            draft.workspaceLoaded = false;
            draft.memberId = null;
            draft.selectedId = null;
            draft.agents = [];
            draft.agentsLoaded = false;
            draft.conversations = {};
            draft.queues = {};
            draft.approvals = [];
            draft.prompts = [];
            draft.progress = {};
            draft.unreadCounts = {};
            draft.recentReplies = {};
            draft.failedTurns = {};
            draft.takeovers = [];
            draft.browserTabs = [];
            draft.activeBrowserTabId = null;
            draft.browserControlState = { sessions: [] };
            draft.sidebarLayout = defaultSidebarLayout();
            draft.duplicatingAgentIds = [];
            draft.capabilities = [];
            draft.hostRestart = null;
            draft.status = "offline";
            draft.error = leftHostIds.has(refreshHostId) ? null : currentText().t("webClient.error.accessEnded");
          });
          // First, so the host that left does not get a status connection when it stops being open.
          runtime.hosts?.setHosts(hosts);
          await runtime.disconnect().catch(() => undefined);
        }
        const connected = hosts.find((host) => host.hostId === hostId);
        setState((draft) => {
          // The connected host is a copy from `connect`. An admin can rename it while connected.
          if (connected && draft.host?.hostId === connected.hostId) {
            draft.host.name = connected.name;
            draft.host.logoKey = connected.logoKey;
          }
          draft.hosts = hosts;
          draft.hostsLoaded = true;
          draft.hostsError = null;
        });
        for (const left of leftHostIds) if (!hosts.some((host) => host.hostId === left)) leftHostIds.delete(left);
        if (!hostId) {
          const savedHostId = readWebServerSelection(props.accountId);
          const initialHost =
            hosts.find((host) => host.hostId === savedHostId) ?? orderWebHosts(hosts, serverOrder())[0];
          if (initialHost) await connect(initialHost);
        }
        // After the opened host, so it takes its Signal connection before the status connections.
        if (!disposed) runtime.hosts?.setHosts(hosts);
      } catch (error) {
        if (!disposed) {
          const message =
            webNetworkFailureMessage(error) ??
            (error instanceof Error ? error.message : currentText().t("webClient.error.hostsFailed"));
          setState((draft) => {
            draft.hostsError = message;
          });
        }
        throw error;
      } finally {
        if (!disposed)
          setState((draft) => {
            draft.hostsLoading = false;
          });
      }
    })();
    hostsRefreshPromise = promise;
    void promise.then(
      () => {
        if (hostsRefreshPromise === promise) hostsRefreshPromise = null;
      },
      () => {
        if (hostsRefreshPromise === promise) hostsRefreshPromise = null;
      },
    );
    return promise;
  }
  /**
   * Leaves a joined host. The host leaves the list as it does when access ends, but without an error.
   * Resolves when the membership is gone. The list read follows it, so a failed read or the connect
   * to the next host is not a failed leave.
   */
  async function leaveHost(host: RemoteTeamHost): Promise<void> {
    await departHost(host, () => runtime.leaveHost(host.hostId, host.membershipId));
  }
  async function removeOwnedHost(host: RemoteTeamHost): Promise<void> {
    const remove = runtime.removeOwnedHost;
    if (!remove) throw new Error(currentText().t("server.settings.actionFailed"));
    await departHost(host, () => remove(host.hostId));
  }
  async function departHost(host: RemoteTeamHost, operation: () => Promise<void>): Promise<void> {
    // Before the request: the host revokes this session before the request answers.
    leftHostIds.add(host.hostId);
    try {
      await operation();
    } catch (error) {
      leftHostIds.delete(host.hostId);
      throw error;
    }
    // A read that started before the leave can still list the host, so this read starts after it.
    void (hostsRefreshPromise ?? Promise.resolve()).catch(() => undefined).then(retryHosts);
  }
  function retryHosts(): Promise<void> {
    return refreshHosts().catch(() => undefined);
  }
  function setHostedSleep(hostedSleep: HostedServerSleep | null): void {
    if (state.hostedSleep !== hostedSleep)
      setState((draft) => {
        draft.hostedSleep = hostedSleep;
      });
  }
  function clearRevokedWorkspace(): void {
    // A revoked session must not leave private conversations visible while the directory
    // decides whether this membership still exists. Keep the host shell for a possible
    // authorized reconnect, but invalidate every private read and pending action now.
    generation += 1;
    selectedId = null;
    setState((draft) => {
      draft.revocationRevision += 1;
      draft.workspaceLoaded = false;
      draft.agents = [];
      draft.agentsLoaded = false;
      draft.conversations = {};
      draft.queues = {};
      draft.selectedId = null;
      draft.approvals = [];
      draft.prompts = [];
      draft.progress = {};
      draft.unreadCounts = {};
      draft.recentReplies = {};
      draft.failedTurns = {};
      draft.takeovers = [];
      draft.browserTabs = [];
      draft.activeBrowserTabId = null;
      draft.browserControlState = { sessions: [] };
      draft.sidebarLayout = defaultSidebarLayout();
      draft.capabilities = [];
      draft.presence = null;
      draft.duplicatingAgentIds = [];
    });
  }
  function blockAccess(error: unknown): boolean {
    if (
      !(error instanceof WebHostConnectionError) ||
      (error.code !== "authentication_required" && error.code !== "access_ended")
    )
      return false;
    clearRevokedWorkspace();
    hostLifecycle.endSleep();
    recoveryBlocked = true;
    recovery.suspend();
    setState((draft) => {
      draft.status = "offline";
      draft.connectionError = error.message;
    });
    return true;
  }
  async function reconnect(): Promise<void> {
    const host = state.hosts.find((listed) => listed.hostId === hostId) ?? state.host;
    if (!host || connectionPromise) return;
    if (state.hostedSleep === "sleeping" || state.hostedIssue) await hostLifecycle.retry();
    else {
      await props.onSessionCheck();
      recoveryBlocked = false;
      await connect(host);
    }
  }
  async function joinInvite(inviteUrl: string): Promise<void> {
    const normalizedInviteUrl = inviteUrl.trim();
    if (!normalizedInviteUrl) throw new Error(currentText().t("webClient.error.enterInvitation"));
    const cached = acceptedInvite?.inviteUrl === normalizedInviteUrl ? acceptedInvite : null;
    const host = cached?.host ?? (await runtime.acceptInvite(normalizedInviteUrl));
    acceptedInvite = { inviteUrl: normalizedInviteUrl, host };
    const hadHostSelection = hostId !== null;
    await refreshHosts();
    if (state.host?.hostId !== host.hostId || (state.status !== "online" && hadHostSelection)) await connect(host);
    if (state.status !== "online" || state.host?.hostId !== host.hostId)
      throw new Error(currentText().t("webClient.error.invitationOffline"));
    acceptedInvite = null;
  }
  async function connect(host: RemoteTeamHost) {
    recoveryBlocked = false;
    recovery.dispose();
    recovery = makeRecovery();
    if (!connectionPromise || connectionPromise.hostId !== host.hostId) hostLifecycle.endSleep();
    try {
      await attemptConnection(host, true);
    } catch {
      if (!disposed && hostId === host.hostId && state.recovery?.phase !== "suspended") recover();
    }
  }
  function attemptConnection(host: RemoteTeamHost, opened = false): Promise<void> {
    if (connectionPromise?.hostId === host.hostId) return connectionPromise.promise;
    const promise = connectWorkspace(host, opened).finally(() => {
      if (connectionPromise?.promise === promise) connectionPromise = null;
    });
    connectionPromise = { hostId: host.hostId, opened, promise };
    return promise;
  }
  async function connectWorkspace(host: RemoteTeamHost, opened: boolean) {
    const current = ++generation;
    const sameHost = hostId === host.hostId;
    // A hosted server that sleeps or wakes keeps the workspace visible, so each retry keeps its agents and the selection.
    const keepWorkspace = sameHost && state.workspaceLoaded;
    const previousSelected = sameHost ? selectedId : null;
    hostId = host.hostId;
    writeWebServerSelection(props.accountId, host.hostId);
    if (!keepWorkspace) selectedId = null;
    if (!sameHost) {
      hostLifecycle.endSleep();
      restartSince = null;
      stopRestartRetry();
      staleQueues.clear();
    }
    setState((draft) => {
      // The same host keeps its object and takes the fields of the directory copy. A new object for each
      // attempt would look like a host change to everything that reads `state.host`.
      if (sameHost && draft.host?.hostId === host.hostId) {
        draft.host.name = host.name;
        draft.host.logoKey = host.logoKey;
        draft.host.devicePublicKey = host.devicePublicKey;
        draft.host.membershipId = host.membershipId;
        draft.host.role = host.role;
        if (host.memberLimit === undefined) delete draft.host.memberLimit;
        else draft.host.memberLimit = host.memberLimit;
      } else draft.host = host;
      draft.recovery = null;
      draft.connectionError = null;
      if (!sameHost) {
        draft.workspaceLoaded = false;
        draft.agentStatus = null;
        draft.models = [];
        // A restart that the previous host announced says nothing about this one. For the same host the
        // notice stays until the host is online again.
        draft.hostRestart = null;
        draft.approvals = [];
        draft.prompts = [];
      }
      draft.status = "connecting";
      draft.memberId = sameHost ? draft.memberId : null;
      if (!keepWorkspace) {
        draft.agents = [];
        draft.agentsLoaded = false;
        draft.selectedId = null;
      }
      if (!sameHost) {
        draft.conversations = {};
        draft.queues = {};
        draft.unreadCounts = {};
        draft.recentReplies = {};
        draft.failedTurns = {};
        draft.hiddenIds = [];
      }
      // The approvals and prompts of the same host stay until its snapshot replaces them.
      draft.takeovers = [];
      draft.browserControlState = { sessions: [] };
      if (!keepWorkspace) {
        draft.progress = {};
        draft.browserTabs = [];
        draft.activeBrowserTabId = null;
        draft.sidebarLayout = defaultSidebarLayout();
        draft.duplicatingAgentIds = [];
        draft.capabilities = [];
        draft.presence = null;
      }
      draft.error = null;
      draft.incompatibility = null;
    });
    try {
      const capabilities = await runtime.connect(host);
      // With no saved chat the first one in sidebar order opens, so the layout is read with the roster.
      // A saved chat needs no layout, which keeps the chat opening in the same turn as the roster.
      const layoutRead =
        !savedAgentId() && capabilities.includes("sidebar-layout") ? runtime.getSidebarLayout : undefined;
      const [agents, agentStatus, models, openingLayout] = await Promise.all([
        runtime.listAgents(),
        runtime.status(),
        runtime.models(),
        layoutRead ? layoutRead().catch(() => null) : Promise.resolve(null),
      ]);
      if (disposed || current !== generation) return;
      revokedReconnect = false;
      hostLifecycle.endSleep();
      setState((draft) => {
        draft.capabilities = capabilities;
        draft.agents = agents;
        draft.agentsLoaded = true;
        draft.workspaceLoaded = true;
        draft.agentStatus = agentStatus;
        draft.models = models;
        draft.connectionError = null;
        draft.status = "online";
        // The host is back, so a restart that it announced is over.
        draft.hostRestart = null;
      });
      restartSince = null;
      stopRestartRetry();
      hostAway = false;
      void loadPanels(
        capabilities,
        agents.map((agent) => agent.id),
      );
      preferences.reconcileActiveServerPins(agents.map((agent) => agent.id));
      for (const agent of agents) loadQueue(agent.id);
      loadReads();
      void runtime
        .currentMemberId?.()
        .then((memberId) => {
          if (!disposed && current === generation)
            setState((draft) => {
              draft.memberId = memberId;
            });
        })
        .catch(() => undefined);
      // Presence only names people. A host that does not answer leaves the list empty.
      void runtime.admin?.team.getPresence().then(
        (presence) => {
          if (!disposed && current === generation && !state.presence)
            setState((draft) => {
              draft.presence = presence;
            });
        },
        () => undefined,
      );
      const agentIds = agents.map((agent) => agent.id);
      const saved = savedAgentId();
      let layout = openingLayout;
      // A saved chat that the host no longer has needs the layout, which is read only for this case.
      if (
        !layout &&
        saved &&
        !agentIds.includes(saved) &&
        !(previousSelected && agentIds.includes(previousSelected)) &&
        capabilities.includes("sidebar-layout")
      ) {
        layout = await readSidebarLayout(capabilities, agentIds).catch(() => null);
        if (disposed || current !== generation) return;
      }
      const first =
        previousSelected && agentIds.includes(previousSelected)
          ? previousSelected
          : initialAgentId(agentIds, layout ?? { agentOrder: [] }, saved);
      if (first) await select(first);
    } catch (error) {
      if (disposed || current !== generation) return;
      hostAway = true;
      setState((draft) => {
        draft.status = "offline";
        // The workspace shows an incompatible host in full, so it is not also reported as an error.
        if (error instanceof WebHostIncompatibleError)
          draft.incompatibility = {
            hostId: host.hostId,
            code: error.code,
            message: error.message,
            hostAppVersion: error.hostAppVersion,
            hostProtocol: { ...error.hostProtocol },
          };
      });
      if (blockAccess(error)) throw error;
      if (error instanceof WebHostIncompatibleError || error instanceof WebHostConnectionError) {
        hostLifecycle.endSleep();
        recoveryBlocked = true;
        recovery.suspend();
        setState((draft) => {
          draft.connectionError = error.message;
        });
      } else {
        setState((draft) => {
          draft.connectionError = currentText().t("server.connection.reconnecting", { name: host.name });
        });
        // A host that restarts for an update is not asleep, so the account service is not asked about it.
        if (!restartActive()) await hostLifecycle.hostUnavailable(host.hostId, opened);
      }
      throw error;
    }
  }
  async function loadPanels(capabilities = state.capabilities, agentIds = state.agents.map((agent) => agent.id)) {
    const current = generation;
    const isCurrent = () => !disposed && current === generation;
    setState((draft) => {
      draft.panelsFailed = false;
      draft.panelsLoading = true;
    });
    const failed = () => {
      if (isCurrent())
        setState((draft) => {
          draft.panelsFailed = true;
        });
    };
    await Promise.all([
      (capabilities.includes("browser-control") ? runtime.browserTabs() : Promise.resolve([]))
        .then((browserTabs) => {
          if (!isCurrent()) return;
          setState((draft) => {
            draft.browserTabs = browserTabs;
            draft.activeBrowserTabId = browserTabs.some((tab) => tab.id === draft.activeBrowserTabId)
              ? draft.activeBrowserTabId
              : (browserTabs[0]?.id ?? null);
          });
        })
        .catch(failed),
      readSidebarLayout(capabilities, agentIds)
        .then((layout) => {
          if (isCurrent())
            setState((draft) => {
              if (layout.revision >= draft.sidebarLayout.revision) draft.sidebarLayout = layout;
            });
        })
        .catch(failed),
    ]);
    if (isCurrent())
      setState((draft) => {
        draft.panelsLoading = false;
      });
  }

  async function load(id: string, older = false) {
    const current = generation;
    const previous = state.conversations[id];
    const before = older ? (previous?.page?.pageInfo.olderCursor ?? undefined) : undefined;
    if (older && !before) return;
    conversationReads.set(id, (conversationReads.get(id) ?? 0) + 1);
    try {
      const page = await runtime.conversation(id, before);
      if (disposed || current !== generation) return;
      if (page.agentId !== id) throw new Error(currentText().t("webClient.error.otherConversation"));
      setState((draft) => {
        const item = draft.conversations[id];
        if (!item) return;
        const old = item.page?.threadId === page.threadId ? item.page : null;
        if (old && page.revision < old.revision) return;
        const resolvedRequests = new Set(
          page.messages.flatMap((message) =>
            message.questionPrompt?.resolution ? [String(message.questionPrompt.requestId)] : [],
          ),
        );
        draft.prompts = draft.prompts.filter(
          (prompt) =>
            prompt.agentId !== id ||
            prompt.threadId !== page.threadId ||
            !resolvedRequests.has(String(prompt.requestId)),
        );
        item.page = {
          ...page,
          messages: mergeConversationPage(
            old?.messages ?? [],
            page.messages,
            older ? "older" : old ? "latest" : "replace",
          ),
          references: { ...old?.references, ...page.references },
          pageInfo: !older && old ? old.pageInfo : page.pageInfo,
          // An older page has the thread's current revision but not its newest messages. The loaded
          // newest messages keep their revision, so a delta held during this read still applies.
          revision: older && old ? old.revision : page.revision,
        };
        item.loading = false;
        item.error = null;
        // An older page has the read state of the whole chat too, but only the latest page follows new messages.
        if (!older && page.readState) setUnread(draft, id, page.readState.unreadCount);
      });
    } catch (error) {
      if (!disposed && current === generation && !blockAccess(error))
        setState((draft) => {
          const item = draft.conversations[id];
          if (item) {
            item.loading = false;
            item.error = currentText().t("webClient.error.requestFailed");
          }
        });
      throw error;
    } finally {
      const reads = (conversationReads.get(id) ?? 1) - 1;
      if (reads > 0) conversationReads.set(id, reads);
      else {
        conversationReads.delete(id);
        const held = heldDeltas.get(id) ?? [];
        heldDeltas.delete(id);
        for (const event of held) applyDelta(event);
      }
    }
  }
  /**
   * Appends streamed text to the selected conversation without a read. A delta that arrives during
   * a read waits for it: the page read may already hold the text, and its revision tells which
   * deltas are newer. A delta for another thread asks for a read.
   */
  function applyDelta(event: Extract<AgentEvent, { type: "conversation-delta" }>) {
    if (disposed || event.agentId !== selectedId) return;
    if (conversationReads.has(event.agentId)) {
      heldDeltas.set(event.agentId, [...(heldDeltas.get(event.agentId) ?? []), event]);
      return;
    }
    let otherThread = false;
    // The checks read the draft: a page that a read just wrote is not visible outside it until a flush.
    setState((draft) => {
      const value = draft.conversations[event.agentId]?.page;
      if (!value) return;
      if (value.threadId !== event.threadId) {
        otherThread = true;
        return;
      }
      if (event.revision <= value.revision) return;
      const message = value.messages.find((item) => item.id === event.messageId);
      if (message) {
        message.text += event.delta;
        message.status = "streaming";
      } else
        value.messages.push({
          id: event.messageId,
          turnId: event.turnId,
          author: "assistant",
          source: "assistant",
          text: event.delta,
          createdAt: event.createdAt,
          status: "streaming",
        });
      value.revision = event.revision;
      value.activeTurnId = event.turnId;
    });
    if (otherThread) void refresh();
  }
  // Coalesce event bursts per agent, as `refresh` does for the conversation.
  function loadQueue(id: string): void {
    const running = queueLoads.get(id);
    if (running?.generation === generation) {
      running.again = true;
      return;
    }
    const load = { generation, again: true };
    queueLoads.set(id, load);
    void (async () => {
      try {
        while (load.again && !disposed && load.generation === generation) {
          load.again = false;
          const revision = queueRevisions.get(id) ?? 0;
          const queue = await runtime.queue(id);
          if (disposed || load.generation !== generation || (queueRevisions.get(id) ?? 0) !== revision) continue;
          staleQueues.delete(id);
          setState((draft) => {
            draft.queues[id] = queue;
          });
        }
      } catch (error) {
        if (load.generation === generation) report(error);
      } finally {
        if (queueLoads.get(id) === load) queueLoads.delete(id);
      }
    })();
  }
  /**
   * Reads the unread count of every agent chat. Reads coalesce as queue reads do. A host that does not
   * answer, such as an older one, leaves the badges as they are: they only help the user and block nothing.
   */
  function loadReads(): void {
    if (readsLoad?.generation === generation) {
      readsLoad.again = true;
      return;
    }
    const load = { generation, again: true };
    readsLoad = load;
    void (async () => {
      try {
        while (load.again && !disposed && load.generation === generation) {
          load.again = false;
          const reads = await runtime.conversationReads();
          if (disposed || load.generation !== generation) continue;
          setState((draft) => {
            draft.unreadCounts = Object.fromEntries(
              Object.entries(reads)
                .filter(([id, read]) => read.unreadCount > 0 && draft.agents.some((agent) => agent.id === id))
                .map(([id, read]) => [id, read.unreadCount]),
            );
          });
        }
      } catch {
        // See above.
      } finally {
        if (readsLoad === load) readsLoad = null;
      }
    })();
  }
  /** An event burst, such as a streamed reply, costs one read. */
  function scheduleReads(): void {
    if (readsTimer !== undefined || disposed) return;
    readsTimer = setTimeout(() => {
      readsTimer = undefined;
      if (!disposed) loadReads();
    }, READS_DELAY_MS);
  }
  /** Sends one queue change for the selected agent. The host then sends the new queue as an event. */
  /** Resolves when the host has answered. A failure is reported and does not reject. */
  function changeQueue(change: (agentId: string) => Promise<void>): Promise<void> {
    const id = selectedId;
    const current = generation;
    if (!id || state.status !== "online") return Promise.resolve();
    return change(id).catch((error) => {
      if (current === generation) report(error);
    });
  }
  /** The chat that this browser last opened on this host, while the host still has it. */
  function savedAgentId(): string | null {
    return hostId ? (readAgentSelection()[webAgentSelectionKey(props.accountId, hostId)] ?? null) : null;
  }
  async function select(id: string) {
    const current = generation;
    selectedId = id;
    if (hostId) writeAgentSelection(webAgentSelectionKey(props.accountId, hostId), id);
    // A resync after the background read only the queue of the opened chat. This one is read now.
    if (staleQueues.delete(id)) loadQueue(id);
    setState((draft) => {
      draft.selectedId = id;
      draft.conversations[id] ??= {
        page: null,
        draft: "",
        attachments: [],
        loading: true,
      };
      draft.conversations[id].loading = true;
      draft.conversations[id].error = null;
      delete draft.recentReplies[id];
    });
    try {
      await load(id);
    } catch (error) {
      if (disposed || current !== generation) return;
      report(error);
    }
  }
  /**
   * Reads what the page may have missed: the agents, the layout, the unread counts and the opened chat. The
   * queue of the opened chat is read here; the other queues come with their events, or when their chat opens.
   * A read that is already running is shared.
   */
  function resync(): Promise<void> {
    if (resyncPromise) return resyncPromise;
    const promise = readAgentsAgain().finally(() => {
      if (resyncPromise === promise) resyncPromise = null;
    });
    resyncPromise = promise;
    return promise;
  }
  async function readAgentsAgain() {
    const current = generation;
    try {
      const agents = await runtime.listAgents();
      if (disposed || current !== generation) return;
      const sidebarLayout = await readSidebarLayout(
        state.capabilities,
        agents.map((agent) => agent.id),
      );
      if (disposed || current !== generation) return;
      reconcileAgents(agents);
      setState((draft) => {
        if (sidebarLayout.revision >= draft.sidebarLayout.revision) draft.sidebarLayout = sidebarLayout;
      });
      staleQueues.clear();
      for (const agent of agents) if (agent.id !== selectedId) staleQueues.add(agent.id);
      if (selectedId) loadQueue(selectedId);
      loadReads();
      if (!selectedId) {
        const first = initialAgentId(
          agents.map((agent) => agent.id),
          sidebarLayout,
          savedAgentId(),
        );
        if (first) await select(first);
      }
      await refresh();
    } catch (error) {
      if (current === generation) report(error);
    }
  }
  /**
   * The page comes back after a while in the background. The connection can look online and be dead: the
   * phone slept, or the network changed. The peer renews its path first, then one small request tells whether
   * the host answers. A host that does not answer starts a new connection; one that does is read again.
   */
  async function returnFromBackground() {
    const current = generation;
    runtime.networkRestored?.();
    try {
      // The compatibility read is the smallest one. A runtime without raw requests reads the status.
      const probe = runtime.admin?.request;
      if (probe) await probe("GET", TEAM_API_ROUTES.compatibility, () => undefined);
      else await runtime.status();
    } catch {
      if (!disposed && current === generation && state.status === "online") recover();
      return;
    }
    if (disposed || current !== generation) return;
    await resync();
  }
  // Coalesce event bursts; an event during a read schedules one further authoritative read.
  async function refresh() {
    pendingReload = true;
    if (reloadPromise) return reloadPromise;
    reloadPromise = (async () => {
      while (pendingReload && !disposed) {
        pendingReload = false;
        const id = selectedId;
        if (id) {
          const current = generation;
          try {
            await load(id);
          } catch (error) {
            if (current === generation) report(error);
          }
        }
      }
    })();
    try {
      await reloadPromise;
    } finally {
      reloadPromise = null;
    }
  }
  /**
   * Sends one message to an agent of the open host. The chat shows it as pending and the answer says
   * whether it arrived; a failure is never resent here. `clientMessageId` lets the host drop a retry.
   */
  async function send(
    id: string,
    text: string,
    attachmentDraftIds: string[],
    replyToMessageId: string | null = null,
    clientMessageId?: string,
  ): Promise<{ messageId: string } | { error: string }> {
    const { t, errorMessage } = currentText();
    if (state.status !== "online") return { error: t("chat.errorStatus.send") };
    if (text.length > INPUT_LIMITS.messageText) return { error: t("webClient.error.messageTooLong") };
    const current = generation;
    let messageId: string;
    try {
      messageId = await runtime.send(id, text, attachmentDraftIds, replyToMessageId, clientMessageId);
    } catch (error) {
      return { error: errorMessage(error, t("webClient.error.deliveryUnconfirmed")) };
    }
    // The next pending send of the chat waits for this answer, so the history reload runs beside it.
    if (current === generation && !disposed)
      refresh().catch((error: unknown) => {
        if (current === generation) report(error);
      });
    return { messageId };
  }
  /** Marks the selected agent's messages read through the newest loaded one. Writes for one agent run in order. */
  function markRead() {
    const id = selectedId;
    if (!id || state.status !== "online") return Promise.resolve();
    const current = generation;
    const write = (readWrites.get(id) ?? Promise.resolve())
      .catch(() => undefined)
      .then(async () => {
        const page = state.conversations[id]?.page;
        if (!page || disposed || current !== generation) return;
        const readState = await runtime.markRead(id, page.messages.at(-1)?.id ?? null);
        if (disposed || current !== generation) return;
        setState((draft) => {
          const value = draft.conversations[id]?.page;
          if (value?.threadId === page.threadId) value.readState = readState;
          setUnread(draft, id, readState.unreadCount);
        });
      });
    readWrites.set(id, write);
    return write;
  }
  /** Marks an agent's whole conversation unread, then updates the open page if it is that agent's. */
  async function markUnread(id: string) {
    if (state.status !== "online" || !state.capabilities.includes("conversation-unread")) {
      throw new Error(currentText().t("webClient.error.markUnreadUnsupported"));
    }
    const current = generation;
    const readState = await (readWrites.get(id) ?? Promise.resolve())
      .catch(() => undefined)
      .then(() => runtime.markUnread(id));
    if (disposed || current !== generation) return;
    setState((draft) => {
      const page = draft.conversations[id]?.page;
      if (page) page.readState = readState;
      setUnread(draft, id, readState.unreadCount);
    });
  }
  /** Marks every agent with unread messages read through its newest one, loaded or not. */
  async function markAllRead() {
    if (state.status !== "online") return;
    const current = generation;
    const reads = await runtime.conversationReads();
    if (disposed || current !== generation) return;
    const unread = Object.entries(reads)
      .filter(([, read]) => read.unreadCount > 0)
      .map(([id]) => id);
    const writes = unread.map((id) => {
      const write = (readWrites.get(id) ?? Promise.resolve())
        .catch(() => undefined)
        .then(async () => {
          if (disposed || current !== generation) return;
          const page = await runtime.conversation(id);
          const latestMessageId = page.messages.at(-1)?.id;
          if (!latestMessageId || disposed || current !== generation) return;
          const readState = await runtime.markRead(id, latestMessageId);
          if (disposed || current !== generation) return;
          setState((draft) => {
            const value = draft.conversations[id]?.page;
            if (value?.threadId === page.threadId) value.readState = readState;
            setUnread(draft, id, readState.unreadCount);
          });
        });
      readWrites.set(id, write);
      return write;
    });
    await Promise.all(writes);
    loadReads();
  }
  createHostRestartToasts(() =>
    state.host
      ? [
          {
            id: state.host.hostId,
            name: state.host.name,
            online: state.status === "online",
            restart: state.hostRestart?.state ?? null,
            version: state.hostRestart?.version ?? null,
          },
        ]
      : [],
  );
  onSettled(() => {
    void refreshHosts().catch(report);
    const focus = () => {
      // The user is back, so every reply that ended while the page had no focus is seen.
      if (Object.keys(state.recentReplies).length > 0)
        setState((draft) => {
          draft.recentReplies = {};
        });
      runtime.hosts?.refresh();
      void props
        .onSessionCheck()
        .then(() => refreshHosts())
        .then(() => {
          if (state.status === "online") return resync();
          if (state.recovery?.phase !== "suspended") recover();
        })
        .catch(report);
    };
    const visibility = () => {
      if (document.hidden) {
        hiddenAt ??= Date.now();
        hostLifecycle.cancelPending();
        if (hostId && state.status !== "online") generation += 1;
        recovery.setActive(false);
      } else {
        const away = hiddenAt === null ? 0 : Date.now() - hiddenAt;
        hiddenAt = null;
        hostLifecycle.resume();
        if (state.status !== "online" && state.recovery?.phase !== "suspended") {
          recover();
          // The user is back, so a wait that grew while the page was hidden is over. One attempt, not a loop.
          recovery.networkRestored();
        } else if (state.status === "online" && away > BACKGROUND_REFRESH_MS) {
          // The page was away long enough for the connection to die without a sign.
          void returnFromBackground();
        }
      }
    };
    const network = () => {
      if (document.hidden) return;
      // The peer renews its own path first: a connection that looks online can be dead after a dead zone.
      runtime.networkRestored?.();
      recovery.networkRestored();
    };
    document.addEventListener("visibilitychange", visibility);
    window.addEventListener("online", network);
    window.addEventListener("focus", focus);
    return () => {
      disposed = true;
      generation += 1;
      clearTimeout(readsTimer);
      stopRestartRetry();
      recovery.dispose();
      hostLifecycle.dispose();
      document.removeEventListener("visibilitychange", visibility);
      window.removeEventListener("online", network);
      acceptedInvite = null;
      window.removeEventListener("focus", focus);
      void runtime.dispose({ sessionsEnded: props.accountSessionEnded?.() ?? false }).catch(() => undefined);
    };
  });
  return {
    state,
    profiles,
    retryPanels: loadPanels,
    selected,
    conversation,
    runtime,
    preferences,
    orderedHosts,
    reorderHosts(hostIds: string[]) {
      setServerOrder(hostIds);
      writeWebServerOrder(props.accountId, hostIds);
    },
    /** Every event of the connected host. Returns the unsubscribe function. */
    onHostEvent(listener: (event: AgentEvent | TeamRealtimeEvent) => void) {
      hostEventListeners.add(listener);
      return () => {
        hostEventListeners.delete(listener);
      };
    },
    /** The events of the hosts this tab has not opened that a notification can show. Returns the unsubscribe function. */
    onHostNotice(listener: (hostId: string, event: WebHostNotice, agents: AgentSummary[]) => void) {
      hostNoticeListeners.add(listener);
      return () => {
        hostNoticeListeners.delete(listener);
      };
    },
    run,
    refreshHosts,
    leaveHost,
    removeOwnedHost,
    retryHosts,
    reconnect,
    joinInvite,
    connect,
    select,
    refresh,
    send,
    cancelQueued: (deliveryId: string): Promise<void> =>
      changeQueue((agentId) => runtime.cancelQueued({ agentId, deliveryId })),
    steerQueued(deliveryId: string) {
      const expectedTurnId = conversation()?.page?.activeTurnId;
      if (expectedTurnId) void changeQueue((agentId) => runtime.steerQueued({ agentId, deliveryId, expectedTurnId }));
    },
    reorderQueue: (deliveryIds: string[]) => changeQueue((agentId) => runtime.reorderQueue({ agentId, deliveryIds })),
    async updateQueued(
      deliveryId: string,
      text: string,
      keepAttachmentIds: string[],
      attachmentDraftIds: string[],
      target?: { agentId: string; serverId: string },
    ): Promise<boolean> {
      const agentId = target?.agentId ?? selectedId;
      if (!agentId) return false;
      // The edit belongs to the host that queued the message. This client talks only to the connected one.
      if (target && target.serverId !== hostId) {
        report(new Error(currentText().t("webClient.error.hostChanged")));
        return false;
      }
      const current = generation;
      try {
        await runtime.updateQueued({ agentId, deliveryId, text, keepAttachmentIds, attachmentDraftIds });
        return true;
      } catch (error) {
        if (current === generation) report(error);
        return false;
      }
    },
    markRead,
    markUnread,
    markAllRead,
    async mutateSidebarLayout(action: SidebarLayoutAction) {
      if (state.status !== "online" || !state.capabilities.includes("sidebar-layout")) {
        throw new Error(currentText().t("webClient.error.sidebarLayout"));
      }
      const mutate = runtime.mutateSidebarLayout;
      if (!mutate) throw new Error(currentText().t("webClient.error.sidebarLayout"));
      const current = generation;
      const layout = await mutate(action);
      if (disposed || current !== generation) return;
      setState((draft) => {
        if (layout.revision >= draft.sidebarLayout.revision) draft.sidebarLayout = layout;
      });
    },
    async duplicateAgent(agentId: string): Promise<void> {
      if (state.status !== "online" || !state.capabilities.includes("agent-duplication")) return;
      if (!state.agents.some((agent) => agent.id === agentId)) return;
      if (state.duplicatingAgentIds.includes(agentId)) return;
      const current = generation;
      setState((draft) => {
        draft.duplicatingAgentIds = [...draft.duplicatingAgentIds, agentId];
        draft.error = null;
      });
      try {
        const result = await runtime.duplicateAgent(agentId);
        if (disposed || current !== generation) return;
        setState((draft) => {
          draft.agents = [result.agent, ...draft.agents.filter((agent) => agent.id !== result.agent.id)];
          if (result.layout.revision >= draft.sidebarLayout.revision) draft.sidebarLayout = result.layout;
        });
        await select(result.agent.id);
      } catch (error) {
        if (current === generation) report(error);
        throw error;
      } finally {
        if (current === generation && !disposed)
          setState((draft) => {
            draft.duplicatingAgentIds = draft.duplicatingAgentIds.filter((id) => id !== agentId);
          });
      }
    },
    async deleteAgent(agentId: string): Promise<void> {
      if (state.status !== "online") throw new Error(currentText().t("webClient.error.deleteOffline"));
      if (state.host?.role === "member") throw new Error(currentText().t("error.team.membersCannotDeleteAgents"));
      if (!state.agents.some((agent) => agent.id === agentId)) return;
      const current = generation;
      const wasSelected = selectedId === agentId;
      try {
        await runtime.deleteAgent(agentId);
        preferences.removePinnedSidebarItemEverywhere({ kind: "agent", id: agentId });
        if (disposed || current !== generation) return;
        const agents = await runtime.listAgents();
        const sidebarLayout = await readSidebarLayout(
          state.capabilities,
          agents.map((agent) => agent.id),
        );
        if (disposed || current !== generation) return;
        reconcileAgents(agents);
        setState((draft) => {
          if (sidebarLayout.revision >= draft.sidebarLayout.revision) draft.sidebarLayout = sidebarLayout;
        });
        if (wasSelected && selectedId === null) {
          const first = initialAgentId(
            agents.map((agent) => agent.id),
            sidebarLayout,
          );
          if (first) await select(first);
        }
      } catch (error) {
        if (current === generation) report(error);
        throw error;
      }
    },
    async answer(input: RespondToPromptInput) {
      const current = generation;
      await runtime.answer(input);
      if (disposed || current !== generation) return;
      setState((draft) => {
        draft.prompts = draft.prompts.filter((item) => String(item.requestId) !== String(input.requestId));
      });
      await refresh();
    },
    async respondToBrowserTakeover(decision: "complete" | "cancel") {
      const current = generation;
      const threadId = state.agents.find((agent) => agent.id === selectedId)?.threadId;
      const request = state.takeovers.find((item) => item.agentId === selectedId && item.threadId === threadId);
      if (!request) return false;
      try {
        await runtime.respondToTakeover({ requestId: request.requestId, decision });
        if (disposed || current !== generation) return false;
        setState((draft) => {
          draft.takeovers = draft.takeovers.filter((item) => String(item.requestId) !== String(request.requestId));
        });
        return true;
      } catch (error) {
        if (current === generation) report(error);
        return false;
      }
    },
    activateBrowserTab(tabId: string) {
      if (state.browserTabs.some((tab) => tab.id === tabId))
        setState((draft) => {
          draft.activeBrowserTabId = tabId;
        });
    },
    async openSearchMessage(messageId: string) {
      const id = selectedId;
      const current = generation;
      if (!id) return;
      while (!state.conversations[id]?.page?.messages.some((message) => message.id === messageId)) {
        const page = state.conversations[id]?.page;
        if (!page?.pageInfo.hasOlder || !page.pageInfo.olderCursor) break;
        const cursor = page.pageInfo.olderCursor;
        await load(id, true);
        if (disposed || current !== generation || selectedId !== id) return;
        if (state.conversations[id]?.page?.pageInfo.olderCursor === cursor) break;
      }
    },
    async approve(input: RespondToApprovalInput) {
      const current = generation;
      await runtime.approve(input);
      if (disposed || current !== generation) return;
      setState((draft) => {
        draft.approvals = draft.approvals.filter((item) => item.requestId !== input.requestId);
      });
      await refresh();
    },
    older: () => {
      const id = selectedId;
      return id ? run(() => load(id, true)) : Promise.resolve();
    },
    setDraft(text: string) {
      const id = selectedId;
      if (id)
        setState((draft) => {
          const conversation = draft.conversations[id];
          if (conversation) conversation.draft = text;
        });
    },
    async upload(file: File) {
      const id = selectedId;
      if (!id) return;
      if ((state.conversations[id]?.attachments.length ?? 0) >= INPUT_LIMITS.attachments) {
        report(new Error(currentText().t("webClient.error.attachmentLimit", { limit: INPUT_LIMITS.attachments })));
        return;
      }
      const current = generation;
      await run(async () => {
        setState((draft) => {
          draft.uploading = true;
        });
        try {
          const attachment = await runtime.upload(file);
          if (current !== generation || disposed) return;
          // The agent was removed during the upload, so the host must not keep the file.
          if (!state.conversations[id]) {
            await runtime.discard(attachment.id);
            return;
          }
          setState((draft) => {
            draft.conversations[id]?.attachments.push(attachment);
          });
        } finally {
          if (!disposed)
            setState((draft) => {
              draft.uploading = false;
            });
        }
      });
    },
    cancelUpload: () => runtime.cancelUpload().catch(report),
    toggleHidden(id: string) {
      setState((draft) => {
        draft.hiddenIds = draft.hiddenIds.includes(id)
          ? draft.hiddenIds.filter((value) => value !== id)
          : [...draft.hiddenIds, id];
      });
    },
    toggleNotifications: () =>
      run(async () => {
        const agent = state.agents.find((value) => value.id === selectedId);
        if (!agent) return;
        const current = generation;
        await runtime.updateAgent({ agentId: agent.id, notifications: !agent.notifications });
        const agents = await runtime.listAgents();
        if (!disposed && current === generation)
          setState((draft) => {
            draft.agents = agents;
          });
      }),
    async discard(attachmentId: string) {
      const id = selectedId;
      const current = generation;
      if (!id) return;
      await run(async () => {
        await runtime.discard(attachmentId);
        if (current === generation && !disposed)
          setState((draft) => {
            const conversation = draft.conversations[id];
            if (conversation)
              conversation.attachments = conversation.attachments.filter((item) => item.id !== attachmentId);
          });
      });
    },
  };
}
