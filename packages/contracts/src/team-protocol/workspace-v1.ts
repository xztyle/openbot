// Optional workspace wire contract of this fork, under `fork-host-v1`.
//
// What it adds, recorded here because freezing it makes it permanent:
//
// - Beside the frozen keys of channels-v1, on each channel of `GET /v1/channels`, of
//   `POST /v1/channels/read` and of `POST /v1/channels/commands`: `kind` (`channel`, `dm`, `group`),
//   `visibility` (`public`, `private`), `topic` (250), `description` (2000), `humanMemberIds` (at most
//   500 team member ids), `createdBy` (`{ kind: "member" | "agent", id }`), and on each member
//   `answerMode` (`mention`, `always`, `always-no-gate`, `lead`) and `focus` (500).
// - On each message of `POST /v1/channels/read`: `threadRootId`, `alsoInChannel`, `threadSummary`
//   (`{ replyCount, lastReplyAt, participantIds }`, at most 20 ids), `reactions` (at most 50, each
//   `{ emoji (64), actors }` with at most 200 actors), `mentions` (at most 100, each
//   `{ kind: "member" | "agent" | "channel" | "here", id? }`), `editedAt` and `deletedAt`;
//   `gatePending` (at most 100 agent ids that the answer gate still considers) and, for an owner or
//   an admin only, `gateDecisions` (at most 100, each `{ agentId, answer, reason (120), priority (0 to
//   1), model (300), ms, fallback?: "timeout" | "error" | "invalid" | "interrupted", limited? }`).
// - `POST /v1/workspace/channels/commands`: the workspace commands (`create`, `join`, `leave`,
//   `invite`, `remove`, `set-member`, `set-meta`, `react`, `edit`, `delete`, `open-dm`) and a `send`
//   that carries `threadRootId` and `alsoToChannel`. It answers the channel, as the released command
//   route does. The host takes the author of a reaction, an edit or a deletion from the session,
//   never from the body.
// - `POST /v1/workspace/channels/thread`: `{ channelId, threadRootId, beforeSequence? }` answers a
//   channel page whose messages are the root and at most 99 of its replies.
// - `POST /v1/admin/workspace/settings` and `/update`: the workspace settings, owner and admin only.
// - The events `channel-message` (`{ channelId, message, revision }`) and `channel-message-removed`
//   (`{ channelId, messageId, revision }`). The host sends them only to a peer that can see the
//   channel.
//
// The host adds the fields only for a peer that advertises `fork-host-v1`, so the wire of every
// released client stays as it was. A client accepts them whenever they are present. A present
// malformed value fails closed. A fork host built before these routes answers 404, so a client fails
// closed there. The bounds are written out: this file must not move with an IPC limit.
import { type ChannelMessage, isChannelMessage } from "../ipc-chat-channels";
import { isDynamicRecord, isString } from "../runtime-values";
import {
  adminRoute,
  boolean,
  count,
  empty,
  fields,
  identifier,
  list,
  nullable,
  type OptionalRouteCodec,
  oneOf,
  string,
} from "./admin-wire";
import { withChannelAttention } from "./channel-attention-v1";
import { CHANNEL_ROUTES, channelResponse, decodeChannelMessageWire } from "./channels-v1";
import { FORK_HOST_CAPABILITY } from "./fork-host-v1";
import type { TeamProtocolV2Json } from "./v2";

export const WORKSPACE_CAPABILITY = FORK_HOST_CAPABILITY;

export const WORKSPACE_ROUTES = {
  command: "/v1/workspace/channels/commands",
  thread: "/v1/workspace/channels/thread",
  settings: "/v1/admin/workspace/settings",
  settingsUpdate: "/v1/admin/workspace/settings/update",
} as const;

/** The largest thread page: the root and this many replies fit the frozen 100-message page bound. */
export const WORKSPACE_THREAD_PAGE_REPLIES = 99;

type Json = TeamProtocolV2Json;
type JsonObject = { [key: string]: Json };
type Decoder = (value: unknown) => Json;

const uniqueIdentifiers =
  (maximum: number): Decoder =>
  (value) => {
    const result = list(identifier, maximum)(value);
    if (!Array.isArray(result) || new Set(result).size !== result.length) throw new Error("Duplicate identifier.");
    return result;
  };
const nonEmpty =
  (maximum: number): Decoder =>
  (value) => {
    const result = string(maximum)(value);
    if (!isString(result) || !result.trim()) throw new Error("Invalid workspace text.");
    return result;
  };
const actor = fields({ kind: oneOf("member", "agent"), id: identifier });
const answerMode = oneOf("mention", "always", "always-no-gate", "lead");
const memberFields = { answerMode, focus: string(500) };
const member = fields({ agentId: identifier }, memberFields);

const CHANNEL_FIELDS: Record<string, Decoder> = {
  kind: oneOf("channel", "dm", "group"),
  visibility: oneOf("public", "private"),
  topic: string(250),
  description: string(2000),
  humanMemberIds: uniqueIdentifiers(500),
  createdBy: actor,
};
const mention: Decoder = (value) => {
  if (!isDynamicRecord(value)) throw new Error("Invalid mention.");
  if (value.kind === "channel" || value.kind === "here") {
    if (value.id !== undefined) throw new Error("Invalid mention.");
    return { kind: value.kind };
  }
  return fields({ kind: oneOf("member", "agent"), id: identifier })(value);
};
const unit: Decoder = (value) => {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1)
    throw new Error("Invalid workspace priority.");
  return value;
};
const gateDecision = fields(
  {
    agentId: identifier,
    answer: boolean,
    reason: string(120),
    priority: unit,
    model: string(300),
    ms: count,
  },
  { fallback: oneOf("timeout", "error", "invalid", "interrupted"), limited: boolean },
);
const MESSAGE_FIELDS: Record<string, Decoder> = {
  threadRootId: identifier,
  alsoInChannel: boolean,
  threadSummary: fields({ replyCount: count, lastReplyAt: string(80), participantIds: uniqueIdentifiers(20) }),
  reactions: list(fields({ emoji: nonEmpty(64), actors: list(actor, 200) }), 50),
  mentions: list(mention, 100),
  editedAt: string(80),
  deletedAt: string(80),
  gatePending: uniqueIdentifiers(100),
  gateDecisions: list(gateDecision, 100),
};

function present(source: unknown, decoders: Record<string, Decoder>): JsonObject {
  if (!isDynamicRecord(source)) return {};
  const result: JsonObject = {};
  for (const [key, decode] of Object.entries(decoders))
    if (source[key] !== undefined) result[key] = decode(source[key]);
  return result;
}

function isObject(value: Json | undefined): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** `projected` (a frozen channel or summary) with the workspace fields of `source`. */
function withChannelFields(projected: Json, source: unknown): Json {
  if (!isObject(projected) || !isDynamicRecord(source)) return projected;
  const result: JsonObject = { ...projected, ...present(source, CHANNEL_FIELDS) };
  const members = projected.members;
  const sourceMembers = source.members;
  if (Array.isArray(members) && Array.isArray(sourceMembers))
    result.members = members.map((entry, index) =>
      isObject(entry) ? { ...entry, ...present(sourceMembers[index], memberFields) } : entry,
    );
  return result;
}

function withMessageFields(projected: Json, source: unknown): Json {
  return isObject(projected) ? { ...projected, ...present(source, MESSAGE_FIELDS) } : projected;
}

function withPageFields(projected: Json, source: unknown): Json {
  if (!isObject(projected) || !isDynamicRecord(source)) return projected;
  const result: JsonObject = { ...projected, channel: withChannelFields(projected.channel ?? null, source.channel) };
  const messages = projected.messages;
  const sourceMessages = source.messages;
  if (Array.isArray(messages) && Array.isArray(sourceMessages))
    result.messages = messages.map((entry, index) => withMessageFields(entry, sourceMessages[index]));
  if (source.threadRootId !== undefined) result.threadRootId = identifier(source.threadRootId);
  return result;
}

/** `projected` with the workspace fields of `source` that the channels-v1 codec dropped. */
export function withWorkspaceChannels(path: string, projected: Json, source: unknown): Json {
  const pathname = new URL(path, "http://openbot.invalid").pathname;
  if (pathname === CHANNEL_ROUTES.list) {
    if (!Array.isArray(projected) || !Array.isArray(source)) return projected;
    return projected.map((summary, index) => withChannelFields(summary, source[index]));
  }
  if (pathname === CHANNEL_ROUTES.read) return withPageFields(projected, source);
  if (pathname === CHANNEL_ROUTES.command) return withChannelFields(projected, source);
  return projected;
}

/** The released channel routes whose responses carry workspace fields. */
export function isWorkspaceChannelRoute(path: string): boolean {
  const pathname = new URL(path, "http://openbot.invalid").pathname;
  return pathname === CHANNEL_ROUTES.list || pathname === CHANNEL_ROUTES.read || pathname === CHANNEL_ROUTES.command;
}

const COMMAND_TYPES = [
  "send",
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
];

const COMMAND_FIELDS: Record<string, { required: Record<string, Decoder>; optional?: Record<string, Decoder> }> = {
  send: {
    required: {
      text: string(100_000),
      recipientAgentId: nullable(identifier),
      replyToMessageId: nullable(identifier),
      attachmentDraftIds: uniqueIdentifiers(100),
    },
    optional: { threadRootId: nullable(identifier), alsoToChannel: boolean },
  },
  create: {
    required: {
      kind: oneOf("channel", "dm", "group"),
      visibility: oneOf("public", "private"),
      name: nonEmpty(80),
      humanMemberIds: uniqueIdentifiers(500),
      members: list(member, 100),
    },
    optional: {
      title: string(120),
      topic: string(250),
      description: string(2000),
      instructions: string(2000),
      leadAgentId: nullable(identifier),
    },
  },
  join: { required: {} },
  leave: { required: {} },
  invite: { required: { humanMemberIds: uniqueIdentifiers(500), members: list(member, 100) } },
  remove: { required: { humanMemberIds: uniqueIdentifiers(500), agentIds: uniqueIdentifiers(100) } },
  "set-member": {
    required: { agentId: identifier },
    optional: { answerMode: nullable(answerMode), focus: nullable(string(500)) },
  },
  "set-meta": { required: {}, optional: { name: nonEmpty(80), topic: string(250), description: string(2000) } },
  react: { required: { messageId: identifier, emoji: nonEmpty(64), action: oneOf("add", "remove") } },
  edit: { required: { messageId: identifier, text: nonEmpty(100_000) } },
  delete: { required: { messageId: identifier } },
  "open-dm": { required: { memberIds: uniqueIdentifiers(8), agentIds: uniqueIdentifiers(8) } },
};

const command: Decoder = (value) => {
  const common = fields({ type: oneOf(...COMMAND_TYPES), operationId: identifier, channelId: identifier })(value);
  const shape = isObject(common) && isString(common.type) ? COMMAND_FIELDS[common.type] : undefined;
  if (!shape || !isObject(common)) throw new Error("Invalid workspace command.");
  const rest = fields(shape.required, shape.optional ?? {})(value);
  return isObject(rest) ? { ...common, ...rest } : common;
};

const channelResult = (status: number, value: unknown): Json =>
  status >= 400
    ? channelResponse(CHANNEL_ROUTES.command, status, value)
    : withWorkspaceChannels(CHANNEL_ROUTES.command, channelResponse(CHANNEL_ROUTES.command, status, value), value);

const threadRequest = fields({ channelId: identifier, threadRootId: identifier }, { beforeSequence: count });
const threadPage = (status: number, value: unknown): Json => {
  if (status >= 400) return channelResponse(CHANNEL_ROUTES.read, status, value);
  const projected = channelResponse(CHANNEL_ROUTES.read, status, value);
  return withPageFields(withChannelAttention(CHANNEL_ROUTES.read, projected, value), value);
};

const settings = fields({
  gate: fields({ provider: identifier, model: nonEmpty(200), timeoutMs: count }, { effort: nonEmpty(32) }),
  defaults: fields({ agentAnswerMode: answerMode }),
});

export const WORKSPACE_CODECS: ReadonlyMap<string, OptionalRouteCodec> = new Map([
  [WORKSPACE_ROUTES.command, { request: command, response: channelResult }],
  [WORKSPACE_ROUTES.thread, { request: threadRequest, response: threadPage }],
  [WORKSPACE_ROUTES.settings, adminRoute(empty, settings)],
  [WORKSPACE_ROUTES.settingsUpdate, adminRoute(settings, settings)],
]);

export const CHANNEL_MESSAGE_EVENT = "channel-message";
export const CHANNEL_MESSAGE_REMOVED_EVENT = "channel-message-removed";

export type WorkspaceChannelEvent =
  | { type: typeof CHANNEL_MESSAGE_EVENT; channelId: string; message: ChannelMessage; revision: number }
  | { type: typeof CHANNEL_MESSAGE_REMOVED_EVENT; channelId: string; messageId: string; revision: number };

/** The workspace event in `value`, or null for any other event. A malformed one throws. */
export function workspaceChannelEvent(value: unknown): WorkspaceChannelEvent | null {
  if (!isDynamicRecord(value)) return null;
  if (value.type === CHANNEL_MESSAGE_EVENT) {
    const channelId = identifier(value.channelId);
    const revision = count(value.revision);
    const message = withMessageFields(decodeChannelMessageWire(value.message), value.message);
    if (!isString(channelId) || typeof revision !== "number" || !isChannelMessage(message))
      throw new Error("Invalid channel message event.");
    if (message.channelId !== channelId) throw new Error("Invalid channel message event.");
    return { type: CHANNEL_MESSAGE_EVENT, channelId, message, revision };
  }
  if (value.type === CHANNEL_MESSAGE_REMOVED_EVENT) {
    const channelId = identifier(value.channelId);
    const messageId = identifier(value.messageId);
    const revision = count(value.revision);
    if (!isString(channelId) || !isString(messageId) || typeof revision !== "number")
      throw new Error("Invalid channel message event.");
    return { type: CHANNEL_MESSAGE_REMOVED_EVENT, channelId, messageId, revision };
  }
  return null;
}
