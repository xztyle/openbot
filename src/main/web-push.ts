import { createHash } from "node:crypto";
import {
  type AgentEvent,
  type AgentInputEscalation,
  type AgentSummary,
  type Channel,
  type ChannelMessage,
  channelKind,
  type WorkspaceNotifyLevel,
} from "@openbot/contracts/ipc";
import type { WebPushRegistration } from "@openbot/contracts/team-protocol/web-push-v1";
import { type AppTranslate, resolveLocale, translateFor } from "@openbot/i18n";
import { toLogValue } from "@openbot/logging";
import {
  agentEventRequestThread,
  inputEscalationDelegator,
  notificationForAgentEvent,
} from "@openbot/team-client/agent-notifications";
import { type ChannelViewer, canSeeChannel } from "../backend/channel-visibility";
import { encryptWebPushMessage, vapidAuthorization } from "./web-push-crypto";
import {
  isWebPushChannelMessage,
  isWebPushRequest,
  WEB_PUSH_NEW_MESSAGE_MS,
  type WebPushAgentKind,
  type WebPushKind,
  webPushAgentConversation,
  webPushAgentPath,
  webPushAllowed,
  webPushChannelKind,
  webPushChannelPath,
} from "./web-push-routing";
import type { WebPushStore, WebPushSubscription } from "./web-push-store";

/**
 * A host sends to a push service only. A member names the address, so any other address is refused:
 * Chrome and Android (FCM), Firefox, Safari and Edge. A new push service needs a change here.
 */
const PUSH_SERVICE_HOSTS = ["fcm.googleapis.com", "updates.push.services.mozilla.com"];
const PUSH_SERVICE_SUFFIXES = [".push.apple.com", ".notify.windows.com"];
/** The contact that a push service can use to reach the sender. It names the project, not a person. */
const VAPID_SUBJECT = "https://openbot.run";
const REQUEST_TIMEOUT_MS = 15_000;
/** A message that a phone gets after this long is out of date, so the push service drops it. */
const TTL_SECONDS = 60 * 60;
const MAX_PER_MEMBER = 10;
const MAX_TOTAL = 200;
/** The same agent and kind within this time is one message. */
const REPEAT_MS = 3_000;
/**
 * After a notice about a conversation, the next ones within this time become one more notice at its
 * end, which replaces the first on the browser and counts them.
 */
const BURST_MS = 20_000;
/** The channel messages whose notice is decided, so a later change of one (a reaction, an edit) is not news. */
const DECIDED_LIMIT = 5_000;

export class WebPushRefusal extends Error {
  constructor(readonly reason: "endpoint" | "limit") {
    super(reason);
  }
}

/** Whether the address is one that a browser's push service uses. A host never sends to another one. */
export function isPushServiceEndpoint(endpoint: string): boolean {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return false;
  }
  return (
    url.protocol === "https:" &&
    url.port === "" &&
    url.username === "" &&
    url.password === "" &&
    (PUSH_SERVICE_HOSTS.includes(url.hostname) || PUSH_SERVICE_SUFFIXES.some((suffix) => url.hostname.endsWith(suffix)))
  );
}

export interface WebPushOptions {
  agents: {
    on(event: "event", listener: (event: AgentEvent) => void): void;
    off(event: "event", listener: (event: AgentEvent) => void): void;
    listAgents(): AgentSummary[];
  };
  store: WebPushStore;
  /** The id that the account service and the browser know this host by. */
  hostId(): string | null;
  /** Whether the member is still a member and not disabled. A removed member gets no more messages. */
  memberActive(memberId: string): boolean;
  /** The agents that the protocol of a browser cannot see. No message names them. */
  hiddenAgentIds(protocol: number): ReadonlySet<string>;
  /**
   * The workspace of the host: channels, people's follows and bells, and spaces. Without it the host
   * sends agent events only, without the address of a channel or a space.
   */
  workspace?: WebPushWorkspace;
  /** The time in which the notices of one conversation become one. Scripts make it short. */
  burstMs?: number;
  fetch?: typeof fetch;
  now?: () => number;
  logger?: { warn(message: string, ...values: unknown[]): void };
}

/** What the push sender reads of the workspace of the host. Each read is of the moment of the event. */
export interface WebPushWorkspace {
  channel(channelId: string): Channel | null;
  /** The channel whose execution thread `threadId` is, or null for an agent's own thread. */
  channelForThread(threadId: string): Channel | null;
  /** The member as a channel reader, or null when they are not a member. */
  viewer(memberId: string): ChannelViewer | null;
  /** Whether the reader follows the thread of `rootId` in the channel. */
  follows(channel: Channel, viewer: ChannelViewer, rootId: string): boolean;
  /** The bell of the member for a conversation (`workspaceNotifyLevel`), or null for the server's level. */
  notifyLevel(memberId: string, conversationId: string): WorkspaceNotifyLevel | null;
  /** The slug of the space of a channel, and of an agent, for the address in a message. */
  channelSpace(channel: Channel): string;
  agentSpace(agentId: string): string;
}

/** The kind of a message, from the event that it reports. Null for an event that no message reports. */
export function webPushKind(event: AgentEvent): WebPushAgentKind | null {
  if (event.type === "prompt") return "needs-input";
  if (event.type === "approval") return "needs-approval";
  if (event.type === "browser-takeover-requested") return "needs-takeover";
  if (event.type === "turn-completed") return event.status === "completed" ? "finished" : "failed";
  return event.type === "error" ? "failed" : null;
}

/** The agent that a request event comes from. */
function eventAgentId(event: AgentEvent): string {
  if (event.type === "approval") return event.approval.agentId;
  if (event.type === "browser-takeover-requested") return event.request.agentId;
  return "agentId" in event && typeof event.agentId === "string" ? event.agentId : "";
}

/** The thread of an agent event: of a request, or of a finished turn. A channel can own it. */
function eventThread(event: AgentEvent): string | null {
  return agentEventRequestThread(event) ?? (event.type === "turn-completed" ? event.threadId : null);
}

/** One notice for one browser, before the burst of its conversation decides when it goes. */
interface Notice {
  kind: WebPushKind;
  title: string;
  body: string;
  /** The title of the notice that counts a burst: the conversation, without one author. */
  burstTitle: string;
  agentId: string;
  threadId: string | null;
  /** The web client address that a tap opens, or null when the host has no workspace. */
  path: string | null;
  /**
   * The notice repeats what a message notice of the same conversation says, as the end of an agent's
   * turn in a channel repeats its reply there: it goes only when no burst of the conversation is on.
   */
  repeat?: boolean;
}

/** The notices of one conversation for one browser in the last `BURST_MS`. */
interface Burst {
  subscription: WebPushSubscription;
  /** The burst ends at this time unless another notice comes before. */
  until: number;
  /** The notices of the burst, the first one too. */
  count: number;
  /** The newest notice that has not gone yet; it goes at `until`, with the count. */
  pending: Notice | null;
  timer: ReturnType<typeof setTimeout> | null;
}

/**
 * Sends Web Push messages from this host to the browsers of its members, so a phone is told also while
 * the page is closed: when an agent needs the member or finishes, and, as Slack does, when someone
 * mentions the member, writes to them in a DM or a group, or replies in a thread they follow. The host
 * signs each message with its own VAPID key and encrypts it to the browser's key, and sends it straight
 * to the browser's push service. The account service is not on the path. The message holds the name of
 * the agent or the author, the name of the conversation, a fixed phrase for the kind of event, ids, and
 * the web client address of the place: no text of a chat.
 *
 * An agent event says what it says on the desktop and the open web page (`notificationForAgentEvent`),
 * with the level that each browser chose. The bell of each conversation (Just mentions, Nothing, mute)
 * applies on top (`webPushAllowed`). The notices of one conversation within `BURST_MS` become one more
 * notice at its end, which replaces the first and counts them.
 */
export class WebPushService {
  readonly #options: WebPushOptions;
  readonly #listener = (event: AgentEvent) => this.#onEvent(event);
  readonly #lastSent = new Map<string, number>();
  readonly #translators = new Map<string, AppTranslate>();
  readonly #pending = new Set<Promise<void>>();
  readonly #bursts = new Map<string, Burst>();
  /** The channel messages that had their notices, oldest first. */
  readonly #decided = new Set<string>();
  /** The last escalation list. It comes before the request event, so a request finds its delegator. */
  #escalations: AgentInputEscalation[] = [];
  #disposed = false;

  constructor(options: WebPushOptions) {
    this.#options = options;
    options.agents.on("event", this.#listener);
  }

  /** The public key that a browser needs to subscribe. Made on first use. */
  publicKey(): string {
    return this.#options.store.vapidKeys().publicKey;
  }

  register(memberId: string, protocol: number, registration: WebPushRegistration): void {
    if (!isPushServiceEndpoint(registration.endpoint)) throw new WebPushRefusal("endpoint");
    const { store } = this.#options;
    const others = store.list().filter((item) => item.endpoint !== registration.endpoint);
    if (others.length >= MAX_TOTAL) throw new WebPushRefusal("limit");
    // A member's oldest browser gives way to a new one, so a forgotten browser does not block it.
    const own = others.filter((item) => item.memberId === memberId).sort((a, b) => a.createdAt - b.createdAt);
    const surplus = new Set(own.slice(0, Math.max(0, own.length - (MAX_PER_MEMBER - 1))).map((item) => item.endpoint));
    if (surplus.size > 0) store.removeWhere((item) => surplus.has(item.endpoint));
    const existing = store.list().find((item) => item.endpoint === registration.endpoint);
    store.upsert({
      ...registration,
      memberId,
      protocol,
      createdAt: existing?.memberId === memberId ? existing.createdAt : this.#now(),
    });
  }

  /** Removes the browser's subscription. Only its own member can: the address is a secret, but not a login. */
  remove(memberId: string, endpoint: string): void {
    this.#options.store.removeWhere((item) => item.endpoint === endpoint && item.memberId === memberId);
  }

  /** Resolves when the messages that are on their way have ended. A burst that has not ended sends nothing more. */
  async dispose(): Promise<void> {
    this.#disposed = true;
    this.#options.agents.off("event", this.#listener);
    for (const burst of this.#bursts.values()) if (burst.timer) clearTimeout(burst.timer);
    this.#bursts.clear();
    await Promise.allSettled([...this.#pending]);
  }

  #now(): number {
    return (this.#options.now ?? Date.now)();
  }

  /** The browsers that may get a message now: of an active member, not set to Nothing, not muted. */
  #readers(now: number): WebPushSubscription[] {
    const subscriptions = this.#options.store.list();
    if (subscriptions.length === 0) return [];
    const gone = subscriptions.filter((item) => !this.#options.memberActive(item.memberId));
    if (gone.length > 0) this.#options.store.removeWhere((item) => gone.includes(item));
    return subscriptions.filter(
      (item) =>
        !gone.includes(item) && item.level !== "nothing" && (item.mutedUntil === null || item.mutedUntil <= now),
    );
  }

  #onEvent(event: AgentEvent): void {
    if (event.type === "agent-input-escalations-changed") {
      this.#escalations = event.escalations;
      return;
    }
    if (event.type === "channel-message") {
      this.#onChannelMessage(event.channelId, event.message);
      return;
    }
    const kind = webPushKind(event);
    if (!kind) return;
    const now = this.#now();
    const subscriptions = this.#readers(now);
    if (subscriptions.length === 0) return;
    const agents = this.#options.agents.listAgents();
    const { workspace } = this.#options;
    const thread = eventThread(event);
    const channel = thread && workspace ? workspace.channelForThread(thread) : null;
    const delegator = inputEscalationDelegator(this.#escalations, event);
    const hostId = this.#options.hostId();
    for (const subscription of subscriptions) {
      const content = notificationForAgentEvent(
        event,
        agents,
        this.#translator(subscription),
        subscription.level,
        null,
        channel ? { id: channel.id, name: channel.name } : null,
        delegator,
      );
      const hidden = this.#options.hiddenAgentIds(subscription.protocol);
      if (!content || hidden.has(content.agentId) || (delegator && hidden.has(eventAgentId(event)))) continue;
      // A request that a teammate makes for another agent shows in that agent's chat, not in the channel.
      const inChannel = channel !== null && content.channelId === channel.id;
      if (inChannel && workspace) {
        const viewer = workspace.viewer(subscription.memberId);
        if (!viewer || !canSeeChannel(channel, viewer)) continue;
      }
      const conversation = inChannel ? channel.id : webPushAgentConversation(content.agentId);
      const bell = workspace?.notifyLevel(subscription.memberId, conversation) ?? null;
      if (!webPushAllowed(kind, subscription.level, bell)) continue;
      const key = `${subscriptionId(subscription)}:${content.agentId}:${kind}`;
      if (now - (this.#lastSent.get(key) ?? 0) < REPEAT_MS) continue;
      this.#lastSent.set(key, now);
      if (this.#lastSent.size > 1_000) this.#lastSent.clear();
      const path = !workspace
        ? null
        : inChannel
          ? webPushChannelPath(hostId, workspace.channelSpace(channel), channel.id, null, null)
          : webPushAgentPath(hostId, workspace.agentSpace(content.agentId), content.agentId);
      const notice: Notice = {
        kind,
        title: content.title,
        body: content.body,
        burstTitle: inChannel ? channel.name : content.title,
        agentId: content.agentId,
        threadId: content.threadId,
        path,
        repeat: inChannel && (kind === "finished" || kind === "failed"),
      };
      this.#notify(subscription, conversation, notice, now);
    }
  }

  /**
   * A new message of a channel notifies each reader for whom it is a mention, a DM or a reply in a
   * followed thread (`webPushChannelKind`). A message notifies once, when it stops streaming; a later
   * change of it, and a message the host sees only long after it was written, notify no one.
   */
  #onChannelMessage(channelId: string, message: ChannelMessage): void {
    const { workspace } = this.#options;
    if (!workspace || message.message.status === "streaming" || this.#decided.has(message.id)) return;
    this.#decided.add(message.id);
    if (this.#decided.size > DECIDED_LIMIT) {
      const [oldest] = this.#decided;
      if (oldest !== undefined) this.#decided.delete(oldest);
    }
    const now = this.#now();
    const createdAt = Date.parse(message.message.createdAt);
    if (
      !isWebPushChannelMessage(message) ||
      message.editedAt !== undefined ||
      !(now - createdAt <= WEB_PUSH_NEW_MESSAGE_MS)
    )
      return;
    const subscriptions = this.#readers(now);
    if (subscriptions.length === 0) return;
    const channel = workspace.channel(channelId);
    if (!channel) return;
    const hostId = this.#options.hostId();
    const space = workspace.channelSpace(channel);
    const author = message.externalAuthor?.name ?? message.author.name;
    const direct = channelKind(channel) === "dm" || channel.name.length === 0;
    for (const subscription of subscriptions) {
      const viewer = workspace.viewer(subscription.memberId);
      if (!viewer) continue;
      const kind = webPushChannelKind(message, channel, viewer, (rootId) => workspace.follows(channel, viewer, rootId));
      if (!kind) continue;
      if (
        message.author.kind !== "member" &&
        this.#options.hiddenAgentIds(subscription.protocol).has(message.author.id)
      )
        continue;
      if (!webPushAllowed(kind, subscription.level, workspace.notifyLevel(subscription.memberId, channel.id))) continue;
      const translate = this.#translator(subscription);
      const notice: Notice = {
        kind,
        title: direct ? author : translate("notification.conversationTitle", { author, conversation: channel.name }),
        body: translate(
          kind === "mention"
            ? "notification.mentionedYou"
            : kind === "reply"
              ? "notification.threadReply"
              : "notification.directMessage",
        ),
        burstTitle: direct ? author : channel.name,
        agentId: message.author.kind === "member" ? "" : message.author.id,
        threadId: null,
        path: webPushChannelPath(hostId, space, channel.id, message.threadRootId ?? null, message.id),
      };
      this.#notify(subscription, channel.id, notice, now);
    }
  }

  /**
   * Sends a notice now, or adds it to the burst of its conversation. A question or an approval is never
   * part of a burst: each one waits for the member.
   */
  #notify(subscription: WebPushSubscription, conversation: string, notice: Notice, now: number): void {
    if (isWebPushRequest(notice.kind)) {
      this.#send(subscription, `request:${notice.agentId}`, notice, false);
      return;
    }
    const key = `${subscriptionId(subscription)}:${conversation}`;
    const burst = this.#bursts.get(key);
    const on = burst !== undefined && (now < burst.until || burst.pending !== null);
    if (notice.repeat && on) return;
    if (!burst || !on) {
      this.#bursts.set(key, { subscription, until: now + this.#burstMs(), count: 1, pending: null, timer: null });
      this.#prune(now);
      this.#send(subscription, burstTag(conversation), notice, false);
      return;
    }
    burst.count += 1;
    burst.pending = notice;
    if (burst.timer) return;
    burst.timer = setTimeout(() => this.#endBurst(key, conversation), Math.max(0, burst.until - now));
    burst.timer.unref?.();
  }

  /** The notice that ends a burst: the newest one, which replaces the first and counts all of them. */
  #endBurst(key: string, conversation: string): void {
    const burst = this.#bursts.get(key);
    if (!burst || this.#disposed) return;
    burst.timer = null;
    const notice = burst.pending;
    if (!notice) return;
    burst.pending = null;
    // The next notice within the time is one more burst of the same count.
    burst.until = this.#now() + this.#burstMs();
    const translate = this.#translator(burst.subscription);
    this.#send(
      burst.subscription,
      burstTag(conversation),
      { ...notice, title: notice.burstTitle, body: translate("notification.newMessages", { count: burst.count }) },
      true,
    );
  }

  #burstMs(): number {
    return this.#options.burstMs ?? BURST_MS;
  }

  /** Forgets the bursts that ended, so the map holds only the conversations of the last minutes. */
  #prune(now: number): void {
    if (this.#bursts.size <= 1_000) return;
    for (const [key, burst] of this.#bursts) if (now >= burst.until && !burst.pending) this.#bursts.delete(key);
  }

  #send(subscription: WebPushSubscription, tag: string, notice: Notice, update: boolean): void {
    const message = JSON.stringify({
      v: 1,
      kind: notice.kind,
      title: notice.title,
      body: notice.body,
      agentId: notice.agentId,
      threadId: notice.threadId,
      hostId: this.#options.hostId(),
      ...(notice.path ? { path: notice.path } : {}),
      tag,
      // The notice that counts a burst replaces the first one without a second sound.
      ...(update ? { update: true } : {}),
    });
    const sending = this.#deliver(subscription, message, notice.kind).finally(() => this.#pending.delete(sending));
    this.#pending.add(sending);
  }

  #translator(subscription: WebPushSubscription): AppTranslate {
    const locale = resolveLocale("system", subscription.locale);
    let translate = this.#translators.get(locale);
    if (!translate) {
      translate = translateFor(locale);
      this.#translators.set(locale, translate);
    }
    return translate;
  }

  async #deliver(subscription: WebPushSubscription, message: string, kind: WebPushKind): Promise<void> {
    const { store, logger } = this.#options;
    // The address is a capability, so a log names only the push service.
    const service = new URL(subscription.endpoint).origin;
    try {
      const response = await (this.#options.fetch ?? fetch)(subscription.endpoint, {
        method: "POST",
        // A push service answers with 201. A redirect would send the message to an address no one checked.
        redirect: "manual",
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        headers: {
          Authorization: vapidAuthorization({
            endpoint: subscription.endpoint,
            subject: VAPID_SUBJECT,
            keys: store.vapidKeys(),
            nowSeconds: Math.floor((this.#options.now ?? Date.now)() / 1000),
          }),
          "Content-Encoding": "aes128gcm",
          "Content-Type": "application/octet-stream",
          TTL: String(TTL_SECONDS),
          Urgency: kind === "finished" ? "normal" : "high",
        },
        body: new Uint8Array(encryptWebPushMessage(Buffer.from(message), subscription)),
      });
      if (response.status >= 200 && response.status < 300) return;
      // The browser unsubscribed or the push service forgot it (404, 410), or it refuses this host's key
      // (401, 403). None of them gets better with time.
      if ([401, 403, 404, 410].includes(response.status)) {
        store.removeWhere((item) => item.endpoint === subscription.endpoint);
        return;
      }
      logger?.warn("Web Push was not accepted:", service, response.status);
    } catch (error) {
      logger?.warn("Web Push could not be sent:", service, toLogValue(error));
    }
  }
}

/**
 * The tag of the notices of a conversation on the browser, so a newer one replaces the older one: the
 * sidebar id of the conversation (`agent:<id>` for an agent's chat, as the service worker had it).
 */
function burstTag(conversation: string): string {
  return conversation;
}

/** A stable short name for a subscription, for the repeat check. It is not the address. */
function subscriptionId(subscription: WebPushSubscription): string {
  return createHash("sha256").update(subscription.endpoint).digest("base64url").slice(0, 16);
}
