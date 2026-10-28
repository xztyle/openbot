// The workspace half of a channel: the kind (channel, direct message, group), who can see it, the
// people in it, how each member agent answers, and the thread, reaction, mention and edit state of
// its messages. Every field is optional, so a channel or a message stored before this file, or read
// from a host without the workspace, is a public channel and a top-level message, as before.
//
// `ipc-chat-channels.ts` owns the channel types and calls the guards here. This file imports no
// value from it, so the two modules do not form an import cycle.

import { chatTagReferences } from "./chat-tag-references";
import { INPUT_LIMITS } from "./input-limits";
import { integerInRange, isBoundedString, isIdentifier } from "./ipc-bounded-values";
import { type DynamicRecord, isBoolean, isDynamicRecord, isOneOf } from "./runtime-values";

export const CHANNEL_KINDS = ["channel", "dm", "group"] as const;
/** `channel` is a named channel, `dm` a direct message between two people or one person and one agent, `group` a group DM. */
export type ChannelKind = (typeof CHANNEL_KINDS)[number];

export const CHANNEL_VISIBILITIES = ["public", "private"] as const;
export type ChannelVisibility = (typeof CHANNEL_VISIBILITIES)[number];

export const CHANNEL_ANSWER_MODES = ["mention", "always", "always-no-gate", "lead"] as const;
/**
 * When a member agent answers in a channel. `mention`: only when a message mentions it, replies to
 * it, or is in a thread it takes part in. `always`: it considers each message of a person; the
 * workspace gate decides if it answers. `always-no-gate`: it answers each message of a person.
 * `lead`: the coordinator routing of the channel, which is the behavior of a member with no mode.
 */
export type ChannelAnswerMode = (typeof CHANNEL_ANSWER_MODES)[number];

export const CHANNEL_TOPIC_LIMIT = 250;
export const CHANNEL_DESCRIPTION_LIMIT = INPUT_LIMITS.agentDescription;
export const CHANNEL_FOCUS_LIMIT = 500;
export const CHANNEL_HUMAN_MEMBER_LIMIT = 500;
/** A group DM holds at most this many participants, people and agents together. */
export const CHANNEL_GROUP_LIMIT = 9;
export const CHANNEL_EMOJI_LIMIT = 64;
export const CHANNEL_REACTION_LIMIT = 50;
export const CHANNEL_REACTION_ACTOR_LIMIT = 200;
export const CHANNEL_MENTION_LIMIT = 100;
export const CHANNEL_THREAD_PARTICIPANT_LIMIT = 20;
/** How many agent replies one person's message can start through mentions between agents. */
export const CHANNEL_MENTION_CHAIN_LIMIT = 3;
/** How many `always` members the gate lets answer one message. A mentioned agent does not count. */
export const CHANNEL_GATE_ANSWER_LIMIT = 2;
export const CHANNEL_GATE_REASON_LIMIT = 120;
export const CHANNEL_GATE_DECISION_LIMIT = 100;

export const CHANNEL_GATE_FALLBACKS = ["timeout", "error", "invalid", "interrupted"] as const;
/**
 * Why the gate has no decision of the model for an agent: it took longer than the workspace budget,
 * the generation failed, the model answered no valid decision, or the host stopped before it
 * decided. The agent then answers only as a `mention` member: it does not answer.
 */
export type ChannelGateFallback = (typeof CHANNEL_GATE_FALLBACKS)[number];

/**
 * What the gate decided for one `always` member on one message of a person. Stored on that message
 * and shown only to the owners and admins of the server ("why did or didn't this agent answer").
 */
export interface ChannelGateDecision {
  agentId: string;
  /** What the model decided. With `fallback`, false. */
  answer: boolean;
  /** The model's reason, at most `CHANNEL_GATE_REASON_LIMIT` characters. Empty with `fallback`. */
  reason: string;
  /** From 0 to 1. The gate keeps the highest ones when more agents want to answer than the limit. */
  priority: number;
  /** The gate model, as `provider/model`. */
  model: string;
  /** How long the decision took, in milliseconds. */
  ms: number;
  fallback?: ChannelGateFallback;
  /** The model decided to answer, but `CHANNEL_GATE_ANSWER_LIMIT` agents with a higher priority answer. */
  limited?: boolean;
}

/** A person (`member`, a team member id) or an agent that acts in a channel. */
export interface ChannelActorRef {
  kind: "member" | "agent";
  id: string;
}

/** On a thread root: how many replies it has, when the last one came, and who wrote them (newest first). */
export interface ChannelThreadSummary {
  replyCount: number;
  lastReplyAt: string;
  participantIds: string[];
}

export interface ChannelReaction {
  emoji: string;
  actors: ChannelActorRef[];
}

/** `channel` and `here` address everyone in the channel; they carry no id. */
export interface ChannelMention {
  kind: "member" | "agent" | "channel" | "here";
  id?: string;
}

/**
 * The Discord channel that a workspace channel is bridged with. `connectionId` is the Discord
 * connection of the host: its `workspaceId`, the Discord server (guild) id. `webhook` is true when
 * the host posts through a webhook of that channel, so each post shows its author's name and
 * picture; false or absent, the OpenBot bot posts with the author's name in front. The webhook
 * secret stays on the host.
 */
export interface ChannelDiscordLink {
  connectionId: string;
  channelId: string;
  channelName: string;
  webhook?: boolean;
}

export const CHANNEL_EXTERNAL_PLATFORMS = ["discord"] as const;
export type ChannelExternalPlatform = (typeof CHANNEL_EXTERNAL_PLATFORMS)[number];

/**
 * The person on another platform who wrote a bridged message. The message `author` is then a
 * `member` with an id that names no team member (`discord-<user id>`), so a client that does not
 * know this field shows the name.
 */
export interface ChannelExternalAuthor {
  kind: "external";
  platform: ChannelExternalPlatform;
  /** The user id on the platform. */
  id: string;
  name: string;
  /** An `https` picture address of the platform. */
  avatarUrl?: string;
}

export const CHANNEL_EXTERNAL_AVATAR_LIMIT = 500;

/** The workspace fields of a channel. Absent, the channel is a public `channel` with no listed people. */
export interface ChannelWorkspaceFields {
  kind?: ChannelKind;
  visibility?: ChannelVisibility;
  topic?: string;
  description?: string;
  /** Team member ids. In a public channel: the people who joined it. In a private channel, a DM or a group: the people who can see it. */
  humanMemberIds?: string[];
  createdBy?: ChannelActorRef;
  /** The bridged Discord channel. Only owners and admins change it (`link-discord`, `unlink-discord`). */
  discordLink?: ChannelDiscordLink;
}

/** The workspace fields of a channel message. */
export interface ChannelMessageWorkspaceFields {
  /** The id of the thread root. Absent: a top-level message. */
  threadRootId?: string;
  /** A thread reply that is also shown in the channel ("Also send to the channel"). */
  alsoInChannel?: boolean;
  threadSummary?: ChannelThreadSummary;
  reactions?: ChannelReaction[];
  mentions?: ChannelMention[];
  editedAt?: string;
  deletedAt?: string;
  /** On a message of a person: the `always` members that the gate still considers ("is thinking"). */
  gatePending?: string[];
  /** On a message of a person: the decisions of the gate. Only owners and admins receive them. */
  gateDecisions?: ChannelGateDecision[];
  /** Set on a message that a bridge brought from another platform, such as Discord. */
  externalAuthor?: ChannelExternalAuthor;
}

/** The workspace fields of one member agent. */
export interface ChannelMemberWorkspaceFields {
  answerMode?: ChannelAnswerMode;
  /** A short note of what this agent cares about in this channel. */
  focus?: string;
}

export function channelKind(channel: ChannelWorkspaceFields): ChannelKind {
  return channel.kind ?? "channel";
}

/** A DM and a group are always private. */
export function channelVisibility(channel: ChannelWorkspaceFields): ChannelVisibility {
  return channelKind(channel) !== "channel" ? "private" : (channel.visibility ?? "public");
}

/** A thread reply that the channel transcript leaves out. */
export function isChannelThreadReply(message: ChannelMessageWorkspaceFields): boolean {
  return message.threadRootId !== undefined && message.alsoInChannel !== true;
}

function identifiers(value: unknown, maximum: number): value is string[] {
  return (
    Array.isArray(value) && value.length <= maximum && value.every(isIdentifier) && new Set(value).size === value.length
  );
}

function timestamp(value: unknown): value is string {
  return isBoundedString(value, 80) && value.length > 0;
}

export function isChannelActorRef(value: unknown): value is ChannelActorRef {
  return isDynamicRecord(value) && (value.kind === "member" || value.kind === "agent") && isIdentifier(value.id);
}

export function isChannelDiscordLink(value: unknown): value is ChannelDiscordLink {
  return (
    isDynamicRecord(value) &&
    isIdentifier(value.connectionId) &&
    isIdentifier(value.channelId) &&
    isBoundedString(value.channelName, 100) &&
    (value.webhook === undefined || isBoolean(value.webhook))
  );
}

function isExternalAvatar(value: unknown): value is string {
  if (!isBoundedString(value, CHANNEL_EXTERNAL_AVATAR_LIMIT)) return false;
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

export function isChannelExternalAuthor(value: unknown): value is ChannelExternalAuthor {
  return (
    isDynamicRecord(value) &&
    value.kind === "external" &&
    isOneOf(CHANNEL_EXTERNAL_PLATFORMS, value.platform) &&
    isIdentifier(value.id) &&
    isBoundedString(value.name, 120) &&
    (value.avatarUrl === undefined || isExternalAvatar(value.avatarUrl))
  );
}

export function isChannelAnswerMode(value: unknown): value is ChannelAnswerMode {
  return isOneOf(CHANNEL_ANSWER_MODES, value);
}

export function isChannelEmoji(value: unknown): value is string {
  return isBoundedString(value, CHANNEL_EMOJI_LIMIT) && value.trim().length > 0;
}

/** The optional member fields. Absent fields pass. */
export function hasValidChannelMemberWorkspaceFields(value: DynamicRecord): boolean {
  return (
    (value.answerMode === undefined || isChannelAnswerMode(value.answerMode)) &&
    (value.focus === undefined || isBoundedString(value.focus, CHANNEL_FOCUS_LIMIT))
  );
}

/** The optional channel fields. Absent fields pass. */
export function hasValidChannelWorkspaceFields(value: DynamicRecord): boolean {
  return (
    (value.kind === undefined || isOneOf(CHANNEL_KINDS, value.kind)) &&
    (value.visibility === undefined || isOneOf(CHANNEL_VISIBILITIES, value.visibility)) &&
    (value.topic === undefined || isBoundedString(value.topic, CHANNEL_TOPIC_LIMIT)) &&
    (value.description === undefined || isBoundedString(value.description, CHANNEL_DESCRIPTION_LIMIT)) &&
    (value.humanMemberIds === undefined || identifiers(value.humanMemberIds, CHANNEL_HUMAN_MEMBER_LIMIT)) &&
    (value.createdBy === undefined || isChannelActorRef(value.createdBy)) &&
    (value.discordLink === undefined || isChannelDiscordLink(value.discordLink))
  );
}

export function isChannelThreadSummary(value: unknown): value is ChannelThreadSummary {
  return (
    isDynamicRecord(value) &&
    integerInRange(value.replyCount, 0, Number.MAX_SAFE_INTEGER) &&
    timestamp(value.lastReplyAt) &&
    identifiers(value.participantIds, CHANNEL_THREAD_PARTICIPANT_LIMIT)
  );
}

export function isChannelReaction(value: unknown): value is ChannelReaction {
  return (
    isDynamicRecord(value) &&
    isChannelEmoji(value.emoji) &&
    Array.isArray(value.actors) &&
    value.actors.length > 0 &&
    value.actors.length <= CHANNEL_REACTION_ACTOR_LIMIT &&
    value.actors.every(isChannelActorRef)
  );
}

export function isChannelMention(value: unknown): value is ChannelMention {
  if (!isDynamicRecord(value)) return false;
  if (value.kind === "channel" || value.kind === "here") return value.id === undefined;
  return (value.kind === "member" || value.kind === "agent") && isIdentifier(value.id);
}

export function isChannelGateDecision(value: unknown): value is ChannelGateDecision {
  return (
    isDynamicRecord(value) &&
    isIdentifier(value.agentId) &&
    isBoolean(value.answer) &&
    isBoundedString(value.reason, CHANNEL_GATE_REASON_LIMIT) &&
    typeof value.priority === "number" &&
    value.priority >= 0 &&
    value.priority <= 1 &&
    isBoundedString(value.model, 300) &&
    integerInRange(value.ms, 0, Number.MAX_SAFE_INTEGER) &&
    (value.fallback === undefined || isOneOf(CHANNEL_GATE_FALLBACKS, value.fallback)) &&
    (value.limited === undefined || isBoolean(value.limited))
  );
}

/** The optional message fields. Absent fields pass. */
export function hasValidChannelMessageWorkspaceFields(value: DynamicRecord): boolean {
  return (
    (value.threadRootId === undefined || isIdentifier(value.threadRootId)) &&
    (value.alsoInChannel === undefined || isBoolean(value.alsoInChannel)) &&
    (value.threadSummary === undefined || isChannelThreadSummary(value.threadSummary)) &&
    (value.reactions === undefined ||
      (Array.isArray(value.reactions) &&
        value.reactions.length <= CHANNEL_REACTION_LIMIT &&
        value.reactions.every(isChannelReaction))) &&
    (value.mentions === undefined ||
      (Array.isArray(value.mentions) &&
        value.mentions.length <= CHANNEL_MENTION_LIMIT &&
        value.mentions.every(isChannelMention))) &&
    (value.editedAt === undefined || timestamp(value.editedAt)) &&
    (value.deletedAt === undefined || timestamp(value.deletedAt)) &&
    (value.gatePending === undefined || identifiers(value.gatePending, CHANNEL_GATE_DECISION_LIMIT)) &&
    (value.gateDecisions === undefined ||
      (Array.isArray(value.gateDecisions) &&
        value.gateDecisions.length <= CHANNEL_GATE_DECISION_LIMIT &&
        value.gateDecisions.every(isChannelGateDecision))) &&
    (value.externalAuthor === undefined || isChannelExternalAuthor(value.externalAuthor))
  );
}

const BROADCAST_MENTION = /(^|[^\w@])@(channel|here|everyone)\b/giu;

/**
 * The people, agents and broadcasts that a message text mentions: each `@[name](member:id)` and
 * `@[name](agent:id)` tag, and the words `@channel`, `@everyone` (both `channel`) and `@here`. Each
 * one once, in the order of the text.
 */
export function channelMentions(text: string): ChannelMention[] {
  const found: { at: number; mention: ChannelMention; key: string }[] = [];
  for (const reference of chatTagReferences(text))
    if (reference.kind === "member" || reference.kind === "agent")
      found.push({
        at: reference.start,
        mention: { kind: reference.kind, id: reference.id },
        key: `${reference.kind}:${reference.id}`,
      });
  for (const match of text.matchAll(BROADCAST_MENTION)) {
    const kind = match[2]?.toLowerCase() === "here" ? "here" : "channel";
    found.push({ at: match.index ?? 0, mention: { kind }, key: kind });
  }
  const seen = new Set<string>();
  return found
    .sort((left, right) => left.at - right.at)
    .filter(({ key, mention }) => isChannelMention(mention) && !seen.has(key) && Boolean(seen.add(key)))
    .slice(0, CHANNEL_MENTION_LIMIT)
    .map(({ mention }) => mention);
}

export const WORKSPACE_GATE_TIMEOUT_LIMITS = { minimum: 500, maximum: 60_000 } as const;
/** The most agents that the workspace settings keep channel defaults for. */
export const WORKSPACE_AGENT_DEFAULTS_LIMIT = 500;

/** The cheap model that decides if an `always` member answers a message. */
export interface WorkspaceGateSettings {
  provider: string;
  model: string;
  effort?: string;
  timeoutMs: number;
}

/** What one agent takes when someone adds it to a channel. An absent field follows the workspace default. */
export interface WorkspaceAgentChannelDefaults {
  answerMode?: ChannelAnswerMode;
  focus?: string;
}

/** Server-wide workspace settings, saved in `openbot-workspace-v1.json` on the host. */
export interface WorkspaceSettings {
  gate: WorkspaceGateSettings;
  defaults: {
    agentAnswerMode: ChannelAnswerMode;
    /**
     * The channel defaults of single agents, by agent id. Absent in the settings of a client or a host
     * that does not know the field; the host then keeps the map it has.
     */
    agents?: Record<string, WorkspaceAgentChannelDefaults>;
  };
}

export const DEFAULT_WORKSPACE_SETTINGS: WorkspaceSettings = {
  // A warm generation answers in about two seconds; the first one after an idle time starts a process.
  gate: { provider: "claude", model: "claude-haiku-5-5", timeoutMs: 6_000 },
  defaults: { agentAnswerMode: "mention" },
};

function isAgentChannelDefaults(value: unknown): value is Record<string, WorkspaceAgentChannelDefaults> {
  if (!isDynamicRecord(value)) return false;
  const entries = Object.entries(value);
  return (
    entries.length <= WORKSPACE_AGENT_DEFAULTS_LIMIT &&
    entries.every(
      ([agentId, entry]) =>
        isIdentifier(agentId) && isDynamicRecord(entry) && hasValidChannelMemberWorkspaceFields(entry),
    )
  );
}

export function isWorkspaceSettings(value: unknown): value is WorkspaceSettings {
  if (!isDynamicRecord(value) || !isDynamicRecord(value.gate) || !isDynamicRecord(value.defaults)) return false;
  const gate = value.gate;
  return (
    isIdentifier(gate.provider) &&
    isBoundedString(gate.model, 200) &&
    gate.model.trim().length > 0 &&
    (gate.effort === undefined || (isBoundedString(gate.effort, 32) && gate.effort.length > 0)) &&
    integerInRange(gate.timeoutMs, WORKSPACE_GATE_TIMEOUT_LIMITS.minimum, WORKSPACE_GATE_TIMEOUT_LIMITS.maximum) &&
    isChannelAnswerMode(value.defaults.agentAnswerMode) &&
    (value.defaults.agents === undefined || isAgentChannelDefaults(value.defaults.agents))
  );
}

/** Only the known fields, so a saved file or a request cannot carry more. */
export function decodeWorkspaceSettings(value: unknown): WorkspaceSettings {
  if (!isWorkspaceSettings(value)) throw new Error("Invalid workspace settings.");
  return {
    gate: {
      provider: value.gate.provider,
      model: value.gate.model,
      ...(value.gate.effort === undefined ? {} : { effort: value.gate.effort }),
      timeoutMs: value.gate.timeoutMs,
    },
    defaults: {
      agentAnswerMode: value.defaults.agentAnswerMode,
      ...(value.defaults.agents === undefined ? {} : { agents: decodeAgentChannelDefaults(value.defaults.agents) }),
    },
  };
}

/** Only the known fields of each agent, and no agent whose defaults are all absent. */
function decodeAgentChannelDefaults(
  agents: Record<string, WorkspaceAgentChannelDefaults>,
): Record<string, WorkspaceAgentChannelDefaults> {
  // `fromEntries` defines each key as an own property, also an id such as `__proto__`.
  return Object.fromEntries(
    Object.entries(agents).flatMap(([agentId, entry]) => {
      const next: WorkspaceAgentChannelDefaults = {
        ...(entry.answerMode === undefined ? {} : { answerMode: entry.answerMode }),
        ...(entry.focus === undefined || !entry.focus.trim() ? {} : { focus: entry.focus.trim() }),
      };
      return next.answerMode !== undefined || next.focus !== undefined ? [[agentId, next] as const] : [];
    }),
  );
}

/**
 * The settings to save from `next`: a body without `defaults.agents` comes from a client that does
 * not know the field, so the channel defaults of `current` stay.
 */
export function withKeptAgentChannelDefaults(current: WorkspaceSettings, next: WorkspaceSettings): WorkspaceSettings {
  if (next.defaults.agents !== undefined || current.defaults.agents === undefined) return next;
  return { ...next, defaults: { ...next.defaults, agents: current.defaults.agents } };
}
