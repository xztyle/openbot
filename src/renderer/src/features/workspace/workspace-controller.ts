/*
 * The workspace controller: which conversation or view is open, which right panel shows, the open
 * thread, the drafts, the activity feed, and every workspace command. The desktop and the browser
 * client build it from their own environment and mount the same view on it.
 */

import { chatTagReferences } from "@openbot/contracts/chat-tag-references";
import {
  type AgentApproval,
  type AgentEvent,
  type ChannelCommand,
  type ChannelMember,
  type ChannelMessage,
  type ChannelPage,
  type ChannelSummary,
  channelKind,
  isChannelAnswerMode,
  type WorkspaceActivity,
  type WorkspaceChannelCommand,
  type WorkspaceSettings,
  type WorkspaceSteps,
} from "@openbot/contracts/ipc";
import { isDynamicRecord } from "@openbot/contracts/runtime-values";
import type { AppTextKey } from "@openbot/i18n";
import type { AgentProfile } from "@openbot/ui/data";
import type { SidebarAgentState } from "@openbot/ui/features/sidebar/sidebar-types";
import type { ChannelDetailsTab } from "@openbot/ui/features/workspace/ChannelDetails";
import type { WorkspaceView } from "@openbot/ui/features/workspace/WorkspaceSidebar";
import { slugChannelName } from "@openbot/ui/features/workspace/workspace-format";
import type { AgentAnswerMode, WorkspaceMenuItem } from "@openbot/ui/features/workspace/workspace-types";
import { currentText } from "@openbot/ui/text";
import { createEffect, createMemo, createStore, onCleanup, untrack } from "solid-js";
import { actionToast } from "../../action-toast";
import type { ChannelsController } from "../channels/channels-controller";
import type { MessagingApi } from "../connectors/messaging-connector";
import {
  AGENT_DM_PREFIX,
  humanIds,
  readerJoined,
  readerReacted,
  sidebarChannels,
  sidebarDirectMessages,
  soleAgentOf,
  type WorkspaceDirectory,
  type WorkspacePerson,
} from "./workspace-model";
import {
  createHostArtifactsSource,
  createHostFleetSource,
  createLocalFleetSource,
  createMessageArtifactsSource,
  type WorkspaceArtifactsSource,
  type WorkspaceFleetSource,
} from "./workspace-sources";

export type WorkspaceRoute =
  | { kind: "channel"; channelId: string }
  /** The owner's DM with an agent: the agent's main chat. */
  | { kind: "agent"; agentId: string }
  | { kind: "view"; view: WorkspaceView };

export type WorkspacePanel =
  | { kind: "thread"; channelId: string; rootId: string }
  | { kind: "details"; channelId: string; tab: ChannelDetailsTab }
  | { kind: "artifacts"; channelId: string };

export type WorkspaceDialog =
  | { kind: "create-channel" }
  | { kind: "new-message" }
  | { kind: "browse" }
  | { kind: "switcher" }
  | { kind: "edit-meta"; channelId: string; field: "topic" | "description" }
  | { kind: "invite"; channelId: string }
  | { kind: "delete-message"; channelId: string; messageId: string; threadRootId: string | null };

/** The one pane a phone shows. */
export type WorkspacePhonePane = "sidebar" | "main" | "panel";

interface ThreadState {
  channelId: string;
  rootId: string;
  page: ChannelPage | null;
  loading: boolean;
  error: string | null;
}

interface EditingState {
  channelId: string;
  messageId: string;
  /** The thread the message is in, or null for the channel transcript. */
  threadRootId: string | null;
}

interface WorkspaceState {
  view: WorkspaceView | null;
  panel: WorkspacePanel | null;
  phonePane: WorkspacePhonePane;
  dialog: WorkspaceDialog | null;
  thread: ThreadState | null;
  editing: EditingState | null;
  drafts: Record<string, string>;
  activity: { data: WorkspaceActivity | null; loading: boolean; failed: boolean };
  settings: WorkspaceSettings | null;
  /** The step trails of agent messages that the host reported, by message id. Null: the host has none. */
  steps: Record<string, WorkspaceSteps | null>;
}

/** What the workspace needs from the app around it. Each shell builds it from its own contexts. */
export interface WorkspaceEnvironment {
  channels: ChannelsController;
  agents: () => AgentProfile[];
  /** Agents the reader hid: they get no DM row. */
  hiddenAgentIds: () => ReadonlySet<string>;
  agentStates: () => Readonly<Record<string, SidebarAgentState>>;
  people: () => readonly WorkspacePerson[];
  reader: () => { id: string | null; name: string; avatarUrl: string | null; role: "owner" | "admin" | "member" };
  isReader: (id: string) => boolean;
  /** True for the server owner: an agent's DM is its main chat, with its steps and reasoning. */
  agentDmIsMainChat: () => boolean;
  /** The agent chat that the shell has open, or null. */
  activeAgentId: () => string | null;
  openAgentChat: (agentId: string) => void;
  openAgentSettings: (agentId: string) => void;
  serverName: () => string;
  /** Whether the host answers. Until it does, commands wait. */
  connectionReady: () => boolean;
  /** The items of the workspace menu: the features of the app that stay reachable from here. */
  menu: () => readonly WorkspaceMenuItem[];
  /** Every event of the host. The workspace reads the live channel messages. */
  onHostEvent: (listener: (event: AgentEvent) => void) => () => void;
  /** Every approval that waits on the host. A channel shows the ones of its own work. */
  approvals?: (() => readonly AgentApproval[]) | undefined;
  /** The Discord connections of the host, for the channel's Integrations tab. */
  messaging?: (() => MessagingApi | undefined) | undefined;
  /** The workspace settings of the host. Only owners and admins may read them. */
  workspaceSettings?: (() => Promise<WorkspaceSettings>) | undefined;
  /** A host fleet endpoint. Absent, the fleet comes from the agent list and its runtime state. */
  fleet?: WorkspaceFleetSource | undefined;
  /** A host artifacts index. Absent, the artifacts come from the messages this client read. */
  artifacts?: WorkspaceArtifactsSource | undefined;
  /** Opens the form of a new agent. */
  createAgent?: (() => void) | undefined;
  /** Opens the invitation of people to the server. */
  inviteTeammates?: (() => void) | undefined;
  /** A link to a message that opens it again, where the client has one. */
  messageLink?: ((channelId: string, messageId: string, threadRootId: string | null) => string | null) | undefined;
  /** Per reader and server, for the drafts this computer keeps. */
  storageKey: () => string;
  /** The layout shows one pane at a time. */
  phone: () => boolean;
  /** Called when the workspace moves to another pane on a phone. */
  onPhonePaneChange?: ((pane: WorkspacePhonePane) => void) | undefined;
}

export type WorkspaceController = ReturnType<typeof createWorkspaceController>;

const DRAFTS_KEY = "openbot.workspace.drafts.v1";
const DRAFT_LIMIT = 200;

function readDrafts(key: string): Record<string, string> {
  try {
    const value = JSON.parse(window.localStorage.getItem(`${DRAFTS_KEY}:${key}`) ?? "{}");
    if (!isDynamicRecord(value)) return {};
    return Object.fromEntries(
      Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
    );
  } catch {
    return {};
  }
}

function writeDrafts(key: string, drafts: Record<string, string>): void {
  try {
    const entries = Object.entries(drafts)
      .filter(([, text]) => text.trim())
      .slice(-DRAFT_LIMIT);
    window.localStorage.setItem(`${DRAFTS_KEY}:${key}`, JSON.stringify(Object.fromEntries(entries)));
  } catch {
    // A private window or a full disk keeps the drafts in memory only.
  }
}

/**
 * An agent's own defaults for the channels it joins, when the host keeps them
 * (`defaults.agents` of the workspace settings). A host without them gives none.
 */
function agentChannelDefaults(
  settings: WorkspaceSettings | null,
  agentId: string,
): { answerMode?: AgentAnswerMode; focus?: string } {
  const defaults = settings?.defaults;
  const agents = defaults && "agents" in defaults ? defaults.agents : undefined;
  const own = isDynamicRecord(agents) ? agents[agentId] : undefined;
  if (!isDynamicRecord(own)) return {};
  return {
    ...(isChannelAnswerMode(own.answerMode) ? { answerMode: own.answerMode } : {}),
    ...(typeof own.focus === "string" && own.focus.trim() ? { focus: own.focus } : {}),
  };
}

/** The draft key of a conversation, or of a thread in it. */
export function draftKey(channelId: string, threadRootId?: string | null): string {
  return threadRootId ? `${channelId}/${threadRootId}` : channelId;
}

function failureToast(error: unknown, fallback: AppTextKey): void {
  const text = currentText();
  actionToast.error(text.errorMessage(error, text.t(fallback)), {
    report: { operation: "other", source: "action", cause_code: "unknown" },
  });
}

export function createWorkspaceController(env: WorkspaceEnvironment) {
  const channels = env.channels;
  const [state, setState] = createStore<WorkspaceState>({
    view: null,
    panel: null,
    phonePane: "sidebar",
    dialog: null,
    thread: null,
    editing: null,
    drafts: untrack(() => readDrafts(env.storageKey())),
    activity: { data: null, loading: false, failed: false },
    settings: null,
    steps: {},
  });

  const directory = createMemo(
    (): WorkspaceDirectory => ({
      agents: env.agents(),
      people: env.people(),
      isReader: env.isReader,
      reader: env.reader(),
      agentStates: env.agentStates(),
    }),
  );

  const summaries = () => channels.state.channels;
  const summary = (channelId: string): ChannelSummary | undefined =>
    channels.state.channels.find((channel) => channel.id === channelId);

  const route = createMemo((): WorkspaceRoute => {
    const channelId = channels.state.selectedId;
    if (channelId) return { kind: "channel", channelId };
    if (state.view) return { kind: "view", view: state.view };
    const agentId = env.activeAgentId();
    if (agentId && env.agentDmIsMainChat()) return { kind: "agent", agentId };
    return { kind: "view", view: "activity" };
  });

  /** The sidebar row of the open conversation: a channel id, or the agent row of the owner's DM. */
  const activeConversationId = createMemo(() => {
    const current = route();
    if (current.kind === "channel") return current.channelId;
    if (current.kind === "agent") return `${AGENT_DM_PREFIX}${current.agentId}`;
    return undefined;
  });

  /** Unread mentions of the reader in each channel, from the activity feed. */
  const mentionCounts = createMemo(() => {
    const counts: Record<string, number> = {};
    for (const item of state.activity.data?.items ?? [])
      if (item.unread && (item.kind === "mention" || item.kind === "reply"))
        counts[item.channelId] = (counts[item.channelId] ?? 0) + 1;
    return counts;
  });

  const sidebarChannelRows = createMemo(() => sidebarChannels(directory(), summaries(), mentionCounts()));
  const sidebarDirectRows = createMemo(() =>
    sidebarDirectMessages({
      directory: directory(),
      summaries: summaries(),
      agentDmIsMainChat: env.agentDmIsMainChat(),
      hiddenAgentIds: env.hiddenAgentIds(),
    }),
  );
  /** The conversations in sidebar order, for Alt+Up and Alt+Down. */
  const conversationOrder = createMemo(() => [
    ...sidebarChannelRows().map((row) => row.id),
    ...sidebarDirectRows().map((row) => row.id),
  ]);

  const activityCount = createMemo(() => (state.activity.data?.items ?? []).filter((item) => item.unread).length);
  const threadsUnread = createMemo(() => (state.activity.data?.threads ?? []).some((thread) => thread.unreadCount > 0));

  const artifactsFallback = createMessageArtifactsSource(directory);
  const hostArtifacts = createHostArtifactsSource({
    port: channels.port,
    directory,
    channels: summaries,
    onHostEvent: env.onHostEvent,
    fallback: artifactsFallback.source,
  });
  const artifacts: WorkspaceArtifactsSource = env.artifacts ?? hostArtifacts.source;
  const fleet: WorkspaceFleetSource =
    env.fleet ??
    createHostFleetSource({
      port: channels.port,
      directory,
      channels: summaries,
      onHostEvent: env.onHostEvent,
      fallback: createLocalFleetSource({
        agents: env.agents,
        agentStates: env.agentStates,
        channels: summaries,
        readerName: () => env.reader().name,
      }),
    });

  // ---------------------------------------------------------------- step trails

  const stepsLoading = new Set<string>();
  const stepTimers = new Map<string, ReturnType<typeof setTimeout>>();
  let stepsUnsupported = false;
  onCleanup(() => {
    for (const timer of stepTimers.values()) clearTimeout(timer);
  });
  async function loadSteps(channelId: string, messageId: string) {
    const read = channels.port().agent.workspaceSteps;
    if (!read || stepsUnsupported || stepsLoading.has(messageId)) return;
    stepsLoading.add(messageId);
    try {
      const steps = await read({ channelId, messageId });
      setState((draft) => {
        draft.steps[messageId] = steps.total > 0 ? steps : null;
      });
    } catch {
      // A host without the steps route keeps the steps the messages show.
      stepsUnsupported = true;
    } finally {
      stepsLoading.delete(messageId);
    }
  }
  /** The host's step trail of an agent message: undefined until it answers, null when it has none. */
  function steps(channelId: string, messageId: string): WorkspaceSteps | null | undefined {
    if (!(messageId in state.steps) && !stepsLoading.has(messageId) && !stepsUnsupported)
      queueMicrotask(() => void loadSteps(channelId, messageId));
    return state.steps[messageId];
  }
  /** A streaming answer reads its steps again, at most every 1.5 s, and once more when it ends. */
  function noteStepsChange(message: ChannelMessage) {
    if (message.author.kind !== "agent" || !(message.id in state.steps)) return;
    const streaming = message.message.status === "streaming";
    clearTimeout(stepTimers.get(message.id));
    stepTimers.set(
      message.id,
      setTimeout(() => void loadSteps(message.channelId, message.id), streaming ? 1_500 : 200),
    );
  }

  // The artifacts of each page the reader opens go to the session list.
  createEffect(
    () => {
      const page = channels.state.page;
      return page ? { id: page.channel.id, name: page.channel.name, count: page.messages.length } : null;
    },
    (current) => {
      if (!current) return;
      const page = untrack(() => channels.state.page);
      if (page) artifactsFallback.note(current.id, current.name, page.messages);
    },
  );

  function setPhonePane(pane: WorkspacePhonePane) {
    if (state.phonePane === pane) return;
    setState((draft) => {
      draft.phonePane = pane;
    });
    env.onPhonePaneChange?.(pane);
  }

  // The shell can open an agent chat from elsewhere, such as a notification or the search. A view
  // the reader had open then gives way, so the chat shows.
  createEffect(env.activeAgentId, (agentId, previous) => {
    if (
      previous !== undefined &&
      agentId !== previous &&
      untrack(() => state.view !== null && !channels.state.selectedId)
    )
      setState((draft) => {
        draft.view = null;
      });
  });

  // A panel of another channel closes when the reader leaves it.
  createEffect(
    () => channels.state.selectedId,
    (channelId) => {
      const panel = untrack(() => state.panel);
      if (panel && panel.channelId !== channelId)
        setState((draft) => {
          draft.panel = null;
          draft.thread = null;
          if (draft.phonePane === "panel") draft.phonePane = "main";
        });
    },
  );

  // Drafts follow the reader and the server.
  createEffect(env.storageKey, (key, previous) => {
    if (previous === undefined || key === previous) return;
    setState((draft) => {
      draft.drafts = readDrafts(key);
      draft.settings = null;
      draft.activity = { data: null, loading: false, failed: false };
    });
    void refreshActivity();
  });
  let draftTimer: ReturnType<typeof setTimeout> | undefined;
  onCleanup(() => {
    if (draftTimer) {
      clearTimeout(draftTimer);
      writeDrafts(env.storageKey(), state.drafts);
    }
  });

  // ---------------------------------------------------------------- activity

  let activityRun = 0;
  let activityTimer: ReturnType<typeof setTimeout> | undefined;
  onCleanup(() => clearTimeout(activityTimer));
  async function refreshActivity(): Promise<void> {
    const port = channels.port().agent;
    if (!port.workspaceActivity || !channels.supported()) return;
    const run = ++activityRun;
    setState((draft) => {
      draft.activity.loading = true;
    });
    try {
      const data = await port.workspaceActivity({ limit: 100 });
      if (run !== activityRun) return;
      setState((draft) => {
        draft.activity = { data, loading: false, failed: false };
      });
    } catch {
      if (run !== activityRun) return;
      setState((draft) => {
        draft.activity.loading = false;
        draft.activity.failed = true;
      });
    }
  }
  function scheduleActivity(delay = 1_500) {
    clearTimeout(activityTimer);
    activityTimer = setTimeout(() => void refreshActivity(), delay);
  }
  createEffect(
    () => channels.supported() && env.connectionReady(),
    (ready) => {
      if (ready) void refreshActivity();
    },
  );

  // ---------------------------------------------------------------- live events

  async function loadThread(channelId: string, rootId: string, quiet = false): Promise<void> {
    if (!quiet)
      setState((draft) => {
        draft.thread = { channelId, rootId, page: null, loading: true, error: null };
      });
    try {
      const page = await channels.port().agent.readChannel({ channelId, threadRootId: rootId });
      const current = state.thread;
      if (current?.channelId !== channelId || current.rootId !== rootId) return;
      setState((draft) => {
        if (draft.thread) Object.assign(draft.thread, { page, loading: false, error: null });
      });
    } catch (error) {
      const current = state.thread;
      if (current?.channelId !== channelId || current.rootId !== rootId) return;
      const text = currentText();
      setState((draft) => {
        if (draft.thread)
          Object.assign(draft.thread, {
            loading: false,
            error: text.errorMessage(error, text.t("workspace.app.thread.loadFailed")),
          });
      });
    }
  }

  function patchThread(message: ChannelMessage) {
    const thread = state.thread;
    if (!thread?.page || thread.channelId !== message.channelId) return;
    if (message.id !== thread.rootId && message.threadRootId !== thread.rootId) return;
    setState((draft) => {
      const page = draft.thread?.page;
      if (!page) return;
      const index = page.messages.findIndex((entry) => entry.id === message.id);
      if (index >= 0) page.messages[index] = message;
      else {
        let at = page.messages.length;
        while (at > 1 && (page.messages[at - 1]?.sequence ?? 0) > message.sequence) at -= 1;
        page.messages.splice(at, 0, message);
      }
      if (message.sequence > page.throughSequence) page.throughSequence = message.sequence;
    });
  }

  const unsubscribe = env.onHostEvent((event) => {
    if (event.type === "channel-message") {
      channels.applyMessage(event.message, event.revision);
      patchThread(event.message);
      noteStepsChange(event.message);
      const author = event.message.author;
      if (!(author.kind === "member" && env.isReader(author.id))) scheduleActivity();
      return;
    }
    if (event.type === "channel-message-removed") {
      channels.removeMessage(event.channelId, event.messageId, event.revision);
      const thread = state.thread;
      if (thread?.page && thread.channelId === event.channelId)
        setState((draft) => {
          const page = draft.thread?.page;
          if (!page) return;
          const index = page.messages.findIndex((entry) => entry.id === event.messageId);
          if (index >= 0) page.messages.splice(index, 1);
        });
      scheduleActivity();
    }
  });
  onCleanup(unsubscribe);

  // ---------------------------------------------------------------- navigation

  function openChannel(channelId: string) {
    setState((draft) => {
      draft.view = null;
      draft.editing = null;
      if (draft.panel && draft.panel.channelId !== channelId) {
        draft.panel = null;
        draft.thread = null;
      }
    });
    setPhonePane("main");
    if (channels.state.selectedId !== channelId) void channels.open(channelId);
  }

  function existingDm(memberIds: readonly string[], agentIds: readonly string[]): ChannelSummary | undefined {
    const people = new Set(memberIds);
    const agents = new Set(agentIds);
    return summaries().find((channel) => {
      if (channel.archived || channelKind(channel) === "channel" || !readerJoined(directory(), channel)) return false;
      const others = humanIds(channel).filter((id) => !env.isReader(id));
      return (
        others.length === people.size &&
        others.every((id) => people.has(id)) &&
        channel.members.length === agents.size &&
        channel.members.every((member) => agents.has(member.agentId))
      );
    });
  }

  function openAgent(agentId: string) {
    if (env.agentDmIsMainChat()) {
      channels.close();
      setState((draft) => {
        draft.view = null;
        draft.panel = null;
        draft.thread = null;
        draft.editing = null;
      });
      setPhonePane("main");
      env.openAgentChat(agentId);
      return;
    }
    const dm = existingDm([], [agentId]);
    if (dm) openChannel(dm.id);
    else void startDm([agentId]);
  }

  /** Opens a sidebar row: a channel, a DM or group channel, or an agent. */
  function openConversation(id: string) {
    if (id.startsWith(AGENT_DM_PREFIX)) openAgent(id.slice(AGENT_DM_PREFIX.length));
    else openChannel(id);
  }

  function openView(view: WorkspaceView) {
    channels.close();
    setState((draft) => {
      draft.view = view;
      draft.panel = null;
      draft.thread = null;
      draft.editing = null;
    });
    setPhonePane("main");
    if (view === "activity" || view === "threads") void refreshActivity();
    if (view === "fleet") fleet.refresh?.();
    if (view === "artifacts") artifacts.refresh?.();
  }

  function moveConversation(delta: number) {
    const order = conversationOrder();
    if (!order.length) return;
    const current = activeConversationId();
    const index = current ? order.indexOf(current) : -1;
    const next = order[(index + delta + order.length) % order.length];
    if (next) openConversation(next);
  }

  function openThread(channelId: string, rootId: string) {
    if (channels.state.selectedId !== channelId) openChannel(channelId);
    setState((draft) => {
      draft.panel = { kind: "thread", channelId, rootId };
    });
    setPhonePane("panel");
    void loadThread(channelId, rootId);
  }

  function openDetails(channelId: string, tab: ChannelDetailsTab = "about") {
    setState((draft) => {
      draft.panel = { kind: "details", channelId, tab };
      draft.thread = null;
    });
    setPhonePane("panel");
  }

  function openArtifactsPanel(channelId: string) {
    setState((draft) => {
      draft.panel = { kind: "artifacts", channelId };
      draft.thread = null;
    });
    setPhonePane("panel");
  }

  function closePanel() {
    setState((draft) => {
      draft.panel = null;
      draft.thread = null;
    });
    if (state.phonePane === "panel") setPhonePane("main");
  }

  /** The back button of a phone pane: the panel goes back to the conversation, the conversation to the list. */
  function back() {
    if (state.phonePane === "panel") closePanel();
    else setPhonePane("sidebar");
  }

  function openDialog(dialog: WorkspaceDialog | null) {
    setState((draft) => {
      draft.dialog = dialog;
    });
  }

  /** Marks the open channel read through its newest message and lets the "new" divider go. */
  function markRead() {
    const page = channels.state.page;
    if (!page || !env.connectionReady()) return;
    channels.releaseUnread();
    void channels.port().agent.channelCommand({
      type: "read",
      channelId: page.channel.id,
      throughSequence: page.throughSequence,
      operationId: crypto.randomUUID(),
    });
  }

  // ---------------------------------------------------------------- drafts

  function draft(key: string): string {
    return state.drafts[key] ?? "";
  }

  function setDraft(key: string, text: string) {
    setState((draft) => {
      if (text) draft.drafts[key] = text;
      else delete draft.drafts[key];
    });
    clearTimeout(draftTimer);
    draftTimer = setTimeout(() => {
      draftTimer = undefined;
      writeDrafts(env.storageKey(), state.drafts);
    }, 400);
  }

  // ---------------------------------------------------------------- commands

  /** Sends a workspace command and refreshes the list after it. A failure throws. */
  async function command(input: WorkspaceChannelCommand | ChannelCommand) {
    const channel = await channels.port().agent.channelCommand(input);
    void channels.refresh();
    return channel;
  }

  /** As `command`, with a toast on failure. */
  async function run(input: WorkspaceChannelCommand, fallback: Parameters<typeof failureToast>[1]): Promise<boolean> {
    try {
      await command(input);
      return true;
    } catch (error) {
      failureToast(error, fallback);
      return false;
    }
  }

  async function workspaceSettings(): Promise<WorkspaceSettings | null> {
    if (state.settings) return state.settings;
    if (!env.workspaceSettings || env.reader().role === "member") return null;
    try {
      const settings = await env.workspaceSettings();
      setState((draft) => {
        draft.settings = settings;
      });
      return settings;
    } catch {
      return null;
    }
  }

  /** How an agent added to a channel answers: its own default, else the workspace default. */
  async function newMember(agentId: string): Promise<ChannelMember> {
    const settings = await workspaceSettings();
    const own = agentChannelDefaults(settings, agentId);
    const answerMode = own.answerMode ?? settings?.defaults.agentAnswerMode ?? "mention";
    return { agentId, answerMode, ...(own?.focus ? { focus: own.focus } : {}) };
  }

  async function send(input: {
    channelId: string;
    text: string;
    attachmentDraftIds: string[];
    threadRootId?: string | null;
    alsoToChannel?: boolean;
  }): Promise<void> {
    if (!env.connectionReady()) throw new Error(currentText().t("workspace.app.composer.offline"));
    const mention = chatTagReferences(input.text).find(
      (reference) => reference.kind === "agent" && !input.text.slice(0, reference.start).trim(),
    );
    await channels.send({
      type: "send",
      operationId: crypto.randomUUID(),
      channelId: input.channelId,
      text: input.text,
      recipientAgentId: input.threadRootId ? null : (mention?.id ?? null),
      replyToMessageId: null,
      attachmentDraftIds: input.attachmentDraftIds,
      ...(input.threadRootId ? { threadRootId: input.threadRootId } : {}),
      ...(input.threadRootId && input.alsoToChannel ? { alsoToChannel: true } : {}),
    });
    if (input.threadRootId && state.thread?.rootId === input.threadRootId)
      void loadThread(input.channelId, input.threadRootId, true);
    scheduleActivity(3_000);
  }

  function findMessage(channelId: string, messageId: string): ChannelMessage | undefined {
    const page = channels.state.page;
    const inPage = page?.channel.id === channelId ? page.messages.find((entry) => entry.id === messageId) : undefined;
    if (inPage) return inPage;
    const thread = state.thread?.page;
    return thread?.channel.id === channelId ? thread.messages.find((entry) => entry.id === messageId) : undefined;
  }

  /** Adds the reader's reaction, or takes it off. The bar changes at once; a failure puts it back. */
  async function toggleReaction(channelId: string, messageId: string, emoji: string) {
    const message = findMessage(channelId, messageId);
    if (!message) return;
    const reacted = readerReacted(directory(), message.reactions, emoji);
    const readerId = env.reader().id ?? "local";
    const reactions = (message.reactions ?? [])
      .map((reaction) =>
        reaction.emoji !== emoji
          ? reaction
          : {
              ...reaction,
              actors: reacted
                ? reaction.actors.filter((actor) => !(actor.kind === "member" && env.isReader(actor.id)))
                : [...reaction.actors, { kind: "member" as const, id: readerId }],
            },
      )
      .filter((reaction) => reaction.actors.length > 0);
    if (!reacted && !reactions.some((reaction) => reaction.emoji === emoji))
      reactions.push({ emoji, actors: [{ kind: "member", id: readerId }] });
    const optimistic: ChannelMessage = { ...message, reactions };
    channels.applyMessage(optimistic, 0);
    patchThread(optimistic);
    try {
      await channels.port().agent.channelCommand({
        type: "react",
        operationId: crypto.randomUUID(),
        channelId,
        messageId,
        emoji,
        action: reacted ? "remove" : "add",
      });
    } catch (error) {
      channels.applyMessage(message, 0);
      patchThread(message);
      failureToast(error, "workspace.app.error.react");
    }
  }

  function startEditing(channelId: string, messageId: string, threadRootId: string | null) {
    setState((draft) => {
      draft.editing = { channelId, messageId, threadRootId };
    });
  }

  function stopEditing() {
    setState((draft) => {
      draft.editing = null;
    });
  }

  async function editMessage(channelId: string, messageId: string, text: string): Promise<void> {
    await channels.port().agent.channelCommand({
      type: "edit",
      operationId: crypto.randomUUID(),
      channelId,
      messageId,
      text,
    });
    stopEditing();
  }

  async function deleteMessage(channelId: string, messageId: string): Promise<boolean> {
    return run(
      { type: "delete", operationId: crypto.randomUUID(), channelId, messageId },
      "workspace.app.error.delete",
    );
  }

  async function createChannel(input: {
    name: string;
    description: string;
    visibility: "public" | "private";
    memberIds: string[];
  }): Promise<void> {
    const agents = new Set(env.agents().map((agent) => agent.id));
    const members = await Promise.all(input.memberIds.filter((id) => agents.has(id)).map(newMember));
    const channelId = crypto.randomUUID();
    await command({
      type: "create",
      operationId: crypto.randomUUID(),
      channelId,
      kind: "channel",
      visibility: input.visibility,
      name: slugChannelName(input.name),
      ...(input.description ? { description: input.description } : {}),
      humanMemberIds: input.memberIds.filter((id) => !agents.has(id)),
      members,
    });
    await channels.refresh();
    openChannel(channelId);
  }

  /** Opens the DM or group with these people and agents, and makes it when it does not exist. */
  async function startDm(memberIds: readonly string[]): Promise<void> {
    const agents = new Set(env.agents().map((agent) => agent.id));
    const agentIds = memberIds.filter((id) => agents.has(id));
    const people = memberIds.filter((id) => !agents.has(id));
    if (env.agentDmIsMainChat() && people.length === 0 && agentIds.length === 1 && agentIds[0]) {
      openAgent(agentIds[0]);
      return;
    }
    const existing = existingDm(people, agentIds);
    if (existing) {
      openChannel(existing.id);
      return;
    }
    try {
      const channel = await command({
        type: "open-dm",
        operationId: crypto.randomUUID(),
        channelId: crypto.randomUUID(),
        memberIds: people,
        agentIds,
      });
      await channels.refresh();
      openChannel(channel.id);
    } catch (error) {
      failureToast(error, "workspace.app.error.openDm");
      throw error;
    }
  }

  async function join(channelId: string): Promise<void> {
    if (await run({ type: "join", operationId: crypto.randomUUID(), channelId }, "workspace.app.error.join")) {
      await channels.refresh();
      openChannel(channelId);
    }
  }

  async function leave(channelId: string): Promise<void> {
    if (await run({ type: "leave", operationId: crypto.randomUUID(), channelId }, "workspace.app.error.leave")) {
      closePanel();
      channels.close();
      openView("activity");
    }
  }

  async function archive(channelId: string): Promise<void> {
    try {
      await channels.remove(channelId);
      closePanel();
      openView("activity");
    } catch (error) {
      failureToast(error, "workspace.app.error.archive");
    }
  }

  async function invite(channelId: string, memberIds: readonly string[]): Promise<boolean> {
    const agents = new Set(env.agents().map((agent) => agent.id));
    const members = await Promise.all(memberIds.filter((id) => agents.has(id)).map(newMember));
    return run(
      {
        type: "invite",
        operationId: crypto.randomUUID(),
        channelId,
        humanMemberIds: memberIds.filter((id) => !agents.has(id)),
        members,
      },
      "workspace.app.error.invite",
    );
  }

  async function removeMember(channelId: string, memberId: string): Promise<boolean> {
    const agent = env.agents().some((candidate) => candidate.id === memberId);
    return run(
      {
        type: "remove",
        operationId: crypto.randomUUID(),
        channelId,
        humanMemberIds: agent ? [] : [memberId],
        agentIds: agent ? [memberId] : [],
      },
      "workspace.app.error.remove",
    );
  }

  async function setMember(
    channelId: string,
    agentId: string,
    change: { answerMode?: AgentAnswerMode; focus?: string },
  ) {
    return run(
      {
        type: "set-member",
        operationId: crypto.randomUUID(),
        channelId,
        agentId,
        ...(change.answerMode ? { answerMode: change.answerMode } : {}),
        ...(change.focus !== undefined ? { focus: change.focus || null } : {}),
      },
      "workspace.app.error.member",
    );
  }

  async function setMeta(channelId: string, change: { name?: string; topic?: string; description?: string }) {
    return run(
      { type: "set-meta", operationId: crypto.randomUUID(), channelId, ...change },
      "workspace.app.error.meta",
    );
  }

  async function linkDiscord(channelId: string, connectionId: string, discordChannelId: string) {
    return run(
      { type: "link-discord", operationId: crypto.randomUUID(), channelId, connectionId, discordChannelId },
      "workspace.app.error.discord",
    );
  }

  async function unlinkDiscord(channelId: string) {
    return run({ type: "unlink-discord", operationId: crypto.randomUUID(), channelId }, "workspace.app.error.discord");
  }

  /** The DM channel of a person or an agent, for the profile's Message button. */
  function messageMember(memberId: string) {
    const agent = env.agents().some((candidate) => candidate.id === memberId);
    if (agent) openAgent(memberId);
    else {
      const existing = existingDm([memberId], []);
      if (existing) openChannel(existing.id);
      else void startDm([memberId]).catch(() => undefined);
    }
  }

  /** Whether the reader may manage the channel: owners and admins, and the person who made it. */
  function canManage(channel: { createdBy?: { kind: string; id: string } | undefined }) {
    const role = env.reader().role;
    if (role === "owner" || role === "admin") return true;
    return channel.createdBy?.kind === "member" && env.isReader(channel.createdBy.id);
  }

  return {
    env,
    state,
    channels,
    directory,
    route,
    activeConversationId,
    summary,
    sidebarChannels: sidebarChannelRows,
    sidebarDirectMessages: sidebarDirectRows,
    activityCount,
    threadsUnread,
    fleet,
    artifacts,
    artifactRecord: hostArtifacts.record,
    steps,
    soleAgent: (channel: Parameters<typeof soleAgentOf>[1]) => soleAgentOf(directory(), channel),
    canManage,
    isAdmin: () => env.reader().role !== "member",
    setPhonePane,
    openChannel,
    openAgent,
    openConversation,
    openView,
    moveConversation,
    openThread,
    reloadThread: () => {
      const thread = state.thread;
      if (thread) void loadThread(thread.channelId, thread.rootId);
    },
    openDetails,
    openArtifactsPanel,
    closePanel,
    back,
    openDialog,
    markRead,
    draft,
    setDraft,
    refreshActivity,
    send,
    toggleReaction,
    startEditing,
    stopEditing,
    editMessage,
    deleteMessage,
    createChannel,
    startDm,
    join,
    leave,
    archive,
    invite,
    removeMember,
    setMember,
    setMeta,
    linkDiscord,
    unlinkDiscord,
    messageMember,
    workspaceSettings,
  };
}
