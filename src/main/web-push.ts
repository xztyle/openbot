import { createHash } from "node:crypto";
import type { AgentEvent, AgentSummary } from "@openbot/contracts/ipc";
import type { WebPushRegistration } from "@openbot/contracts/team-protocol/web-push-v1";
import { type AppTranslate, resolveLocale, translateFor } from "@openbot/i18n";
import { toLogValue } from "@openbot/logging";
import { notificationForAgentEvent } from "@openbot/team-client/agent-notifications";
import { encryptWebPushMessage, vapidAuthorization } from "./web-push-crypto";
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

export type WebPushKind = "needs-input" | "needs-approval" | "finished" | "failed";

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
  fetch?: typeof fetch;
  now?: () => number;
  logger?: { warn(message: string, ...values: unknown[]): void };
}

/** The kind of a message, from the event that it reports. Null for an event that no message reports. */
export function webPushKind(event: AgentEvent): WebPushKind | null {
  if (event.type === "prompt") return "needs-input";
  if (event.type === "approval") return "needs-approval";
  if (event.type === "turn-completed") return event.status === "completed" ? "finished" : "failed";
  return event.type === "error" ? "failed" : null;
}

/**
 * Sends Web Push messages from this host to the browsers of its members, so a phone is told that an
 * agent needs it also while the page is closed. The host signs each message with its own VAPID key and
 * encrypts it to the browser's key, and sends it straight to the browser's push service. The account
 * service is not on the path. The message holds the agent's name, a fixed phrase for the kind of
 * event, and ids: no text of a chat. The decision whether an event says anything, and its words, are
 * those of the desktop and the open web page (`notificationForAgentEvent`), with the level that each
 * browser chose.
 */
export class WebPushService {
  readonly #options: WebPushOptions;
  readonly #listener = (event: AgentEvent) => this.#onEvent(event);
  readonly #lastSent = new Map<string, number>();
  readonly #translators = new Map<string, AppTranslate>();
  readonly #pending = new Set<Promise<void>>();

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
      createdAt: existing?.memberId === memberId ? existing.createdAt : (this.#options.now ?? Date.now)(),
    });
  }

  /** Removes the browser's subscription. Only its own member can: the address is a secret, but not a login. */
  remove(memberId: string, endpoint: string): void {
    this.#options.store.removeWhere((item) => item.endpoint === endpoint && item.memberId === memberId);
  }

  /** Resolves when the messages that are on their way have ended. */
  async dispose(): Promise<void> {
    this.#options.agents.off("event", this.#listener);
    await Promise.allSettled([...this.#pending]);
  }

  #onEvent(event: AgentEvent): void {
    const kind = webPushKind(event);
    if (!kind) return;
    const subscriptions = this.#options.store.list();
    if (subscriptions.length === 0) return;
    const now = (this.#options.now ?? Date.now)();
    const agents = this.#options.agents.listAgents();
    const gone = subscriptions.filter((item) => !this.#options.memberActive(item.memberId));
    if (gone.length > 0) this.#options.store.removeWhere((item) => gone.includes(item));
    for (const subscription of subscriptions) {
      if (gone.includes(subscription)) continue;
      if (subscription.level === "nothing" || (subscription.mutedUntil !== null && subscription.mutedUntil > now))
        continue;
      const content = notificationForAgentEvent(event, agents, this.#translator(subscription), subscription.level);
      if (!content || this.#options.hiddenAgentIds(subscription.protocol).has(content.agentId)) continue;
      const key = `${subscriptionId(subscription)}:${content.agentId}:${kind}`;
      if (now - (this.#lastSent.get(key) ?? 0) < REPEAT_MS) continue;
      this.#lastSent.set(key, now);
      if (this.#lastSent.size > 1_000) this.#lastSent.clear();
      const message = JSON.stringify({
        v: 1,
        kind,
        title: content.title,
        body: content.body,
        agentId: content.agentId,
        threadId: content.threadId,
        hostId: this.#options.hostId(),
      });
      const sending = this.#deliver(subscription, message, kind).finally(() => this.#pending.delete(sending));
      this.#pending.add(sending);
    }
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

/** A stable short name for a subscription, for the repeat check. It is not the address. */
function subscriptionId(subscription: WebPushSubscription): string {
  return createHash("sha256").update(subscription.endpoint).digest("base64url").slice(0, 16);
}
