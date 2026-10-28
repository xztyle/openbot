import { INPUT_LIMITS } from "./input-limits";
import { isBoundedString, isIdentifier } from "./ipc-bounded-values";
import {
  CHANNEL_DESCRIPTION_LIMIT,
  CHANNEL_FOCUS_LIMIT,
  CHANNEL_GROUP_LIMIT,
  CHANNEL_HUMAN_MEMBER_LIMIT,
  CHANNEL_KINDS,
  CHANNEL_TOPIC_LIMIT,
  CHANNEL_VISIBILITIES,
  type ChannelAnswerMode,
  type ChannelExternalAuthor,
  type ChannelKind,
  type ChannelMemberWorkspaceFields,
  type ChannelMessageWorkspaceFields,
  type ChannelVisibility,
  type ChannelWorkspaceFields,
  hasValidChannelMemberWorkspaceFields,
  hasValidChannelMessageWorkspaceFields,
  hasValidChannelWorkspaceFields,
  isChannelAnswerMode,
  isChannelEmoji,
} from "./ipc-chat-workspace";
import { type ConversationMessage, isConversationMessage } from "./ipc-conversation-messages";
import { optionalHistoryExtent } from "./ipc-decoding";
import { type DynamicRecord, isDynamicRecord, isOneOf, isString } from "./runtime-values";

export * from "./ipc-chat-workspace";
export * from "./ipc-workspace-activity";

export const CHANNEL_CHATS_CAPABILITY = "channel-chats-v1";
export const CHANNEL_DELETE_CAPABILITY = "channel-delete-v1";
/**
 * The id a channel row carries for the reader, and for its own author, while no account is signed
 * in. The person behind it does not change when they sign in, so their read cursors follow them and
 * their own messages stay their own in the transcript.
 */
export const SIGNED_OUT_CHANNEL_MEMBER_ID = "local";
export const CHANNEL_PARALLEL_LIMIT = 2;
export const CHANNEL_ASSIGNMENT_LIMIT = 8;

export interface ChannelMember extends ChannelMemberWorkspaceFields {
  agentId: string;
}

export interface ChannelDraft {
  name: string;
  title: string;
  instructions: string;
  members: ChannelMember[];
  leadAgentId: string | null;
}

export interface Channel extends ChannelDraft, ChannelWorkspaceFields {
  id: string;
  archived: boolean;
  revision: number;
  createdAt: string;
}

export type ChannelTaskState = "queued" | "running" | "waiting" | "paused" | "completed" | "failed" | "cancelled";

export interface ChannelTask {
  id: string;
  channelId: string;
  parentTaskId: string | null;
  rootTaskId: string;
  ownerAgentId: string | null;
  requestMessageId: string;
  instruction: string;
  attachmentDraftIds: string[];
  expectedResult: string;
  sourceMessageIds: string[];
  dependencies: string[];
  resources: string[];
  state: ChannelTaskState;
  revision: number;
  assignmentCount: number;
  error: string | null;
}

export interface ChannelMessage extends ChannelMessageWorkspaceFields {
  id: string;
  channelId: string;
  sequence: number;
  author: { kind: "member" | "agent" | "coordinator"; id: string; name: string };
  taskId: string | null;
  superseded: boolean;
  message: ConversationMessage;
}

/** One ellipsised sidebar line: enough to preview a channel, never a whole message body. */
export interface ChannelPreview {
  authorName: string;
  /** Who wrote it. Absent from a host without channel-attention-v1. */
  author?: { kind: ChannelMessage["author"]["kind"]; id: string };
  /** Whether it is still streaming. Absent from a host without channel-attention-v1. */
  status?: ConversationMessage["status"];
  text: string;
  at: string;
}

/** The execution thread of one member agent in a channel. A prompt on it belongs to the channel. */
export interface ChannelThread {
  agentId: string;
  threadId: string;
}

export const CHANNEL_PREVIEW_LIMIT = 160;

export interface ChannelSummary extends Channel {
  unreadCount: number;
  activeTasks: number;
  /** Its queued, waiting and running tasks; `activeTasks` counts only running ones. Absent from a host without channel-attention-v1. */
  openTasks?: number;
  lastMessage: ChannelPreview | null;
  /** One for each member agent that has worked here. Absent from a host without channel-attention-v1. */
  threads?: ChannelThread[];
}

export interface ChannelPage {
  channel: Channel;
  messages: ChannelMessage[];
  tasks: ChannelTask[];
  olderCursor: number | null;
  throughSequence: number;
  /** As in `ConversationPageInfo`: the unloaded length, for the scroll rail. Absent from a remote host. */
  olderCount?: number;
  oldestAt?: string;
  /** Set on the page of one thread: the root comes first, then its replies. */
  threadRootId?: string;
}

export type ChannelCommand =
  | {
      type: "save";
      operationId: string;
      channelId: string;
      draft: ChannelDraft;
      /**
       * The save edits a channel that the sender has open. A save without it creates the channel
       * when its id is unknown, which is how a channel is made, and how every released client
       * still saves. Settings save on every field and a save can arrive after a deletion, so the
       * settings panel sets this and the service refuses to bring the channel back.
       */
      update?: boolean;
    }
  | { type: "restore"; operationId: string; channelId: string }
  | { type: "archive"; operationId: string; channelId: string }
  | {
      type: "send";
      operationId: string;
      channelId: string;
      text: string;
      recipientAgentId: string | null;
      replyToMessageId: string | null;
      attachmentDraftIds: string[];
      /** A reply in the thread of this root message. */
      threadRootId?: string | null;
      /** A thread reply that is also shown in the channel. */
      alsoToChannel?: boolean;
      /**
       * Set only by the host's channel bridge, never parsed from a client: the message came from
       * another platform. It keeps this id and shows this author.
       */
      bridged?: { messageId: string; author: ChannelExternalAuthor };
    }
  | {
      /**
       * A routine firing into the channel. It is a `send` without the continuation heuristic: a
       * schedule must start its own task rather than fold itself into whatever a member is doing.
       * The `requestMessageId` is minted by the caller and persisted on its run row before the
       * command is issued, so a replay after a crash lands on the same message.
       */
      type: "request";
      operationId: string;
      channelId: string;
      text: string;
      recipientAgentId: string | null;
      requestMessageId: string;
      origin: { kind: "routine"; routineId: string; routineName: string; runId: string };
    }
  | {
      type: "stop" | "resume" | "reassign";
      operationId: string;
      channelId: string;
      taskId: string;
      recipientAgentId: string | null;
    }
  | { type: "read"; operationId: string; channelId: string; throughSequence: number }
  | WorkspaceChannelCommand;

/**
 * The workspace commands. Only a client that the host advertises the workspace to sends them; the
 * released channel route refuses each one, so a host without them fails closed.
 */
export type WorkspaceChannelCommand =
  | {
      /** Makes a channel, a DM or a group with this id. The creator is always one of its people. */
      type: "create";
      operationId: string;
      channelId: string;
      kind: ChannelKind;
      visibility: ChannelVisibility;
      name: string;
      title?: string;
      topic?: string;
      description?: string;
      instructions?: string;
      humanMemberIds: string[];
      members: ChannelMember[];
      leadAgentId?: string | null;
    }
  | { type: "join" | "leave"; operationId: string; channelId: string }
  | { type: "invite"; operationId: string; channelId: string; humanMemberIds: string[]; members: ChannelMember[] }
  | { type: "remove"; operationId: string; channelId: string; humanMemberIds: string[]; agentIds: string[] }
  | {
      /** Changes how one member agent answers. `null` clears the field. */
      type: "set-member";
      operationId: string;
      channelId: string;
      agentId: string;
      answerMode?: ChannelAnswerMode | null;
      focus?: string | null;
    }
  | { type: "set-meta"; operationId: string; channelId: string; name?: string; topic?: string; description?: string }
  | {
      type: "react";
      operationId: string;
      channelId: string;
      messageId: string;
      emoji: string;
      action: "add" | "remove";
    }
  | { type: "edit"; operationId: string; channelId: string; messageId: string; text: string }
  | { type: "delete"; operationId: string; channelId: string; messageId: string }
  | {
      /**
       * Opens the DM or group of exactly these people and agents (the sender is added). It answers the
       * channel that already exists for them, or makes one with `channelId`.
       */
      type: "open-dm";
      operationId: string;
      channelId: string;
      memberIds: string[];
      agentIds: string[];
    }
  | {
      /**
       * Bridges a `channel` with one text channel of a Discord server that the host connected
       * (`connectionId` is its `workspaceId`, the guild id). Owners and admins only. A Discord channel
       * has at most one bridge. The host reads the channel name from Discord and makes the webhook.
       */
      type: "link-discord";
      operationId: string;
      channelId: string;
      connectionId: string;
      discordChannelId: string;
    }
  | { type: "unlink-discord"; operationId: string; channelId: string }
  | {
      /**
       * Makes a `channel` public or private. Owners and admins only. A channel that turns private
       * keeps the people it has; one that turns public shows to everyone.
       */
      type: "set-visibility";
      operationId: string;
      channelId: string;
      visibility: ChannelVisibility;
    }
  | {
      /**
       * The onboarding channel. When the workspace has no `channel` yet, the host makes `#general`
       * with `channelId`: public, with every person of the team and the visible agents, which answer
       * when mentioned. It answers the first channel named general, or the new one. Idempotent.
       */
      type: "ensure-general";
      operationId: string;
      channelId: string;
    };

export const WORKSPACE_CHANNEL_COMMAND_TYPES = [
  "create",
  "join",
  "leave",
  "invite",
  "remove",
  "set-member",
  "set-meta",
  "react",
  "edit",
  "delete",
  "open-dm",
  "link-discord",
  "unlink-discord",
  "set-visibility",
  "ensure-general",
] as const satisfies readonly WorkspaceChannelCommand["type"][];

/** A command that only the workspace route carries: a workspace command, or a send into a thread. */
export function isWorkspaceChannelCommand(command: ChannelCommand): boolean {
  return (
    isOneOf(WORKSPACE_CHANNEL_COMMAND_TYPES, command.type) ||
    (command.type === "send" && ((command.threadRootId ?? null) !== null || command.alsoToChannel === true))
  );
}

export interface ChannelReadInput {
  channelId: string;
  beforeSequence?: number | undefined;
  /** Reads one thread: its root and its replies. */
  threadRootId?: string | undefined;
}

/**
 * A channel used to hold one `purpose`. It now holds a `title` and `instructions`, the way an agent
 * does, and the guards below are strict about both - so every row written before the rename has to
 * pass through here on the way in. This is the only place that knows the old key: the store reads
 * `channel_json` through `decodeChannel` (`channel-store.ts`), and a strict guard at the call sites
 * would make every one of those rows unreadable instead.
 */
export function normalizeChannelDraft(value: unknown): DynamicRecord | undefined {
  if (!isDynamicRecord(value)) return undefined;
  if (!("purpose" in value)) return value;
  const { purpose, ...rest } = value;
  return { title: "", instructions: isString(purpose) ? purpose : "", ...rest };
}

export function isChannelDraft(value: unknown): value is ChannelDraft {
  return (
    isDynamicRecord(value) &&
    isBoundedString(value.name, INPUT_LIMITS.agentName) &&
    value.name.trim().length > 0 &&
    isBoundedString(value.title, INPUT_LIMITS.agentTitle) &&
    isBoundedString(value.instructions, INPUT_LIMITS.agentDescription) &&
    Array.isArray(value.members) &&
    value.members.length <= INPUT_LIMITS.agents &&
    value.members.every(isChannelMember) &&
    new Set(value.members.map((member) => member.agentId)).size === value.members.length &&
    (value.leadAgentId === null ||
      (isIdentifier(value.leadAgentId) && value.members.some((member) => member.agentId === value.leadAgentId)))
  );
}

function isChannelMember(value: unknown): value is ChannelMember {
  return isDynamicRecord(value) && isIdentifier(value.agentId) && hasValidChannelMemberWorkspaceFields(value);
}

/** The known member fields only: a draft cannot carry another key into the stored channel. */
function channelMember(member: ChannelMember): ChannelMember {
  return {
    agentId: member.agentId,
    ...(member.answerMode === undefined ? {} : { answerMode: member.answerMode }),
    ...(member.focus === undefined ? {} : { focus: member.focus }),
  };
}

function identifiers(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.length <= INPUT_LIMITS.agents &&
    value.every(isIdentifier) &&
    new Set(value).size === value.length
  );
}

function sequence(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

export function isChannel(value: unknown): value is Channel {
  return (
    isDynamicRecord(value) &&
    isChannelDraft(value) &&
    isIdentifier(value.id) &&
    typeof value.archived === "boolean" &&
    sequence(value.revision) &&
    isBoundedString(value.createdAt, 80) &&
    hasValidChannelWorkspaceFields(value)
  );
}

export function isChannelTask(value: unknown): value is ChannelTask {
  return (
    isDynamicRecord(value) &&
    isIdentifier(value.id) &&
    isIdentifier(value.channelId) &&
    isIdentifier(value.rootTaskId) &&
    (value.parentTaskId === null || isIdentifier(value.parentTaskId)) &&
    (value.ownerAgentId === null || isIdentifier(value.ownerAgentId)) &&
    isIdentifier(value.requestMessageId) &&
    identifiers(value.attachmentDraftIds) &&
    isBoundedString(value.instruction, INPUT_LIMITS.messageText) &&
    isBoundedString(value.expectedResult, INPUT_LIMITS.messageText) &&
    identifiers(value.sourceMessageIds) &&
    identifiers(value.dependencies) &&
    Array.isArray(value.resources) &&
    value.resources.length <= 64 &&
    value.resources.every((resource) => isBoundedString(resource, INPUT_LIMITS.path)) &&
    isOneOf(["queued", "running", "waiting", "paused", "completed", "failed", "cancelled"] as const, value.state) &&
    sequence(value.revision) &&
    sequence(value.assignmentCount) &&
    (value.error === null || isBoundedString(value.error, INPUT_LIMITS.messageText))
  );
}

export function isChannelMessage(value: unknown): value is ChannelMessage {
  return (
    isDynamicRecord(value) &&
    isIdentifier(value.id) &&
    isIdentifier(value.channelId) &&
    sequence(value.sequence) &&
    isDynamicRecord(value.author) &&
    isOneOf(["member", "agent", "coordinator"] as const, value.author.kind) &&
    isIdentifier(value.author.id) &&
    // The author of a channel message can be a person, and an account name is bounded there, not
    // by the agent name. A name this validator refuses is a stored message no read can decode.
    isBoundedString(value.author.name, INPUT_LIMITS.accountName) &&
    (value.taskId === null || isIdentifier(value.taskId)) &&
    typeof value.superseded === "boolean" &&
    isConversationMessage(value.message) &&
    hasValidChannelMessageWorkspaceFields(value)
  );
}

/** The message as a person who is not an owner or an admin receives it: without the gate decisions. */
export function withoutChannelGateDecisions(message: ChannelMessage): ChannelMessage {
  if (message.gateDecisions === undefined) return message;
  const { gateDecisions: _hidden, ...rest } = message;
  return rest;
}

export function decodeChannel(value: unknown): Channel {
  const channel = normalizeChannelDraft(value);
  if (!isChannel(channel)) throw new Error("Invalid channel response.");
  return channel;
}

export function decodeChannelPage(value: unknown): ChannelPage {
  const channel = isDynamicRecord(value) ? normalizeChannelDraft(value.channel) : undefined;
  if (
    !isDynamicRecord(value) ||
    !isChannel(channel) ||
    !Array.isArray(value.messages) ||
    !value.messages.every(isChannelMessage) ||
    !Array.isArray(value.tasks) ||
    !value.tasks.every(isChannelTask) ||
    !(value.olderCursor === null || sequence(value.olderCursor)) ||
    !sequence(value.throughSequence)
  ) {
    throw new Error("Invalid channel conversation response.");
  }
  return {
    channel,
    messages: value.messages,
    tasks: value.tasks,
    olderCursor: value.olderCursor,
    throughSequence: value.throughSequence,
    ...optionalHistoryExtent(value),
  };
}

export function decodeChannelSummaries(value: unknown): ChannelSummary[] {
  if (!Array.isArray(value)) throw new Error("Invalid channel list response.");
  const summaries: unknown[] = value.map(normalizeChannelDraft);
  if (!summaries.every(isChannelSummary)) throw new Error("Invalid channel list response.");
  return summaries;
}

function isChannelSummary(value: unknown): value is ChannelSummary {
  return (
    isDynamicRecord(value) &&
    isChannel(value) &&
    sequence(value.unreadCount) &&
    sequence(value.activeTasks) &&
    (value.openTasks === undefined || sequence(value.openTasks)) &&
    (value.lastMessage === null || isChannelPreview(value.lastMessage)) &&
    (value.threads === undefined ||
      (Array.isArray(value.threads) &&
        value.threads.length <= INPUT_LIMITS.agents &&
        value.threads.every(isChannelThread)))
  );
}

function isChannelThread(value: unknown): value is ChannelThread {
  return isDynamicRecord(value) && isIdentifier(value.agentId) && isIdentifier(value.threadId);
}

function isChannelPreview(value: unknown): value is ChannelPreview {
  return (
    isDynamicRecord(value) &&
    isBoundedString(value.authorName, INPUT_LIMITS.accountName) &&
    (value.author === undefined ||
      (isDynamicRecord(value.author) &&
        (value.author.kind === "member" || value.author.kind === "agent" || value.author.kind === "coordinator") &&
        isIdentifier(value.author.id))) &&
    (value.status === undefined ||
      value.status === "streaming" ||
      value.status === "completed" ||
      value.status === "failed" ||
      value.status === "interrupted") &&
    isBoundedString(value.text, CHANNEL_PREVIEW_LIMIT) &&
    isBoundedString(value.at, 80)
  );
}

export function parseChannelRead(value: unknown): ChannelReadInput {
  if (
    !isDynamicRecord(value) ||
    !isIdentifier(value.channelId) ||
    !(value.beforeSequence === undefined || sequence(value.beforeSequence)) ||
    !(value.threadRootId === undefined || isIdentifier(value.threadRootId))
  ) {
    throw new Error("Provide a valid channel and message cursor.");
  }
  return {
    channelId: value.channelId,
    beforeSequence: value.beforeSequence,
    ...(value.threadRootId === undefined ? {} : { threadRootId: value.threadRootId }),
  };
}

export function parseChannelCommand(value: unknown): ChannelCommand {
  if (!isDynamicRecord(value) || !isIdentifier(value.operationId) || !isIdentifier(value.channelId))
    throw new Error("Provide a valid channel command.");
  const common = { operationId: value.operationId, channelId: value.channelId };
  const draft = normalizeChannelDraft(value.draft);
  if (value.type === "save" && isChannelDraft(draft))
    return {
      ...common,
      type: value.type,
      // Only the draft fields: the workspace fields of a channel change through their own commands.
      draft: {
        name: draft.name,
        title: draft.title,
        instructions: draft.instructions,
        members: draft.members.map(channelMember),
        leadAgentId: draft.leadAgentId,
      },
      ...(value.update === true ? { update: true } : {}),
    };
  const workspace = parseWorkspaceChannelCommand(value, common);
  if (workspace) return workspace;
  if (value.type === "archive" || value.type === "restore") return { ...common, type: value.type };
  if (value.type === "read" && sequence(value.throughSequence))
    return { ...common, type: value.type, throughSequence: value.throughSequence };
  if (
    (value.type === "stop" || value.type === "resume" || value.type === "reassign") &&
    isIdentifier(value.taskId) &&
    (value.recipientAgentId === null || isIdentifier(value.recipientAgentId))
  ) {
    return { ...common, type: value.type, taskId: value.taskId, recipientAgentId: value.recipientAgentId };
  }
  if (
    value.type === "send" &&
    isBoundedString(value.text, INPUT_LIMITS.messageText) &&
    (value.recipientAgentId === null || isIdentifier(value.recipientAgentId)) &&
    (value.replyToMessageId === null || isIdentifier(value.replyToMessageId)) &&
    identifiers(value.attachmentDraftIds) &&
    (value.text.trim().length > 0 || value.attachmentDraftIds.length > 0) &&
    (value.threadRootId === undefined || value.threadRootId === null || isIdentifier(value.threadRootId)) &&
    (value.alsoToChannel === undefined || typeof value.alsoToChannel === "boolean")
  ) {
    return {
      ...common,
      type: value.type,
      text: value.text,
      recipientAgentId: value.recipientAgentId,
      replyToMessageId: value.replyToMessageId,
      attachmentDraftIds: value.attachmentDraftIds,
      ...(isIdentifier(value.threadRootId) ? { threadRootId: value.threadRootId } : {}),
      ...(isIdentifier(value.threadRootId) && value.alsoToChannel === true ? { alsoToChannel: true } : {}),
    };
  }
  if (
    value.type === "request" &&
    isBoundedString(value.text, INPUT_LIMITS.messageText) &&
    value.text.trim().length > 0 &&
    (value.recipientAgentId === null || isIdentifier(value.recipientAgentId)) &&
    isIdentifier(value.requestMessageId) &&
    isDynamicRecord(value.origin) &&
    value.origin.kind === "routine" &&
    isIdentifier(value.origin.routineId) &&
    isBoundedString(value.origin.routineName, INPUT_LIMITS.routineName) &&
    isIdentifier(value.origin.runId)
  ) {
    return {
      ...common,
      type: value.type,
      text: value.text,
      recipientAgentId: value.recipientAgentId,
      requestMessageId: value.requestMessageId,
      origin: {
        kind: "routine",
        routineId: value.origin.routineId,
        routineName: value.origin.routineName,
        runId: value.origin.runId,
      },
    };
  }
  throw new Error("Provide a valid channel command.");
}

function members(value: unknown): value is ChannelMember[] {
  return (
    Array.isArray(value) &&
    value.length <= INPUT_LIMITS.agents &&
    value.every(isChannelMember) &&
    new Set(value.map((member) => member.agentId)).size === value.length
  );
}

function people(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.length <= CHANNEL_HUMAN_MEMBER_LIMIT &&
    value.every(isIdentifier) &&
    new Set(value).size === value.length
  );
}

/** A Discord snowflake: a guild or channel id. */
function isDiscordId(value: unknown): value is string {
  return typeof value === "string" && /^[0-9]{1,24}$/u.test(value);
}

function optionalText(value: unknown, maximum: number): value is string | undefined {
  return value === undefined || isBoundedString(value, maximum);
}

function parseWorkspaceChannelCommand(
  value: DynamicRecord,
  common: { operationId: string; channelId: string },
): WorkspaceChannelCommand | null {
  switch (value.type) {
    case "create":
      if (
        !isOneOf(CHANNEL_KINDS, value.kind) ||
        !isOneOf(CHANNEL_VISIBILITIES, value.visibility) ||
        !isBoundedString(value.name, INPUT_LIMITS.agentName) ||
        !value.name.trim() ||
        !optionalText(value.title, INPUT_LIMITS.agentTitle) ||
        !optionalText(value.topic, CHANNEL_TOPIC_LIMIT) ||
        !optionalText(value.description, CHANNEL_DESCRIPTION_LIMIT) ||
        !optionalText(value.instructions, INPUT_LIMITS.agentDescription) ||
        !people(value.humanMemberIds) ||
        !members(value.members) ||
        !(value.leadAgentId === undefined || value.leadAgentId === null || isIdentifier(value.leadAgentId)) ||
        (isIdentifier(value.leadAgentId) && !value.members.some((member) => member.agentId === value.leadAgentId))
      )
        return null;
      return {
        ...common,
        type: "create",
        kind: value.kind,
        visibility: value.visibility,
        name: value.name,
        ...(value.title === undefined ? {} : { title: value.title }),
        ...(value.topic === undefined ? {} : { topic: value.topic }),
        ...(value.description === undefined ? {} : { description: value.description }),
        ...(value.instructions === undefined ? {} : { instructions: value.instructions }),
        humanMemberIds: value.humanMemberIds,
        members: value.members.map(channelMember),
        ...(value.leadAgentId === undefined ? {} : { leadAgentId: value.leadAgentId }),
      };
    case "join":
    case "leave":
      return { ...common, type: value.type };
    case "invite":
      if (!people(value.humanMemberIds) || !members(value.members)) return null;
      if (!value.humanMemberIds.length && !value.members.length) return null;
      return {
        ...common,
        type: "invite",
        humanMemberIds: value.humanMemberIds,
        members: value.members.map(channelMember),
      };
    case "remove":
      if (!people(value.humanMemberIds) || !identifiers(value.agentIds)) return null;
      if (!value.humanMemberIds.length && !value.agentIds.length) return null;
      return { ...common, type: "remove", humanMemberIds: value.humanMemberIds, agentIds: value.agentIds };
    case "set-member":
      if (
        !isIdentifier(value.agentId) ||
        !(value.answerMode === undefined || value.answerMode === null || isChannelAnswerMode(value.answerMode)) ||
        !(value.focus === undefined || value.focus === null || isBoundedString(value.focus, CHANNEL_FOCUS_LIMIT)) ||
        (value.answerMode === undefined && value.focus === undefined)
      )
        return null;
      return {
        ...common,
        type: "set-member",
        agentId: value.agentId,
        ...(value.answerMode === undefined ? {} : { answerMode: value.answerMode }),
        ...(value.focus === undefined ? {} : { focus: value.focus }),
      };
    case "set-meta":
      if (
        !(value.name === undefined || (isBoundedString(value.name, INPUT_LIMITS.agentName) && value.name.trim())) ||
        !optionalText(value.topic, CHANNEL_TOPIC_LIMIT) ||
        !optionalText(value.description, CHANNEL_DESCRIPTION_LIMIT) ||
        (value.name === undefined && value.topic === undefined && value.description === undefined)
      )
        return null;
      return {
        ...common,
        type: "set-meta",
        ...(value.name === undefined ? {} : { name: value.name }),
        ...(value.topic === undefined ? {} : { topic: value.topic }),
        ...(value.description === undefined ? {} : { description: value.description }),
      };
    case "react":
      if (!isIdentifier(value.messageId) || !isChannelEmoji(value.emoji)) return null;
      if (value.action !== "add" && value.action !== "remove") return null;
      return { ...common, type: "react", messageId: value.messageId, emoji: value.emoji, action: value.action };
    case "edit":
      // An empty text is valid for a message with files; the host refuses it for one without.
      if (!isIdentifier(value.messageId) || !isBoundedString(value.text, INPUT_LIMITS.messageText)) return null;
      return { ...common, type: "edit", messageId: value.messageId, text: value.text };
    case "delete":
      if (!isIdentifier(value.messageId)) return null;
      return { ...common, type: "delete", messageId: value.messageId };
    case "open-dm":
      if (!people(value.memberIds) || !identifiers(value.agentIds)) return null;
      // The sender is added, so the others are 1 to `CHANNEL_GROUP_LIMIT - 1`.
      if (value.memberIds.length + value.agentIds.length < 1) return null;
      if (value.memberIds.length + value.agentIds.length > CHANNEL_GROUP_LIMIT - 1) return null;
      return { ...common, type: "open-dm", memberIds: value.memberIds, agentIds: value.agentIds };
    case "link-discord":
      if (!isDiscordId(value.connectionId) || !isDiscordId(value.discordChannelId)) return null;
      return {
        ...common,
        type: "link-discord",
        connectionId: value.connectionId,
        discordChannelId: value.discordChannelId,
      };
    case "unlink-discord":
      return { ...common, type: "unlink-discord" };
    case "set-visibility":
      if (!isOneOf(CHANNEL_VISIBILITIES, value.visibility)) return null;
      return { ...common, type: "set-visibility", visibility: value.visibility };
    case "ensure-general":
      return { ...common, type: "ensure-general" };
    default:
      return null;
  }
}
