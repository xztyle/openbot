import type {
  AgentEvent,
  Channel,
  ChannelCommand,
  ChannelMemory,
  ChannelMessage,
  ChannelPage,
  ChannelRoutine,
  ChannelRoutineRun,
  ChannelSummary,
  ChannelTask,
  CreateChannelMemoryInput,
  CreateChannelRoutineInput,
  DeleteChannelMemoryInput,
  DeleteChannelRoutineInput,
  ListChannelRoutineRunsInput,
  RoutineSchedule,
  RoutineTrigger,
  TestChannelRoutineInput,
  UpdateChannelMemoryInput,
  UpdateChannelRoutineInput,
} from "@openbot/contracts/ipc";
import { channelMentions, channelRoutingConversationEventItemType } from "@openbot/contracts/ipc";

/** The preview's own person: every message the preview sends is theirs. */
const PREVIEW_MEMBER_ID = "preview";

import { markdownPreviewText } from "@openbot/contracts/markdown-preview-text";

/** A channel that exists when the preview starts, with its history. */
export interface MockChannelSeed {
  channel: Channel;
  messages: ChannelMessage[];
}

export function createMockChannels(
  emit: (event: AgentEvent) => void,
  agentName: (agentId: string) => string,
  seeds: readonly MockChannelSeed[] = [],
) {
  const channels = new Map<string, Channel>(seeds.map((seed) => [seed.channel.id, structuredClone(seed.channel)]));
  const messages = new Map<string, ChannelMessage[]>(
    seeds.map((seed) => [seed.channel.id, structuredClone(seed.messages)]),
  );
  const tasks = new Map<string, ChannelTask[]>();
  const receipts = new Map<string, Channel>();
  const memories = new Map<string, ChannelMemory[]>();
  const routines = new Map<string, ChannelRoutine[]>();
  const routineRuns = new Map<string, ChannelRoutineRun[]>();
  const changed = (channelId: string, revision: number) => emit({ type: "channels-changed", channelId, revision });
  const messageChanged = (channel: Channel, message: ChannelMessage) =>
    emit({
      type: "channel-message",
      channelId: channel.id,
      message: structuredClone(message),
      revision: channel.revision,
    });
  /** The transcript leaves out thread replies and deleted messages, as the host does. */
  const topLevel = (message: ChannelMessage) =>
    (message.threadRootId === undefined || message.alsoInChannel === true) &&
    (message.deletedAt === undefined || (message.threadSummary?.replyCount ?? 0) > 0);
  const findMessage = (channelId: string, messageId: string) => {
    const message = (messages.get(channelId) ?? []).find((item) => item.id === messageId);
    if (!message || message.deletedAt) throw new Error("This message is unavailable.");
    return message;
  };
  /** The workspace commands of the preview: the same shapes as the host, without the task routing. */
  const applyWorkspace = (input: ChannelCommand, channel: Channel): Channel | null => {
    const humans = channel.humanMemberIds ?? [];
    switch (input.type) {
      case "join":
        return { ...channel, humanMemberIds: [...new Set([...humans, PREVIEW_MEMBER_ID])] };
      case "leave":
        return { ...channel, humanMemberIds: humans.filter((id) => id !== PREVIEW_MEMBER_ID) };
      case "invite": {
        const known = new Set(channel.members.map((member) => member.agentId));
        return {
          ...channel,
          humanMemberIds: [...new Set([...humans, ...input.humanMemberIds])],
          members: [
            ...channel.members,
            ...input.members
              .filter((member) => !known.has(member.agentId))
              .map((member) => ({ ...member, answerMode: member.answerMode ?? "mention" })),
          ],
        };
      }
      case "remove":
        return {
          ...channel,
          humanMemberIds: humans.filter((id) => !input.humanMemberIds.includes(id)),
          members: channel.members.filter((member) => !input.agentIds.includes(member.agentId)),
          leadAgentId: channel.leadAgentId && input.agentIds.includes(channel.leadAgentId) ? null : channel.leadAgentId,
        };
      case "set-member":
        return {
          ...channel,
          members: channel.members.map((member) => {
            if (member.agentId !== input.agentId) return member;
            const { answerMode, focus, ...rest } = member;
            const mode = input.answerMode === undefined ? answerMode : (input.answerMode ?? undefined);
            const note = input.focus === undefined ? focus : input.focus?.trim() || undefined;
            return { ...rest, ...(mode ? { answerMode: mode } : {}), ...(note ? { focus: note } : {}) };
          }),
        };
      case "link-discord":
        return {
          ...channel,
          discordLink: {
            connectionId: input.connectionId,
            channelId: input.discordChannelId,
            channelName: "general",
            webhook: true,
          },
        };
      case "unlink-discord": {
        const { discordLink: _removed, ...rest } = channel;
        return rest;
      }
      case "set-meta":
        return {
          ...channel,
          name: input.name?.trim() || channel.name,
          ...(input.topic === undefined ? {} : { topic: input.topic }),
          ...(input.description === undefined ? {} : { description: input.description }),
        };
      case "react": {
        const message = findMessage(channel.id, input.messageId);
        const actor = { kind: "member" as const, id: PREVIEW_MEMBER_ID };
        const reactions = (message.reactions ?? []).map((reaction) => ({
          ...reaction,
          actors: reaction.actors.filter((item) => !(reaction.emoji === input.emoji && item.id === actor.id)),
        }));
        if (input.action === "add") {
          const existing = reactions.find((reaction) => reaction.emoji === input.emoji);
          if (existing) existing.actors.push(actor);
          else reactions.push({ emoji: input.emoji, actors: [actor] });
        }
        message.reactions = reactions.filter((reaction) => reaction.actors.length > 0);
        messageChanged(channel, message);
        return channel;
      }
      case "edit": {
        const message = findMessage(channel.id, input.messageId);
        if (message.author.id !== PREVIEW_MEMBER_ID) throw new Error("You can edit only your own messages.");
        message.message = { ...message.message, text: input.text };
        message.editedAt = new Date().toISOString();
        const mentions = channelMentions(input.text);
        if (mentions.length) message.mentions = mentions;
        else delete message.mentions;
        messageChanged(channel, message);
        return channel;
      }
      case "delete": {
        const message = findMessage(channel.id, input.messageId);
        message.deletedAt = new Date().toISOString();
        message.message = { ...message.message, text: "" };
        delete message.reactions;
        if (topLevel(message) || message.threadRootId) messageChanged(channel, message);
        else
          emit({
            type: "channel-message-removed",
            channelId: channel.id,
            messageId: message.id,
            revision: channel.revision,
          });
        return channel;
      }
      default:
        return null;
    }
  };
  const requireChannel = (id: string) => {
    const channel = channels.get(id);
    if (!channel) throw new Error("Channel not found.");
    return channel;
  };
  return {
    listChannels: async (): Promise<ChannelSummary[]> =>
      [...channels.values()].map((channel) => {
        const latest = (messages.get(channel.id) ?? []).at(-1);
        return {
          ...structuredClone(channel),
          unreadCount: 0,
          activeTasks: (tasks.get(channel.id) ?? []).filter((task) => task.state === "running").length,
          lastMessage: latest
            ? {
                authorName: latest.author.name,
                text: markdownPreviewText(latest.message.text),
                at: latest.message.createdAt,
              }
            : null,
        };
      }),
    readChannel: async ({
      channelId,
      threadRootId,
    }: {
      channelId: string;
      threadRootId?: string;
    }): Promise<ChannelPage> => {
      const all = messages.get(channelId) ?? [];
      const root = threadRootId ? all.find((message) => message.id === threadRootId) : undefined;
      if (threadRootId && !root) throw new Error("This thread is unavailable.");
      return {
        channel: structuredClone(requireChannel(channelId)),
        messages: structuredClone(
          root
            ? [root, ...all.filter((message) => message.threadRootId === root.id && !message.deletedAt)]
            : all.filter(topLevel),
        ),
        tasks: structuredClone(tasks.get(channelId) ?? []),
        olderCursor: null,
        throughSequence: all.length,
        ...(root ? { threadRootId: root.id } : {}),
      };
    },
    channelCommand: async (input: ChannelCommand): Promise<Channel> => {
      const receipt = receipts.get(input.operationId);
      if (receipt) return structuredClone(receipt);
      if (input.type === "create" || input.type === "open-dm") {
        const humans = [
          ...new Set([PREVIEW_MEMBER_ID, ...(input.type === "create" ? input.humanMemberIds : input.memberIds)]),
        ];
        const agentIds = input.type === "create" ? input.members.map((member) => member.agentId) : input.agentIds;
        const kind =
          input.type === "create"
            ? input.kind
            : humans.length + agentIds.length === 2
              ? ("dm" as const)
              : ("group" as const);
        const existing =
          input.type === "open-dm"
            ? [...channels.values()].find(
                (item) =>
                  item.kind === kind &&
                  (item.humanMemberIds ?? []).length === humans.length &&
                  humans.every((id) => item.humanMemberIds?.includes(id)) &&
                  item.members.length === agentIds.length &&
                  agentIds.every((id) => item.members.some((member) => member.agentId === id)),
              )
            : undefined;
        if (existing) return structuredClone(existing);
        const created: Channel = {
          id: input.channelId,
          name:
            input.type === "create"
              ? input.name
              : ["You", ...agentIds.map(agentName), ...humans.slice(1)].join(", ").slice(0, 80),
          title: input.type === "create" ? (input.title ?? "") : "",
          instructions: input.type === "create" ? (input.instructions ?? "") : "",
          members: agentIds.map((agentId) => ({
            agentId,
            answerMode:
              (input.type === "create"
                ? input.members.find((member) => member.agentId === agentId)?.answerMode
                : undefined) ?? (kind === "dm" ? "always-no-gate" : "mention"),
          })),
          leadAgentId: input.type === "create" ? (input.leadAgentId ?? null) : null,
          archived: false,
          revision: 1,
          createdAt: new Date().toISOString(),
          kind,
          visibility: kind === "channel" && input.type === "create" ? input.visibility : "private",
          humanMemberIds: humans,
          createdBy: { kind: "member", id: PREVIEW_MEMBER_ID },
          ...(input.type === "create" && input.topic ? { topic: input.topic } : {}),
        };
        channels.set(created.id, structuredClone(created));
        messages.set(created.id, []);
        receipts.set(input.operationId, structuredClone(created));
        changed(created.id, created.revision);
        return structuredClone(created);
      }
      const workspace = applyWorkspace(input, requireChannel(input.channelId));
      if (workspace) {
        const next = { ...workspace, revision: workspace.revision + 1 };
        channels.set(next.id, structuredClone(next));
        receipts.set(input.operationId, structuredClone(next));
        changed(next.id, next.revision);
        return structuredClone(next);
      }
      let channel =
        input.type === "save"
          ? {
              ...input.draft,
              id: input.channelId,
              revision: channels.get(input.channelId)?.revision ?? 0,
              archived: channels.get(input.channelId)?.archived ?? false,
              createdAt: channels.get(input.channelId)?.createdAt ?? new Date().toISOString(),
            }
          : requireChannel(input.channelId);
      channel = { ...channel, revision: channel.revision + 1 };
      if (input.type === "archive" || input.type === "restore") channel.archived = input.type === "archive";
      const work = tasks.get(channel.id) ?? [];
      if (input.type === "archive")
        for (const task of work) {
          if (task.state !== "completed" && task.state !== "cancelled") task.state = "paused";
        }
      if (input.type === "stop" || input.type === "resume" || input.type === "reassign") {
        const task = work.find((item) => item.id === input.taskId);
        if (!task) throw new Error("Channel task not found.");
        task.state = input.type === "stop" ? "paused" : "queued";
        task.revision += 1;
        if (input.type === "reassign") task.ownerAgentId = input.recipientAgentId;
      }
      if (input.type === "send") {
        const list = messages.get(channel.id) ?? [];
        const id = crypto.randomUUID();
        const taskId = crypto.randomUUID();
        // The real service routes a request with no recipient through the lead's model and posts the
        // choice as a channel message. It skips both when the answer is already known: a named
        // recipient, or a channel with one member. The preview has no model, so it keeps assigning
        // the lead, but it reproduces which requests get a visible dispatch row and which do not.
        const routed = !input.recipientAgentId && channel.members.length > 1 && channel.leadAgentId !== null;
        work.push({
          id: taskId,
          channelId: channel.id,
          rootTaskId: taskId,
          parentTaskId: null,
          ownerAgentId: input.recipientAgentId ?? channel.leadAgentId,
          requestMessageId: id,
          instruction: input.text,
          attachmentDraftIds: input.attachmentDraftIds,
          expectedResult: "Complete the requested work and report the result.",
          sourceMessageIds: [id],
          dependencies: [],
          resources: ["host"],
          state: "queued",
          revision: 0,
          assignmentCount: 0,
          error: null,
        });
        const threadRootId = input.threadRootId ?? undefined;
        const mentions = channelMentions(input.text);
        const sent: ChannelMessage = {
          id,
          channelId: channel.id,
          sequence: list.length + 1,
          author: { kind: "member", id: PREVIEW_MEMBER_ID, name: "You" },
          taskId,
          superseded: false,
          message: {
            id,
            author: "user",
            text: input.text,
            createdAt: new Date().toISOString(),
            status: "completed",
            replyToMessageId: input.replyToMessageId,
          },
          ...(threadRootId ? { threadRootId } : {}),
          ...(threadRootId && input.alsoToChannel ? { alsoInChannel: true } : {}),
          ...(mentions.length ? { mentions } : {}),
        };
        list.push(sent);
        const root = threadRootId ? list.find((message) => message.id === threadRootId) : undefined;
        if (root) {
          root.threadSummary = {
            replyCount: (root.threadSummary?.replyCount ?? 0) + 1,
            lastReplyAt: sent.message.createdAt,
            participantIds: [
              PREVIEW_MEMBER_ID,
              ...(root.threadSummary?.participantIds ?? []).filter((item) => item !== PREVIEW_MEMBER_ID),
            ],
          };
          messageChanged(channel, root);
        }
        messageChanged(channel, sent);
        if (routed && channel.leadAgentId) {
          const dispatchId = crypto.randomUUID();
          // The name is resolved from the agent roster by the timeline, so the id stands in for it.
          list.push({
            id: dispatchId,
            channelId: channel.id,
            sequence: list.length + 1,
            author: { kind: "agent", id: channel.leadAgentId, name: agentName(channel.leadAgentId) },
            taskId,
            superseded: false,
            message: {
              id: dispatchId,
              author: "system",
              text: `Assigned to ${agentName(channel.leadAgentId)}.`,
              createdAt: new Date().toISOString(),
              status: "completed",
              itemType: channelRoutingConversationEventItemType("assigned", channel.leadAgentId),
            },
          });
        }
        messages.set(channel.id, list);
      }
      tasks.set(channel.id, work);
      channels.set(channel.id, structuredClone(channel));
      receipts.set(input.operationId, structuredClone(channel));
      changed(channel.id, channel.revision);
      return structuredClone(channel);
    },
    deleteChannel: async (channelId: string): Promise<void> => {
      requireChannel(channelId);
      channels.delete(channelId);
      messages.delete(channelId);
      tasks.delete(channelId);
      memories.delete(channelId);
      const channelRoutines = routines.get(channelId) ?? [];
      routines.delete(channelId);
      for (const routine of channelRoutines) routineRuns.delete(routine.id);
      emit({ type: "channels-changed", channelId, revision: 0 });
    },
    listChannelMemories: async (channelId: string): Promise<ChannelMemory[]> => {
      requireChannel(channelId);
      return structuredClone(memories.get(channelId) ?? []);
    },
    createChannelMemory: async (input: CreateChannelMemoryInput): Promise<ChannelMemory> => {
      requireChannel(input.channelId);
      const now = new Date().toISOString();
      const memory: ChannelMemory = {
        id: crypto.randomUUID(),
        channelId: input.channelId,
        text: input.text.trim(),
        origin: "manual",
        sourceTurnId: null,
        createdAt: now,
        updatedAt: now,
      };
      memories.set(input.channelId, [...(memories.get(input.channelId) ?? []), memory]);
      emit({ type: "channel-memories-changed", channelId: input.channelId });
      return structuredClone(memory);
    },
    updateChannelMemory: async (input: UpdateChannelMemoryInput): Promise<ChannelMemory> => {
      const current = memories.get(input.channelId)?.find((memory) => memory.id === input.memoryId);
      if (!current) throw new Error("This memory no longer exists.");
      const updated = { ...current, text: input.text.trim(), updatedAt: new Date().toISOString() };
      memories.set(
        input.channelId,
        (memories.get(input.channelId) ?? []).map((memory) => (memory.id === input.memoryId ? updated : memory)),
      );
      emit({ type: "channel-memories-changed", channelId: input.channelId });
      return structuredClone(updated);
    },
    deleteChannelMemory: async (input: DeleteChannelMemoryInput): Promise<void> => {
      memories.set(
        input.channelId,
        (memories.get(input.channelId) ?? []).filter((memory) => memory.id !== input.memoryId),
      );
      emit({ type: "channel-memories-changed", channelId: input.channelId });
    },
    clearChannelMemories: async (channelId: string): Promise<void> => {
      memories.delete(channelId);
      emit({ type: "channel-memories-changed", channelId });
    },
    listChannelRoutines: async (channelId: string): Promise<ChannelRoutine[]> => {
      requireChannel(channelId);
      return structuredClone(routines.get(channelId) ?? []);
    },
    createChannelRoutine: async (input: CreateChannelRoutineInput): Promise<ChannelRoutine> => {
      requireChannel(input.channelId);
      const now = new Date().toISOString();
      const id = crypto.randomUUID();
      const routine: ChannelRoutine = {
        id,
        channelId: input.channelId,
        name: input.name.trim(),
        instruction: input.instruction.trim(),
        active: input.active,
        timezone: input.timezone,
        limitPolicy: input.limitPolicy ?? "wait",
        missedPolicy: input.missedPolicy ?? "skip",
        trigger: nextTrigger(id, input.schedule, now),
        createdAt: now,
        updatedAt: now,
      };
      routines.set(input.channelId, [routine, ...(routines.get(input.channelId) ?? [])]);
      emit({ type: "channel-routines-changed", channelId: input.channelId });
      return structuredClone(routine);
    },
    updateChannelRoutine: async (input: UpdateChannelRoutineInput): Promise<ChannelRoutine> => {
      const current = routines.get(input.channelId)?.find((routine) => routine.id === input.routineId);
      if (!current) throw new Error("Routine not found.");
      const now = new Date().toISOString();
      const updated: ChannelRoutine = {
        ...current,
        ...(input.name === undefined ? {} : { name: input.name.trim() }),
        ...(input.instruction === undefined ? {} : { instruction: input.instruction.trim() }),
        ...(input.active === undefined ? {} : { active: input.active }),
        ...(input.limitPolicy === undefined ? {} : { limitPolicy: input.limitPolicy }),
        ...(input.missedPolicy === undefined ? {} : { missedPolicy: input.missedPolicy }),
        ...(input.schedule === undefined ? {} : { trigger: nextTrigger(current.id, input.schedule, now) }),
        updatedAt: now,
      };
      routines.set(
        input.channelId,
        (routines.get(input.channelId) ?? []).map((routine) => (routine.id === current.id ? updated : routine)),
      );
      emit({ type: "channel-routines-changed", channelId: input.channelId });
      return structuredClone(updated);
    },
    deleteChannelRoutine: async (input: DeleteChannelRoutineInput): Promise<void> => {
      routines.set(
        input.channelId,
        (routines.get(input.channelId) ?? []).filter((routine) => routine.id !== input.routineId),
      );
      routineRuns.delete(input.routineId);
      emit({ type: "channel-routines-changed", channelId: input.channelId });
    },
    testChannelRoutine: async (input: TestChannelRoutineInput): Promise<ChannelRoutineRun> => {
      const routine = routines.get(input.channelId)?.find((candidate) => candidate.id === input.routineId);
      if (!routine) throw new Error("Routine not found.");
      const now = new Date().toISOString();
      const run: ChannelRoutineRun = {
        id: crypto.randomUUID(),
        channelId: input.channelId,
        routineId: routine.id,
        triggerId: null,
        kind: "manual",
        scheduledFor: now,
        routineName: routine.name,
        instruction: routine.instruction,
        requestMessageId: crypto.randomUUID(),
        status: "queued",
        error: null,
        createdAt: now,
        updatedAt: now,
      };
      routineRuns.set(routine.id, [run, ...(routineRuns.get(routine.id) ?? [])]);
      emit({ type: "channel-routines-changed", channelId: input.channelId });
      return structuredClone(run);
    },
    listChannelRoutineRuns: async (input: ListChannelRoutineRunsInput): Promise<ChannelRoutineRun[]> =>
      structuredClone((routineRuns.get(input.routineId) ?? []).slice(0, input.limit ?? 50)),
  };
}

/** One fire an hour from now is enough for the preview: nothing here evaluates a schedule. */
function nextTrigger(routineId: string, schedule: RoutineSchedule, now: string): RoutineTrigger {
  return {
    id: crypto.randomUUID(),
    routineId,
    schedule,
    nextRunAt: new Date(Date.parse(now) + 3_600_000).toISOString(),
    createdAt: now,
    updatedAt: now,
  };
}
