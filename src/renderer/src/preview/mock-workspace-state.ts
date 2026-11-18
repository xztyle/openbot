import type {
  AgentEvent,
  ChannelMessage,
  ChannelPage,
  ChannelReadInput,
  ChannelSummary,
  WorkspaceFollowThreadInput,
  WorkspaceReadThreadInput,
  WorkspaceThreadState,
  WorkspaceThreadStates,
  WorkspaceThreadStatesInput,
} from "@openbot/contracts/ipc";
import { WORKSPACE_FOLLOWED_THREADS_LIMIT } from "@openbot/contracts/ipc";

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
  };
}
