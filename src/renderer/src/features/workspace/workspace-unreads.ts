/*
 * Slack's All unreads: the unread messages of each conversation, grouped, in sidebar order. The view
 * reads them once when it opens and on Refresh; new unreads do not move the list under the reader,
 * a refresh button shows instead. Mark as read reads one group (with Undo where the host can mark a
 * message unread); Mark all read reads every group.
 */

import type { ChannelMessage, ChannelSummary } from "@openbot/contracts/ipc";
import { currentText } from "@openbot/ui/text";
import { createMemo, createStore } from "solid-js";
import { firstUnreadChannelMessageId } from "../channels/channel-conversation-rows";
import type { ChannelsController } from "../channels/channels-controller";
import { visibleEntry } from "./workspace-model";

export interface UnreadGroupState {
  channelId: string;
  /** The unread count of the channel when the group loaded. */
  unreadCount: number;
  /** The sequence a Mark as read reads through. */
  throughSequence: number;
  /** The first unread message: Undo marks the conversation unread from it again. */
  firstUnreadId: string | null;
  messages: ChannelMessage[];
  /** The reader marked it read here; the group stays, with Undo, until the next refresh. */
  read: boolean;
  collapsed: boolean;
}

interface UnreadsState {
  groups: UnreadGroupState[];
  loading: boolean;
  loaded: boolean;
  failed: boolean;
  /** The unread counts the groups loaded with, by channel, to see that new unreads came. */
  snapshot: Record<string, number>;
}

export interface WorkspaceUnreadsDeps {
  channels: ChannelsController;
  isReader: (id: string) => boolean;
  /** The conversations that count: joined, not muted, not archived, in the space that shows. */
  include: (channel: ChannelSummary) => boolean;
  /** The order of the sidebar, by conversation id. */
  order: () => readonly string[];
  connectionReady: () => boolean;
}

/** The most unread messages one group shows; the conversation holds the rest. */
const GROUP_MESSAGE_LIMIT = 50;

export function createWorkspaceUnreads(deps: WorkspaceUnreadsDeps) {
  const [state, setState] = createStore<UnreadsState>({
    groups: [],
    loading: false,
    loaded: false,
    failed: false,
    snapshot: {},
  });

  const unreadChannels = createMemo(() => {
    const rank = new Map(deps.order().map((id, index) => [id, index]));
    return deps.channels.state.channels
      .filter((channel) => channel.unreadCount > 0 && deps.include(channel))
      .sort(
        (left, right) =>
          (rank.get(left.id) ?? Number.MAX_SAFE_INTEGER) - (rank.get(right.id) ?? Number.MAX_SAFE_INTEGER) ||
          left.name.localeCompare(right.name),
      );
  });

  /** New unreads arrived since the groups loaded: the header offers a refresh. */
  const stale = createMemo(
    () => state.loaded && unreadChannels().some((channel) => channel.unreadCount > (state.snapshot[channel.id] ?? 0)),
  );

  let run = 0;
  async function load(): Promise<void> {
    if (!deps.connectionReady()) return;
    const current = ++run;
    const channels = unreadChannels();
    setState((draft) => {
      draft.loading = true;
      draft.failed = false;
    });
    const results = await Promise.allSettled(
      channels.map(async (channel): Promise<UnreadGroupState> => {
        const page = await deps.channels.port().agent.readChannel({ channelId: channel.id });
        const firstUnreadId = firstUnreadChannelMessageId(page.messages, channel.unreadCount, deps.isReader);
        const start = firstUnreadId ? page.messages.findIndex((message) => message.id === firstUnreadId) : -1;
        const unread = (start >= 0 ? page.messages.slice(start) : page.messages.slice(-channel.unreadCount)).filter(
          visibleEntry,
        );
        return {
          channelId: channel.id,
          unreadCount: channel.unreadCount,
          throughSequence: page.throughSequence,
          firstUnreadId,
          messages: unread.slice(-GROUP_MESSAGE_LIMIT),
          read: false,
          collapsed: false,
        };
      }),
    );
    if (current !== run) return;
    const groups = results.flatMap((result) => (result.status === "fulfilled" ? [result.value] : []));
    setState((draft) => {
      draft.groups = groups;
      draft.loading = false;
      draft.loaded = true;
      draft.failed = groups.length === 0 && results.some((result) => result.status === "rejected");
      draft.snapshot = Object.fromEntries(channels.map((channel) => [channel.id, channel.unreadCount]));
    });
  }

  function patch(channelId: string, change: (group: UnreadGroupState) => void) {
    setState((draft) => {
      const group = draft.groups.find((item) => item.channelId === channelId);
      if (group) change(group);
    });
  }

  /** Reads one group. A failure throws, in the reader's language. */
  async function markRead(channelId: string): Promise<void> {
    const group = state.groups.find((item) => item.channelId === channelId);
    if (!group || group.read) return;
    patch(channelId, (item) => {
      item.read = true;
      item.collapsed = true;
    });
    try {
      await deps.channels.port().agent.channelCommand({
        type: "read",
        channelId,
        throughSequence: group.throughSequence,
        operationId: crypto.randomUUID(),
      });
    } catch (error) {
      patch(channelId, (item) => {
        item.read = false;
        item.collapsed = false;
      });
      const text = currentText();
      throw new Error(text.errorMessage(error, text.t("workspace.unreads.markFailed")));
    }
  }

  /** Whether the host can mark a message unread, for Undo. */
  const canUndo = () => Boolean(deps.channels.port().agent.workspaceMarkUnread);

  /** Undoes a Mark as read: the conversation is unread again from its first unread message. */
  async function undo(channelId: string): Promise<void> {
    const group = state.groups.find((item) => item.channelId === channelId);
    const mark = deps.channels.port().agent.workspaceMarkUnread;
    if (!group?.read || !group.firstUnreadId || !mark) return;
    patch(channelId, (item) => {
      item.read = false;
      item.collapsed = false;
    });
    try {
      await mark({ operationId: crypto.randomUUID(), channelId, messageId: group.firstUnreadId });
      setState((draft) => {
        draft.snapshot[channelId] = group.unreadCount;
      });
    } catch (error) {
      patch(channelId, (item) => {
        item.read = true;
      });
      const text = currentText();
      throw new Error(text.errorMessage(error, text.t("workspace.unreads.undoFailed")));
    }
  }

  /** Reads every group that shows. */
  async function markAllRead(): Promise<void> {
    const ids = state.groups.filter((group) => !group.read).map((group) => group.channelId);
    if (!ids.length) return;
    await deps.channels.markAllRead(ids);
    setState((draft) => {
      draft.groups = [];
      draft.snapshot = {};
    });
  }

  return {
    state,
    stale,
    canUndo,
    /** Unread conversations, for the sidebar row. */
    hasUnread: () => unreadChannels().length > 0,
    load,
    markRead,
    undo,
    markAllRead,
    toggle(channelId: string) {
      patch(channelId, (group) => {
        group.collapsed = !group.collapsed;
      });
    },
    setCollapsed(channelId: string, collapsed: boolean) {
      patch(channelId, (group) => {
        group.collapsed = collapsed;
      });
    },
  };
}

export type WorkspaceUnreads = ReturnType<typeof createWorkspaceUnreads>;
