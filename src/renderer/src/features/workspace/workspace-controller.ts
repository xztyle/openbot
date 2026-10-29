/*
 * The workspace controller: which conversation or view is open, which right panel shows, the open
 * thread, the drafts, the activity feed, and every workspace command. The desktop and the browser
 * client build it from their own environment and mount the same view on it.
 */

import { chatTagReferences } from "@openbot/contracts/chat-tag-references";
import {
  type AgentApproval,
  type AgentEvent,
  type BrowserTakeoverRequest,
  CHANNEL_TYPING_INTERVAL_MS,
  type ChannelCommand,
  type ChannelMember,
  type ChannelMessage,
  type ChannelPage,
  type ChannelSummary,
  type ChannelTypingEntry,
  channelKind,
  isChannelAnswerMode,
  type TeamRealtimeEvent,
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
import { QUICK_REACTIONS, type ReactionEmojiPicker } from "@openbot/ui/features/workspace/MessageRow";
import type { WorkspaceView } from "@openbot/ui/features/workspace/WorkspaceSidebar";
import { slugChannelName } from "@openbot/ui/features/workspace/workspace-format";
import type { AgentAnswerMode, WorkspaceMenuItem } from "@openbot/ui/features/workspace/workspace-types";
import { currentText } from "@openbot/ui/text";
import { createEffect, createMemo, createStore, onCleanup, untrack } from "solid-js";
import { actionToast } from "../../action-toast";
import type { ChannelsController } from "../channels/channels-controller";
import type { MessagingApi } from "../connectors/messaging-connector";
import type { StorageHygieneCalls } from "../storage-hygiene/storage-hygiene-port";
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
  /**
   * Who types, thinks or works in each channel, from the host's `channel-typing` events. A channel
   * with no event yet is absent: its page and the gate marks of its messages say it then.
   */
  typing: Record<string, ChannelTypingEntry[]>;
  /** The agents the reader may open a DM with, as the host says. Null: the host does not say. */
  dmAgentIds: string[] | null;
  /** The first-run hints the reader closed, on this computer. */
  hintsSeen: Record<string, true>;
  /** `ensure-general` runs. */
  creatingGeneral: boolean;
  /** The reader opened an agent's chat in this session: a new workspace then shows it, not the welcome. */
  agentChosen: boolean;
  /** The reader's own sidebar: the order they dragged the rows into and the muted conversations. */
  sidebar: SidebarPrefs;
  /** The text that filters the sidebar rows. */
  sidebarFilter: string;
  /** The emoji the reader used last, newest first, and their skin tone (0: none). On this computer. */
  emoji: { recent: string[]; skinTone: number };
}

interface SidebarPrefs {
  order: { channels: string[]; direct: string[] };
  muted: string[];
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
  onHostEvent: (listener: (event: AgentEvent | TeamRealtimeEvent) => void) => () => void;
  /** Every approval that waits on the host. A channel shows the ones of its own work. */
  approvals?: (() => readonly AgentApproval[]) | undefined;
  /** Every browser takeover that waits on the host. A channel shows the ones of its own work. */
  takeovers?: (() => readonly BrowserTakeoverRequest[]) | undefined;
  /** Whether the host is this computer: a browser secret can then be saved to the Vault. */
  localHost?: (() => boolean) | undefined;
  /** Opens the browser tab of a takeover, where the shell has the browser. */
  openBrowserTab?: ((tabId: string) => void) | undefined;
  /** The Discord connections of the host, for the channel's Integrations tab. */
  messaging?: (() => MessagingApi | undefined) | undefined;
  /** The workspace settings of the host. Only owners and admins may read them. */
  workspaceSettings?: (() => Promise<WorkspaceSettings>) | undefined;
  /** A host fleet endpoint. Absent, the fleet comes from the agent list and its runtime state. */
  fleet?: WorkspaceFleetSource | undefined;
  /** A host artifacts index. Absent, the artifacts come from the messages this client read. */
  artifacts?: WorkspaceArtifactsSource | undefined;
  /** The storage hygiene calls of the host, for an owner or admin. Absent, there is no Storage view. */
  storageHygiene?: (() => StorageHygieneCalls | undefined) | undefined;
  /** Opens Server settings > Storage, where the cleanup rules are. */
  openStorageRules?: (() => void) | undefined;
  /** Opens the form of a new agent. */
  createAgent?: (() => void) | undefined;
  /** Opens the invitation of people to the server. */
  inviteTeammates?: (() => void) | undefined;
  /** The id of the host in message links: a link to another host opens as a plain link. */
  hostId?: (() => string | null) | undefined;
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
const HINTS_KEY = "openbot.workspace.hints.v1";

const SIDEBAR_KEY = "openbot.workspace.sidebar.v1";
const EMOJI_KEY = "openbot.workspace.emoji.v1";
const RECENT_EMOJI_LIMIT = 24;

function readEmoji(): { recent: string[]; skinTone: number } {
  try {
    const value = JSON.parse(window.localStorage.getItem(EMOJI_KEY) ?? "{}");
    if (!isDynamicRecord(value)) return { recent: [], skinTone: 0 };
    const tone = typeof value.skinTone === "number" && value.skinTone >= 0 && value.skinTone <= 5 ? value.skinTone : 0;
    return { recent: idList(value.recent).slice(0, RECENT_EMOJI_LIMIT), skinTone: Math.round(tone) };
  } catch {
    return { recent: [], skinTone: 0 };
  }
}

function idList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string").slice(0, 500) : [];
}

/** The reader's sidebar order and mutes on this computer, per reader and server. */
function readSidebar(key: string): SidebarPrefs {
  try {
    const value = JSON.parse(window.localStorage.getItem(`${SIDEBAR_KEY}:${key}`) ?? "{}");
    if (!isDynamicRecord(value)) return { order: { channels: [], direct: [] }, muted: [] };
    const order = isDynamicRecord(value.order) ? value.order : {};
    return { order: { channels: idList(order.channels), direct: idList(order.direct) }, muted: idList(value.muted) };
  } catch {
    return { order: { channels: [], direct: [] }, muted: [] };
  }
}

/** Rows in the reader's order: the ones they placed first, in their order, then the others as they come. */
function inOrder<Row extends { id: string }>(rows: Row[], order: readonly string[]): Row[] {
  if (!order.length) return rows;
  const place = new Map(order.map((id, index) => [id, index]));
  return rows
    .map((row, index) => ({ row, index, at: place.get(row.id) }))
    .sort((left, right) =>
      left.at !== undefined && right.at !== undefined
        ? left.at - right.at
        : left.at !== undefined
          ? -1
          : right.at !== undefined
            ? 1
            : left.index - right.index,
    )
    .map((entry) => entry.row);
}

/** The hints the reader closed. They are the same on every server of this computer. */
function readHints(): Record<string, true> {
  try {
    const value = JSON.parse(window.localStorage.getItem(HINTS_KEY) ?? "{}");
    if (!isDynamicRecord(value)) return {};
    return Object.fromEntries(Object.keys(value).map((key) => [key, true as const]));
  } catch {
    return {};
  }
}
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

function sameRecord(left: Readonly<Record<string, string>>, right: Readonly<Record<string, string>>): boolean {
  const keys = Object.keys(left);
  return keys.length === Object.keys(right).length && keys.every((key) => left[key] === right[key]);
}

function samePeople(left: readonly WorkspacePerson[], right: readonly WorkspacePerson[]): boolean {
  return (
    left.length === right.length &&
    left.every((person, index) => {
      const other = right[index];
      return (
        other !== undefined &&
        person.id === other.id &&
        person.name === other.name &&
        person.avatarUrl === other.avatarUrl &&
        person.role === other.role &&
        person.online === other.online
      );
    })
  );
}

function sameAgentStates(
  left: Readonly<Record<string, SidebarAgentState>>,
  right: Readonly<Record<string, SidebarAgentState>>,
): boolean {
  const keys = Object.keys(left);
  return (
    keys.length === Object.keys(right).length &&
    keys.every((key) => left[key] === right[key] || JSON.stringify(left[key]) === JSON.stringify(right[key]))
  );
}

/**
 * The directory changes only when what it says changes. The roster and the agent states are built
 * again on each presence or turn event; every row on screen reads the directory.
 */
function sameDirectory(left: WorkspaceDirectory, right: WorkspaceDirectory): boolean {
  return (
    left.agents === right.agents &&
    left.isReader === right.isReader &&
    left.reader.id === right.reader.id &&
    left.reader.name === right.reader.name &&
    left.reader.avatarUrl === right.reader.avatarUrl &&
    left.names === right.names &&
    samePeople(left.people, right.people) &&
    sameAgentStates(left.agentStates, right.agentStates)
  );
}

function failureToast(error: unknown, fallback: AppTextKey): void {
  const text = currentText();
  actionToast.error(text.errorMessage(error, text.t(fallback)), {
    report: { operation: "other", source: "action", cause_code: "unknown" },
  });
}

/** A link to a workspace message: `openbot://workspace/<host>/<channel>/<message>` or `…#ws=<host>/<channel>/<message>`. */
export interface WorkspaceMessageLink {
  hostId: string;
  channelId: string;
  /** The message, or the root of its thread. */
  messageId: string;
}

export const DESKTOP_MESSAGE_LINK_PREFIX = "openbot://workspace/";

/** The desktop's message link. The app opens it in place; the web client writes `#ws=` links. */
export function desktopMessageLink(hostId: string, channelId: string, messageId: string): string {
  return `${DESKTOP_MESSAGE_LINK_PREFIX}${encodeURIComponent(hostId)}/${encodeURIComponent(channelId)}/${encodeURIComponent(messageId)}`;
}

export function parseMessageLink(url: string): WorkspaceMessageLink | null {
  const path = url.startsWith(DESKTOP_MESSAGE_LINK_PREFIX)
    ? url.slice(DESKTOP_MESSAGE_LINK_PREFIX.length)
    : /#ws=(.+)$/u.exec(url)?.[1];
  const parts = path?.split("/");
  if (parts?.length !== 3 || parts.some((part) => !part)) return null;
  try {
    const [hostId, channelId, messageId] = parts.map((part) => decodeURIComponent(part));
    return hostId && channelId && messageId ? { hostId, channelId, messageId } : null;
  } catch {
    return null;
  }
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
    typing: {},
    dmAgentIds: null,
    hintsSeen: readHints(),
    creatingGeneral: false,
    agentChosen: false,
    sidebar: untrack(() => readSidebar(env.storageKey())),
    sidebarFilter: "",
    emoji: readEmoji(),
  });

  /**
   * The names that the channel messages carry for their people, for the people the roster lacks.
   * Each live message reads the page again; the same names keep the same directory, so the rows on
   * screen do not build their authors, reactions and mentions again for each message.
   */
  const names = createMemo(
    () => {
      const found: Record<string, string> = {};
      for (const channel of channels.state.channels) {
        const last = channel.lastMessage;
        if (last?.author?.kind === "member") found[last.author.id] = last.authorName;
      }
      for (const entry of channels.state.page?.messages ?? [])
        if (entry.author.kind === "member" && !entry.externalAuthor) found[entry.author.id] = entry.author.name;
      for (const item of state.activity.data?.items ?? [])
        if (item.actor.kind === "member") found[item.actor.id] = item.actor.name;
      return found;
    },
    { equals: sameRecord },
  );
  const directory = createMemo(
    (): WorkspaceDirectory => ({
      agents: env.agents(),
      people: env.people(),
      isReader: env.isReader,
      reader: env.reader(),
      agentStates: env.agentStates(),
      names: names(),
    }),
    { equals: sameDirectory },
  );

  const summaries = () => channels.state.channels;
  const summary = (channelId: string): ChannelSummary | undefined =>
    channels.state.channels.find((channel) => channel.id === channelId);

  /** The workspace has no channel yet: the welcome shows. */
  const workspaceEmpty = createMemo(
    () =>
      channels.supported() &&
      channels.state.listed &&
      !summaries().some((channel) => !channel.archived && channelKind(channel) === "channel"),
  );
  const route = createMemo((): WorkspaceRoute => {
    const channelId = channels.state.selectedId;
    if (channelId) return { kind: "channel", channelId };
    if (state.view) return { kind: "view", view: state.view };
    const agentId = env.activeAgentId();
    if (agentId && env.agentDmIsMainChat() && (state.agentChosen || !workspaceEmpty()))
      return { kind: "agent", agentId };
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

  // ---------------------------------------------------------------- DM eligibility

  let dmAgentsRun = 0;
  async function refreshDmAgents() {
    const read = channels.port().agent.workspaceDmAgents;
    if (!read || !channels.supported() || !env.connectionReady()) return;
    const run = ++dmAgentsRun;
    try {
      const { agentIds } = await read();
      if (run === dmAgentsRun)
        setState((draft) => {
          draft.dmAgentIds = agentIds;
        });
    } catch {
      // A host without the route lets the reader message each agent the list shows.
    }
  }
  // The list follows the agents: an agent added, hidden or shared reads it again.
  createEffect(
    () => ({
      ready: channels.supported() && env.connectionReady(),
      agents: env
        .agents()
        .map((agent) => agent.id)
        .join(","),
      key: env.storageKey(),
    }),
    (current, previous) => {
      if (previous && current.key !== previous.key)
        setState((draft) => {
          draft.dmAgentIds = null;
        });
      if (current.ready) void refreshDmAgents();
    },
  );
  const dmAgentSet = createMemo(() => (state.dmAgentIds ? new Set(state.dmAgentIds) : null));
  /** Whether the reader may open a DM with an agent, or add it: the host's list, or every agent it shows. */
  const canMessageAgent = (agentId: string) => dmAgentSet()?.has(agentId) ?? true;

  const mutedSet = createMemo(() => new Set(state.sidebar.muted));
  const filterText = () => state.sidebarFilter.trim().toLocaleLowerCase();
  const allChannelRows = createMemo(() =>
    inOrder(
      sidebarChannels(directory(), summaries(), mentionCounts()).map((row) =>
        mutedSet().has(row.id) ? { ...row, muted: true } : row,
      ),
      state.sidebar.order.channels,
    ),
  );
  const allDirectRows = createMemo(() =>
    inOrder(
      sidebarDirectMessages({
        directory: directory(),
        summaries: summaries(),
        agentDmIsMainChat: env.agentDmIsMainChat(),
        hiddenAgentIds: env.hiddenAgentIds(),
        dmAgentIds: dmAgentSet(),
      }).map((row) => (mutedSet().has(row.id) ? { ...row, muted: true } : row)),
      state.sidebar.order.direct,
    ),
  );
  const sidebarChannelRows = createMemo(() => {
    const filter = filterText();
    return filter ? allChannelRows().filter((row) => row.name.toLocaleLowerCase().includes(filter)) : allChannelRows();
  });
  const sidebarDirectRows = createMemo(() => {
    const filter = filterText();
    return filter
      ? allDirectRows().filter((row) => row.members.some((member) => member.name.toLocaleLowerCase().includes(filter)))
      : allDirectRows();
  });

  function saveSidebar() {
    try {
      window.localStorage.setItem(`${SIDEBAR_KEY}:${env.storageKey()}`, JSON.stringify(state.sidebar));
    } catch {
      // The order and the mutes stay for this session.
    }
  }
  /** The reader dragged or moved a row: the group keeps this order on this computer. */
  function reorderSidebar(group: "channels" | "direct", ids: string[]) {
    setState((draft) => {
      draft.sidebar.order[group] = ids;
    });
    saveSidebar();
  }
  /** Moves a row one place up or down in its group, the keyboard's way to reorder. */
  function moveSidebarRow(group: "channels" | "direct", id: string, delta: number) {
    const ids = (group === "channels" ? allChannelRows() : allDirectRows()).map((row) => row.id);
    const from = ids.indexOf(id);
    const to = from + delta;
    if (from < 0 || to < 0 || to >= ids.length) return;
    ids.splice(from, 1);
    ids.splice(to, 0, id);
    reorderSidebar(group, ids);
  }
  /** A muted conversation stays in the list but shows no unread mark. Only on this computer. */
  function setMuted(id: string, muted: boolean) {
    setState((draft) => {
      const others = draft.sidebar.muted.filter((item) => item !== id);
      draft.sidebar.muted = muted ? [...others, id] : others;
    });
    saveSidebar();
  }
  function saveEmoji() {
    try {
      window.localStorage.setItem(EMOJI_KEY, JSON.stringify(state.emoji));
    } catch {
      // The recent emoji stay for this session.
    }
  }
  /** An emoji the reader picked goes first in Recent. */
  function noteEmoji(emoji: string) {
    setState((draft) => {
      draft.emoji.recent = [emoji, ...draft.emoji.recent.filter((item) => item !== emoji)].slice(0, RECENT_EMOJI_LIMIT);
    });
    saveEmoji();
  }
  function setSkinTone(tone: number) {
    setState((draft) => {
      draft.emoji.skinTone = tone;
    });
    saveEmoji();
  }

  /** The quick reactions: the reader's recent emoji first, then Slack's frequent ones. */
  const quickReactions = createMemo(
    () => [...new Set([...state.emoji.recent, ...QUICK_REACTIONS])].slice(0, QUICK_REACTIONS.length),
    { equals: (left, right) => left.length === right.length && left.every((emoji, index) => emoji === right[index]) },
  );
  /** The full picker of the reactions, with one object while its fields stay the same. */
  const reactionPicker: ReactionEmojiPicker = {
    get recent() {
      return state.emoji.recent;
    },
    get skinTone() {
      return state.emoji.skinTone;
    },
    onSkinToneChange: (tone: number) => setSkinTone(tone),
  };

  function setSidebarFilter(text: string) {
    setState((draft) => {
      draft.sidebarFilter = text;
    });
  }
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
    // The first agent the shell selects is not a choice of the reader; a later switch is.
    if (previous && agentId && agentId !== previous && !untrack(() => state.agentChosen))
      setState((draft) => {
        draft.agentChosen = true;
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
      draft.sidebar = readSidebar(key);
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
    if (event.type === "channel-typing") {
      setState((draft) => {
        draft.typing[event.channelId] = event.typing;
      });
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

  // ---------------------------------------------------------------- typing

  /** The typing signals this client sent, per conversation or thread. */
  const ownTyping = new Map<
    string,
    { channelId: string; threadRootId: string | null; sentAt: number; idle: ReturnType<typeof setTimeout> }
  >();
  /** A person who stops typing for this long stops showing as typing, before the host's timeout. */
  const TYPING_IDLE_MS = 5_000;

  function sendTyping(channelId: string, threadRootId: string | null, typing: boolean) {
    const signal = channels.port().agent.channelTyping;
    if (!signal || !env.connectionReady()) return;
    void signal({ channelId, ...(threadRootId ? { threadRootId } : {}), typing }).catch(() => undefined);
  }

  /**
   * The reader typed in a composer (`typing`), or emptied it, sent it or left it. The host hears it
   * at most every `CHANNEL_TYPING_INTERVAL_MS` while the reader types, and once when they stop.
   */
  function noteTyping(channelId: string, threadRootId: string | null, typing: boolean, sent = false) {
    const key = draftKey(channelId, threadRootId);
    const current = ownTyping.get(key);
    if (!typing) {
      if (!current) return;
      clearTimeout(current.idle);
      ownTyping.delete(key);
      // A sent message ends the typing on the host by itself.
      if (!sent) sendTyping(channelId, threadRootId, false);
      return;
    }
    const now = Date.now();
    if (current) clearTimeout(current.idle);
    const idle = setTimeout(() => noteTyping(channelId, threadRootId, false), TYPING_IDLE_MS);
    if (current && now - current.sentAt < CHANNEL_TYPING_INTERVAL_MS) {
      current.idle = idle;
      return;
    }
    ownTyping.set(key, { channelId, threadRootId, sentAt: now, idle });
    sendTyping(channelId, threadRootId, true);
  }
  onCleanup(() => {
    for (const entry of ownTyping.values()) {
      clearTimeout(entry.idle);
      sendTyping(entry.channelId, entry.threadRootId, false);
    }
    ownTyping.clear();
  });

  /**
   * The people who type and the agents that think or work in a channel, or in one of its threads,
   * as the host last said. Null until the host says anything about the channel.
   */
  function typingIn(
    channelId: string,
    threadRootId: string | null,
  ): { humans: string[]; agents: { id: string; state: "thinking" | "working" }[] } | null {
    const entries = state.typing[channelId];
    if (!entries) return null;
    const humans: string[] = [];
    const agents: { id: string; state: "thinking" | "working" }[] = [];
    for (const entry of entries) {
      if ((entry.threadRootId ?? null) !== threadRootId) continue;
      if (entry.kind === "member") {
        if (entry.state === "typing" && !env.isReader(entry.id)) humans.push(entry.id);
      } else if (entry.state !== "typing") agents.push({ id: entry.id, state: entry.state });
    }
    return { humans, agents };
  }

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
        draft.agentChosen = true;
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

  /**
   * Opens a link to a message of this host in place: its channel, and its thread. A link to another
   * host, or to a channel the reader cannot see, is not handled and opens as a plain link.
   */
  function openLink(url: string): boolean {
    const link = parseMessageLink(url);
    if (!link || !env.hostId || env.hostId() !== link.hostId || !summary(link.channelId)) return false;
    openChannel(link.channelId);
    openThread(link.channelId, link.messageId);
    return true;
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
    if (!reacted) noteEmoji(emoji);
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

  /**
   * Opens `#general`, and makes it first when the workspace has no channel: public, with every
   * person of the team and the agents, which answer when mentioned. A host without `ensure-general`
   * gets the same channel from a `create`.
   */
  async function ensureGeneral(): Promise<void> {
    if (state.creatingGeneral) return;
    setState((draft) => {
      draft.creatingGeneral = true;
    });
    try {
      let openId: string;
      try {
        openId = (
          await command({ type: "ensure-general", operationId: crypto.randomUUID(), channelId: crypto.randomUUID() })
        ).id;
      } catch (error) {
        const existing = summaries().find(
          (candidate) => !candidate.archived && channelKind(candidate) === "channel" && candidate.name === "general",
        );
        if (existing) openId = existing.id;
        else if (env.reader().role === "member") throw error;
        else {
          const agents = env
            .agents()
            .filter((agent) => !env.hiddenAgentIds().has(agent.id))
            .map((agent): ChannelMember => ({ agentId: agent.id, answerMode: "mention" }));
          openId = crypto.randomUUID();
          await command({
            type: "create",
            operationId: crypto.randomUUID(),
            channelId: openId,
            kind: "channel",
            visibility: "public",
            name: "general",
            description: currentText().t("workspace.app.welcome.generalDescription"),
            humanMemberIds: [
              ...new Set([
                ...(env.reader().id ? [env.reader().id ?? ""] : []),
                ...env.people().map((person) => person.id),
              ]),
            ].filter(Boolean),
            members: agents,
          });
        }
      }
      await channels.refresh();
      openChannel(openId);
    } catch (error) {
      failureToast(error, "workspace.app.welcome.failed");
    } finally {
      setState((draft) => {
        draft.creatingGeneral = false;
      });
    }
  }

  function closeHint(id: string) {
    setState((draft) => {
      draft.hintsSeen[id] = true;
    });
    try {
      window.localStorage.setItem(HINTS_KEY, JSON.stringify(state.hintsSeen));
    } catch {
      // The hint stays closed for this session.
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

  /** Makes a channel public or private. Owners and admins only; the host checks it again. */
  async function setVisibility(channelId: string, visibility: "public" | "private") {
    return run(
      { type: "set-visibility", operationId: crypto.randomUUID(), channelId, visibility },
      "workspace.app.error.visibility",
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
    reorderSidebar,
    moveSidebarRow,
    setMuted,
    isMuted: (id: string) => mutedSet().has(id),
    setSidebarFilter,
    noteEmoji,
    setSkinTone,
    quickReactions,
    reactionPicker,
    activityCount,
    threadsUnread,
    fleet,
    artifacts,
    artifactRecord: hostArtifacts.record,
    steps,
    soleAgent: (channel: Parameters<typeof soleAgentOf>[1]) => soleAgentOf(directory(), channel),
    canManage,
    canMessageAgent,
    isAdmin: () => env.reader().role !== "member",
    setPhonePane,
    openChannel,
    openAgent,
    openConversation,
    openLink,
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
    noteTyping,
    typingIn,
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
    ensureGeneral,
    workspaceEmpty,
    closeHint,
    leave,
    archive,
    invite,
    removeMember,
    setMember,
    setMeta,
    setVisibility,
    linkDiscord,
    unlinkDiscord,
    messageMember,
    workspaceSettings,
  };
}
