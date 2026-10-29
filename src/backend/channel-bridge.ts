import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { chatTagReferences } from "@openbot/contracts/chat-tag-references";
import { INPUT_LIMITS } from "@openbot/contracts/input-limits";
import {
  type AgentEvent,
  CHANNEL_RESULT_MESSAGE_PREFIX,
  type Channel,
  type ChannelDiscordLink,
  type ChannelExternalAuthor,
  type ChannelMessage,
  channelMembersAnswer,
  channelMentions,
  isRestatedChannelResult,
} from "@openbot/contracts/ipc";
import { isDynamicRecord } from "@openbot/contracts/runtime-values";
import { DISCORD_MESSAGE_TEXT_LIMIT } from "@openbot/contracts/signal-protocol/discord-api";
import { sourceText } from "@openbot/i18n/source";
import { createOpenBotLogger } from "@openbot/logging";
import { Effect, Exit, Schema, Scope, Semaphore } from "effect";
import { writeJsonFileAtomically } from "./atomic-json-file";
import type { ChannelDiscordBridgePort, ChannelService } from "./channel-service";
import { chunkMarkdown } from "./messaging/messaging-chunks";
import {
  type BridgedDiscordChange,
  type BridgedDiscordMessage,
  type BridgedDiscordReaction,
  DiscordApiError,
  type InboundFile,
  type MessagingAdapter,
  MessagingAdapterError,
  type MessagingChannelBridge,
} from "./messaging/messaging-types";

const logger = createOpenBotLogger("channel-bridge");

const DISCORD_API = "https://discord.com/api/v10";
/** A margin under Discord's limit for the reply line and the name in front of a bot post. */
const CHUNK_CHARACTERS = DISCORD_MESSAGE_TEXT_LIMIT - 200;
/** The bridged messages that each channel remembers, newest kept. Older ones are no longer mirrored. */
const MESSAGES_PER_CHANNEL = 2_000;
/** How long a burst of changes in one channel waits, so a streaming answer is read once at its end. */
const SETTLE_MS = 1_000;
const WEBHOOK_TIMEOUT_MS = 15_000;
const WEBHOOK_NAME = "OpenBot bridge";
/** Agent message kinds that are not an answer for the reader: steps, plans, questions. */
const ANSWER_ITEM_TYPES = new Set([undefined, "agentMessage", "final_answer"]);

const Webhook = Schema.Struct({
  guildId: Schema.String,
  channelId: Schema.String,
  webhookId: Schema.String,
  token: Schema.String,
});
const Bridged = Schema.Struct({
  id: Schema.String,
  discordIds: Schema.Array(Schema.String),
  viaWebhook: Schema.Boolean,
  hash: Schema.String,
  inbound: Schema.Boolean,
  // Later fields; an older build ignores them.
  threadId: Schema.optional(Schema.String),
  postedIn: Schema.optional(Schema.String),
  reactions: Schema.optional(Schema.Array(Schema.String)),
});
const Link = Schema.Struct({ linkedAt: Schema.String, messages: Schema.Array(Bridged) });
const BridgeFile = Schema.Struct({
  version: Schema.Literal(1),
  webhooks: Schema.Record(Schema.String, Webhook),
  links: Schema.Record(Schema.String, Link),
});
const decodeBridgeFile = Schema.decodeUnknownSync(BridgeFile);

type WebhookSecret = typeof Webhook.Type;
interface BridgedMessage {
  id: string;
  /** The Discord posts of the message, the first one first. A long message takes several. */
  discordIds: string[];
  viaWebhook: boolean;
  /** The hash of the text that Discord shows, to see an edit. */
  hash: string;
  /** It came from Discord. */
  inbound: boolean;
  /** On a thread root: the Discord thread (a channel) that holds its replies. */
  threadId?: string;
  /** The Discord thread that the posts are in, when they are not in the bridged channel itself. */
  postedIn?: string;
  /** The unicode emoji that OpenBot added in Discord, for the workspace reactions of the message. */
  reactions?: string[];
}
interface LinkState {
  linkedAt: string;
  /** Oldest first. */
  messages: BridgedMessage[];
}

export interface ChannelBridgeOptions {
  channels: ChannelService;
  messaging: {
    discordAdapter(guildId: string): MessagingAdapter | null;
    refreshDiscordListen(guildId: string): void;
    setChannelBridge(bridge: MessagingChannelBridge | null): void;
  };
  /** Subscribes to the agent events; returns the unsubscribe. */
  onEvent(listener: (event: AgentEvent) => void): () => void;
  /** The host-only file of webhook secrets and bridged message ids. Null keeps them in memory. */
  path: string | null;
  /** A public `https` picture of a person or an agent, for a webhook post. */
  avatarUrl?(author: ChannelMessage["author"]): string | null;
  fetch?: typeof fetch;
}

/** What a webhook post or edit sends. `allowed_mentions` is added to each: no post pings anyone. */
interface WebhookBody {
  content: string;
  username?: string;
  avatar_url?: string;
}

class WebhookGone extends Schema.TaggedError<WebhookGone>()("WebhookGone", {}) {}
class WebhookFailed extends Schema.TaggedError<WebhookFailed>()("WebhookFailed", { status: Schema.Number }) {}

/** A unicode emoji that Discord takes as a reaction. A custom emoji or a short code is not one. */
export function isUnicodeReaction(emoji: string): boolean {
  return (
    emoji.length <= 64 &&
    /^(?:\p{Extended_Pictographic}|\p{Emoji_Component}|\p{Emoji_Modifier}|\u200D|\uFE0F|\u20E3)+$/u.test(emoji) &&
    /\p{Extended_Pictographic}|\p{Regional_Indicator}|\u20E3/u.test(emoji)
  );
}

/** The member id of a Discord person in the workspace: the author id of their bridged messages. */
function discordMemberId(userId: string): string {
  return `discord-${userId}`;
}

function hashText(text: string): string {
  return createHash("sha256").update(text).digest("base64url").slice(0, 22);
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

/** Workspace tags as Discord text: `@[Ana](member:id)` is `@Ana`, `#[general](channel:id)` is `#general`. */
function discordText(text: string): string {
  let result = "";
  let at = 0;
  for (const reference of chatTagReferences(text)) {
    result += text.slice(at, reference.start);
    result +=
      reference.kind === "channel" ? `#${reference.name}` : reference.kind === "quote" ? "" : `@${reference.name}`;
    at = reference.end;
  }
  return result + text.slice(at);
}

/** A webhook name that Discord takes: 1 to 80 characters, without "discord" or "clyde". */
function webhookName(name: string): string {
  const cleaned = name
    .replace(/discord|clyde/giu, (word) => `${word[0]}​${word.slice(1)}`)
    .trim()
    .slice(0, 80);
  return cleaned || "OpenBot";
}

/**
 * Bridges workspace channels with Discord channels. A Discord message of a person in a bridged
 * channel becomes a channel message with an external author, and goes through the answer modes as
 * a person's message does. The messages of people and the answers of agents in the workspace
 * channel go to Discord: through a webhook of the channel with the author's name and picture when
 * the bot could make one, otherwise from the bot with the name in front.
 *
 * The link itself is in the channel (`discordLink`). The webhook secrets and the map between
 * Discord and workspace message ids stay in a host-only file, never on the wire. Signal leaves out
 * the posts of bots and webhooks, so a bridged post does not come back.
 *
 * Reactions with a unicode emoji go both ways: a person's reaction in Discord is a reaction of the
 * member `discord-<user id>`, and the reactions of the workspace's own people and agents are
 * OpenBot's reactions on the Discord post. A Discord thread maps to the workspace thread of its
 * root: a thread that starts from a bridged message has that message's id, and a thread without one
 * makes its first message the root. A deletion in Discord of a workspace post leaves the workspace
 * message; the bridge forgets its Discord ids, so an edit later does not call Discord again.
 */
export class ChannelBridge implements MessagingChannelBridge, ChannelDiscordBridgePort {
  readonly #options: ChannelBridgeOptions;
  readonly #fetch: typeof fetch;
  readonly #scope = Scope.makeUnsafe();
  readonly #writes = Semaphore.makeUnsafe(1);
  /** `guildId:discordChannelId` to the workspace channel id. */
  readonly #index = new Map<string, string>();
  /** Workspace channel id to its link, for the bridged channels in `#index`. */
  readonly #links = new Map<string, ChannelDiscordLink>();
  #webhooks = new Map<string, WebhookSecret>();
  #state = new Map<string, LinkState>();
  /** By channel: the message ids that changed and wait for the settle. */
  readonly #pending = new Map<string, Set<string>>();
  readonly #timers = new Map<string, ReturnType<typeof setTimeout>>();
  readonly #serial = new Map<string, Semaphore.Semaphore>();
  #unsubscribe: (() => void) | null = null;

  constructor(options: ChannelBridgeOptions) {
    this.#options = options;
    this.#fetch = options.fetch ?? fetch;
  }

  /** Reads the file and the links, then takes the bridged messages of messaging and the channel events. */
  start(): void {
    this.#load();
    for (const channelId of this.#options.channels.store.ids()) {
      this.#reindex(channelId);
      // An archived bridge takes nothing, and its state tells an unarchive to take it again.
      if (!this.#state.has(channelId) && this.#hasLink(channelId))
        this.#state.set(channelId, { linkedAt: new Date().toISOString(), messages: [] });
    }
    // A link that went while OpenBot was off leaves a webhook and its message ids.
    for (const channelId of new Set([...this.#webhooks.keys(), ...this.#state.keys()]))
      if (!this.#hasLink(channelId)) this.#forget(channelId);
    this.#unsubscribe = this.#options.onEvent((event) => this.#event(event));
    this.#options.channels.discordBridge = this;
    this.#options.messaging.setChannelBridge(this);
  }

  readonly stop = Effect.fn("ChannelBridge.stop")(function* (this: ChannelBridge) {
    this.#unsubscribe?.();
    this.#unsubscribe = null;
    if (this.#options.channels.discordBridge === this) this.#options.channels.discordBridge = null;
    this.#options.messaging.setChannelBridge(null);
    for (const timer of this.#timers.values()) clearTimeout(timer);
    this.#timers.clear();
    yield* Scope.close(this.#scope, Exit.void);
  });

  // --- MessagingChannelBridge ---

  discordChannels(guildId: string): readonly string[] {
    const prefix = `${guildId}:`;
    return [...this.#index.keys()].filter((key) => key.startsWith(prefix)).map((key) => key.slice(prefix.length));
  }

  readonly receiveDiscord = Effect.fn("ChannelBridge.receiveDiscord")(function* (
    this: ChannelBridge,
    message: BridgedDiscordMessage,
  ) {
    const channelId = this.#index.get(`${message.guildId}:${message.channelId}`);
    if (!channelId) return;
    yield* this.#serialFor(channelId).withPermit(
      this.#receive(channelId, message).pipe(
        Effect.catch((error) =>
          Effect.sync(() => logger.warn("A Discord message did not reach its bridged channel.", errorName(error))),
        ),
      ),
    );
  });

  readonly changeDiscord = Effect.fn("ChannelBridge.changeDiscord")(function* (
    this: ChannelBridge,
    change: BridgedDiscordChange,
  ) {
    const channelId = this.#index.get(`${change.guildId}:${change.channelId}`);
    if (!channelId) return;
    yield* this.#serialFor(channelId).withPermit(
      this.#change(channelId, change).pipe(
        Effect.catch((error) =>
          Effect.sync(() => logger.warn("A Discord edit did not reach its bridged channel.", errorName(error))),
        ),
      ),
    );
  });

  readonly reactDiscord = Effect.fn("ChannelBridge.reactDiscord")(function* (
    this: ChannelBridge,
    reaction: BridgedDiscordReaction,
  ) {
    const channelId = this.#index.get(`${reaction.guildId}:${reaction.channelId}`);
    if (!channelId) return;
    yield* this.#serialFor(channelId).withPermit(
      this.#react(channelId, reaction).pipe(
        Effect.catch((error) =>
          Effect.sync(() => logger.warn("A Discord reaction did not reach its bridged channel.", errorName(error))),
        ),
      ),
    );
  });

  // --- ChannelDiscordBridgePort ---

  readonly link = Effect.fn("ChannelBridge.link")(function* (
    this: ChannelBridge,
    channel: Channel,
    guildId: string,
    discordChannelId: string,
  ): Effect.fn.Return<ChannelDiscordLink, Error> {
    const adapter = this.#options.messaging.discordAdapter(guildId);
    if (!adapter) return yield* Effect.fail(new Error(sourceText("error.backend.channelDiscordUnavailable")));
    const taken = this.#workspaceChannelOf(guildId, discordChannelId);
    if (taken && taken !== channel.id)
      return yield* Effect.fail(new Error(sourceText("error.backend.channelDiscordTaken")));
    const places = yield* adapter
      .places()
      .pipe(Effect.mapError(() => new Error(sourceText("error.backend.channelDiscordUnavailable"))));
    const place = places.find((item) => item.id === discordChannelId && item.kind === "channel");
    if (!place) return yield* Effect.fail(new Error(sourceText("error.backend.channelDiscordChannelMissing")));
    const channelName = place.name.replace(/^#/u, "").slice(0, 100) || discordChannelId;
    const kept = this.#webhooks.get(channel.id);
    if (kept?.guildId === guildId && kept.channelId === discordChannelId)
      return { connectionId: guildId, channelId: discordChannelId, channelName, webhook: true };
    // Without Manage Webhooks, or from an older Signal, the bot posts with the author's name in front.
    const created = adapter.createWebhook
      ? yield* adapter.createWebhook(discordChannelId, WEBHOOK_NAME).pipe(
          Effect.map((webhook) => ({ webhookId: webhook.webhookId, token: webhook.token })),
          Effect.catch(() => Effect.succeed(null)),
        )
      : null;
    if (created) {
      if (kept) this.#deleteWebhook(kept);
      this.#webhooks.set(channel.id, { guildId, channelId: discordChannelId, ...created });
      yield* this.#save();
    }
    return { connectionId: guildId, channelId: discordChannelId, channelName, webhook: created !== null };
  });

  changed(channelId: string, previous: ChannelDiscordLink | undefined, next: ChannelDiscordLink | undefined): void {
    const moved =
      previous && (!next || previous.connectionId !== next.connectionId || previous.channelId !== next.channelId);
    if (moved || !next) {
      // A new Discord channel starts a new map; the old webhook goes unless the link kept it.
      const webhook = this.#webhooks.get(channelId);
      if (webhook && (!next || webhook.guildId !== next.connectionId || webhook.channelId !== next.channelId)) {
        this.#deleteWebhook(webhook);
        this.#webhooks.delete(channelId);
      }
      this.#state.delete(channelId);
    }
    if (next && !this.#state.has(channelId))
      this.#state.set(channelId, { linkedAt: new Date().toISOString(), messages: [] });
    this.#fork(this.#save());
    this.#reindex(channelId);
  }

  // --- Inbound ---

  readonly #receive = Effect.fn("ChannelBridge.receiveOne")(function* (
    this: ChannelBridge,
    channelId: string,
    message: BridgedDiscordMessage,
  ) {
    const { channels } = this.#options;
    const state = this.#state.get(channelId);
    if (!state || state.messages.some((item) => item.inbound && item.discordIds.includes(message.messageId))) return;
    const channel = channels.store.get(channelId);
    if (channel.archived || !channel.discordLink) return;
    // In a Discord thread: the thread's root. Else the message it replies to.
    const threadId = message.threadId ?? null;
    const anchor = threadId
      ? (state.messages.find((item) => item.threadId === threadId) ??
        state.messages.find((item) => item.discordIds.includes(threadId)))
      : message.replyToMessageId
        ? state.messages.find((item) => item.discordIds.includes(message.replyToMessageId ?? ""))
        : undefined;
    const anchorMessage = anchor ? channels.store.message(channelId, anchor.id) : null;
    const threadRootId =
      anchorMessage && !anchorMessage.deletedAt ? (anchorMessage.threadRootId ?? anchorMessage.id) : null;
    const root = threadRootId ? channels.store.message(channelId, threadRootId) : null;
    const threadRoot = root && !root.deletedAt && !root.threadRootId ? root : null;
    const text = this.#inboundText(channel, message.text, message.files);
    if (!text.trim()) return;
    const author: ChannelExternalAuthor = {
      kind: "external",
      platform: "discord",
      id: message.authorId,
      name: message.authorName.slice(0, 120) || message.authorId,
      ...(message.authorAvatarUrl ? { avatarUrl: message.authorAvatarUrl } : {}),
    };
    const messageId = randomUUID();
    yield* channels.command(
      {
        type: "send",
        operationId: `discord-${message.messageId}`,
        channelId,
        text,
        recipientAgentId: this.#addressedAgent(channel, text, message.mentionedBot),
        replyToMessageId: null,
        attachmentDraftIds: [],
        ...(threadRoot ? { threadRootId: threadRoot.id } : {}),
        bridged: { messageId, author },
      },
      { id: discordMemberId(message.authorId), name: author.name },
    );
    if (threadId && threadRoot) {
      // The root keeps its Discord thread, so the workspace replies go into it.
      const rootRecord = state.messages.find((item) => item.id === threadRoot.id);
      if (!rootRecord)
        // A root that the bridge never posted, as when the thread starts from one of its replies.
        this.#remember(channelId, {
          id: threadRoot.id,
          discordIds: [],
          viaWebhook: false,
          hash: "",
          inbound: threadRoot.externalAuthor !== undefined,
          threadId,
        });
      else if (!rootRecord.threadId) this.#remember(channelId, { ...rootRecord, threadId });
    } else if (threadId) {
      // A thread without a known root: its first message is the root of the workspace thread.
      for (const item of state.messages) if (item.threadId === threadId) delete item.threadId;
    }
    this.#remember(channelId, {
      id: messageId,
      discordIds: [message.messageId],
      viaWebhook: false,
      hash: hashText(text),
      inbound: true,
      ...(threadId && !threadRoot ? { threadId } : {}),
      ...(threadId ? { postedIn: threadId } : {}),
    });
    yield* this.#save();
  });

  /**
   * Mirrors an edit or a deletion that a person made in Discord, for a message the bridge brought
   * in. The edit or the deletion acts as the Discord author, who wrote the workspace message.
   */
  readonly #change = Effect.fn("ChannelBridge.changeOne")(function* (
    this: ChannelBridge,
    channelId: string,
    change: BridgedDiscordChange,
  ) {
    const { channels } = this.#options;
    const state = this.#state.get(channelId);
    const posted = state?.messages.find((item) => !item.inbound && item.discordIds.includes(change.messageId));
    if (state && posted) {
      // Someone deleted a workspace post in Discord. The workspace keeps the message; the bridge
      // forgets the deleted post, so an edit or a deletion later does not call Discord for it.
      if (!change.edit) {
        this.#remember(channelId, { ...posted, discordIds: posted.discordIds.filter((id) => id !== change.messageId) });
        yield* this.#save();
      }
      return;
    }
    const known = state?.messages.find((item) => item.inbound && item.discordIds.includes(change.messageId));
    if (!state || !known) return;
    const channel = channels.store.get(channelId);
    const message = channels.store.message(channelId, known.id);
    if (channel.archived || !channel.discordLink || !message || message.deletedAt) return;
    const actor = { id: message.author.id, name: message.author.name };
    if (!change.edit) {
      yield* channels.command(
        { type: "delete", operationId: `discord-delete-${change.messageId}`, channelId, messageId: known.id },
        actor,
      );
      this.#remember(channelId, { ...known, hash: "" });
      return yield* this.#save();
    }
    const text = this.#inboundText(channel, change.edit.text, change.edit.files);
    const hash = hashText(text);
    if (!text.trim() || hash === known.hash) return;
    yield* channels.command(
      {
        type: "edit",
        operationId: `discord-edit-${change.messageId}-${hash}`,
        channelId,
        messageId: known.id,
        text,
      },
      actor,
    );
    this.#remember(channelId, { ...known, hash });
    yield* this.#save();
  });

  /**
   * Mirrors a person's reaction in Discord on a bridged message, of either direction, as a reaction
   * of the member `discord-<user id>`. OpenBot's own reactions never arrive: Signal leaves them out.
   */
  readonly #react = Effect.fn("ChannelBridge.reactOne")(function* (
    this: ChannelBridge,
    channelId: string,
    reaction: BridgedDiscordReaction,
  ) {
    const { channels } = this.#options;
    const state = this.#state.get(channelId);
    const known = state?.messages.find((item) => item.discordIds.includes(reaction.messageId));
    if (!state || !known || !isUnicodeReaction(reaction.emoji)) return;
    const channel = channels.store.get(channelId);
    const message = channels.store.message(channelId, known.id);
    if (channel.archived || !channel.discordLink || !message || message.deletedAt) return;
    const actorId = discordMemberId(reaction.userId);
    const has = (message.reactions ?? []).some(
      (item) =>
        item.emoji === reaction.emoji && item.actors.some((actor) => actor.kind === "member" && actor.id === actorId),
    );
    if (has === reaction.on) return;
    const name = (reaction.userName ?? "").slice(0, 120) || reaction.userId;
    yield* channels.command(
      {
        type: "react",
        operationId: `discord-react-${randomUUID()}`,
        channelId,
        messageId: known.id,
        emoji: reaction.emoji,
        action: reaction.on ? "add" : "remove",
      },
      { id: actorId, name },
    );
  });

  /** The workspace text of a Discord message: agent names as tags, then a line for each file. */
  #inboundText(channel: Channel, text: string, files: readonly InboundFile[]): string {
    return [this.#agentTags(channel, text), ...files.map((file) => `📎 [${file.name}](${file.url})`)]
      .filter(Boolean)
      .join("\n")
      .slice(0, INPUT_LIMITS.messageText);
  }

  /** `@Name` of a member agent, typed in Discord, as the workspace tag that addresses it. */
  #agentTags(channel: Channel, text: string): string {
    const agents = this.#options.channels.hooks
      .agents()
      .filter((agent) => channel.members.some((member) => member.agentId === agent.id) && agent.name.trim())
      .sort((left, right) => right.name.length - left.name.length);
    let result = text;
    for (const agent of agents)
      result = result.replace(
        new RegExp(`(^|[^\\w@\\[])@${escapeRegExp(agent.name)}(?![\\w])`, "giu"),
        (_match, before: string) => `${before}@[${agent.name}](agent:${agent.id})`,
      );
    return result;
  }

  /**
   * A mention of OpenBot in Discord, with no agent named, addresses the channel: its lead, or its
   * only member agent. Otherwise the answer modes decide.
   */
  #addressedAgent(channel: Channel, text: string, mentionedBot: boolean): string | null {
    if (!mentionedBot || channelMentions(text).some((mention) => mention.kind === "agent")) return null;
    const live = new Set(this.#options.channels.hooks.agents().map((agent) => agent.id));
    const eligible = channel.members
      .map((member) => member.agentId)
      .filter((agentId) => live.has(agentId) && !this.#options.channels.hooks.hidden?.(agentId));
    if (channel.leadAgentId && eligible.includes(channel.leadAgentId)) return channel.leadAgentId;
    return eligible.length === 1 ? (eligible[0] ?? null) : null;
  }

  // --- Outbound ---

  #event(event: AgentEvent): void {
    if (event.type === "channels-changed") {
      // Only a bridged channel, or one archived with a bridge, can change its bridge here: a new
      // bridge comes through `changed`.
      if (this.#links.has(event.channelId) || this.#state.has(event.channelId)) this.#reindex(event.channelId);
      if (this.#links.has(event.channelId)) this.#schedule(event.channelId);
      return;
    }
    if (event.type === "channel-message" || event.type === "channel-message-removed") {
      if (!this.#links.has(event.channelId)) return;
      const id = event.type === "channel-message" ? event.message.id : event.messageId;
      const pending = this.#pending.get(event.channelId) ?? new Set<string>();
      pending.add(id);
      this.#pending.set(event.channelId, pending);
      this.#schedule(event.channelId);
    }
  }

  #schedule(channelId: string): void {
    if (this.#timers.has(channelId)) return;
    this.#timers.set(
      channelId,
      setTimeout(() => {
        this.#timers.delete(channelId);
        this.#fork(
          this.#serialFor(channelId).withPermit(
            this.#flush(channelId).pipe(
              Effect.catch((error) =>
                Effect.sync(() => logger.warn("A bridged channel did not reach Discord.", errorName(error))),
              ),
            ),
          ),
        );
      }, SETTLE_MS),
    );
  }

  /**
   * Mirrors the changed messages: a new answer or message is posted, an edit is edited, a deletion
   * is deleted. A message of an agent whose task still runs waits for the task, so a step that the
   * turn later turns into commentary does not reach Discord.
   */
  readonly #flush = Effect.fn("ChannelBridge.flush")(function* (this: ChannelBridge, channelId: string) {
    const link = this.#links.get(channelId);
    const state = this.#state.get(channelId);
    if (!link || !state) return;
    const pending = this.#pending.get(channelId);
    this.#pending.delete(channelId);
    if (!pending?.size) return;
    const { store } = this.#options.channels;
    const tasks = new Map(store.tasks(channelId).map((task) => [task.id, task]));
    const waiting = new Set<string>();
    const changed: ChannelMessage[] = [];
    // A result note that restates an answer of its turn is never posted. The history is read only
    // when such a note changed.
    const membersAnswer = channelMembersAnswer(store.get(channelId));
    let history: ChannelMessage[] | null = null;
    const restated = (message: ChannelMessage): boolean => {
      if (!membersAnswer || !message.id.startsWith(CHANNEL_RESULT_MESSAGE_PREFIX)) return false;
      history ??= store.messages(channelId);
      return isRestatedChannelResult(
        message,
        history.filter((item) => item.message.turnId === message.message.turnId),
        true,
      );
    };
    for (const id of pending) {
      const message = store.message(channelId, id);
      const known = state.messages.find((item) => item.id === id);
      if (!message || message.deletedAt || (known && !this.#postable(message)) || restated(message)) {
        if (known && !known.inbound) yield* this.#mirror("be deleted", this.#remove(link, channelId, known));
        continue;
      }
      if (!this.#postable(message) || message.message.createdAt < state.linkedAt) continue;
      const task = message.taskId ? tasks.get(message.taskId) : undefined;
      if (message.author.kind === "agent" && (task?.state === "running" || task?.state === "queued")) {
        waiting.add(id);
        continue;
      }
      changed.push(message);
    }
    if (waiting.size) {
      const next = this.#pending.get(channelId) ?? new Set<string>();
      for (const id of waiting) next.add(id);
      this.#pending.set(channelId, next);
    }
    for (const message of changed.sort((left, right) => left.sequence - right.sequence)) {
      const known = state.messages.find((item) => item.id === message.id);
      if (known?.inbound) continue;
      const text = this.#outboundText(message, state, link, known?.viaWebhook ?? this.#webhooks.has(channelId));
      if (known) {
        if (known.hash !== hashText(text)) yield* this.#mirror("be edited", this.#edit(link, channelId, known, text));
      } else yield* this.#mirror("be posted", this.#post(link, channelId, message, text));
    }
    // The reactions of the workspace's people and agents, on the bridged messages of both directions.
    for (const id of pending) {
      if (waiting.has(id)) continue;
      const message = store.message(channelId, id);
      const known = state.messages.find((item) => item.id === id);
      if (message && !message.deletedAt && known) yield* this.#syncReactions(link, channelId, known, message);
    }
    yield* this.#save();
  });

  /**
   * Adds and removes OpenBot's reactions on the first Discord post of a message, so that they follow
   * the unicode reactions that people and agents of the workspace have on it. The reactions of
   * Discord people (`discord-<id>`) are in Discord already. Only the bot can react: a webhook cannot.
   */
  readonly #syncReactions = Effect.fn("ChannelBridge.syncReactions")(function* (
    this: ChannelBridge,
    link: ChannelDiscordLink,
    channelId: string,
    known: BridgedMessage,
    message: ChannelMessage,
  ) {
    const [first] = known.discordIds;
    const adapter = this.#options.messaging.discordAdapter(link.connectionId);
    if (!first || !adapter?.reactEmoji) return;
    const wanted = new Set(
      (message.reactions ?? [])
        .filter(
          (reaction) =>
            isUnicodeReaction(reaction.emoji) &&
            reaction.actors.some((actor) => actor.kind === "agent" || !actor.id.startsWith("discord-")),
        )
        .map((reaction) => reaction.emoji),
    );
    const current = new Set(known.reactions ?? []);
    const target = { platformChannelId: known.postedIn ?? link.channelId, replyThreadId: null };
    for (const emoji of [...wanted].filter((item) => !current.has(item)))
      yield* this.#mirror(
        "be reacted to",
        adapter.reactEmoji(target, first, emoji, true).pipe(Effect.tap(() => Effect.sync(() => current.add(emoji)))),
      );
    for (const emoji of [...current].filter((item) => !wanted.has(item)))
      yield* this.#mirror(
        "be reacted to",
        adapter
          .reactEmoji(target, first, emoji, false)
          .pipe(Effect.tap(() => Effect.sync(() => current.delete(emoji)))),
      );
    const reactions = [...current];
    const record = this.#state.get(channelId)?.messages.find((item) => item.id === known.id);
    if (!record) return;
    if (reactions.length) record.reactions = reactions;
    else delete record.reactions;
  });

  /** The Discord thread that holds the replies of a workspace thread reply's root, if it has one. */
  #discordThread(message: ChannelMessage, state: LinkState): string | null {
    if (!message.threadRootId) return null;
    return state.messages.find((item) => item.id === message.threadRootId)?.threadId ?? null;
  }

  /** One failed post does not hold the next ones. Discord's answer text is not logged. */
  #mirror(action: string, effect: Effect.Effect<void, unknown>): Effect.Effect<void> {
    return effect.pipe(
      Effect.catch((error) =>
        Effect.sync(() => logger.warn(`A bridged message could not ${action} in Discord.`, errorName(error))),
      ),
    );
  }

  /** People's messages and agents' answers; never a bridged message, a routine request, or a step. */
  #postable(message: ChannelMessage): boolean {
    if (message.externalAuthor || message.superseded || !message.message.text.trim()) return false;
    if (message.message.status !== "completed") return false;
    if (message.author.kind === "member") return !message.author.id.startsWith("routine:");
    if (message.author.kind !== "agent") return false;
    return (
      ANSWER_ITEM_TYPES.has(message.message.itemType) && !message.message.questionPrompt && !message.message.uiBlock
    );
  }

  /** The text that Discord shows: the reply line for a thread or a reply, the text, the file names. */
  #outboundText(message: ChannelMessage, state: LinkState, link: ChannelDiscordLink, viaWebhook: boolean): string {
    const files = (message.message.attachments ?? []).map((file) => `📎 ${file.name}`);
    const body = [discordText(message.message.text), ...files].filter(Boolean).join("\n");
    const name = viaWebhook ? "" : `**${message.author.name.replace(/[*_`~|]/gu, "")}:** `;
    // A reply that goes into a Discord thread needs no reply line.
    if (this.#discordThread(message, state)) return `${name}${body}`;
    const repliedId = message.threadRootId ?? message.message.replyToMessageId ?? null;
    const replied = repliedId ? state.messages.find((item) => item.id === repliedId)?.discordIds[0] : undefined;
    // A webhook post cannot reply in Discord, so it links the message it answers.
    const replyLine =
      replied && viaWebhook
        ? `-# ↪ https://discord.com/channels/${link.connectionId}/${link.channelId}/${replied}\n`
        : "";
    return `${replyLine}${name}${body}`;
  }

  readonly #post = Effect.fn("ChannelBridge.post")(function* (
    this: ChannelBridge,
    link: ChannelDiscordLink,
    channelId: string,
    message: ChannelMessage,
    text: string,
  ) {
    const chunks = chunkMarkdown(text, CHUNK_CHARACTERS);
    const webhook = this.#webhooks.get(channelId);
    const ids: string[] = [];
    const thread = this.#discordThread(message, this.#state.get(channelId) ?? { linkedAt: "", messages: [] });
    const inThread = thread ? { postedIn: thread } : {};
    if (webhook) {
      const username = webhookName(message.author.name);
      const avatarUrl = this.#options.avatarUrl?.(message.author) ?? null;
      const posted = yield* Effect.forEach(chunks, (content) =>
        this.#webhookCall(webhook, "POST", `?wait=true${threadQuery(thread, "&")}`, {
          content,
          username,
          ...(avatarUrl ? { avatar_url: avatarUrl } : {}),
        }),
      ).pipe(
        Effect.map((answers) => answers.map((answer) => answer ?? "")),
        Effect.catchTag("WebhookGone", () =>
          Effect.sync(() => {
            // Someone deleted the webhook in Discord: the bot posts from now on.
            this.#webhooks.delete(channelId);
            return null;
          }),
        ),
      );
      if (posted) {
        this.#remember(channelId, {
          id: message.id,
          discordIds: posted.filter(Boolean),
          viaWebhook: true,
          hash: hashText(text),
          inbound: false,
          ...inThread,
        });
        return;
      }
      text = this.#outboundText(message, this.#state.get(channelId) ?? { linkedAt: "", messages: [] }, link, false);
    }
    const adapter = this.#options.messaging.discordAdapter(link.connectionId);
    if (!adapter) return;
    const state = this.#state.get(channelId);
    const repliedId = message.threadRootId ?? message.message.replyToMessageId ?? null;
    const replyTo =
      repliedId && !thread ? (state?.messages.find((item) => item.id === repliedId)?.discordIds[0] ?? null) : null;
    for (const content of chunkMarkdown(text, CHUNK_CHARACTERS))
      ids.push(
        yield* adapter.post({ platformChannelId: thread ?? link.channelId, replyThreadId: replyTo }, { text: content }),
      );
    this.#remember(channelId, {
      id: message.id,
      discordIds: ids,
      viaWebhook: false,
      hash: hashText(text),
      inbound: false,
      ...inThread,
    });
  });

  /** An edit changes the first post. A longer text than it holds is cut to Discord's limit. */
  readonly #edit = Effect.fn("ChannelBridge.edit")(function* (
    this: ChannelBridge,
    link: ChannelDiscordLink,
    channelId: string,
    known: BridgedMessage,
    text: string,
  ) {
    const [first] = known.discordIds;
    if (!first) return;
    const content = chunkMarkdown(text, CHUNK_CHARACTERS)[0] ?? text.slice(0, CHUNK_CHARACTERS);
    const webhook = this.#webhooks.get(channelId);
    // A post that is gone in Discord is forgotten, so the next edit does not try it again.
    let gone = false;
    if (known.viaWebhook) {
      if (!webhook) return;
      yield* this.#webhookCall(webhook, "PATCH", `/messages/${first}${threadQuery(known.postedIn, "?")}`, {
        content,
      }).pipe(
        Effect.catchTag("WebhookGone", () => Effect.void),
        Effect.catchTag("WebhookFailed", (error) =>
          error.status === 404 ? Effect.sync(() => (gone = true)) : Effect.fail(error),
        ),
      );
    } else {
      const adapter = this.#options.messaging.discordAdapter(link.connectionId);
      if (!adapter) return;
      yield* adapter
        .edit({ platformChannelId: known.postedIn ?? link.channelId, replyThreadId: null }, first, { text: content })
        .pipe(Effect.catch((error) => (isNotFound(error) ? Effect.sync(() => (gone = true)) : Effect.fail(error))));
    }
    if (gone) known.discordIds = known.discordIds.filter((id) => id !== first);
    known.hash = hashText(text);
  });

  readonly #remove = Effect.fn("ChannelBridge.remove")(function* (
    this: ChannelBridge,
    link: ChannelDiscordLink,
    channelId: string,
    known: BridgedMessage,
  ) {
    const webhook = this.#webhooks.get(channelId);
    const adapter = this.#options.messaging.discordAdapter(link.connectionId);
    for (const id of known.discordIds) {
      if (known.viaWebhook && webhook)
        yield* this.#webhookCall(webhook, "DELETE", `/messages/${id}${threadQuery(known.postedIn, "?")}`, null).pipe(
          Effect.catch(() => Effect.succeed(null)),
        );
      else if (!known.viaWebhook && adapter?.remove)
        yield* adapter
          .remove({ platformChannelId: known.postedIn ?? link.channelId, replyThreadId: null }, id)
          .pipe(Effect.catch(() => Effect.void));
    }
    const state = this.#state.get(channelId);
    if (state) state.messages = state.messages.filter((item) => item !== known);
  });

  /**
   * One call of a channel webhook, straight to Discord: the webhook token authorizes it, so it needs
   * neither Signal nor the bot token. No post can ping anyone. Answers the message id of a post.
   */
  #webhookCall(
    webhook: WebhookSecret,
    method: "POST" | "PATCH" | "DELETE",
    suffix: string,
    body: WebhookBody | null,
  ): Effect.Effect<string | null, WebhookGone | WebhookFailed> {
    const url = `${DISCORD_API}/webhooks/${webhook.webhookId}/${webhook.token}${suffix}`;
    const request = Effect.tryPromise({
      try: async (signal) => {
        const response = await this.#fetch(url, {
          method,
          signal: AbortSignal.any([signal, AbortSignal.timeout(WEBHOOK_TIMEOUT_MS)]),
          ...(body
            ? {
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ ...body, allowed_mentions: { parse: [] } }),
              }
            : {}),
        });
        if (response.status === 429) {
          const retry = Number(answerField(await response.json().catch(() => null), "retry_after") ?? 1);
          return { status: 429, retryMs: Math.min(10_000, Math.max(0, retry * 1_000)), id: null };
        }
        if (!response.ok) return { status: response.status, retryMs: 0, id: null };
        if (response.status === 204) return { status: 204, retryMs: 0, id: null };
        const id = answerField(await response.json().catch(() => null), "id");
        return { status: response.status, retryMs: 0, id };
      },
      catch: () => new WebhookFailed({ status: 0 }),
    });
    const answer = (attempt: number): Effect.Effect<string | null, WebhookGone | WebhookFailed> =>
      request.pipe(
        Effect.flatMap((result) => {
          if (result.status === 429 && attempt < 2)
            return Effect.sleep(result.retryMs).pipe(Effect.andThen(answer(attempt + 1)));
          if (result.status === 401 || (result.status === 404 && method === "POST"))
            return Effect.fail(new WebhookGone());
          if (result.status >= 400 && !(result.status === 404 && method === "DELETE"))
            return Effect.fail(new WebhookFailed({ status: result.status }));
          return Effect.succeed(result.id);
        }),
      );
    return answer(0);
  }

  #deleteWebhook(webhook: WebhookSecret): void {
    this.#fork(
      this.#webhookCall(webhook, "DELETE", "", null).pipe(
        Effect.catch(() => Effect.sync(() => logger.warn("A bridge webhook could not be deleted in Discord."))),
      ),
    );
  }

  // --- Links and the file ---

  /** Follows the stored link of one channel: a bridged channel that is archived or deleted takes nothing. */
  #reindex(channelId: string): void {
    const link = this.#storedLink(channelId);
    const before = this.#links.get(channelId);
    const same = before && link && before.connectionId === link.connectionId && before.channelId === link.channelId;
    if (same) {
      this.#links.set(channelId, link);
      return;
    }
    if (before) {
      this.#index.delete(`${before.connectionId}:${before.channelId}`);
      this.#links.delete(channelId);
      this.#options.messaging.refreshDiscordListen(before.connectionId);
    }
    if (link) {
      const key = `${link.connectionId}:${link.channelId}`;
      // A Discord channel has one bridge: the first channel keeps it.
      if (this.#index.has(key) && this.#index.get(key) !== channelId) return;
      this.#index.set(key, channelId);
      this.#links.set(channelId, link);
      if (!this.#state.has(channelId)) this.#state.set(channelId, { linkedAt: new Date().toISOString(), messages: [] });
      this.#options.messaging.refreshDiscordListen(link.connectionId);
    }
    // A deleted channel leaves its webhook and its message ids.
    if (
      !link &&
      (this.#state.has(channelId) || this.#webhooks.has(channelId)) &&
      !this.#options.channels.store.exists(channelId)
    )
      this.#forget(channelId);
  }

  #storedLink(channelId: string): ChannelDiscordLink | null {
    const { store } = this.#options.channels;
    try {
      if (!store.exists(channelId)) return null;
      const channel = store.get(channelId);
      return channel.archived ? null : (channel.discordLink ?? null);
    } catch {
      return null;
    }
  }

  /** Whether the channel exists and has a link, archived or not. */
  #hasLink(channelId: string): boolean {
    const { store } = this.#options.channels;
    try {
      return store.exists(channelId) && store.get(channelId).discordLink !== undefined;
    } catch {
      return false;
    }
  }

  /** The workspace channel bridged with a Discord channel, archived ones too. */
  #workspaceChannelOf(guildId: string, discordChannelId: string): string | null {
    const indexed = this.#index.get(`${guildId}:${discordChannelId}`);
    if (indexed) return indexed;
    const { store } = this.#options.channels;
    for (const id of store.ids()) {
      const link = store.get(id).discordLink;
      if (link?.connectionId === guildId && link.channelId === discordChannelId) return id;
    }
    return null;
  }

  /** Drops what a link that no longer exists left: its webhook in Discord and its message ids. */
  #forget(channelId: string): void {
    const webhook = this.#webhooks.get(channelId);
    if (webhook) this.#deleteWebhook(webhook);
    this.#webhooks.delete(channelId);
    this.#state.delete(channelId);
    this.#fork(this.#save());
  }

  #remember(channelId: string, message: BridgedMessage): void {
    const state = this.#state.get(channelId);
    if (!state) return;
    state.messages = [...state.messages.filter((item) => item.id !== message.id), message].slice(-MESSAGES_PER_CHANNEL);
  }

  #serialFor(channelId: string): Semaphore.Semaphore {
    let serial = this.#serial.get(channelId);
    if (!serial) {
      serial = Semaphore.makeUnsafe(1);
      this.#serial.set(channelId, serial);
    }
    return serial;
  }

  #fork(effect: Effect.Effect<void, unknown>): void {
    Effect.runFork(
      Effect.forkIn(
        effect.pipe(
          Effect.catch((error) => Effect.sync(() => logger.warn("The channel bridge failed.", errorName(error)))),
        ),
        this.#scope,
      ),
    );
  }

  #load(): void {
    const path = this.#options.path;
    if (!path) return;
    try {
      const file = decodeBridgeFile(JSON.parse(readFileSync(path, "utf8")));
      this.#webhooks = new Map(Object.entries(file.webhooks).map(([id, webhook]) => [id, { ...webhook }]));
      this.#state = new Map(
        Object.entries(file.links).map(([id, link]) => [
          id,
          {
            linkedAt: link.linkedAt,
            messages: link.messages.map(({ reactions, ...item }) => ({
              ...item,
              discordIds: [...item.discordIds],
              ...(reactions ? { reactions: [...reactions] } : {}),
            })),
          },
        ]),
      );
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT"))
        logger.warn("The channel bridge file could not be read.");
    }
  }

  readonly #save = Effect.fn("ChannelBridge.save")(function* (this: ChannelBridge) {
    const path = this.#options.path;
    if (!path) return;
    yield* this.#writes.withPermit(
      writeJsonFileAtomically(
        path,
        {
          version: 1,
          webhooks: Object.fromEntries(this.#webhooks),
          links: Object.fromEntries(this.#state),
        },
        { createDirectory: true },
      ),
    );
  });
}

/** The `thread_id` query of a webhook call into a Discord thread, or nothing outside a thread. */
function threadQuery(thread: string | null | undefined, separator: "?" | "&"): string {
  return thread ? `${separator}thread_id=${encodeURIComponent(thread)}` : "";
}

/** Discord answered that the post is not there (any more). */
function isNotFound(error: unknown): boolean {
  if (!(error instanceof MessagingAdapterError)) return false;
  const cause = error.cause;
  return cause instanceof DiscordApiError && cause.code === "not_found";
}

/** One field of a Discord answer, as text. Discord's answer is never logged. */
function answerField(answer: unknown, key: "id" | "retry_after"): string | null {
  if (!isDynamicRecord(answer)) return null;
  const value = answer[key];
  return typeof value === "string" || typeof value === "number" ? String(value) : null;
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}
