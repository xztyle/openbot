import {
  type AgentAccessLevel,
  type AgentSummary,
  agentAccessRank,
  CHANNEL_GROUP_LIMIT,
  CHANNEL_REACTION_ACTOR_LIMIT,
  CHANNEL_REACTION_LIMIT,
  type Channel,
  type ChannelActorRef,
  type ChannelAnswerMode,
  type ChannelMember,
  type ChannelMessage,
  type ChannelReaction,
  type ChannelVisibility,
  canAdministerServer,
  channelKind,
  channelMentions,
  channelVisibility,
  type WorkspaceAgentChannelDefaults,
  type WorkspaceChannelCommand,
} from "@openbot/contracts/ipc";
import { sourceText } from "@openbot/i18n/source";
import { type ChannelViewer, canManageChannel, canSeeChannel, isChannelPerson } from "./channel-visibility";

/**
 * What the workspace commands read besides the channel. `ChannelService` gives it; the functions
 * here change no store and start no work, so the service keeps the commit, the events and the
 * scheduling of each command.
 */
export interface WorkspaceCommandContext {
  agents: readonly AgentSummary[];
  hidden(agentId: string): boolean;
  /** A person of the team by id, or null for an id that names no active member. */
  person(id: string): { id: string; name: string } | null;
  /** The answer mode an agent gets when it joins a workspace channel without one. */
  defaultAnswerMode: ChannelAnswerMode;
  /** The channel defaults of one agent, which come before `defaultAnswerMode`. */
  agentDefaults(agentId: string): WorkspaceAgentChannelDefaults | undefined;
  /** The access level of the sender for an agent. Absent: the sender may chat with every agent. */
  agentLevel?(agentId: string): AgentAccessLevel;
  actor: { id: string; name: string };
  /** The person who sent the command. Absent for a command of this computer's own services. */
  viewer?: ChannelViewer | undefined;
}

type Create = Extract<WorkspaceChannelCommand, { type: "create" }>;
type OpenDm = Extract<WorkspaceChannelCommand, { type: "open-dm" }>;

/** Each id once, in order. */
function unique(ids: readonly string[]): string[] {
  return [...new Set(ids)];
}

function requirePeople(ids: readonly string[], context: WorkspaceCommandContext): void {
  for (const id of ids)
    if (id !== context.actor.id && !context.viewer?.ids.has(id) && !context.person(id))
      throw new Error(sourceText("error.backend.channelPersonUnavailable"));
}

function requireAgents(members: readonly ChannelMember[], context: WorkspaceCommandContext, known = new Set<string>()) {
  for (const member of members)
    if (!known.has(member.agentId) && !context.agents.some((agent) => agent.id === member.agentId))
      throw new Error(sourceText("error.backend.channelMemberUnavailable"));
    else if (!known.has(member.agentId) && context.hidden(member.agentId))
      throw new Error(sourceText("error.backend.recipientHidden"));
}

/**
 * Members that come with no answer mode take the agent's own channel default, or `mode`; members
 * with no focus take the agent's default focus. `fixedMode` (a one-to-one DM) wins over the agent.
 */
function withDefaultModes(
  members: readonly ChannelMember[],
  mode: ChannelAnswerMode,
  context: Pick<WorkspaceCommandContext, "agentDefaults">,
  fixedMode = false,
): ChannelMember[] {
  return members.map((member) => {
    const defaults = context.agentDefaults(member.agentId);
    const focus = member.focus ?? defaults?.focus;
    return {
      ...member,
      answerMode: member.answerMode ?? (fixedMode ? mode : (defaults?.answerMode ?? mode)),
      ...(focus ? { focus } : {}),
    };
  });
}

/** A DM brings an agent to a person only when the person may chat with it. */
function requireChatLevel(agentIds: readonly string[], context: WorkspaceCommandContext): void {
  for (const agentId of agentIds)
    if (context.agentLevel && agentAccessRank(context.agentLevel(agentId)) < agentAccessRank("chat"))
      throw new Error(sourceText("error.backend.channelAgentChatRequired"));
}

/** A DM holds two participants, a group three to nine, people and agents together. */
function requireDirectSize(kind: "dm" | "group", humans: number, agents: number): void {
  const total = humans + agents;
  if (kind === "dm" ? total !== 2 || humans < 1 : total < 3 || total > CHANNEL_GROUP_LIMIT || humans < 1)
    throw new Error(sourceText("error.backend.channelDirectParticipants"));
}

/** The answer mode of the agents of a new DM or group: the agent of a one-to-one DM answers each message. */
function directMode(kind: "dm" | "group", context: WorkspaceCommandContext): ChannelAnswerMode {
  return kind === "dm" ? "always-no-gate" : context.defaultAnswerMode;
}

export function createdChannel(command: Create, context: WorkspaceCommandContext): Channel {
  const humans = unique([context.actor.id, ...command.humanMemberIds]);
  requirePeople(humans, context);
  requireAgents(command.members, context);
  const kind = command.kind;
  if (kind !== "channel") requireDirectSize(kind, humans.length, command.members.length);
  const mode = kind === "channel" ? context.defaultAnswerMode : directMode(kind, context);
  return {
    id: command.channelId,
    name: command.name.trim(),
    title: command.title ?? "",
    instructions: command.instructions ?? "",
    members: withDefaultModes(command.members, mode, context, kind === "dm"),
    leadAgentId: command.leadAgentId ?? null,
    archived: false,
    revision: 0,
    createdAt: new Date().toISOString(),
    kind,
    visibility: kind === "channel" ? command.visibility : "private",
    ...(command.topic ? { topic: command.topic } : {}),
    ...(command.description ? { description: command.description } : {}),
    humanMemberIds: humans,
    createdBy: { kind: "member", id: context.actor.id },
  };
}

/** The key of the DM or group of exactly these people and agents, the sender included. */
export function directKey(command: OpenDm, actorId: string): string {
  const humans = unique([actorId, ...command.memberIds]).sort();
  const agents = unique(command.agentIds).sort();
  return `${humans.join(",")}|${agents.join(",")}`;
}

/**
 * Makes a channel public or private. Owners and admins only; a command of this computer's own
 * services has no viewer and passes. A channel that turns private keeps the people who joined it.
 */
export function visibilityChannel(
  channel: Channel,
  visibility: ChannelVisibility,
  context: WorkspaceCommandContext,
): Channel {
  if (channelKind(channel) !== "channel") throw new Error(sourceText("error.backend.channelVisibilityKind"));
  if (context.viewer && !canAdministerServer(context.viewer.role))
    throw new Error(sourceText("error.backend.channelVisibilityAdmin"));
  if (channelVisibility(channel) === visibility) return channel;
  return { ...channel, kind: "channel", visibility };
}

/** The name of the onboarding channel. */
export const GENERAL_CHANNEL_NAME = "general";

/**
 * The channel that `ensure-general` answers when the workspace already has a `channel`: the first
 * one named general that the sender sees, else the oldest one they see. Null when the workspace has
 * no `channel`, so `#general` is made; a workspace whose channels the sender cannot see fails.
 */
export function existingGeneral(channels: readonly Channel[], viewer: ChannelViewer | undefined): Channel | null {
  const workspace = channels
    .filter((channel) => channel.kind === "channel" && !channel.archived)
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  if (!workspace.length) return null;
  const visible = workspace.filter((channel) => !viewer || canSeeChannel(channel, viewer));
  const found = visible.find((channel) => channel.name.trim().toLowerCase() === GENERAL_CHANNEL_NAME) ?? visible[0];
  if (!found) throw new Error(sourceText("error.backend.channelNotFound"));
  return found;
}

/**
 * `#general`: public, with every person of the team and every visible agent of the server (not
 * hidden, not in the background), which answer when mentioned.
 */
export function generalChannel(
  channelId: string,
  people: readonly { id: string }[],
  context: WorkspaceCommandContext,
): Channel {
  const humans = unique([context.actor.id, ...people.map((person) => person.id)]);
  const members: ChannelMember[] = context.agents
    .filter((agent) => agent.hiddenAt === undefined && agent.background !== true && !context.hidden(agent.id))
    .map((agent) => ({ agentId: agent.id, answerMode: "mention" }));
  return {
    id: channelId,
    name: GENERAL_CHANNEL_NAME,
    title: "",
    instructions: "",
    members,
    leadAgentId: null,
    archived: false,
    revision: 0,
    createdAt: new Date().toISOString(),
    kind: "channel",
    visibility: "public",
    humanMemberIds: humans,
    createdBy: { kind: "member", id: context.actor.id },
  };
}

function sameSet(left: readonly string[], right: readonly string[]): boolean {
  const set = new Set(left);
  return set.size === new Set(right).size && right.every((id) => set.has(id));
}

/**
 * The DM or group of exactly these people and agents, the sender included: the one that exists, or
 * a new one with the id of the command. Its name lists the participants, so a client that does not
 * know DMs still shows a readable channel.
 */
export function directChannel(
  command: OpenDm,
  channels: readonly Channel[],
  context: WorkspaceCommandContext,
): { channel: Channel; created: boolean } {
  const humans = unique([context.actor.id, ...command.memberIds]);
  const agentIds = unique(command.agentIds);
  const kind = humans.length + agentIds.length === 2 ? "dm" : "group";
  requireDirectSize(kind, humans.length, agentIds.length);
  const existing = channels.find(
    (channel) =>
      channelKind(channel) === kind &&
      !channel.archived &&
      sameSet(channel.humanMemberIds ?? [], humans) &&
      sameSet(
        channel.members.map((member) => member.agentId),
        agentIds,
      ),
  );
  requireChatLevel(agentIds, context);
  if (existing) return { channel: existing, created: false };
  requirePeople(humans, context);
  const members = agentIds.map((agentId) => ({ agentId }));
  requireAgents(members, context);
  const names = [
    ...humans.map((id) => (id === context.actor.id ? context.actor.name : (context.person(id)?.name ?? id))),
    ...agentIds.map((id) => context.agents.find((agent) => agent.id === id)?.name ?? id),
  ];
  return {
    created: true,
    channel: {
      id: command.channelId,
      name: names.join(", ").slice(0, 80).trim() || kind,
      title: "",
      instructions: "",
      members: withDefaultModes(members, directMode(kind, context), context, kind === "dm"),
      leadAgentId: null,
      archived: false,
      revision: 0,
      createdAt: new Date().toISOString(),
      kind,
      visibility: "private",
      humanMemberIds: humans,
      createdBy: { kind: "member", id: context.actor.id },
    },
  };
}

export function joinedChannel(channel: Channel, context: WorkspaceCommandContext): Channel {
  const viewer = context.viewer;
  if (channelKind(channel) !== "channel") throw new Error(sourceText("error.backend.channelDirectFixed"));
  if (
    channel.visibility === "private" &&
    viewer &&
    !canAdministerServer(viewer.role) &&
    !isChannelPerson(channel, viewer)
  )
    throw new Error(sourceText("error.backend.channelJoinPrivate"));
  const humans = channel.humanMemberIds ?? [];
  if (viewer ? isChannelPerson(channel, viewer) : humans.includes(context.actor.id)) return channel;
  return { ...channel, humanMemberIds: [...humans, context.actor.id] };
}

export function leftChannel(channel: Channel, context: WorkspaceCommandContext): Channel {
  if (channelKind(channel) === "dm") throw new Error(sourceText("error.backend.channelDirectFixed"));
  const ids = context.viewer?.ids ?? new Set([context.actor.id]);
  return { ...channel, humanMemberIds: (channel.humanMemberIds ?? []).filter((id) => !ids.has(id)) };
}

function requireManage(channel: Channel, context: WorkspaceCommandContext): void {
  if (context.viewer && !canManageChannel(channel, context.viewer))
    throw new Error(sourceText("error.backend.channelManageRequired"));
}

/** The people and agents an invitation adds. Agents keep their own answer mode or take the default. */
export function invitedChannel(
  channel: Channel,
  humanMemberIds: readonly string[],
  members: readonly ChannelMember[],
  context: WorkspaceCommandContext,
): Channel {
  requireManage(channel, context);
  const kind = channelKind(channel);
  if (kind === "dm") throw new Error(sourceText("error.backend.channelDirectFixed"));
  requirePeople(humanMemberIds, context);
  const known = new Set(channel.members.map((member) => member.agentId));
  const added = members.filter((member) => !known.has(member.agentId));
  requireAgents(added, context);
  const humans = unique([...(channel.humanMemberIds ?? []), ...humanMemberIds]);
  const agents = [...channel.members, ...withDefaultModes(added, context.defaultAnswerMode, context)];
  if (kind === "group") requireDirectSize("group", humans.length, agents.length);
  return { ...channel, humanMemberIds: humans, members: agents };
}

/**
 * The people and agents a removal leaves. Only an owner, an admin or the creator of the channel
 * removes another person; anyone removes themselves.
 */
export function removedChannel(
  channel: Channel,
  humanMemberIds: readonly string[],
  agentIds: readonly string[],
  context: WorkspaceCommandContext,
): Channel {
  requireManage(channel, context);
  const kind = channelKind(channel);
  if (kind === "dm") throw new Error(sourceText("error.backend.channelDirectFixed"));
  const viewer = context.viewer;
  const self = viewer?.ids ?? new Set([context.actor.id]);
  const others = humanMemberIds.filter((id) => !self.has(id));
  const creator = channel.createdBy?.kind === "member" && self.has(channel.createdBy.id);
  if (others.length && viewer && !canAdministerServer(viewer.role) && !creator)
    throw new Error(sourceText("error.backend.channelRemovePeople"));
  const removed = new Set(agentIds);
  const humans = (channel.humanMemberIds ?? []).filter((id) => !humanMemberIds.includes(id));
  const members = channel.members.filter((member) => !removed.has(member.agentId));
  return {
    ...channel,
    humanMemberIds: humans,
    members,
    leadAgentId: channel.leadAgentId && removed.has(channel.leadAgentId) ? null : channel.leadAgentId,
  };
}

export function memberSettingsChannel(
  channel: Channel,
  command: Extract<WorkspaceChannelCommand, { type: "set-member" }>,
  context: WorkspaceCommandContext,
): Channel {
  requireManage(channel, context);
  if (!channel.members.some((member) => member.agentId === command.agentId))
    throw new Error(sourceText("error.backend.channelMemberRequired"));
  return {
    ...channel,
    members: channel.members.map((member) => {
      if (member.agentId !== command.agentId) return member;
      const { answerMode, focus, ...rest } = member;
      const nextMode = command.answerMode === undefined ? answerMode : (command.answerMode ?? undefined);
      const nextFocus = command.focus === undefined ? focus : command.focus?.trim() || undefined;
      return {
        ...rest,
        ...(nextMode === undefined ? {} : { answerMode: nextMode }),
        ...(nextFocus === undefined ? {} : { focus: nextFocus }),
      };
    }),
  };
}

export function metaChannel(
  channel: Channel,
  command: Extract<WorkspaceChannelCommand, { type: "set-meta" }>,
  context: WorkspaceCommandContext,
): Channel {
  requireManage(channel, context);
  const { topic, description, ...rest } = channel;
  const nextTopic = command.topic === undefined ? topic : command.topic.trim() || undefined;
  const nextDescription = command.description === undefined ? description : command.description.trim() || undefined;
  return {
    ...rest,
    name: command.name?.trim() || channel.name,
    ...(nextTopic === undefined ? {} : { topic: nextTopic }),
    ...(nextDescription === undefined ? {} : { description: nextDescription }),
  };
}

function sameActor(left: ChannelActorRef, right: ChannelActorRef): boolean {
  return left.kind === right.kind && left.id === right.id;
}

/** The message with one reaction of `actor` added or removed. An empty reaction leaves the list. */
export function reactedMessage(
  message: ChannelMessage,
  emoji: string,
  action: "add" | "remove",
  actor: ChannelActorRef,
): ChannelMessage {
  if (message.deletedAt) throw new Error(sourceText("error.backend.channelMessageNotFound"));
  const reactions: ChannelReaction[] = (message.reactions ?? []).map((reaction) => ({
    emoji: reaction.emoji,
    actors: reaction.actors.filter((item) => !(reaction.emoji === emoji && sameActor(item, actor))),
  }));
  if (action === "add") {
    const existing = reactions.find((reaction) => reaction.emoji === emoji);
    if (existing) {
      if (existing.actors.length < CHANNEL_REACTION_ACTOR_LIMIT) existing.actors.push(actor);
    } else if (reactions.length < CHANNEL_REACTION_LIMIT) reactions.push({ emoji, actors: [actor] });
  }
  const { reactions: _previous, ...rest } = message;
  const kept = reactions.filter((reaction) => reaction.actors.length > 0);
  return kept.length ? { ...rest, reactions: kept } : rest;
}

/** Whether the sender wrote this message. A person's message is theirs under any of their ids. */
function isOwnMessage(message: ChannelMessage, context: WorkspaceCommandContext): boolean {
  if (message.author.kind !== "member") return false;
  return context.viewer ? context.viewer.ids.has(message.author.id) : message.author.id === context.actor.id;
}

/**
 * The message with a new text. Its files stay: an edit changes only the text, and a message with
 * files can have an empty text.
 */
export function editedMessage(message: ChannelMessage, text: string, context: WorkspaceCommandContext): ChannelMessage {
  if (message.deletedAt) throw new Error(sourceText("error.backend.channelMessageNotFound"));
  if (!isOwnMessage(message, context)) throw new Error(sourceText("error.backend.channelEditOwnOnly"));
  if (!text.trim() && !message.message.attachments?.length)
    throw new Error(sourceText("error.backend.channelEditEmpty"));
  const mentions = channelMentions(text);
  const { mentions: _previous, ...rest } = message;
  return {
    ...rest,
    ...(mentions.length ? { mentions } : {}),
    editedAt: new Date().toISOString(),
    message: { ...message.message, text },
  };
}

/**
 * The message as a deletion leaves it: no text, no files, no reactions. A thread root keeps its
 * place and its replies; any other message leaves the transcript.
 *
 * The files leave the view only: the mailbox keeps the request that owns them (`channelId`, the
 * message id), so a task that already started still reads them, and they are removed with the
 * channel (`MailboxStore.deleteChannelData`). No agent can ask for them again: `channel_history`
 * gives only the files of a message that the channel still shows.
 */
export function deletedMessage(message: ChannelMessage, context: WorkspaceCommandContext): ChannelMessage {
  if (message.deletedAt) return message;
  const admin = context.viewer ? canAdministerServer(context.viewer.role) : true;
  if (!isOwnMessage(message, context) && !admin) throw new Error(sourceText("error.backend.channelDeleteOwnOnly"));
  const { reactions: _reactions, mentions: _mentions, ...rest } = message;
  const { attachments: _attachments, questionPrompt: _question, ...inner } = message.message;
  return { ...rest, deletedAt: new Date().toISOString(), message: { ...inner, text: "" } };
}
