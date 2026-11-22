import type { EfficiencyCalls } from "../efficiency/efficiency-port";
/*
 * The workspace controller: which conversation or view is open, which right panel shows, the open
 * thread, the drafts, the activity feed, and every workspace command. The desktop and the browser
 * client build it from their own environment and mount the same view on it.
 */

import { chatTagReferences } from "@openbot/contracts/chat-tag-references";
import {
  type AgentApproval,
  type AgentAttentionItem,
  type AgentEvent,
  type BrowserTakeoverRequest,
  boundedWorkspaceSidebar,
  CHANNEL_TYPING_INTERVAL_MS,
  type ChannelCommand,
  type ChannelMember,
  type ChannelMessage,
  type ChannelPage,
  type ChannelSummary,
  type ChannelTypingEntry,
  type ChannelTypingState,
  channelKind,
  channelVisibility,
  type DraftAttachment,
  GENERAL_SPACE_ID,
  isChannelAnswerMode,
  isTicketAttention,
  type QueueSnapshot,
  type TeamRealtimeEvent,
  type WorkspaceActivity,
  type WorkspaceChannelCommand,
  type WorkspaceNotifyLevel,
  type WorkspaceSettings,
  type WorkspaceSidebar,
  type WorkspaceSidebarPrefs,
  type WorkspaceSteps,
  withWorkspaceNotifyLevel,
  workspaceNotifyLevel,
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
import type { JSX } from "@solidjs/web";
import { createEffect, createMemo, createSignal, createStore, flush, onCleanup, untrack } from "solid-js";
import { actionToast } from "../../action-toast";
import { setActiveSpaces } from "../../active-space";
import { applyWorkspaceAppearance } from "../../atelier-theme";
import type { ChannelsController } from "../channels/channels-controller";
import type { MessagingApi } from "../connectors/messaging-connector";
import type { StorageHygieneCalls } from "../storage-hygiene/storage-hygiene-port";
import type { TrustCalls } from "../trust/trust-port";
import type { ConnectorAccessStore } from "./connector-access-store";
import type { OwnerAwayStore } from "./owner-away-store";
import { createWorkspaceFrecency } from "./workspace-frecency";
import { createWorkspaceLater } from "./workspace-later";
import { createWorkspaceMarks } from "./workspace-marks";
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
import { createWorkspaceOutbox, type OutboxMessage } from "./workspace-outbox";
import { createWorkspaceSearch } from "./workspace-search";
import { localSectionPrefs, sidebarSections, withSectionOrder } from "./workspace-sidebar-sections";
import {
  type ArtifactThumbnailUrl,
  createHostArtifactsSource,
  createHostFleetSource,
  createLocalFleetSource,
  createMessageArtifactsSource,
  type WorkspaceArtifactsSource,
  type WorkspaceFleetSource,
} from "./workspace-sources";
import { createWorkspaceSpaces } from "./workspace-spaces";
import { createWorkspaceUnreads } from "./workspace-unreads";

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
  /** `name` fills the name field, as Jump to's "Create #name" does. */
  | { kind: "create-channel"; name?: string }
  | { kind: "new-message" }
  | { kind: "browse" }
  | { kind: "switcher" }
  /** The keyboard shortcuts sheet (⌘/). */
  | { kind: "shortcuts" }
  /** Confirms Shift+Escape: every conversation of the space read. */
  | { kind: "mark-all-read" }
  | { kind: "edit-meta"; channelId: string; field: "topic" | "description" }
  | { kind: "invite"; channelId: string }
  | { kind: "delete-message"; channelId: string; messageId: string; threadRootId: string | null }
  /** Confirms leaving a private channel: the reader cannot come back without an invite. */
  | { kind: "leave"; channelId: string }
  /** Confirms deleting a channel (it stays in Deleted channels and can be restored). */
  | { kind: "archive"; channelId: string }
  /** Confirms taking a person or an agent out of a channel. */
  | { kind: "remove-member"; channelId: string; memberId: string }
  /** Makes a space (no id) or changes one. */
  | { kind: "space-edit"; spaceId: string | null }
  | { kind: "space-delete"; spaceId: string }
  /** Moves agents or channels to another space. */
  | { kind: "space-move"; agentIds: string[]; channelIds: string[] };

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
  /** The agent whose talks with other agents the Between agents view lists, or null for all. */
  agentTalkAgentId: string | null;
  panel: WorkspacePanel | null;
  phonePane: WorkspacePhonePane;
  dialog: WorkspaceDialog | null;
  thread: ThreadState | null;
  /** A message that a link named: the list shows it and marks it until the reader leaves its channel. */
  focus: { channelId: string; messageId: string } | null;
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
  /** The agents whose main chat is the reader's DM with them, as the host says. */
  mainChatAgentIds: string[];
  /** The agents that a person wrote to lately, as the host says. Null: the host does not say, so all show. */
  recentAgentIds: string[] | null;
  /** The first-run hints the reader closed, on this computer. */
  hintsSeen: Record<string, true>;
  /** `ensure-general` runs. */
  creatingGeneral: boolean;
  /** The reader opened an agent's chat in this session: a new workspace then shows it, not the welcome. */
  agentChosen: boolean;
  /**
   * The reader's own sidebar: the order they dragged the rows into and the muted conversations. The
   * host keeps it per member; this computer keeps a copy for a host that cannot.
   */
  sidebar: SidebarPrefs;
  /** The text that filters the sidebar rows. */
  sidebarFilter: string;
  /** The emoji the reader used last, newest first, and their skin tone (0: none). On this computer. */
  emoji: { recent: string[]; skinTone: number };
}

type SidebarPrefs = WorkspaceSidebarPrefs;

/** The routine canvas that a shell draws in the workspace's Routines view. */
export interface WorkspaceRoutines {
  available: () => boolean;
  agentId: () => string | null;
  selectAgent: (agentId: string) => void;
  /** `openAgent` opens an agent's chat, as making a routine does. */
  pane: (actions: { openAgent: (agentId: string) => void }) => JSX.Element;
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
  /**
   * Every request of every agent that waits for the reader (`needsYouItems`): the "Needs you" list of
   * the top bar, Activity and the phone's Home.
   */
  needsYou?: (() => readonly AgentAttentionItem[]) | undefined;
  /** The owner's quiet hours, focus and "When you're back" list. Only the owner's web client has it. */
  ownerAway?: OwnerAwayStore | undefined;
  /** The owner's MCP access links and webhook senders, under Secrets. Only the owner's web client has it. */
  connectorAccess?: ConnectorAccessStore | undefined;
  /** Whether the host is this computer: a browser secret can then be saved to the Vault. */
  localHost?: (() => boolean) | undefined;
  /** Opens the browser tab of a takeover, where the shell has the browser. */
  openBrowserTab?: ((tabId: string, agentId: string) => void) | undefined;
  /** The Discord connections of the host, for the channel's Integrations tab. */
  messaging?: (() => MessagingApi | undefined) | undefined;
  /** The workspace settings of the host. Only owners and admins may read them. */
  workspaceSettings?: (() => Promise<WorkspaceSettings>) | undefined;
  /** Saves the workspace settings of the host and answers the saved ones. Only owners and admins may. */
  saveWorkspaceSettings?: ((settings: WorkspaceSettings) => Promise<WorkspaceSettings>) | undefined;
  /** A host fleet endpoint. Absent, the fleet comes from the agent list and its runtime state. */
  fleet?: WorkspaceFleetSource | undefined;
  /** A host artifacts index. Absent, the artifacts come from the messages this client read. */
  artifacts?: WorkspaceArtifactsSource | undefined;
  /** The address of the host's image of an artifact page. Absent, the artifact cards keep their drawing. */
  artifactThumbnailUrl?: ArtifactThumbnailUrl | undefined;
  /** The storage hygiene calls of the host, for an owner or admin. Absent, there is no Storage view. */
  storageHygiene?: (() => StorageHygieneCalls | undefined) | undefined;
  /** True when the reader may see the agent key store: the server owner or an admin. */
  secrets?: (() => boolean) | undefined;
  /** The sleep, review and playbook calls of the host, for an owner or admin of a fork host. */
  efficiency?: (() => EfficiencyCalls | undefined) | undefined;
  /** The trust and control calls of the host, for an owner or admin. Absent, there is no Trust view. */
  trust?: (() => TrustCalls | undefined) | undefined;
  /** Opens Server settings > Storage, where the cleanup rules are. */
  openStorageRules?: (() => void) | undefined;
  /**
   * The runtime state that the org chart reads beside the fleet: each agent's queue, for the agents
   * that message each other, and the last failed turn of each agent. Absent, the chart shows the
   * fleet state only.
   */
  agentRuntime?:
    | (() => {
        queues: Readonly<Record<string, QueueSnapshot>>;
        failedTurns: Readonly<Record<string, string | undefined>>;
      })
    | undefined;
  /** Sets an agent's manager in the org chart; `null` is the top level. Absent, the chart is read-only. */
  setAgentManager?: ((agentId: string, managerId: string | null) => Promise<void>) | undefined;
  /** Opens the form of a new agent. */
  createAgent?: (() => void) | undefined;
  /** Deletes an agent, as the shell's own delete does (with its undo, where it has one). */
  deleteAgent?: ((agentId: string) => Promise<void> | void) | undefined;
  /** Opens the invitation of people to the server. */
  inviteTeammates?: (() => void) | undefined;
  /** Opens the server's apps: Discord, Slack, Telegram and the other connectors. Admins only. */
  openApps?: (() => void) | undefined;
  /**
   * The routine canvas of one agent, as a workspace view. `available` is false on a host that does
   * not serve routine flows. `selectAgent` changes the agent that the canvas shows.
   */
  routines?: WorkspaceRoutines | undefined;
  /** The id of the host in message links: a link to another host opens as a plain link. */
  hostId?: (() => string | null) | undefined;
  /** A link to a message that opens it again, where the client has one. */
  messageLink?: ((channelId: string, messageId: string, threadRootId: string | null) => string | null) | undefined;
  /** A link to a message of the owner's DM with an agent (the agent's chat), where the client has one. */
  agentMessageLink?: ((agentId: string, messageId: string) => string | null) | undefined;
  /** A link to a channel, DM or group that opens it again, where the client has one. */
  channelLink?: ((channelId: string) => string | null) | undefined;
  /**
   * Opens a link of the client's own address in place, such as a web client address in a message.
   * False when the link is not one: the workspace reads it as a message link, or opens it as a page.
   */
  openAddress?: ((url: string) => boolean) | undefined;
  /** Per reader and server, for the drafts this computer keeps. */
  storageKey: () => string;
  /** The layout shows one pane at a time. */
  phone: () => boolean;
  /**
   * Keeps the view and the open thread on this computer, per reader and server, and shows them
   * again when the workspace starts. The web client keeps them in its address instead.
   */
  rememberPlace?: boolean | undefined;
  /** Called when the workspace moves to another pane on a phone. */
  onPhonePaneChange?: ((pane: WorkspacePhonePane) => void) | undefined;
}

export type WorkspaceController = ReturnType<typeof createWorkspaceController>;

const DRAFTS_KEY = "openbot.workspace.drafts.v1";
const HINTS_KEY = "openbot.workspace.hints.v1";

const SIDEBAR_KEY = "openbot.workspace.sidebar.v1";
const PLACE_KEY = "openbot.workspace.place.v1";

/** The view or the thread that showed last, kept on this computer. */
interface SavedPlace {
  view?: WorkspaceView;
  agentId?: string | null;
  thread?: { channelId: string; rootId: string };
}

const SAVED_VIEWS: readonly WorkspaceView[] = [
  "unreads",
  "later",
  "dms",
  "threads",
  "activity",
  "fleet",
  "org",
  "artifacts",
  "agents",
  "storage",
  "routines",
  "secrets",
  "reviews",
  "loops",
  "insights",
  "trust",
  "space-agents",
  "drafts",
];

function readPlace(key: string): SavedPlace {
  try {
    const value = JSON.parse(window.localStorage.getItem(`${PLACE_KEY}:${key}`) ?? "{}");
    if (!isDynamicRecord(value)) return {};
    const view = SAVED_VIEWS.find((item) => item === value.view);
    const thread = isDynamicRecord(value.thread) ? value.thread : null;
    return {
      ...(view ? { view, agentId: typeof value.agentId === "string" ? value.agentId : null } : {}),
      ...(thread && typeof thread.channelId === "string" && typeof thread.rootId === "string"
        ? { thread: { channelId: thread.channelId, rootId: thread.rootId } }
        : {}),
    };
  } catch {
    return {};
  }
}

function writePlace(key: string, place: SavedPlace): void {
  try {
    window.localStorage.setItem(`${PLACE_KEY}:${key}`, JSON.stringify(place));
  } catch {
    // A private window or a full disk keeps no place.
  }
}

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

/** The copy of the reader's sidebar order and mutes on this computer, per reader and server. */
function readSidebar(key: string): SidebarPrefs {
  try {
    const value = JSON.parse(window.localStorage.getItem(`${SIDEBAR_KEY}:${key}`) ?? "{}");
    if (!isDynamicRecord(value))
      return { order: { channels: [], direct: [] }, muted: [], notifyMentions: [], notifyNothing: [] };
    const order = isDynamicRecord(value.order) ? value.order : {};
    return {
      order: { channels: idList(order.channels), direct: idList(order.direct) },
      muted: idList(value.muted),
      ...(Array.isArray(value.closed) ? { closed: idList(value.closed) } : {}),
      ...(typeof value.space === "string" && value.space ? { space: value.space } : {}),
      ...(Array.isArray(value.collapsed) ? { collapsed: idList(value.collapsed) } : {}),
      // Always present, so a view that reads a level before the first choice hears the change.
      notifyMentions: idList(value.notifyMentions),
      notifyNothing: idList(value.notifyNothing),
      ...localSectionPrefs(value),
    };
  } catch {
    return { order: { channels: [], direct: [] }, muted: [], notifyMentions: [], notifyNothing: [] };
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
/** When the reader last changed each draft, for the Drafts & sent list. A key of its own: older copies have none. */
const DRAFT_TIMES_KEY = "openbot.workspace.drafts.at.v1";

function readDraftTimes(key: string): Record<string, number> {
  try {
    const value = JSON.parse(window.localStorage.getItem(`${DRAFT_TIMES_KEY}:${key}`) ?? "{}");
    if (!isDynamicRecord(value)) return {};
    return Object.fromEntries(
      Object.entries(value).filter(
        (entry): entry is [string, number] => typeof entry[1] === "number" && Number.isFinite(entry[1]),
      ),
    );
  } catch {
    return {};
  }
}

function writeDraftTimes(key: string, drafts: Record<string, string>, times: Record<string, number>): void {
  try {
    const kept = Object.entries(times).filter(([draft]) => drafts[draft]?.trim());
    window.localStorage.setItem(`${DRAFT_TIMES_KEY}:${key}`, JSON.stringify(Object.fromEntries(kept)));
  } catch {
    // The times stay for this session.
  }
}

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

/** The failure in the reader's language, for a dialog that shows it in place. */
function failureText(error: unknown, fallback: AppTextKey): string {
  const text = currentText();
  return text.errorMessage(error, text.t(fallback));
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
    agentTalkAgentId: null,
    panel: null,
    phonePane: "sidebar",
    dialog: null,
    thread: null,
    focus: null,
    editing: null,
    drafts: untrack(() => readDrafts(env.storageKey())),
    activity: { data: null, loading: false, failed: false },
    settings: null,
    steps: {},
    typing: {},
    dmAgentIds: null,
    mainChatAgentIds: [],
    recentAgentIds: null,
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
      // A Discord person's messages carry their name, so their reactions (as `discord-<id>`) show it too.
      for (const entry of channels.state.page?.messages ?? [])
        if (entry.author.kind === "member") found[entry.author.id] = entry.externalAuthor?.name ?? entry.author.name;
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
    if (agentId && dmIsMainChat(agentId) && (state.agentChosen || !workspaceEmpty())) return { kind: "agent", agentId };
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

  // ---------------------------------------------------------------- spaces

  const spaces = createWorkspaceSpaces({
    port: channels.port,
    ready: () => channels.supported() && env.connectionReady(),
    key: env.storageKey,
    onHostEvent: env.onHostEvent,
    channelIds: () => summaries().map((channel) => channel.id),
    agentIds: () => env.agents().map((agent) => agent.id),
    saved: () => state.sidebar.space,
    save: (spaceId) => {
      setState((draft) => {
        draft.sidebar.space = spaceId;
      });
      saveSidebar();
    },
  });
  // New agents from any form of the app start in the space that shows, and agent settings move agents.
  createEffect(
    () => spaces.available(),
    (available) => {
      setActiveSpaces(
        available
          ? {
              current: spaces.current,
              options: () => spaces.list().map((space) => ({ value: space.id, label: space.name })),
              agentSpace: spaces.agentSpace,
              moveAgent:
                env.reader().role === "member"
                  ? undefined
                  : (agentId, spaceId) =>
                      void spaces
                        .act({ kind: "move", spaceId, agentIds: [agentId] })
                        .catch((error: unknown) => failureToast(error, "workspace.spaces.moveFailed")),
            }
          : null,
      );
    },
  );
  onCleanup(() => setActiveSpaces(null));
  /** The space of a sidebar row: a channel, or the agent row of the owner's DM. */
  const rowSpace = (id: string) =>
    id.startsWith(AGENT_DM_PREFIX) ? spaces.agentSpace(id.slice(AGENT_DM_PREFIX.length)) : spaces.channelSpace(id);
  /** Opens a space. A conversation of another space that shows closes, so the space shows its activity. */
  function selectSpace(spaceId: string) {
    spaces.select(spaceId);
    const open = activeConversationId();
    // A phone shows one pane: the reader picked the space on the sidebar and wants to see its list.
    if (open && rowSpace(open) !== spaceId) openView("activity", env.phone() ? "sidebar" : "main");
  }
  /**
   * A conversation of another space that the reader opens, from Jump to, a notification, a link or a
   * new agent, brings its space along, so the sidebar shows where it is. Only an open that the reader
   * makes calls this: a choice of space never moves back to the conversation that showed before it,
   * and the conversation that shows when the workspace starts does not move the saved space. A
   * conversation whose space the host has not named yet does not move it either.
   */
  function followConversation(id: string) {
    untrack(() => {
      if (!spaces.available()) return;
      const known = id.startsWith(AGENT_DM_PREFIX)
        ? spaces.knowsAgent(id.slice(AGENT_DM_PREFIX.length))
        : spaces.knowsChannel(id);
      const spaceId = rowSpace(id);
      if (known && spaceId !== spaces.current()) spaces.select(spaceId);
    });
  } // A channel that the reader opens anywhere in the app (search, a notification, history) follows too.
  // Only an open after this workspace started: the last open before it was a choice of another time.
  createEffect(channels.opened, (opened, previous) => {
    if (opened && previous !== undefined && opened !== previous) followConversation(opened.channelId);
  });

  // ---------------------------------------------------------------- DM eligibility

  let dmAgentsRun = 0;
  async function refreshDmAgents() {
    const read = channels.port().agent.workspaceDmAgents;
    if (!read || !channels.supported() || !env.connectionReady()) return;
    const run = ++dmAgentsRun;
    try {
      const { agentIds, mainChatAgentIds, recentAgentIds, appearance } = await read();
      if (run !== dmAgentsRun) return;
      setState((draft) => {
        draft.dmAgentIds = agentIds;
        draft.mainChatAgentIds = mainChatAgentIds ?? [];
        draft.recentAgentIds = recentAgentIds ?? null;
      });
      // The look that the owner chose for the workspace; a host that predates it shows the default.
      applyWorkspaceAppearance(appearance);
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
          draft.mainChatAgentIds = [];
          draft.recentAgentIds = null;
        });
      if (current.ready) void refreshDmAgents();
    },
  );
  const dmAgentSet = createMemo(() => (state.dmAgentIds ? new Set(state.dmAgentIds) : null));
  const mainChatAgentSet = createMemo(() => new Set(state.mainChatAgentIds));
  const recentAgentSet = createMemo(() => (state.recentAgentIds ? new Set(state.recentAgentIds) : null));
  const closedSet = createMemo(() => new Set(state.sidebar.closed ?? []));
  /** The agents that the reader opened in this session: their DM rows stay while they talk. */
  const [openedAgentIds, setOpenedAgentIds] = createSignal<ReadonlySet<string>>(new Set());
  /**
   * Whether an agent's DM row shows: the reader wrote to it lately, it waits for the reader, or the
   * reader opened it now. Every other agent stays one step away, in New message, Jump to and Fleet.
   */
  const showAgentRow = (agentId: string) => {
    if (directory().agentStates[agentId]?.kind === "waiting") return true;
    if (closedSet().has(`${AGENT_DM_PREFIX}${agentId}`)) return false;
    const recent = recentAgentSet();
    return !recent || recent.has(agentId) || openedAgentIds().has(agentId) || env.activeAgentId() === agentId;
  };
  /** The owner's DM with each agent is its main chat; another person's is, when the agent shares it. */
  const dmIsMainChat = (agentId: string) => env.agentDmIsMainChat() || mainChatAgentSet().has(agentId);
  /** Whether the reader may open a DM with an agent, or add it: the host's list, or every agent it shows. */
  const canMessageAgent = (agentId: string) => dmAgentSet()?.has(agentId) ?? true;

  const mutedSet = createMemo(() => new Set(state.sidebar.muted));
  /** The host keeps a notification level for each conversation (Slack's bell). */
  const [notifyLevels, setNotifyLevels] = createSignal(false);
  /** The reader's level for a conversation, or null for the server's. Mute reads as "nothing". */
  const notifyLevel = (id: string): WorkspaceNotifyLevel | null => workspaceNotifyLevel(state.sidebar, id);
  /** The level the reader set on the bell, without mute: mute keeps its own badge rules. */
  const chosenLevel = (id: string): WorkspaceNotifyLevel | null =>
    workspaceNotifyLevel(
      { muted: [], notifyMentions: state.sidebar.notifyMentions, notifyNothing: state.sidebar.notifyNothing },
      id,
    );
  function setNotifyLevel(id: string, level: WorkspaceNotifyLevel | null) {
    setState((draft) => {
      const next = withWorkspaceNotifyLevel(draft.sidebar, id, level);
      draft.sidebar.notifyMentions = next.notifyMentions;
      draft.sidebar.notifyNothing = next.notifyNothing;
      // "All" or "Mentions" is no mute: a muted conversation the reader turns on again unmutes.
      if (level !== "nothing") draft.sidebar.muted = draft.sidebar.muted.filter((item) => item !== id);
    });
    saveSidebar();
  }
  /** Unread mentions only, for a conversation whose level lets nothing else count. */
  const onlyMentions = createMemo(() => {
    const counts: Record<string, number> = {};
    for (const item of state.activity.data?.items ?? [])
      if (item.unread && item.kind === "mention") counts[item.channelId] = (counts[item.channelId] ?? 0) + 1;
    return counts;
  });
  const filterText = () => state.sidebarFilter.trim().toLocaleLowerCase();
  /** The channel rows of every space, for the unread marks of the space rail. */
  const everyChannelRow = createMemo(() =>
    inOrder(
      sidebarChannels(directory(), summaries(), mentionCounts()).map((row) =>
        mutedSet().has(row.id) ? { ...row, muted: true } : row,
      ),
      state.sidebar.order.channels,
    ),
  );
  const everyDirectRow = createMemo(() =>
    inOrder(
      sidebarDirectMessages({
        directory: directory(),
        summaries: summaries(),
        agentDmIsMainChat: dmIsMainChat,
        hiddenAgentIds: env.hiddenAgentIds(),
        dmAgentIds: dmAgentSet(),
        closed: closedSet(),
        showAgentRow,
      })
        .map((row) => (mutedSet().has(row.id) ? { ...row, muted: true } : row))
        // A DM set to "Just mentions" or "Nothing" counts only its mentions, as a muted one does.
        .map((row) =>
          chosenLevel(row.id) && !row.id.startsWith(AGENT_DM_PREFIX)
            ? { ...row, mentionCount: onlyMentions()[row.id] ?? 0 }
            : row,
        ),
      state.sidebar.order.direct,
    ),
  );
  /** The rows of the space that the reader looks at. */
  const allChannelRows = createMemo(() => everyChannelRow().filter((row) => rowSpace(row.id) === spaces.current()));
  const allDirectRows = createMemo(() => everyDirectRow().filter((row) => rowSpace(row.id) === spaces.current()));
  /** Unread conversations and mentions of each space, for its mark on the rail. Muted rows count for nothing. */
  const spaceUnread = createMemo(() => {
    const totals = new Map<string, { unread: boolean; mentions: number }>();
    for (const row of [...everyChannelRow(), ...everyDirectRow()]) {
      if (row.muted) continue;
      const spaceId = rowSpace(row.id);
      const total = totals.get(spaceId) ?? { unread: false, mentions: 0 };
      total.unread ||= row.unread === true;
      total.mentions += row.mentionCount ?? 0;
      totals.set(spaceId, total);
    }
    return totals;
  });
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

  // ---------------------------------------------------------------- sidebar on the host

  /**
   * Where the sidebar lives for this reader and server. `pending`: the host value is not read yet.
   * `host`: the host keeps it per member, so it follows the account. `local`: the host has no
   * sidebar route (an older host), so only this computer keeps it.
   */
  let sidebarHome: "pending" | "host" | "local" = "pending";
  /** A change that the host has not taken. A read then sends it instead of showing the host value. */
  let sidebarUnsent = false;
  /** Changes with the reader or the server. A read or write of the previous one does nothing. */
  let sidebarKeyRun = 0;
  let sidebarReadRun = 0;
  /** The `sidebarKeyRun` of the write on its way, or -1. */
  let sidebarSendingRun = -1;
  /**
   * How many changes the reader made in this window, and how many of them the last write carried. A
   * read that started before a change, or that lands while a write is on its way, answers an older
   * value: the host sends its change event to the window that saved too, so every save is followed by
   * such a read. Applying it would undo the reader's newest choice.
   */
  let sidebarEdits = 0;
  let sidebarSentEdits = 0;
  /**
   * The host revision of the value this window shows, from the last read or write answer it applied.
   * A write names it, so the host keeps what other sessions of the reader saved since; an answer with
   * a smaller one is older than the value shown. Undefined: none yet, or an older host.
   */
  let sidebarRevision: number | undefined;

  function writeLocalSidebar(value: SidebarPrefs = state.sidebar) {
    try {
      window.localStorage.setItem(`${SIDEBAR_KEY}:${env.storageKey()}`, JSON.stringify(value));
    } catch {
      // The order and the mutes stay for this session.
    }
  }
  /** Sends the newest value. A change made while one write is on its way goes in one more write. */
  async function sendSidebar() {
    const write = channels.port().agent.setWorkspaceSidebar;
    const run = sidebarKeyRun;
    if (!write || sidebarHome !== "host" || sidebarSendingRun === run) return;
    sidebarSendingRun = run;
    try {
      while (sidebarUnsent && run === sidebarKeyRun) {
        sidebarUnsent = false;
        sidebarSentEdits = sidebarEdits;
        // The whole value goes: a field that this write left out would be lost on the host. A copy,
        // so the write does not hold the store's proxies.
        const value: SidebarPrefs = JSON.parse(JSON.stringify(state.sidebar));
        let answer: WorkspaceSidebar;
        try {
          answer = await write(
            boundedWorkspaceSidebar({
              ...value,
              closed: value.closed ?? [],
              ...(sidebarRevision === undefined ? {} : { baseRevision: sidebarRevision }),
            }),
          );
        } catch {
          // This computer keeps the change; the next read of the host sends it again.
          if (run === sidebarKeyRun) sidebarUnsent = true;
          return;
        }
        // The host kept this value with the changes of the reader's other sessions since the base. It
        // shows unless the reader changed the sidebar again meanwhile; that change goes next, from the
        // same base.
        if (run === sidebarKeyRun && sidebarEdits === sidebarSentEdits && answer.sidebar)
          applyHostSidebar(answer.sidebar, answer.revision);
      }
    } finally {
      if (sidebarSendingRun === run) sidebarSendingRun = -1;
    }
  }
  /** Shows the host value in this window and keeps it on this computer, with its revision. */
  function applyHostSidebar(hosted: SidebarPrefs, revision: number | undefined) {
    const local = untrack(() => state.sidebar);
    // The space is this window's own, as the open conversation is: a save of another window or
    // computer of the reader does not move it. A window that has none yet starts in the host's.
    const space = local.space ?? hosted.space;
    // A host that predates `collapsed` drops it: the reader's choice on this computer stays.
    const collapsed = hosted.collapsed ?? local.collapsed;
    const { baseRevision: _base, ...kept } = hosted;
    // A host that predates the sections drops them: the reader's choices on this computer stay.
    const starred = hosted.starred ?? local.starred;
    const sections = hosted.sections ?? local.sections;
    const groupOptions = hosted.groupOptions ?? local.groupOptions;
    const value: SidebarPrefs = {
      ...kept,
      ...(space ? { space } : {}),
      ...(collapsed ? { collapsed } : {}),
      ...(starred ? { starred } : {}),
      ...(sections ? { sections } : {}),
      ...(groupOptions ? { groupOptions } : {}),
      // A host that predates the levels drops them: the reader's choices on this computer stay.
      notifyMentions: hosted.notifyMentions ?? local.notifyMentions ?? [],
      notifyNothing: hosted.notifyNothing ?? local.notifyNothing ?? [],
    };
    sidebarRevision = revision;
    setState((draft) => {
      draft.sidebar = value;
    });
    // The store shows the value after its flush; this computer keeps it now.
    writeLocalSidebar(value);
  }
  /**
   * Reads the host value. It replaces the copy of this computer, unless the reader changed the
   * sidebar meanwhile. A host with no value gets the copy of this computer, once.
   */
  async function loadHostSidebar() {
    const read = channels.port().agent.workspaceSidebar;
    if (!read) {
      sidebarHome = "local";
      return;
    }
    const keyRun = sidebarKeyRun;
    const readRun = ++sidebarReadRun;
    const editsAtStart = sidebarEdits;
    let hosted: SidebarPrefs | null;
    let revision: number | undefined;
    try {
      const answer = await read();
      hosted = answer.sidebar;
      revision = answer.revision;
      setNotifyLevels(answer.notifyLevels === true);
    } catch {
      // A host without the route, or one that cannot answer now: this computer keeps the sidebar.
      if (keyRun === sidebarKeyRun && readRun === sidebarReadRun) sidebarHome = "local";
      return;
    }
    if (keyRun !== sidebarKeyRun || readRun !== sidebarReadRun) return;
    sidebarHome = "host";
    const local = untrack(() => state.sidebar);
    // An answer older than the value that a write of this window got back: the host has a newer one.
    if (revision !== undefined && sidebarRevision !== undefined && revision < sidebarRevision) return;
    if (hosted) {
      // The reader changed the sidebar since the read began, or a write is on its way: this window
      // holds the newer value. It goes to the host unless the last write already carried it.
      if (sidebarEdits !== editsAtStart || sidebarUnsent || sidebarSendingRun === keyRun) {
        if (sidebarSentEdits !== sidebarEdits) {
          sidebarUnsent = true;
          void sendSidebar();
        }
        return;
      }
      applyHostSidebar(hosted, revision);
      return;
    }
    if (
      !local.order.channels.length &&
      !local.order.direct.length &&
      !local.muted.length &&
      !local.space &&
      !local.collapsed?.length &&
      !local.starred?.length &&
      !local.sections?.length &&
      !local.groupOptions?.length
    )
      return;
    sidebarUnsent = true;
    void sendSidebar();
  }
  createEffect(
    () => ({ ready: channels.supported() && env.connectionReady(), key: env.storageKey() }),
    (current, previous) => {
      if (previous && current.key !== previous.key) {
        sidebarKeyRun += 1;
        sidebarUnsent = false;
        sidebarHome = "pending";
        sidebarRevision = undefined;
      }
      // A reconnect reads again: another computer of the reader may have changed it.
      if (current.ready && (!previous?.ready || current.key !== previous.key)) void loadHostSidebar();
    },
  );
  // Coming back to this window reads again too, so an order or a mute set on another computer shows
  // without a reload. The host sends no event for it.
  if (typeof document !== "undefined") {
    const reread = () => {
      if (document.visibilityState === "visible" && channels.supported() && env.connectionReady())
        void loadHostSidebar();
    };
    document.addEventListener("visibilitychange", reread);
    window.addEventListener("focus", reread);
    onCleanup(() => {
      document.removeEventListener("visibilitychange", reread);
      window.removeEventListener("focus", reread);
    });
  }

  function saveSidebar() {
    // A store write shows only after the flush: without it the copy and the host get the old value,
    // and the host's answer then takes the change back.
    flush();
    sidebarEdits += 1;
    writeLocalSidebar();
    sidebarUnsent = true;
    void sendSidebar();
  }
  /**
   * The reader dragged or moved a row: the section keeps this order for the reader's account, and
   * sorts in it from now on.
   */
  function reorderSidebar(section: string, ids: string[]) {
    updateSidebarPrefs((prefs) => withSectionOrder(prefs, section, ids));
  }
  /** Moves a row one place up or down in its section, the keyboard's way to reorder. */
  function moveSidebarRow(section: string, id: string, delta: number) {
    const ids = (sidebarSectionList().find((entry) => entry.id === section)?.items ?? []).map((item) => item.row.id);
    const from = ids.indexOf(id);
    const to = from + delta;
    if (from < 0 || to < 0 || to >= ids.length) return;
    ids.splice(from, 1);
    ids.splice(to, 0, id);
    reorderSidebar(section, ids);
  }
  /** A muted conversation stays in the list but shows no unread mark. It follows the reader's account. */
  /** Takes a DM out of the list until the reader opens it again. */
  function closeConversation(id: string) {
    setState((draft) => {
      const others = (draft.sidebar.closed ?? []).filter((item) => item !== id);
      draft.sidebar.closed = [...others, id];
    });
    saveSidebar();
    if (activeConversationId() === id) openView("activity");
  }
  /** A DM that the reader opens comes back to the list. */
  function reopenConversation(id: string) {
    if (!(state.sidebar.closed ?? []).includes(id)) return;
    setState((draft) => {
      draft.sidebar.closed = (draft.sidebar.closed ?? []).filter((item) => item !== id);
    });
    saveSidebar();
  }
  /**
   * Applies a change to the reader's sidebar preferences (sections, Starred, sort and filter), and
   * keeps it on this computer and on the host, as the order and the mutes.
   */
  function updateSidebarPrefs(change: (prefs: SidebarPrefs) => SidebarPrefs) {
    // The draft holds the writes that this task made before, which a read does not show yet.
    setState((draft) => {
      draft.sidebar = change(JSON.parse(JSON.stringify(draft.sidebar)));
    });
    saveSidebar();
  }
  /** Collapses or opens a sidebar section. It follows the reader's account, as the order does. */
  function setGroupCollapsed(group: string, collapsed: boolean) {
    setState((draft) => {
      const others = (draft.sidebar.collapsed ?? []).filter((item) => item !== group);
      draft.sidebar.collapsed = collapsed ? [...others, group] : others;
    });
    saveSidebar();
  }
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
  /** The conversations with a draft that is not sent, in the conversation or in one of its threads. */
  const draftConversationIds = createMemo(
    () =>
      new Set(
        Object.keys(state.drafts).flatMap((key) => (state.drafts[key]?.trim() ? [key.split("/")[0] ?? key] : [])),
      ),
  );
  /** The sidebar sections of the space that shows: Starred, the reader's own, Channels, Direct messages. */
  const sidebarSectionList = createMemo(() =>
    sidebarSections({
      channels: sidebarChannelRows(),
      direct: sidebarDirectRows(),
      prefs: state.sidebar,
      activeId: activeConversationId() ?? undefined,
      draftIds: draftConversationIds(),
      filtering: filterText().length > 0,
    }),
  );
  /** The conversations in sidebar order, for Alt+Up and Alt+Down. */
  const conversationOrder = createMemo(() =>
    sidebarSectionList().flatMap((section) => section.items.map((item) => item.row.id)),
  );

  /** The activity and the threads of the space that shows. */
  const spaceActivity = createMemo(() =>
    (state.activity.data?.items ?? []).filter((item) => spaces.channelInCurrent(item.channelId)),
  );
  const spaceThreads = createMemo(() =>
    (state.activity.data?.threads ?? []).filter((thread) => spaces.channelInCurrent(thread.channelId)),
  );
  /** The Activity badge: unread mentions, replies and DMs. Reactions never count (Slack). */
  // A conversation set to "Just mentions" or "Nothing" adds only its mentions.
  const activityCount = createMemo(
    () =>
      spaceActivity().filter(
        (item) => item.unread && item.kind !== "reaction" && (item.kind === "mention" || !chosenLevel(item.channelId)),
      ).length,
  );
  const threadsUnread = createMemo(() => spaceThreads().some((thread) => thread.unreadCount > 0));

  const artifactsFallback = createMessageArtifactsSource(directory);
  const hostArtifacts = createHostArtifactsSource({
    port: channels.port,
    directory,
    channels: summaries,
    onHostEvent: env.onHostEvent,
    fallback: artifactsFallback.source,
    thumbnailUrl: env.artifactThumbnailUrl,
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

  /** The reader's thread positions and follows, saved messages, pins and "Mark unread". */
  const marks = createWorkspaceMarks({
    port: channels.port,
    onHostEvent: env.onHostEvent,
    isReader: env.isReader,
    onChannelMarkedUnread: (messageId, position) =>
      channels.holdUnread(position.channelId, messageId, position.unreadCount, position.throughSequence),
  });

  // ---------------------------------------------------------------- step trails

  const stepsLoading = new Set<string>();
  const stepTimers = new Map<string, ReturnType<typeof setTimeout>>();
  /** The channel of each message whose steps were read, so a host event can read them again. */
  const stepChannels = new Map<string, string>();
  /** The messages whose steps change while a read of them runs. */
  const stepsAgain = new Set<string>();
  let stepsUnsupported = false;
  onCleanup(() => {
    for (const timer of stepTimers.values()) clearTimeout(timer);
  });
  async function loadSteps(channelId: string, messageId: string) {
    const read = channels.port().agent.workspaceSteps;
    if (!read || stepsUnsupported) return;
    // A read asked for while one runs follows it: the running one can be from before the turn ended.
    if (stepsLoading.has(messageId)) {
      stepsAgain.add(messageId);
      return;
    }
    stepsLoading.add(messageId);
    stepChannels.set(messageId, channelId);
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
      if (stepsAgain.delete(messageId)) void loadSteps(channelId, messageId);
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
      setTimeout(
        () => {
          stepTimers.delete(message.id);
          void loadSteps(message.channelId, message.id);
        },
        streaming ? 1_500 : 200,
      ),
    );
  }
  /**
   * A turn can go on after its answer was posted, so the last message event can arrive while the
   * host still reports the turn as running. The end of the turn changes the channel (its task ends)
   * and the fleet, so each of those events reads again the steps that still stream.
   */
  function settleSteps(channelId: string | null) {
    for (const [messageId, steps] of Object.entries(state.steps)) {
      // A read that is already due covers the change.
      if (!steps?.streaming || stepTimers.has(messageId)) continue;
      const stepChannel = stepChannels.get(messageId);
      if (!stepChannel || (channelId !== null && stepChannel !== channelId)) continue;
      stepTimers.set(
        messageId,
        setTimeout(() => {
          stepTimers.delete(messageId);
          void loadSteps(stepChannel, messageId);
        }, 200),
      );
    }
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
    // When the open agent was deleted or hidden, the shell picks another one by itself: that is not
    // the reader's choice, so the view and the space that show stay.
    const replaced =
      Boolean(previous) &&
      untrack(() => !env.agents().some((agent) => agent.id === previous) || env.hiddenAgentIds().has(previous ?? ""));
    if (replaced) return;
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
    // An agent chat that the shell opens, such as from a notification, brings its space along.
    if (previous && agentId && agentId !== previous) followConversation(`${AGENT_DM_PREFIX}${agentId}`);
  });

  // A panel of another channel closes when the reader leaves it, and so does the mark of a linked message.
  createEffect(
    () => channels.state.selectedId,
    (channelId) => {
      if (untrack(() => state.focus && state.focus.channelId !== channelId))
        setState((draft) => {
          draft.focus = null;
        });
      const panel = untrack(() => state.panel);
      if (panel && panel.channelId !== channelId)
        setState((draft) => {
          draft.panel = null;
          draft.thread = null;
          if (draft.phonePane === "panel") draft.phonePane = "main";
        });
    },
  );

  const [draftTimes, setDraftTimes] = createStore<Record<string, number>>(
    untrack(() => readDraftTimes(env.storageKey())),
  );
  // Drafts follow the reader and the server.
  createEffect(env.storageKey, (key, previous) => {
    if (previous === undefined || key === previous) return;
    setDraftTimes(() => readDraftTimes(key));
    setState((draft) => {
      draft.drafts = readDrafts(key);
      draft.sidebar = readSidebar(key);
      draft.settings = null;
      draft.activity = { data: null, loading: false, failed: false };
    });
    void refreshActivity();
  });
  let draftTimer: ReturnType<typeof setTimeout> | undefined;
  function writePendingDrafts() {
    if (!draftTimer) return;
    clearTimeout(draftTimer);
    draftTimer = undefined;
    writeDrafts(env.storageKey(), state.drafts);
    writeDraftTimes(env.storageKey(), state.drafts, draftTimes);
  }
  // A phone can close a page in the background without another task: the last keys are stored as it goes.
  const storeOnHide = () => {
    if (document.visibilityState === "hidden") writePendingDrafts();
  };
  window.addEventListener("pagehide", writePendingDrafts);
  document.addEventListener("visibilitychange", storeOnHide);
  onCleanup(() => {
    window.removeEventListener("pagehide", writePendingDrafts);
    document.removeEventListener("visibilitychange", storeOnHide);
    writePendingDrafts();
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
    if (event.type === "channels-changed") {
      settleSteps(event.channelId);
      return;
    }
    if (event.type === "workspace-fleet-changed" || event.type === "turn-completed") {
      settleSteps(null);
      return;
    }
    if (event.type === "workspace-sidebar-changed") {
      // Another session of the reader changed the order or the mutes.
      if (!event.memberId || env.isReader(event.memberId)) void loadHostSidebar();
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

  /**
   * The typing signals this client sends, per conversation or thread. `refresh` repeats the signal
   * while the entry lives, so the reader stays typing on the host also when the focus left the box.
   */
  const ownTyping = new Map<
    string,
    {
      channelId: string;
      threadRootId: string | null;
      refresh: ReturnType<typeof setInterval>;
      idle: ReturnType<typeof setTimeout>;
    }
  >();
  /** A person who stops typing for this long stops showing as typing, before the host's timeout. */
  const TYPING_IDLE_MS = 5_000;

  function sendTyping(channelId: string, threadRootId: string | null, typing: boolean) {
    const signal = channels.port().agent.channelTyping;
    if (!signal || !env.connectionReady()) return;
    void signal({ channelId, ...(threadRootId ? { threadRootId } : {}), typing }).catch(() => undefined);
  }

  /**
   * The reader edited a draft that has text (`typing`), or emptied it, sent it or left it. While the
   * last edit is less than `TYPING_IDLE_MS` old, the host hears `typing` every
   * `CHANNEL_TYPING_INTERVAL_MS`, wherever the focus is; it hears once when the reader stops.
   */
  function noteTyping(channelId: string, threadRootId: string | null, typing: boolean, sent = false) {
    const key = draftKey(channelId, threadRootId);
    const current = ownTyping.get(key);
    if (!typing) {
      if (!current) return;
      clearTimeout(current.idle);
      clearInterval(current.refresh);
      ownTyping.delete(key);
      // A sent message ends the typing on the host by itself.
      if (!sent) sendTyping(channelId, threadRootId, false);
      return;
    }
    const idle = setTimeout(() => noteTyping(channelId, threadRootId, false), TYPING_IDLE_MS);
    if (current) {
      clearTimeout(current.idle);
      current.idle = idle;
      return;
    }
    const refresh = setInterval(() => sendTyping(channelId, threadRootId, true), CHANNEL_TYPING_INTERVAL_MS);
    ownTyping.set(key, { channelId, threadRootId, refresh, idle });
    sendTyping(channelId, threadRootId, true);
  }
  onCleanup(() => {
    for (const entry of ownTyping.values()) {
      clearTimeout(entry.idle);
      clearInterval(entry.refresh);
      sendTyping(entry.channelId, entry.threadRootId, false);
    }
    ownTyping.clear();
  });

  // A list that a lost connection left can be stale: an agent that ended stays, or one that started
  // never shows. The host sends every list again when the event stream opens, so the lists go with
  // the connection, and the page's own tasks show the work until then.
  createEffect(
    () => env.connectionReady(),
    (ready) => {
      if (!ready && Object.keys(state.typing).length)
        setState((draft) => {
          draft.typing = {};
        });
    },
  );

  /**
   * The people who type and the agents that think, route, wait or work in a channel, or in one of its
   * threads, as the host last said. Null until the host says anything about the channel.
   */
  function typingIn(
    channelId: string,
    threadRootId: string | null,
  ): { humans: string[]; agents: { id: string; state: Exclude<ChannelTypingState, "typing"> }[] } | null {
    const entries = state.typing[channelId];
    if (!entries) return null;
    const humans: string[] = [];
    const agents: { id: string; state: Exclude<ChannelTypingState, "typing"> }[] = [];
    for (const entry of entries) {
      if ((entry.threadRootId ?? null) !== threadRootId) continue;
      if (entry.kind === "member") {
        if (entry.state === "typing" && !env.isReader(entry.id)) humans.push(entry.id);
      } else if (entry.state !== "typing") agents.push({ id: entry.id, state: entry.state });
    }
    return { humans, agents };
  }

  // ---------------------------------------------------------------- the place of the last session

  // The view or the thread that showed last comes back when the workspace starts, once per server.
  // Until then the place is not written, so the start does not replace it with the first screen.
  let placeShownFor: string | null = null;
  createEffect(
    () =>
      env.rememberPlace && channels.supported() && env.connectionReady() && channels.state.listed && spaces.settled()
        ? env.storageKey()
        : null,
    (key) => {
      if (!key || key === placeShownFor) return;
      placeShownFor = key;
      const place = readPlace(key);
      if (place.view && !channels.state.selectedId && viewAvailable(place.view)) {
        if (place.view === "agents") openAgentTalk(place.agentId ?? null);
        else openView(place.view);
      } else if (place.thread && channels.state.selectedId === place.thread.channelId)
        openThread(place.thread.channelId, place.thread.rootId);
    },
  );
  createEffect(
    () => {
      if (!env.rememberPlace || placeShownFor !== env.storageKey()) return null;
      const current = route();
      const panel = state.panel;
      const place: SavedPlace =
        // Only a view that the reader opened: the activity that shows when nothing is open is no choice.
        current.kind === "view" && state.view !== null
          ? { view: current.view, agentId: current.view === "agents" ? state.agentTalkAgentId : null }
          : current.kind === "channel" && panel?.kind === "thread" && panel.channelId === current.channelId
            ? { thread: { channelId: panel.channelId, rootId: panel.rootId } }
            : {};
      return { key: env.storageKey(), place };
    },
    (saved) => {
      if (saved) writePlace(saved.key, saved.place);
    },
  );

  // ---------------------------------------------------------------- navigation

  function openChannel(channelId: string) {
    reopenConversation(channelId);
    setState((draft) => {
      draft.view = null;
      draft.editing = null;
      draft.focus = null;
      if (draft.panel && draft.panel.channelId !== channelId) {
        draft.panel = null;
        draft.thread = null;
      }
    });
    setPhonePane("main");
    if (channels.state.selectedId !== channelId) void channels.open(channelId);
  }

  /** Whether the reader has a view on this server: some need a role or a host feature. */
  function viewAvailable(view: WorkspaceView): boolean {
    if (view === "secrets") return env.secrets?.() === true && Boolean(channels.port().agent.workspaceSecrets);
    // The owner and the admins: the same role as the key store, on a host that has the routes.
    if (view === "insights") return env.secrets?.() === true && Boolean(channels.port().agent.workspaceInsight);
    if (view === "storage") return Boolean(env.storageHygiene?.());
    if (view === "reviews") return Boolean(env.efficiency?.());
    if (view === "loops") return Boolean(channels.port().agent.workspaceLoops);
    if (view === "trust") return Boolean(env.trust?.());
    if (view === "routines") return env.routines?.available() === true;
    if (view === "later") return later.supported();
    if (view === "search") return search.supported();
    return true;
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
    followConversation(`${AGENT_DM_PREFIX}${agentId}`);
    if (!openedAgentIds().has(agentId)) setOpenedAgentIds((current) => new Set(current).add(agentId));
    reopenConversation(`${AGENT_DM_PREFIX}${agentId}`);
    if (dmIsMainChat(agentId)) {
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
    else void startDm([agentId]).catch((error: unknown) => failureToast(error, "workspace.app.error.openDm"));
  }

  /**
   * Opens a link to a message of this host in place: its channel, and its thread. A link to another
   * host, or to a channel the reader cannot see, is not handled and opens as a plain link.
   */
  function openLink(url: string): boolean {
    if (env.openAddress?.(url)) return true;
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

  /** Shows a view. `pane` is the pane that a phone shows after it; a store read in this batch is stale. */
  function openView(view: WorkspaceView, pane: WorkspacePhonePane = "main") {
    channels.close();
    setState((draft) => {
      draft.view = view;
      draft.panel = null;
      draft.thread = null;
      draft.editing = null;
    });
    setPhonePane(pane);
    if (view === "activity" || view === "threads") void refreshActivity();
    if (view === "unreads") void unreads.load();
    if (view === "later") later.refresh();
    if (view === "fleet") fleet.refresh?.();
    if (view === "artifacts") artifacts.refresh?.();
  }

  /** The Between agents view, with the talks of one agent, or of all when `agentId` is null. */
  function openAgentTalk(agentId: string | null) {
    setState((draft) => {
      draft.agentTalkAgentId = agentId;
    });
    openView("agents");
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
      draft.focus = null;
    });
    setPhonePane("panel");
    void loadThread(channelId, rootId);
  }

  /** Shows a message of a channel or of one of its threads, and marks it, as a link to it asks. */
  function focusMessage(channelId: string, messageId: string | null) {
    setState((draft) => {
      draft.focus = messageId ? { channelId, messageId } : null;
    });
  }

  function openDetails(channelId: string, tab: ChannelDetailsTab = "about") {
    setState((draft) => {
      draft.panel = { kind: "details", channelId, tab };
      draft.thread = null;
    });
    setPhonePane("panel");
  }

  /** Keeps the details tab the reader picked, so a re-render after a change does not reset it. */
  function setDetailsTab(tab: ChannelDetailsTab) {
    setState((draft) => {
      if (draft.panel?.kind === "details") draft.panel.tab = tab;
    });
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
      draft.focus = null;
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

  // The files of each draft. They are uploads on the host, so they stay in memory only, but a change
  // of conversation or thread, which makes a new composer, must not drop them.
  const [draftFileStore, setDraftFileStore] = createStore<Record<string, DraftAttachment[]>>({});
  function draftFiles(key: string): readonly DraftAttachment[] {
    return draftFileStore[key] ?? [];
  }
  function setDraftFiles(key: string, files: readonly DraftAttachment[]) {
    setDraftFileStore((current) => {
      if (files.length) current[key] = [...files];
      else delete current[key];
    });
  }

  function setDraft(key: string, text: string) {
    const changed = (state.drafts[key] ?? "") !== text;
    setState((draft) => {
      if (text) draft.drafts[key] = text;
      else delete draft.drafts[key];
    });
    if (changed)
      setDraftTimes((times) => {
        if (text.trim()) times[key] = Date.now();
        else delete times[key];
      });
    clearTimeout(draftTimer);
    draftTimer = setTimeout(() => {
      draftTimer = undefined;
      writeDrafts(env.storageKey(), state.drafts);
      writeDraftTimes(env.storageKey(), state.drafts, draftTimes);
    }, 400);
  }

  /**
   * The drafts of the space that shows that are not sent, newest change first, for Drafts & sent.
   * A space is Slack's workspace: its drafts are its own.
   */
  const draftEntries = createMemo(() =>
    Object.entries(state.drafts)
      .filter(([key, text]) => text.trim() && rowSpace(key.split("/")[0] ?? key) === spaces.current())
      .map(([key, text]) => {
        const [channelId = key, threadRootId] = key.split("/");
        return {
          key,
          channelId,
          threadRootId: threadRootId ?? null,
          text,
          at: draftTimes[key],
          fileCount: draftFileStore[key]?.length ?? 0,
        };
      })
      .sort((left, right) => (right.at ?? 0) - (left.at ?? 0)),
  );
  /** Throws a draft away: its text and its files. */
  function discardDraft(key: string) {
    for (const file of draftFiles(key))
      void channels
        .port()
        .agent.discardDraftAttachment?.(file.id)
        ?.catch(() => undefined);
    setDraftFiles(key, []);
    setDraft(key, "");
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

  /**
   * Turns hands-off mode of a channel on or off: its agents then never wait for a person. Reads the
   * current settings first, so a change that another admin made meanwhile stays.
   */
  async function setHandsOff(channelId: string, enabled: boolean): Promise<void> {
    const read = env.workspaceSettings;
    const save = env.saveWorkspaceSettings;
    if (!read || !save || env.reader().role === "member") return;
    try {
      const current = await read();
      const others = (current.handsOffChannelIds ?? []).filter((id) => id !== channelId);
      // Without `defaults.agents`, the host keeps the channel defaults of each agent as they are.
      const saved = await save({
        gate: current.gate,
        defaults: { agentAnswerMode: current.defaults.agentAnswerMode },
        handsOffChannelIds: enabled ? [...others, channelId] : others,
      });
      setState((draft) => {
        draft.settings = saved;
      });
    } catch (error) {
      failureToast(error, "workspace.app.handsOff.failed");
    }
  }

  /** How an agent added to a channel answers: its own default, else the workspace default. */
  async function newMember(agentId: string): Promise<ChannelMember> {
    const settings = await workspaceSettings();
    const own = agentChannelDefaults(settings, agentId);
    const answerMode = own.answerMode ?? settings?.defaults.agentAnswerMode ?? "mention";
    return { agentId, answerMode, ...(own?.focus ? { focus: own.focus } : {}) };
  }

  /** Sends one message of the outbox, with the operation id it got when the reader sent it. */
  async function deliver(message: OutboxMessage): Promise<void> {
    const mention = chatTagReferences(message.text).find(
      (reference) => reference.kind === "agent" && !message.text.slice(0, reference.start).trim(),
    );
    await channels.send({
      type: "send",
      operationId: message.id,
      channelId: message.channelId,
      text: message.text,
      recipientAgentId: message.threadRootId ? null : (mention?.id ?? null),
      replyToMessageId: null,
      attachmentDraftIds: message.attachmentDraftIds,
      ...(message.threadRootId ? { threadRootId: message.threadRootId } : {}),
      ...(message.threadRootId && message.alsoToChannel ? { alsoToChannel: true } : {}),
    });
    if (message.threadRootId && state.thread?.rootId === message.threadRootId)
      void loadThread(message.channelId, message.threadRootId, true);
    scheduleActivity(3_000);
  }
  const outbox = createWorkspaceOutbox({
    storageKey: env.storageKey,
    ready: () => channels.supported() && env.connectionReady(),
    deliver,
    describe: (error) => failureText(error, "workspace.app.outbox.failed"),
  });
  onCleanup(() => outbox.dispose());
  // The messages that waited for the connection leave when it is back, in the order they were written.
  createEffect(
    () => channels.supported() && env.connectionReady(),
    (ready) => {
      if (ready) outbox.connected();
    },
  );
  // The messages follow the reader and the server, as the drafts do.
  createEffect(env.storageKey, (key, previous) => {
    if (previous !== undefined && key !== previous) outbox.reload();
  });

  /**
   * Sends a message. It never waits for the connection: the outbox keeps it, shows it as sending, and
   * sends it once the host is reachable, so a phone between cells loses nothing the reader wrote.
   */
  function send(input: {
    channelId: string;
    text: string;
    attachmentDraftIds: string[];
    threadRootId?: string | null;
    alsoToChannel?: boolean;
  }): OutboxMessage {
    return outbox.add({
      key: draftKey(input.channelId, input.threadRootId),
      channelId: input.channelId,
      threadRootId: input.threadRootId ?? null,
      text: input.text,
      attachmentDraftIds: input.attachmentDraftIds,
      alsoToChannel: input.threadRootId ? input.alsoToChannel === true : false,
    });
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

  /** Puts a channel that the reader creates next in the space that shows, before it exists. */
  async function placeInSpace(channelId: string): Promise<void> {
    const spaceId = spaces.current();
    if (!spaces.available() || spaceId === GENERAL_SPACE_ID) return;
    await spaces.act({ kind: "place-channel", spaceId, channelId });
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
    await placeInSpace(channelId);
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

  /**
   * Opens the DM or group with these people and agents, and makes it when it does not exist. A
   * failure rejects: the New message dialog shows it in place, and the other callers in a toast.
   */
  async function startDm(memberIds: readonly string[]): Promise<void> {
    const agents = new Set(env.agents().map((agent) => agent.id));
    const agentIds = memberIds.filter((id) => agents.has(id));
    const people = memberIds.filter((id) => !agents.has(id));
    if (people.length === 0 && agentIds.length === 1 && agentIds[0] && dmIsMainChat(agentIds[0])) {
      openAgent(agentIds[0]);
      return;
    }
    const existing = existingDm(people, agentIds);
    if (existing) {
      openChannel(existing.id);
      return;
    }
    const channelId = crypto.randomUUID();
    // A DM with one agent follows that agent; a group or a DM of people is in the space that shows.
    if (people.length > 0 || agentIds.length !== 1) await placeInSpace(channelId);
    const channel = await command({
      type: "open-dm",
      operationId: crypto.randomUUID(),
      channelId,
      memberIds: people,
      agentIds,
    });
    await channels.refresh();
    openChannel(channel.id);
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

  /** Leaves a channel. A failure comes back as its message, for the confirm that asked. */
  async function leave(channelId: string): Promise<true | string> {
    try {
      await command({ type: "leave", operationId: crypto.randomUUID(), channelId });
    } catch (error) {
      return failureText(error, "workspace.app.error.leave");
    }
    closePanel();
    channels.close();
    openView("activity");
    return true;
  }

  /**
   * Leave from a menu: a private channel asks first, as in Slack, because the reader needs an invite
   * to come back; a public one leaves at once, and a failure shows in a toast.
   */
  function requestLeave(channelId: string): void {
    const channel = summary(channelId);
    if (channel && channelVisibility(channel) === "private") {
      openDialog({ kind: "leave", channelId });
      return;
    }
    void leave(channelId).then((result) => {
      if (result !== true) failureToast(new Error(result), "workspace.app.error.leave");
    });
  }

  /** Deletes a channel; it stays in Deleted channels. A failure comes back as its message. */
  async function archive(channelId: string): Promise<true | string> {
    try {
      await channels.remove(channelId);
    } catch (error) {
      return failureText(error, "workspace.app.error.archive");
    }
    closePanel();
    openView("activity");
    return true;
  }

  /** Adds people and agents. The dialog shows a failure in place: it gets the message instead of `false`. */
  async function invite(channelId: string, memberIds: readonly string[]): Promise<true | string> {
    try {
      const agents = new Set(env.agents().map((agent) => agent.id));
      const members = await Promise.all(memberIds.filter((id) => agents.has(id)).map(newMember));
      await command({
        type: "invite",
        operationId: crypto.randomUUID(),
        channelId,
        humanMemberIds: memberIds.filter((id) => !agents.has(id)),
        members,
      });
      return true;
    } catch (error) {
      return failureText(error, "workspace.app.error.invite");
    }
  }

  /** Takes a person or an agent out of a channel. A failure comes back as its message, for the confirm. */
  async function removeMember(channelId: string, memberId: string): Promise<true | string> {
    const agent = env.agents().some((candidate) => candidate.id === memberId);
    try {
      await command({
        type: "remove",
        operationId: crypto.randomUUID(),
        channelId,
        humanMemberIds: agent ? [] : [memberId],
        agentIds: agent ? [memberId] : [],
      });
      return true;
    } catch (error) {
      return failureText(error, "workspace.app.error.remove");
    }
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

  /** Changes the name, topic or description. The dialog shows a failure in place: it gets the message. */
  async function setMeta(
    channelId: string,
    change: { name?: string; topic?: string; description?: string },
  ): Promise<true | string> {
    try {
      await command({ type: "set-meta", operationId: crypto.randomUUID(), channelId, ...change });
      return true;
    } catch (error) {
      return failureText(error, "workspace.app.error.meta");
    }
  }

  /** Makes a channel public or private. Owners and admins only; the host checks it again. */
  async function setVisibility(channelId: string, visibility: "public" | "private") {
    return run(
      { type: "set-visibility", operationId: crypto.randomUUID(), channelId, visibility },
      "workspace.app.error.visibility",
    );
  }

  /**
   * Turns coordinator routing on or off, or picks its lead. Owners and admins only; the host checks
   * it again and refuses coordinator routing without a lead.
   */
  async function setRouting(channelId: string, routing: "responders" | "coordinator", leadAgentId?: string) {
    return run(
      {
        type: "set-routing",
        operationId: crypto.randomUUID(),
        channelId,
        routing,
        ...(leadAgentId ? { leadAgentId } : {}),
      },
      "workspace.app.error.routing",
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
      else void startDm([memberId]).catch((error: unknown) => failureToast(error, "workspace.app.error.openDm"));
    }
  }

  /** Whether the reader may manage the channel: owners and admins, and the person who made it. */
  function canManage(channel: { createdBy?: { kind: string; id: string } | undefined }) {
    const role = env.reader().role;
    if (role === "owner" || role === "admin") return true;
    return channel.createdBy?.kind === "member" && env.isReader(channel.createdBy.id);
  }

  /** Moves agents or channels to a space; the sidebar reads the spaces again from the answer. */
  async function moveToSpace(input: { agentIds?: string[]; channelIds?: string[] }, spaceId: string) {
    await spaces.act({ kind: "move", spaceId, ...input });
  }

  // ---------------------------------------------------------------- Jump to, search, Unreads, Later

  const frecency = createWorkspaceFrecency({ storageKey: env.storageKey, active: activeConversationId });
  const search = createWorkspaceSearch({
    channels,
    directory,
    storageKey: env.storageKey,
    connectionReady: env.connectionReady,
    currentSpace: () => (spaces.available() ? spaces.current() : null),
  });
  const later = createWorkspaceLater({
    channels,
    ready: () => channels.supported() && env.connectionReady(),
    storageKey: env.storageKey,
    isReader: env.isReader,
    onHostEvent: env.onHostEvent,
  });
  const unreads = createWorkspaceUnreads({
    channels,
    isReader: env.isReader,
    include: (channel) =>
      !channel.archived &&
      readerJoined(directory(), channel) &&
      !mutedSet().has(channel.id) &&
      spaces.channelInCurrent(channel.id),
    order: conversationOrder,
    connectionReady: env.connectionReady,
  });
  // Threads and Activity read again when a read position or a follow of the reader moves.
  onCleanup(
    env.onHostEvent((event) => {
      if (event.type === "workspace-read-state-changed" && (!event.memberId || env.isReader(event.memberId)))
        scheduleActivity(300);
    }),
  );
  /** The channel whose work a thread is, by the threads that the channel list names. */
  const channelOfThread = createMemo(() => {
    const byThread = new Map<string, string>();
    for (const channel of channels.state.channels)
      for (const thread of channel.threads ?? []) byThread.set(`${thread.agentId}\n${thread.threadId}`, channel.id);
    return byThread;
  });
  /**
   * Where a request is answered: the channel of its work (that the host names for a teammate's
   * delegated request, or that owns the thread), else the agent's chat.
   */
  function needsYouPlace(item: AgentAttentionItem): { channelId: string } | { agentId: string } {
    const channelId = item.channelId ?? channelOfThread().get(`${item.agentId}\n${item.threadId}`);
    return channelId ? { channelId } : { agentId: item.agentId };
  }
  /** The requests that wait for the reader in the space that shows, oldest first. */
  const needsYou = createMemo(() =>
    (env.needsYou?.() ?? []).filter((item) => {
      const place = needsYouPlace(item);
      return "channelId" in place ? spaces.channelInCurrent(place.channelId) : spaces.agentInCurrent(item.agentId);
    }),
  );
  /** Opens the chat that answers a request: the card waits at its end. */
  function openNeedsYou(item: AgentAttentionItem) {
    // A Motion ticket that waits on the reader opens in Motion.
    if (isTicketAttention(item)) {
      void channels.port().openUrl(item.url);
      return;
    }
    const place = needsYouPlace(item);
    if ("channelId" in place) openChannel(place.channelId);
    else openAgent(place.agentId);
  }

  /** Runs a message search and shows its results. */
  function openSearch(query?: string) {
    if (query?.trim()) search.submit(query);
    openView("search");
  }

  return {
    env,
    state,
    channels,
    frecency,
    search,
    later,
    unreads,
    openSearch,
    directory,
    spaces,
    selectSpace,
    spaceUnread,
    rowSpace,
    spaceActivity,
    spaceThreads,
    moveToSpace,
    /** Shows why a move to another space failed. */
    spaceFailure: (error: unknown) => failureToast(error, "workspace.spaces.moveFailed"),
    /** The agents of the space that shows, for pickers and views. */
    spaceAgents: () => env.agents().filter((agent) => spaces.agentInCurrent(agent.id)),
    route,
    activeConversationId,
    summary,
    sidebarChannels: sidebarChannelRows,
    sidebarDirectMessages: sidebarDirectRows,
    sidebarSections: sidebarSectionList,
    /** The drafts of the space that shows that are not sent, for the Drafts & sent row. */
    draftCount: () => draftEntries().length,
    updateSidebarPrefs,
    reorderSidebar,
    moveSidebarRow,
    setMuted,
    setGroupCollapsed,
    closeConversation,
    isMuted: (id: string) => mutedSet().has(id),
    notifyLevels,
    /** The level that notifications use: the bell's choice, "nothing" when muted, else null for the server's. */
    notifyLevel,
    /** The bell's choice, without mute. */
    chosenNotifyLevel: chosenLevel,
    setNotifyLevel,
    marks,
    setSidebarFilter,
    noteEmoji,
    setSkinTone,
    quickReactions,
    reactionPicker,
    activityCount,
    threadsUnread,
    needsYou,
    needsYouPlace,
    openNeedsYou,
    fleet,
    artifacts,
    artifactRecord: hostArtifacts.record,
    /** The host's image of a page that a message links, for its card. */
    artifactThumbnail: hostArtifacts.thumbnailFor,
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
    openAgentTalk,
    moveConversation,
    openThread,
    focusMessage,
    viewAvailable,
    reloadThread: () => {
      const thread = state.thread;
      if (thread) void loadThread(thread.channelId, thread.rootId);
    },
    openDetails,
    setDetailsTab,
    openArtifactsPanel,
    closePanel,
    back,
    openDialog,
    markRead,
    draft,
    setDraft,
    draftEntries,
    discardDraft,
    draftFiles,
    setDraftFiles,
    noteTyping,
    typingIn,
    refreshActivity,
    send,
    outbox,
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
    requestLeave,
    archive,
    invite,
    removeMember,
    setMember,
    setMeta,
    setVisibility,
    setRouting,
    linkDiscord,
    unlinkDiscord,
    messageMember,
    workspaceSettings,
    setHandsOff,
  };
}
