import type {
  AgentEvent,
  ChannelMessage,
  ChannelPage,
  ChannelReadInput,
  ChannelSummary,
  WorkspaceFollowThreadInput,
  WorkspaceMarkUnreadInput,
  WorkspaceReadPosition,
  WorkspaceReadThreadInput,
  WorkspaceSearchHit,
  WorkspaceSearchInput,
  WorkspaceSearchPage,
  WorkspaceThreadState,
  WorkspaceThreadStates,
  WorkspaceThreadStatesInput,
} from "@openbot/contracts/ipc";
import {
  WORKSPACE_FOLLOWED_THREADS_LIMIT,
  WORKSPACE_SEARCH_SNIPPET_LIMIT,
  workspaceSearchLimit,
} from "@openbot/contracts/ipc";
import { markdownPreviewText } from "@openbot/contracts/markdown-preview-text";

/** Lowercase without accents, as the host's index reads words. */
function fold(text: string): string {
  return text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
}

/** What the preview's workspace state reads from the preview channels. */
export interface MockWorkspaceStateChannels {
  listChannels(): Promise<ChannelSummary[]>;
  readChannel(input: ChannelReadInput): Promise<ChannelPage>;
}

/**
 * The preview's thread read positions and follows, as the host keeps them for one person: a thread
 * is followed when the person wrote its root or a reply, a reply mentions them, or it is in a DM or a
 * group, unless they chose otherwise; a reply after their position that they did not write is unread.
 */
export function createMockWorkspaceState(
  emit: (event: AgentEvent) => void,
  channels: MockWorkspaceStateChannels,
  memberId: string,
) {
  const positions = new Map<string, number>();
  const choices = new Map<string, boolean>();
  const key = (channelId: string, rootId: string) => `${channelId}\n${rootId}`;
  const own = (message: ChannelMessage) => message.author.kind === "member" && message.author.id === memberId;

  async function state(channelId: string, rootId: string): Promise<WorkspaceThreadState | null> {
    const list = await channels.listChannels();
    const channel = list.find((item) => item.id === channelId);
    if (!channel) throw new Error("Channel not found.");
    const page = await channels.readChannel({ channelId, threadRootId: rootId }).catch(() => null);
    const [root, ...replies] = page?.messages ?? [];
    if (!root || root.threadRootId !== undefined) return null;
    const through = positions.get(key(channelId, rootId)) ?? 0;
    const automatic =
      (channel.kind !== undefined && channel.kind !== "channel") ||
      own(root) ||
      replies.some(
        (reply) =>
          own(reply) || (reply.mentions ?? []).some((mention) => mention.kind === "member" && mention.id === memberId),
      );
    return {
      channelId,
      rootId,
      followed: choices.get(key(channelId, rootId)) ?? automatic,
      throughSequence: through,
      unreadCount: replies.filter((reply) => reply.sequence > through && !own(reply)).length,
    };
  }

  async function requireState(channelId: string, rootId: string): Promise<WorkspaceThreadState> {
    const found = await state(channelId, rootId);
    if (!found) throw new Error("This thread is unavailable.");
    return found;
  }

  return {
    workspaceThreadStates: async (input: WorkspaceThreadStatesInput): Promise<WorkspaceThreadStates> => {
      const rootIds =
        input.rootIds ??
        (await channels.readChannel({ channelId: input.channelId })).messages
          .filter((message) => (message.threadSummary?.replyCount ?? 0) > 0)
          .map((message) => message.id);
      const states = await Promise.all(rootIds.map((rootId) => state(input.channelId, rootId)));
      return {
        channelId: input.channelId,
        threads: states
          .filter(
            (item): item is WorkspaceThreadState => item !== null && (input.rootIds !== undefined || item.followed),
          )
          .slice(0, WORKSPACE_FOLLOWED_THREADS_LIMIT),
      };
    },
    workspaceReadThread: async (input: WorkspaceReadThreadInput): Promise<WorkspaceThreadState> => {
      const id = key(input.channelId, input.threadRootId);
      const before = positions.get(id) ?? 0;
      if (input.throughSequence > before) positions.set(id, input.throughSequence);
      const after = await requireState(input.channelId, input.threadRootId);
      if (after.throughSequence !== before)
        emit({ type: "workspace-read-state-changed", channelId: input.channelId, threadRootId: input.threadRootId });
      return after;
    },
    workspaceFollowThread: async (input: WorkspaceFollowThreadInput): Promise<WorkspaceThreadState> => {
      choices.set(key(input.channelId, input.threadRootId), input.followed);
      const after = await requireState(input.channelId, input.threadRootId);
      emit({ type: "workspace-read-state-changed", channelId: input.channelId, threadRootId: input.threadRootId });
      return after;
    },
    /** The preview's message search: each word must start a word of the message, as on the host. */
    workspaceSearch: async (input: WorkspaceSearchInput): Promise<WorkspaceSearchPage> => {
      const words = fold(input.query)
        .split(/\s+/u)
        .filter((word) => word.length > 0 && !word.startsWith("-"))
        .map((word) => word.replaceAll('"', ""));
      if (!words.length) return { hits: [], total: 0, nextCursor: null };
      const hits: WorkspaceSearchHit[] = [];
      for (const channel of await channels.listChannels()) {
        if (input.channelIds && !input.channelIds.includes(channel.id)) continue;
        const page = await channels.readChannel({ channelId: channel.id });
        const threads = await Promise.all(
          page.messages
            .filter((message) => (message.threadSummary?.replyCount ?? 0) > 0)
            .map((root) => channels.readChannel({ channelId: channel.id, threadRootId: root.id })),
        );
        const messages = [...page.messages, ...threads.flatMap((thread) => thread.messages.slice(1))];
        for (const message of messages) {
          const text = markdownPreviewText(message.message.text);
          const folded = fold(text);
          const tokens = folded.split(/[^\p{L}\p{N}]+/u);
          const starts = (word: string) => tokens.some((token) => token.startsWith(word));
          if (message.deletedAt || !words.every(starts)) continue;
          if (input.authorIds && !input.authorIds.includes(message.author.id)) continue;
          if (input.threadsOnly && !message.threadRootId && !(message.threadSummary?.replyCount ?? 0)) continue;
          const at = folded.indexOf(words[0] ?? "");
          hits.push({
            channelId: channel.id,
            messageId: message.id,
            sequence: message.sequence,
            ...(message.threadRootId ? { threadRootId: message.threadRootId } : {}),
            author: { kind: message.author.kind, id: message.author.id, name: message.author.name },
            at: message.message.createdAt,
            snippet: text.slice(0, WORKSPACE_SEARCH_SNIPPET_LIMIT),
            highlights:
              at >= 0 && at < WORKSPACE_SEARCH_SNIPPET_LIMIT ? [{ start: at, length: (words[0] ?? "").length }] : [],
          });
        }
      }
      hits.sort((left, right) => right.at.localeCompare(left.at));
      const offset = input.cursor ? Number(input.cursor) : 0;
      const limit = workspaceSearchLimit(input);
      const next = offset + limit;
      return {
        hits: hits.slice(offset, next),
        total: hits.length,
        nextCursor: next < hits.length ? String(next) : null,
      };
    },
    workspaceMarkUnread: async (input: WorkspaceMarkUnreadInput): Promise<WorkspaceReadPosition> => {
      const page = await channels.readChannel({
        channelId: input.channelId,
        ...(input.threadRootId ? { threadRootId: input.threadRootId } : {}),
      });
      const message = page.messages.find((item) => item.id === input.messageId);
      if (!message) throw new Error("This message is unavailable.");
      const throughSequence = Math.max(0, message.sequence - 1);
      if (input.threadRootId) {
        positions.set(key(input.channelId, input.threadRootId), throughSequence);
        const after = await requireState(input.channelId, input.threadRootId);
        emit({ type: "workspace-read-state-changed", channelId: input.channelId, threadRootId: input.threadRootId });
        return {
          channelId: input.channelId,
          threadRootId: input.threadRootId,
          throughSequence,
          unreadCount: after.unreadCount,
        };
      }
      emit({ type: "workspace-read-state-changed", channelId: input.channelId });
      return {
        channelId: input.channelId,
        throughSequence,
        unreadCount: page.messages.filter((item) => item.sequence > throughSequence && !own(item)).length,
      };
    },
  };
}
