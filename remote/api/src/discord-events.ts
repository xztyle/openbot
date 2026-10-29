// What Signal keeps from the OpenBot Discord bot's Gateway, and how it turns a Gateway event into a
// delivery for a host. Everything here is pure and in memory: the Gateway adapter
// (`./discord-gateway.ts`) gives it the events and does the actions it returns.
//
// Signal keeps only the names and the channel-to-guild map of the guilds that the bot is in, and
// the pending button presses. It keeps no message.

import {
  DISCORD_ATTACHMENTS_LIMIT,
  DISCORD_CUSTOM_ID_PREFIX,
  DISCORD_QUOTE_TEXT_LIMIT,
  DISCORD_REACTION_EMOJI_LIMIT,
  DISCORD_ROLES_LIMIT,
  type DiscordDelivery,
  type DiscordInboundAttachment,
  type DiscordInboundInteraction,
  type DiscordInboundMessage,
  type DiscordInboundMessageChange,
  type DiscordInboundQuote,
  type DiscordInboundReaction,
} from "@openbot/contracts/signal-protocol/discord-api";
import {
  GatewayDispatchEvents,
  type GatewayDispatchPayload,
  InteractionType,
  MessageReferenceType,
} from "discord-api-types/v10";

/** The text of the one reply to a direct message. */
export const DISCORD_DIRECT_MESSAGE_REPLY = "OpenBot answers in Discord servers. Mention @OpenBot in a server channel.";

/** Discord accepts follow-ups with an interaction token for 15 minutes. */
const INTERACTION_TOKEN_TTL_MILLISECONDS = 15 * 60_000;
const MAXIMUM_INTERACTIONS = 10_000;
const DIRECT_REPLY_INTERVAL_MILLISECONDS = 60 * 60_000;
const MAXIMUM_DIRECT_REPLIES = 10_000;
const ATTACHMENT_HOSTS = new Set(["cdn.discordapp.com", "media.discordapp.net"]);
/** Discord deletes at most 100 messages in one bulk deletion. */
const DISCORD_BULK_DELETE_LIMIT = 100;
/** System messages about a thread: "started a thread" in the channel, and the first post of a thread. */
const THREAD_SYSTEM_MESSAGE_TYPES = new Set([18, 21]);

type DiscordAttachmentData = {
  id: string;
  filename: string;
  content_type?: string | undefined;
  size: number;
  url: string;
};

/** The fields of a Gateway or REST message that Signal reads. */
export interface DiscordMessageData {
  id: string;
  /** Discord's message type. Absent in a test fixture: a plain message. */
  type?: number;
  channel_id: string;
  guild_id?: string;
  content: string;
  timestamp: string;
  webhook_id?: string;
  author: { id: string; username: string; global_name?: string | null; bot?: boolean; avatar?: string | null };
  member?: { nick?: string | null; roles?: string[] };
  mentions: { id: string }[];
  message_reference?: { type?: number; message_id?: string };
  referenced_message?: {
    id: string;
    content?: string;
    timestamp?: string;
    author: { id: string; username?: string; global_name?: string | null };
    message_reference?: { message_id?: string };
    attachments?: DiscordAttachmentData[];
  } | null;
  attachments: DiscordAttachmentData[];
}

/** What the Gateway adapter does for one event. */
export type DiscordAction =
  | { type: "deliver"; guildId: string; delivery: DiscordDelivery }
  // Acknowledge a button press at once, as a deferred update: Discord waits 3 seconds.
  | { type: "acknowledge"; interactionId: string; interactionToken: string }
  | { type: "direct-reply"; channelId: string }
  // A new thread in a channel whose threads a host asked for: the bot joins it, so the Gateway sends
  // its messages.
  | { type: "join-thread"; channelId: string }
  // The Gateway listed every guild of the bot: the account service drops the links of the others.
  | { type: "reconcile" };

interface StoredInteraction {
  token: string;
  guildId: string;
  expiresAt: number;
}

/** The display name of a message author: the guild nickname, the global name, or the user name. */
export function discordAuthorName(message: {
  author: { username: string; global_name?: string | null | undefined };
  member?: { nick?: string | null | undefined } | undefined;
}): string {
  return message.member?.nick ?? message.author.global_name ?? message.author.username;
}

/** Removes each mention of the bot user: a host does not know the bot user ID. */
export function stripBotMention(content: string, botUserId: string | null): string {
  if (!botUserId) return content.trim();
  return content.split(`<@${botUserId}>`).join("").split(`<@!${botUserId}>`).join("").trim();
}

/** The author's picture on Discord's CDN, for a channel bridge of the host. */
function avatarOf(author: DiscordMessageData["author"]): { authorAvatarUrl?: string } {
  const hash = author.avatar;
  if (!hash || !/^(?:a_)?[0-9a-f]{1,64}$/u.test(hash)) return {};
  return { authorAvatarUrl: `https://cdn.discordapp.com/avatars/${author.id}/${hash}.png?size=128` };
}

/**
 * Whether the host of a guild asked for the messages of a channel that do not mention the bot
 * (`discord-listen`).
 */
export type DiscordListens = (guildId: string, channelId: string) => boolean;

/**
 * The delivery for one guild message, or null when the host must not receive it: a bot or webhook
 * wrote it, or it does not mention the bot in a channel that the host did not ask for. A message
 * without a mention has `mentioned: false`; a mention keeps the shape that an older host knows.
 */
export function normalizeGuildMessage(
  message: DiscordMessageData,
  botUserId: string,
  listens: DiscordListens = () => false,
): DiscordInboundMessage | null {
  if (!message.guild_id || message.author.bot === true || message.webhook_id) return null;
  if (message.type !== undefined && THREAD_SYSTEM_MESSAGE_TYPES.has(message.type)) return null;
  const mentioned = message.mentions.some((user) => user.id === botUserId);
  if (!mentioned && !listens(message.guild_id, message.channel_id)) return null;
  const reference = message.message_reference;
  let replyTo: DiscordInboundMessage["replyTo"] = null;
  const repliedId = message.referenced_message?.id ?? reference?.message_id;
  if (reference && (reference.type ?? MessageReferenceType.Default) === MessageReferenceType.Default && repliedId) {
    const referenced = message.referenced_message;
    const authorIsBot = referenced?.author.id === botUserId;
    replyTo = {
      messageId: repliedId,
      authorIsBot,
      rootId: authorIsBot ? (referenced?.message_reference?.message_id ?? null) : null,
      quote: authorIsBot || !referenced ? null : quoteOf(referenced, botUserId),
    };
  }
  return {
    id: message.id,
    channelId: message.channel_id,
    authorId: message.author.id,
    authorName: discordAuthorName(message),
    authorRoleIds: message.member?.roles?.slice(0, DISCORD_ROLES_LIMIT) ?? null,
    content: stripBotMention(message.content, botUserId),
    replyTo,
    attachments: attachmentsOf(message.attachments),
    sentAt: message.timestamp,
    ...avatarOf(message.author),
    ...(mentioned ? {} : { mentioned: false as const }),
  };
}

/**
 * The change for one edit of a person's message in a channel whose changes the host asked for, or
 * null: a bot or a webhook wrote it, the host did not ask, or Discord gave no text (an embed that
 * loaded, or a Gateway without the Message Content intent).
 */
export function normalizeMessageUpdate(
  message: Partial<DiscordMessageData> & { id: string; channel_id: string },
  listensChanges: DiscordListens,
): DiscordInboundMessageChange | null {
  if (!message.guild_id || message.author?.bot === true || message.webhook_id) return null;
  if (typeof message.content !== "string" || !listensChanges(message.guild_id, message.channel_id)) return null;
  return {
    id: message.id,
    channelId: message.channel_id,
    content: message.content,
    attachments: attachmentsOf(message.attachments ?? []),
  };
}

/** The fields of a Gateway reaction event that Signal reads. */
export interface DiscordReactionData {
  user_id: string;
  channel_id: string;
  message_id: string;
  guild_id?: string;
  member?: { nick?: string | null; user?: { username: string; global_name?: string | null; bot?: boolean } };
  emoji: { id: string | null; name: string | null };
  burst?: boolean;
}

/**
 * The text of a reaction's emoji: the unicode emoji, or `:name:` for a custom emoji of the guild.
 * Null when Discord gave no name, as for a custom emoji that was deleted since.
 */
export function reactionEmojiText(emoji: { id: string | null; name: string | null }): string | null {
  if (!emoji.name) return null;
  if (emoji.id === null) return emoji.name.length > DISCORD_REACTION_EMOJI_LIMIT ? null : emoji.name;
  return /^[\w~-]{1,32}$/u.test(emoji.name) ? `:${emoji.name}:` : null;
}

/**
 * The reaction of a person, or null when a bot reacted: OpenBot's own reactions too, so a mirrored
 * reaction does not come back. A custom emoji is `:name:`, and a super reaction counts as a plain
 * one. Discord names no member on a removal, so a removal has no name.
 */
export function normalizeReaction(
  reaction: DiscordReactionData,
  on: boolean,
  botUserId: string | null,
): DiscordInboundReaction | null {
  if (!reaction.guild_id || !botUserId || reaction.user_id === botUserId) return null;
  if (reaction.member?.user?.bot === true) return null;
  const emoji = reactionEmojiText(reaction.emoji);
  if (!emoji) return null;
  const user = reaction.member?.user;
  return {
    channelId: reaction.channel_id,
    messageId: reaction.message_id,
    userId: reaction.user_id,
    ...(user ? { userName: discordAuthorName({ author: user, member: reaction.member }) } : {}),
    emoji,
    on,
  };
}

/** The attachments on Discord's CDN, up to Discord's limit. */
export function attachmentsOf(list: DiscordAttachmentData[]): DiscordInboundAttachment[] {
  const attachments: DiscordInboundAttachment[] = [];
  for (const attachment of list) {
    if (attachments.length >= DISCORD_ATTACHMENTS_LIMIT) break;
    if (!isDiscordCdnUrl(attachment.url)) continue;
    attachments.push({
      id: attachment.id,
      filename: attachment.filename,
      contentType: attachment.content_type ?? null,
      size: attachment.size,
      url: attachment.url,
    });
  }
  return attachments;
}

/**
 * The replied-to message of a person, or null when Discord gave neither text nor attachments:
 * without the Message Content intent, Discord gives them only for a message that mentions the bot.
 */
function quoteOf(
  referenced: NonNullable<DiscordMessageData["referenced_message"]>,
  botUserId: string,
): DiscordInboundQuote | null {
  const content = stripBotMention(referenced.content ?? "", botUserId);
  const attachments = attachmentsOf(referenced.attachments ?? []);
  if ((!content && attachments.length === 0) || !referenced.timestamp) return null;
  return {
    authorId: referenced.author.id,
    authorName: referenced.author.global_name ?? referenced.author.username ?? referenced.author.id,
    content: content.slice(0, DISCORD_QUOTE_TEXT_LIMIT),
    sentAt: referenced.timestamp,
    attachments,
  };
}

function isDiscordCdnUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && ATTACHMENT_HOSTS.has(url.hostname);
  } catch {
    return false;
  }
}

export class DiscordState {
  readonly #configuredApplicationId: string;
  #applicationId: string | null = null;
  #botUserId: string | null = null;
  // Guild ID to name, for each guild that the bot is in.
  readonly #guilds = new Map<string, string>();
  // The guilds that the bot is in, for each Gateway shard, from that shard's READY on. Discord puts a
  // guild on shard `(guild_id >> 22) % shard count`.
  readonly #shardGuilds = new Map<number, Set<string>>();
  #shardCount: number | null = null;
  // The shards whose connection closed. Their guilds can be stale until the shard resumes, when the
  // Gateway sends the missed events, or until its next READY.
  readonly #closedShards = new Set<number>();
  // Channel or thread ID to its guild and name, and for a thread its channel.
  readonly #channels = new Map<string, { guildId: string; name: string; parentId?: string }>();
  readonly #interactions = new Map<string, StoredInteraction>();
  // User ID to the time of the last reply to a direct message from that user.
  readonly #directReplies = new Map<string, number>();

  readonly #listens: DiscordListens;
  readonly #listensChanges: DiscordListens;
  readonly #listensReactions: DiscordListens;
  readonly #listensThreads: DiscordListens;
  readonly #listensReactionClears: DiscordListens;

  constructor(
    applicationId: string,
    listens: DiscordListens = () => false,
    // Whether the host of a guild asked for the edits and deletions in a listened channel.
    listensChanges: DiscordListens = () => false,
    // Whether the host asked for the reactions in a listened channel, and for the threads of one.
    // and for the reactions that a moderator clears at once.
    more: { reactions?: DiscordListens; threads?: DiscordListens; reactionClears?: DiscordListens } = {},
  ) {
    this.#configuredApplicationId = applicationId;
    this.#listens = listens;
    this.#listensChanges = listensChanges;
    this.#listensReactions = more.reactions ?? (() => false);
    this.#listensThreads = more.threads ?? (() => false);
    this.#listensReactionClears = more.reactionClears ?? (() => false);
  }

  /**
   * The channel of a thread whose host asked for the threads of that channel, or null: the channel
   * is not a thread, Signal does not know its channel, or the host did not ask.
   */
  #threadParent(guildId: string, channelId: string): string | null {
    const parentId = this.#channels.get(channelId)?.parentId;
    return parentId && this.#listensThreads(guildId, parentId) ? parentId : null;
  }

  #rememberThread(thread: { id: string; parent_id?: string | null; name?: string | null }, guildId: string): void {
    this.#channels.set(thread.id, {
      guildId,
      name: thread.name ?? "",
      ...(thread.parent_id ? { parentId: thread.parent_id } : {}),
    });
  }

  /** Whether the bot is in the guild, or null before the READY of every shard. */
  isMember(guildId: string): boolean | null {
    return this.memberGuildIds() === null
      ? null
      : (this.#shardGuilds.get(this.#shardOf(guildId))?.has(guildId) ?? false);
  }

  /** Every guild that the bot is in, or null before the READY of every shard and while one is closed. */
  memberGuildIds(): string[] | null {
    const count = this.#shardCount;
    if (count === null || this.#shardGuilds.size < count || this.#closedShards.size > 0) return null;
    return [...this.#shardGuilds.values()].flatMap((guilds) => [...guilds]);
  }

  /** A shard's connection closed: its guilds are not known until it resumes or is ready again. */
  shardClosed(shard: number): void {
    this.#closedShards.add(shard);
  }

  /** A shard resumed: the Gateway sent the events it missed, so its guilds are current again. */
  shardResumed(shard: number): DiscordAction[] {
    this.#closedShards.delete(shard);
    return this.memberGuildIds() === null ? [] : [{ type: "reconcile" }];
  }

  #shardOf(guildId: string): number {
    return Number((BigInt(guildId) >> 22n) % BigInt(this.#shardCount ?? 1));
  }

  get botUserId(): string | null {
    return this.#botUserId;
  }

  /** The application ID from the Gateway, or the configured one before READY. */
  get applicationId(): string {
    return this.#applicationId ?? this.#configuredApplicationId;
  }

  channel(channelId: string): { guildId: string; name: string } | null {
    return this.#channels.get(channelId) ?? null;
  }

  /** Keeps a channel that a REST call found, for a guild that the bot is in. */
  rememberChannel(channelId: string, guildId: string, name: string): void {
    if (this.#guilds.has(guildId)) this.#channels.set(channelId, { guildId, name });
  }

  /** The token of a button press in the guild that Discord still accepts, or null. */
  interactionToken(interactionId: string, guildId: string, now = Date.now()): string | null {
    const stored = this.#interactions.get(interactionId);
    if (!stored || stored.guildId !== guildId || stored.expiresAt <= now) return null;
    return stored.token;
  }

  handle(payload: GatewayDispatchPayload, now = Date.now()): DiscordAction[] {
    switch (payload.t) {
      case GatewayDispatchEvents.Ready:
        this.#botUserId = payload.d.user.id;
        this.#applicationId = payload.d.application.id;
        {
          const [shard, count] = payload.d.shard ?? [0, 1];
          // A new session of a shard lists its guilds again; a guild that it does not list was left.
          if (this.#shardCount !== count) this.#shardGuilds.clear();
          this.#shardCount = count;
          this.#shardGuilds.set(shard, new Set(payload.d.guilds.map((guild) => guild.id)));
          this.#closedShards.delete(shard);
        }
        return this.memberGuildIds() === null ? [] : [{ type: "reconcile" }];
      case GatewayDispatchEvents.GuildCreate:
      case GatewayDispatchEvents.GuildUpdate: {
        const guild = payload.d;
        this.#guilds.set(guild.id, guild.name);
        if (this.#shardCount !== null) this.#shardGuilds.get(this.#shardOf(guild.id))?.add(guild.id);
        if (payload.t === GatewayDispatchEvents.GuildCreate) {
          for (const channel of payload.d.channels ?? []) {
            this.#channels.set(channel.id, { guildId: guild.id, name: channel.name ?? "" });
          }
          for (const thread of payload.d.threads ?? []) this.#rememberThread(thread, guild.id);
        }
        return [];
      }
      case GatewayDispatchEvents.GuildDelete: {
        // An outage makes a guild unavailable. Only a removal ends the guild's connection.
        if (payload.d.unavailable === true) return [];
        this.#forgetGuild(payload.d.id);
        return [{ type: "deliver", guildId: payload.d.id, delivery: { kind: "removed" } }];
      }
      case GatewayDispatchEvents.ChannelCreate:
      case GatewayDispatchEvents.ChannelUpdate: {
        const channel = payload.d;
        if ("guild_id" in channel && channel.guild_id) {
          this.#channels.set(channel.id, { guildId: channel.guild_id, name: channel.name ?? "" });
        }
        return [];
      }
      case GatewayDispatchEvents.ThreadCreate:
      case GatewayDispatchEvents.ThreadUpdate: {
        const thread = payload.d;
        if (!thread.guild_id) return [];
        this.#rememberThread(thread, thread.guild_id);
        return payload.t === GatewayDispatchEvents.ThreadCreate &&
          payload.d.newly_created === true &&
          this.#threadParent(thread.guild_id, thread.id)
          ? [{ type: "join-thread", channelId: thread.id }]
          : [];
      }
      case GatewayDispatchEvents.ChannelDelete:
      case GatewayDispatchEvents.ThreadDelete:
        this.#channels.delete(payload.d.id);
        return [];
      case GatewayDispatchEvents.ThreadListSync:
        for (const thread of payload.d.threads) this.#rememberThread(thread, payload.d.guild_id);
        return [];
      case GatewayDispatchEvents.MessageCreate:
        return this.#message(payload.d, now);
      case GatewayDispatchEvents.MessageUpdate: {
        // In a thread, the changes of the thread's channel count.
        const parent = payload.d.guild_id ? this.#threadParent(payload.d.guild_id, payload.d.channel_id) : null;
        const change = normalizeMessageUpdate(payload.d, (guildId, channelId) =>
          this.#listensChanges(guildId, parent ?? channelId),
        );
        return change && payload.d.guild_id
          ? [
              {
                type: "deliver",
                guildId: payload.d.guild_id,
                delivery: {
                  kind: "message-update",
                  change: { ...change, ...(parent ? { threadParentId: parent } : {}) },
                },
              },
            ]
          : [];
      }
      case GatewayDispatchEvents.MessageDelete: {
        // Discord names no author for a deletion; the host mirrors only the messages it brought in.
        const { guild_id: guildId, channel_id: channelId, id: messageId } = payload.d;
        const parent = guildId ? this.#threadParent(guildId, channelId) : null;
        return guildId && this.#listensChanges(guildId, parent ?? channelId)
          ? [
              {
                type: "deliver",
                guildId,
                delivery: {
                  kind: "message-delete",
                  channelId,
                  messageId,
                  ...(parent ? { threadParentId: parent } : {}),
                },
              },
            ]
          : [];
      }
      case GatewayDispatchEvents.MessageDeleteBulk: {
        // A moderator or a bot deleted many messages at once. Each one is a `message-delete`, the
        // delivery that every host with `changes` already knows.
        const { guild_id: guildId, channel_id: channelId, ids } = payload.d;
        const parent = guildId ? this.#threadParent(guildId, channelId) : null;
        if (!guildId || !this.#listensChanges(guildId, parent ?? channelId)) return [];
        return [...new Set(ids)].slice(0, DISCORD_BULK_DELETE_LIMIT).map((messageId) => ({
          type: "deliver" as const,
          guildId,
          delivery: {
            kind: "message-delete" as const,
            channelId,
            messageId,
            ...(parent ? { threadParentId: parent } : {}),
          },
        }));
      }
      case GatewayDispatchEvents.MessageReactionAdd:
      case GatewayDispatchEvents.MessageReactionRemove: {
        const reaction = normalizeReaction(
          payload.d,
          payload.t === GatewayDispatchEvents.MessageReactionAdd,
          this.#botUserId,
        );
        const guildId = payload.d.guild_id;
        if (!reaction || !guildId) return [];
        const parent = this.#threadParent(guildId, reaction.channelId);
        if (!this.#listensReactions(guildId, parent ?? reaction.channelId)) return [];
        return [
          {
            type: "deliver",
            guildId,
            delivery: { kind: "reaction", reaction: { ...reaction, ...(parent ? { threadParentId: parent } : {}) } },
          },
        ];
      }
      case GatewayDispatchEvents.MessageReactionRemoveAll:
      case GatewayDispatchEvents.MessageReactionRemoveEmoji: {
        // A moderator removed all the reactions of a message, or all of one emoji. Discord names no
        // people, so the host removes the reactions of every Discord person it mirrored.
        const { guild_id: guildId, channel_id: channelId, message_id: messageId } = payload.d;
        if (!guildId) return [];
        let emoji: string | undefined;
        if (payload.t === GatewayDispatchEvents.MessageReactionRemoveEmoji) {
          const text = reactionEmojiText(payload.d.emoji);
          if (!text) return [];
          emoji = text;
        }
        const parent = this.#threadParent(guildId, channelId);
        if (!this.#listensReactionClears(guildId, parent ?? channelId)) return [];
        return [
          {
            type: "deliver",
            guildId,
            delivery: {
              kind: "reaction-clear",
              channelId,
              messageId,
              ...(emoji ? { emoji } : {}),
              ...(parent ? { threadParentId: parent } : {}),
            },
          },
        ];
      }
      case GatewayDispatchEvents.InteractionCreate:
        return this.#interaction(payload.d, now);
      default:
        return [];
    }
  }

  #message(message: DiscordMessageData, now: number): DiscordAction[] {
    if (!message.guild_id) return this.#directMessage(message, now);
    if (!this.#botUserId) return [];
    // A message in a thread of a listened channel, for a host that asked for the threads.
    const parent = this.#threadParent(message.guild_id, message.channel_id);
    const normalized = normalizeGuildMessage(message, this.#botUserId, parent ? () => true : this.#listens);
    return normalized
      ? [
          {
            type: "deliver",
            guildId: message.guild_id,
            delivery: { kind: "message", message: { ...normalized, ...(parent ? { threadParentId: parent } : {}) } },
          },
        ]
      : [];
  }

  #directMessage(message: DiscordMessageData, now: number): DiscordAction[] {
    if (message.author.bot === true || message.webhook_id) return [];
    const last = this.#directReplies.get(message.author.id);
    if (last !== undefined && now - last < DIRECT_REPLY_INTERVAL_MILLISECONDS) return [];
    for (const [userId, repliedAt] of this.#directReplies) {
      if (now - repliedAt >= DIRECT_REPLY_INTERVAL_MILLISECONDS) this.#directReplies.delete(userId);
    }
    this.#directReplies.delete(message.author.id);
    if (this.#directReplies.size >= MAXIMUM_DIRECT_REPLIES) return [];
    this.#directReplies.set(message.author.id, now);
    return [{ type: "direct-reply", channelId: message.channel_id }];
  }

  #interaction(
    interaction: Extract<GatewayDispatchPayload, { t: GatewayDispatchEvents.InteractionCreate }>["d"],
    now: number,
  ): DiscordAction[] {
    if (interaction.type !== InteractionType.MessageComponent) return [];
    const guildId = interaction.guild_id;
    const userId = interaction.member?.user.id;
    const customId = interaction.data.custom_id;
    const channelId = interaction.channel?.id ?? interaction.channel_id;
    if (!guildId || !userId || !channelId || !customId.startsWith(DISCORD_CUSTOM_ID_PREFIX)) return [];
    this.#rememberInteraction(
      interaction.id,
      { token: interaction.token, guildId, expiresAt: now + INTERACTION_TOKEN_TTL_MILLISECONDS },
      now,
    );
    const pressed: DiscordInboundInteraction = {
      id: interaction.id,
      channelId,
      messageId: interaction.message.id,
      replyToId: interaction.message.message_reference?.message_id ?? null,
      userId,
      customId,
    };
    return [
      { type: "acknowledge", interactionId: interaction.id, interactionToken: interaction.token },
      { type: "deliver", guildId, delivery: { kind: "interaction", interaction: pressed } },
    ];
  }

  #rememberInteraction(id: string, stored: StoredInteraction, now: number): void {
    for (const [key, value] of this.#interactions) {
      if (value.expiresAt <= now) this.#interactions.delete(key);
    }
    while (this.#interactions.size >= MAXIMUM_INTERACTIONS) {
      const oldest = this.#interactions.keys().next().value;
      if (oldest === undefined) break;
      this.#interactions.delete(oldest);
    }
    this.#interactions.set(id, stored);
  }

  #forgetGuild(guildId: string): void {
    this.#guilds.delete(guildId);
    if (this.#shardCount !== null) this.#shardGuilds.get(this.#shardOf(guildId))?.delete(guildId);
    for (const [channelId, channel] of this.#channels) {
      if (channel.guildId === guildId) this.#channels.delete(channelId);
    }
    for (const [interactionId, interaction] of this.#interactions) {
      if (interaction.guildId === guildId) this.#interactions.delete(interactionId);
    }
  }
}
