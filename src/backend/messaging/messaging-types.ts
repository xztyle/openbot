// The seam between the platform-agnostic messaging core and one chat platform. A platform is one
// `MessagingDriver`: an adapter for its API and a transport for its inbound events. The OpenBot
// Slack app uses the Events API: Slack posts to Signal, Signal checks Slack's signature, and passes
// each request of a workspace linked to this host over the `MessagingIngress` socket, which the host
// opens. The OpenBot Discord app's Gateway connection is in Signal, which holds the bot token: Signal
// passes each guild's events over the same socket and makes the host's Discord calls. The OpenBot
// Telegram bot works the same way: Telegram posts each update to Signal, which passes it over the same
// socket, and the host calls the Bot API through Signal, which holds the bot token. No transport needs
// a public endpoint on the host.

import type { MessagingConnectionState, MessagingPlatform } from "@openbot/contracts/ipc";
import type { DiscordApiRequest, DiscordDelivery } from "@openbot/contracts/signal-protocol/discord-api";
import type {
  TelegramCallMethod,
  TelegramCallParams,
  TelegramCallResult,
} from "@openbot/contracts/signal-protocol/telegram-route";
import { type Effect, Schema } from "effect";
import type { MessagingOperationFailed } from "./messaging-service";
import type { MessagingAnswerFile } from "./messaging-threads";

/** Where a post goes: a platform channel, and the thread in it or the top level. */
export interface MessageTarget {
  platformChannelId: string;
  replyThreadId: string | null;
}

/** A channel, thread or chat that OpenBot can post in, for the agent's `messaging_list_places` tool. */
export interface MessagingPlace {
  id: string;
  name: string;
  kind: "channel" | "private" | "thread" | "chat";
}

export interface InboundFile {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  url: string;
}

/** One message that addresses OpenBot, in the same shape for every platform. */
export interface InboundMessage {
  /** Stable for one message across redeliveries. */
  dedupKey: string;
  platformChannelId: string;
  /** Names the conversation: one link, and so one execution thread, per key and channel. */
  threadKey: string;
  target: MessageTarget;
  platformMessageId: string;
  isDirect: boolean;
  /** True for a reply that does not name OpenBot: it counts only in a conversation that already has an agent. */
  requiresLink: boolean;
  authorId: string;
  /** Text with each user mention as `@<user id>`; `mentionedUserIds` lists those ids. */
  text: string;
  /** The users the text mentions, without OpenBot, so the service can name them. */
  mentionedUserIds: string[];
  files: InboundFile[];
  /**
   * The author's role ids, for a platform with role lists (Discord). Null when the platform did not
   * say: a connection with a role list then ignores the message.
   */
  authorRoleIds?: readonly string[] | null;
  /** The message this one replies to, when a person wrote it and the platform gave its text or files. */
  replyTo?: InboundQuote | null;
  /** False for a Discord message that does not mention OpenBot: only a channel that answers every message takes it. */
  mentioned?: boolean;
  /** For a reply to an OpenBot post: true. Lets a channel that answers every message find the conversation. */
  repliesToBot?: boolean;
  /** The author's display name, when the platform gave it with the message (Discord). */
  authorName?: string;
  /** The author's picture, an `https` address of the platform, for a channel bridge. */
  authorAvatarUrl?: string;
  /** The platform id of the message this one replies to, any author. For a channel bridge. */
  replyToMessageId?: string | null;
  /** For a message in a Discord thread (`platformChannelId`): the channel of the thread. For a channel bridge. */
  threadParentId?: string;
}

/** A replied-to message, given to the agent as context. Mentions are written as in `text`. */
interface InboundQuote {
  authorName: string;
  text: string;
  mentionedUserIds: string[];
  /** ISO time. */
  sentAt: string;
}

interface InboundActionBase {
  token: string;
  actorId: string;
  target: MessageTarget;
  platformMessageId: string;
  /** What the platform needs to answer the press privately, such as a Discord interaction id. */
  replyHandle?: string;
}

export type InboundAction =
  | (InboundActionBase & { type: "approval"; decision: "accept" | "decline" })
  | (InboundActionBase & { type: "stop" });

interface MessageButton {
  action: "accept" | "decline" | "stop";
  label: string;
  /** Opaque and single use. It maps to the request only in the host's memory. */
  token: string;
  style?: "primary" | "danger";
}

export interface MessageBody {
  text: string;
  buttons?: MessageButton[];
}

export type StatusReaction = "received" | "done" | "failed" | "stopped";

export interface ConnectionIdentity {
  workspaceId: string;
  workspaceName: string;
  botUserId: string;
  appId: string;
  missingScopes: string[];
}

export interface ContextEntry {
  id: string;
  authorName: string;
  /** Names the message's files too, when it has any. */
  text: string;
  sentAt: string;
  /** The message's files, which the agent gets with the message that it answers. */
  files?: InboundFile[];
}

/** A failure the connection cannot recover from alone. The user must act. */
export class MessagingConnectionError extends Error {
  constructor(readonly state: Extract<MessagingConnectionState, "invalid_token">) {
    super(state);
  }
}

export class MessagingAdapterError extends Schema.TaggedError<MessagingAdapterError>()("MessagingAdapterError", {
  cause: Schema.Defect(),
}) {}

export interface MessagingAdapter {
  readonly platform: MessagingPlatform;
  identify(): Effect.Effect<ConnectionIdentity, MessagingAdapterError>;
  post(target: MessageTarget, body: MessageBody): Effect.Effect<string, MessagingAdapterError>;
  edit(target: MessageTarget, messageId: string, body: MessageBody): Effect.Effect<void, MessagingAdapterError>;
  /** A post that only `userId` sees. `replyHandle` is the one of the press that it answers, if any. */
  postPrivate(
    target: MessageTarget,
    userId: string,
    text: string,
    replyHandle?: string,
  ): Effect.Effect<void, MessagingAdapterError>;
  react(
    target: MessageTarget,
    messageId: string,
    reaction: StatusReaction,
    on: boolean,
  ): Effect.Effect<void, MessagingAdapterError>;
  /**
   * Posts the agent's answer, in as many posts as the platform needs. The first part replaces
   * `replaceMessageId` when it is given.
   */
  postAnswer(
    target: MessageTarget,
    markdown: string,
    replaceMessageId: string | null,
  ): Effect.Effect<void, MessagingAdapterError>;
  /** Deletes a post of OpenBot's own. Only some platforms can. */
  remove?(target: MessageTarget, messageId: string): Effect.Effect<void, MessagingAdapterError>;
  /** Uploads files to the conversation, and returns the names it did not send. */
  upload(target: MessageTarget, files: MessagingAnswerFile[]): Effect.Effect<string[], MessagingAdapterError>;
  /** Earlier messages of the conversation, oldest first, after `afterId` and before `beforeId`. */
  history(
    platformChannelId: string,
    threadKey: string,
    afterId: string | null,
    beforeId: string,
  ): Effect.Effect<ContextEntry[], MessagingAdapterError>;
  /**
   * The newest messages of a place, oldest first, posts by bots included, for the agent's history
   * tool. With `threadKey`, only that conversation; with null, the whole channel or chat. At most
   * `limit` messages; the platform can give fewer.
   */
  recent(
    platformChannelId: string,
    threadKey: string | null,
    limit: number,
  ): Effect.Effect<ContextEntry[], MessagingAdapterError>;
  /** Downloads one file to `destination`. Refuses a file larger than `maxBytes`. */
  download(file: InboundFile, destination: string, maxBytes: number): Effect.Effect<void, MessagingAdapterError>;
  authorName(userId: string): Effect.Effect<string, MessagingAdapterError>;
  placeName(platformChannelId: string): Effect.Effect<string, MessagingAdapterError>;
  /** The places of this connection that OpenBot can post in now. */
  places(): Effect.Effect<MessagingPlace[], MessagingAdapterError>;
  /** The roles a person can have in this workspace, highest first, for a platform with role lists. */
  roles?(): Effect.Effect<Array<{ id: string; name: string }>, MessagingAdapterError>;
  mention(userId: string): string;
  /** Joins every public place the platform lets OpenBot join without an invitation. */
  joinPublicPlaces?(): Effect.Effect<void, MessagingAdapterError>;
  /** Joins one public place, such as a channel that was just created. */
  joinPlace?(platformChannelId: string): Effect.Effect<void, MessagingAdapterError>;
  /** Adds or removes OpenBot's own reaction with a unicode emoji, for a channel bridge (Discord). */
  reactEmoji?(
    target: MessageTarget,
    messageId: string,
    emoji: string,
    on: boolean,
  ): Effect.Effect<void, MessagingAdapterError>;
  /** Makes a webhook in a channel, for a channel bridge (Discord). The token is a secret. */
  createWebhook?(
    platformChannelId: string,
    name: string,
  ): Effect.Effect<{ webhookId: string; token: string }, MessagingAdapterError>;
}

/**
 * A person edited or deleted a message on the platform. Only a Discord channel bridged with a
 * workspace channel receives one (Signal sends them only for the channels the bridge listens to).
 */
export interface InboundMessageChange {
  platformChannelId: string;
  platformMessageId: string;
  /** The new text and files; null for a deletion. Mentions are written as in `InboundMessage.text`. */
  edit: { text: string; mentionedUserIds: string[]; files: InboundFile[] } | null;
  /** As on `InboundMessage`. */
  threadParentId?: string;
}

/** A person added or removed a reaction with a unicode emoji, in a Discord channel of a channel bridge. */
export interface InboundReaction {
  platformChannelId: string;
  platformMessageId: string;
  userId: string;
  userName?: string;
  emoji: string;
  on: boolean;
  /** As on `InboundMessage`. */
  threadParentId?: string;
}

export interface TransportSink {
  state(state: MessagingConnectionState, detail?: { retryAt?: string }): void;
  message(message: InboundMessage): void;
  /** An edit or a deletion of a person's message, for a channel bridge. */
  changed?(change: InboundMessageChange): void;
  /** A reaction of a person, for a channel bridge. */
  reacted?(reaction: InboundReaction): void;
  action(action: InboundAction): void;
  /** A public place was created that OpenBot can join. */
  placeCreated?(platformChannelId: string): void;
  /** The workspace, such as a Telegram chat, has a new name. */
  renamed?(workspaceName: string): void;
}

export interface MessagingTransport {
  start(sink: TransportSink): void;
  /** Reconnects now, such as after the computer wakes. */
  reconnect(): void;
  stop(): Effect.Effect<void>;
  /** Handles one request that the ingress relay brought, for a transport that gets its events that way. */
  deliver?(delivery: IngressDelivery): Effect.Effect<IngressAnswer>;
}

/**
 * One event that Signal passed on. For Slack, the HTTP request that Slack sent to its request URL,
 * whose signature Signal has checked. For Discord, a Gateway event that Signal normalized. For
 * Telegram, one update of a chat, whose secret header Signal has checked. Discord and Telegram get no
 * answer.
 */
export type IngressDelivery = (
  | { platform: "slack"; kind: "events" | "interactivity"; retryNum: number | null; body: Uint8Array }
  | { platform: "discord"; delivery: DiscordDelivery }
  // `linked` marks the `/start <code>` update that the account service just linked to this host.
  | { platform: "telegram"; botId: string; body: Uint8Array; linked: boolean }
) & {
  // Signal kept it while this hosted server started (`queued-delivery`). It can come before its
  // connection has a transport, and nothing sends it again.
  queued?: boolean;
};

/** The HTTP answer the platform gets. A body only for a URL check or a button reply. */
export interface IngressAnswer {
  status: 200 | 400 | 401 | 404 | 503;
  contentType?: "application/json" | "text/plain";
  body?: string;
}

/** `unavailable` has a reason the user can act on: sign in, name this computer, or wait for Signal. */
export type IngressState = "online" | "connecting" | "signed_out" | "no_host" | "unavailable";

/**
 * Handles one request for a workspace, by the platform's workspace id (a Slack team, a Discord guild
 * or a Telegram chat).
 */
export type IngressHandler = (
  workspaceId: string,
  delivery: IngressDelivery,
) => Effect.Effect<IngressAnswer, MessagingOperationFailed>;

/**
 * The Bot API of the OpenBot Telegram bot, through Signal, which holds the token. Signal accepts a
 * call only for a chat routed to this host.
 */
export interface TelegramGateway {
  /** False until Signal says it has a Telegram bot. */
  available(): boolean;
  call<M extends TelegramCallMethod>(
    botId: string,
    method: M,
    params: TelegramCallParams[M],
  ): Effect.Effect<TelegramCallResult, MessagingAdapterError>;
  /** Downloads the file of a `getFile` token. Refuses a file larger than `maxBytes`. */
  download(fileToken: string, destination: string, maxBytes: number): Effect.Effect<void, MessagingAdapterError>;
  /** Posts a file for a `sendDocument` token, and returns the message ID. */
  upload(uploadToken: string, path: string): Effect.Effect<number, MessagingAdapterError>;
}

/** A Bot API call that failed. The description is Telegram's, and never quotes message text. */
export class TelegramCallError extends Error {
  readonly code: string;
  constructor(
    readonly errorCode: number,
    description: string,
    readonly retryAfter: number | null,
  ) {
    super(description);
    this.name = "TelegramCallError";
    this.code = `telegram_${errorCode}`;
  }
}

/**
 * The relay that brings a platform's HTTP requests to this host: Signal's `ingress` socket, which
 * the main process owns. It is open while anything holds it.
 */
export interface MessagingIngress {
  /**
   * Keeps the relay open until the returned function runs. The relay asks Signal for the routes of
   * the platforms that hold it.
   */
  acquire(platform: MessagingPlatform): () => void;
  /**
   * Names the channels of a Discord guild in which Signal also passes on the messages that do not
   * mention OpenBot. An empty list stops it.
   */
  setDiscordListen?(guildId: string, channelIds: readonly string[]): void;
  state(): IngressState;
  onState(listener: (state: IngressState) => void): () => void;
  /** Sets the one handler of the requests the relay receives, or removes it. */
  handle(handler: IngressHandler | null): void;
  readonly telegram: TelegramGateway;
  /**
   * Opens the socket again, such as after the computer wakes, or after a workspace was connected or
   * disconnected: Signal learns the workspaces of this host when the socket connects.
   */
  reconnect(): void;
  /**
   * Makes one Discord call through Signal, which holds the bot token, with the session of the open
   * socket. Waits a short time for the session when the socket is still connecting. `decode` checks
   * the JSON body of the answer.
   */
  discord<A>(
    request: DiscordApiRequest,
    decode: (value: unknown) => A,
    file?: DiscordUploadFile,
  ): Effect.Effect<A, MessagingAdapterError>;
  /**
   * Calls `listener` with the Discord guilds that Signal routes to the socket, each time Signal
   * sends a session. A guild of this host that is not in it was unlinked, or the bot left it.
   */
  onDiscordRoutes(listener: (guildIds: ReadonlySet<string>) => void): () => void;
}

/** The bytes of one `upload` call. */
export interface DiscordUploadFile {
  bytes: Uint8Array;
  mimeType: string;
}

/** A Discord call that Signal or Discord refused, with Signal's code. */
export class DiscordApiError extends Error {
  constructor(
    readonly op: string,
    readonly code: string,
    readonly retryAfterMs?: number,
  ) {
    super(`Discord ${op} failed: ${code}`);
  }
}

export interface MessagingDriverOptions {
  /** Called when the platform asks the host to wait, with the time it can try again. */
  rateLimited(retryAt: string): void;
}

export interface MessagingDriver {
  readonly platform: MessagingPlatform;
  /** The stored value without which a connection cannot start, such as Slack's bot token. */
  readonly requiredCredential: string;
  createAdapter(credentials: Record<string, string>, options: MessagingDriverOptions): MessagingAdapter;
  createTransport(credentials: Record<string, string>, identity: ConnectionIdentity): MessagingTransport;
}

/** One message of a Discord channel that a channel bridge takes, with its mentions named. */
export interface BridgedDiscordMessage {
  guildId: string;
  channelId: string;
  messageId: string;
  authorId: string;
  authorName: string;
  authorAvatarUrl: string | null;
  /** Plain text: each user mention as `@<name>`, or `@<id>` without a name. */
  text: string;
  files: readonly InboundFile[];
  /** The Discord message it replies to, any author. */
  replyToMessageId: string | null;
  /** The message mentions OpenBot (the mention itself is taken out of `text`). */
  mentionedBot: boolean;
  /** The Discord thread of the message, in `channelId`. Null outside a thread. */
  threadId?: string | null;
}

/** An edit (with the new text and files) or a deletion (`edit: null`) of a bridged Discord message. */
export interface BridgedDiscordChange {
  guildId: string;
  channelId: string;
  messageId: string;
  edit: { text: string; files: readonly InboundFile[] } | null;
  /** The Discord thread of the message, in `channelId`. Null outside a thread. */
  threadId?: string | null;
}

/** A person's reaction with a unicode emoji on a message of a bridged Discord channel or one of its threads. */
export interface BridgedDiscordReaction {
  guildId: string;
  channelId: string;
  threadId: string | null;
  messageId: string;
  userId: string;
  userName: string | null;
  emoji: string;
  on: boolean;
}

/**
 * The workspace channel bridge (`channel-bridge.ts`) as messaging sees it. A Discord channel that it
 * takes skips the connector's own routing: its messages go to the bridge, also without a mention.
 */
export interface MessagingChannelBridge {
  /** The channels of a Discord guild that are bridged with a workspace channel. */
  discordChannels(guildId: string): readonly string[];
  /** Never fails: the bridge reports its own failures. */
  receiveDiscord(message: BridgedDiscordMessage): Effect.Effect<void>;
  /** Mirrors an edit or a deletion of a message the bridge brought in. Never fails. */
  changeDiscord?(change: BridgedDiscordChange): Effect.Effect<void>;
  /** Mirrors a person's reaction on a bridged message. Never fails. */
  reactDiscord?(reaction: BridgedDiscordReaction): Effect.Effect<void>;
}
