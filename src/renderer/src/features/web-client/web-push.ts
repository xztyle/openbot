import { isDynamicRecord, isString } from "@openbot/contracts/runtime-values";
import {
  WEB_PUSH_CAPABILITY,
  WEB_PUSH_ROUTES,
  type WebPushLevel,
  type WebPushRegistration,
} from "@openbot/contracts/team-protocol/web-push-v1";
import type { TeamApiRequest } from "@openbot/team-client/team-api-requests";
import { createSignal } from "solid-js";
import type { WebServerNotificationState } from "./web-notification-preferences";

/** Where a push subscription lives: a service worker registration, one for each host, under this prefix. */
const SCOPE_PREFIX = "/app/push/";
const WORKER_URL = "/app/sw.js";
const STORAGE_PREFIX = "openbot.web.push:";

/** The service worker sends this to an open page when the user taps a notification. */
export const WEB_PUSH_OPEN_MESSAGE = "openbot:open-chat";
/** The service worker sends this to an open page when the push service gave the browser another address. */
export const WEB_PUSH_CHANGED_MESSAGE = "openbot:push-changed";

export type WebPushFailure = "denied" | "failed";

export type WebPushAvailability = "browser-unsupported" | "no-host" | "host-unsupported" | "ready";

export function isWebPushBrowserSupported(): boolean {
  return (
    typeof window !== "undefined" &&
    "serviceWorker" in navigator &&
    "PushManager" in window &&
    typeof Notification !== "undefined"
  );
}

function storageKey(accountId: string): string {
  return `${STORAGE_PREFIX}${accountId}`;
}

/** The hosts that this browser asked to push to, for the account. */
function readEnabled(accountId: string): string[] {
  try {
    const value = JSON.parse(window.localStorage.getItem(storageKey(accountId)) ?? "[]");
    return Array.isArray(value) ? value.filter(isString) : [];
  } catch {
    return [];
  }
}

function writeEnabled(accountId: string, hostIds: string[]): void {
  try {
    window.localStorage.setItem(storageKey(accountId), JSON.stringify(hostIds));
  } catch {
    // Without storage the choice holds until the page closes. The subscription itself is in the browser.
  }
}

/** Whether this browser gets push notifications from the host. Another reader of the same storage, such as the tab. */
export function isWebPushEnabled(accountId: string, hostId: string): boolean {
  return readEnabled(accountId).includes(hostId);
}

function applicationServerKey(publicKey: string): Uint8Array<ArrayBuffer> {
  const bytes = Uint8Array.from(atob(publicKey.replace(/-/gu, "+").replace(/_/gu, "/")), (char) => char.charCodeAt(0));
  return bytes;
}

function sameKey(subscription: PushSubscription, key: Uint8Array): boolean {
  const current = subscription.options.applicationServerKey;
  if (!current) return false;
  const bytes = new Uint8Array(current);
  return bytes.length === key.length && bytes.every((byte, index) => byte === key[index]);
}

/** A worker that was just registered is not active yet, and a subscription needs an active one. */
async function activated(registration: ServiceWorkerRegistration): Promise<ServiceWorkerRegistration> {
  if (registration.active) return registration;
  const worker = registration.installing ?? registration.waiting;
  if (!worker) throw new Error("The service worker did not start.");
  await new Promise<void>((resolve, reject) => {
    worker.addEventListener("statechange", () => {
      if (worker.state === "activated") resolve();
      else if (worker.state === "redundant") reject(new Error("The service worker did not start."));
    });
  });
  return registration;
}

function registrationFor(hostId: string): Promise<ServiceWorkerRegistration> {
  return navigator.serviceWorker
    .register(WORKER_URL, { scope: `${SCOPE_PREFIX}${encodeURIComponent(hostId)}/`, updateViaCache: "none" })
    .then(activated);
}

/** What the host needs to know of the browser's choices, from the same state that the page's own notifications use. */
export function webPushPreferences(
  state: WebServerNotificationState,
  locale: string,
): Pick<WebPushRegistration, "level" | "mutedUntil" | "locale"> {
  // A mute with no end is a level of nothing. A timed mute keeps the level and ends by itself on the host.
  const level: WebPushLevel = state.muted && state.mutedUntil === null ? "nothing" : state.level;
  return { level, mutedUntil: state.muted ? state.mutedUntil : null, locale };
}

/**
 * Push notifications for this browser, from the opened host. The host keeps the subscription and sends
 * the messages straight to the browser's push service, signed with its own key and encrypted for this
 * browser. Each host has its own key, and a subscription belongs to one key, so each host has its own
 * service worker registration (a scope under `/app/push/`).
 */
export function createWebPush(options: {
  accountId: string;
  hostId: () => string | null;
  online: () => boolean;
  capabilities: () => readonly string[];
  /** The Team API requests of the opened host, or undefined while there is none. */
  request: () => TeamApiRequest | undefined;
  notificationState: (hostId: string) => WebServerNotificationState;
  /** The locale of the interface, such as `de`. The host writes the notification in it. */
  locale: () => string;
  /** The user tapped a notification. */
  onOpenChat: (hostId: string, agentId: string) => void;
}) {
  const [enabledHosts, setEnabledHosts] = createSignal(readEnabled(options.accountId));
  const [busy, setBusy] = createSignal(false);
  const [failure, setFailure] = createSignal<WebPushFailure | null>(null);

  function availability(): WebPushAvailability {
    if (!isWebPushBrowserSupported()) return "browser-unsupported";
    if (!options.hostId() || !options.online()) return "no-host";
    return options.capabilities().includes(WEB_PUSH_CAPABILITY) ? "ready" : "host-unsupported";
  }
  function setEnabled(hostId: string, enabled: boolean): void {
    const next = enabledHosts().filter((id) => id !== hostId);
    if (enabled) next.push(hostId);
    setEnabledHosts(next);
    writeEnabled(options.accountId, next);
  }

  /** Subscribes this browser to the host's key and gives the host the subscription. */
  async function register(hostId: string, request: TeamApiRequest): Promise<void> {
    const { publicKey } = await request(
      "POST",
      WEB_PUSH_ROUTES.key,
      (value) => {
        if (!isDynamicRecord(value) || !isString(value.publicKey)) throw new Error("The host returned an invalid key.");
        return { publicKey: value.publicKey };
      },
      {},
    );
    const registration = await registrationFor(hostId);
    const key = applicationServerKey(publicKey);
    let subscription = await registration.pushManager.getSubscription();
    // A subscription that was made for another key, such as the key of a host that was set up again, cannot be used.
    if (subscription && !sameKey(subscription, key)) {
      await subscription.unsubscribe();
      subscription = null;
    }
    subscription ??= await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
    const json = subscription.toJSON();
    const { p256dh, auth } = json.keys ?? {};
    if (!json.endpoint || !p256dh || !auth) throw new Error("The browser returned an invalid subscription.");
    await request("POST", WEB_PUSH_ROUTES.register, () => undefined, {
      endpoint: json.endpoint,
      p256dh,
      auth,
      ...webPushPreferences(options.notificationState(hostId), options.locale()),
    });
  }

  async function enable(): Promise<void> {
    const hostId = options.hostId();
    const request = options.request();
    if (busy() || availability() !== "ready" || !hostId || !request) return;
    setBusy(true);
    setFailure(null);
    try {
      // The browser asks only from a user action, so this comes before any other wait.
      const permission =
        Notification.permission === "default" ? await Notification.requestPermission() : Notification.permission;
      if (permission !== "granted") {
        setFailure("denied");
        return;
      }
      await register(hostId, request);
      setEnabled(hostId, true);
    } catch {
      setFailure("failed");
    } finally {
      setBusy(false);
    }
  }

  async function disable(): Promise<void> {
    const hostId = options.hostId();
    if (busy() || !hostId) return;
    setBusy(true);
    setFailure(null);
    try {
      const registration = await navigator.serviceWorker.getRegistration(
        `${SCOPE_PREFIX}${encodeURIComponent(hostId)}/`,
      );
      const subscription = await registration?.pushManager.getSubscription();
      const request = options.request();
      // The host is told first, while the address is still known. A host that does not answer forgets
      // the subscription when its push service refuses the next message.
      if (subscription && request && options.online())
        await request("POST", WEB_PUSH_ROUTES.remove, () => undefined, { endpoint: subscription.endpoint }).catch(
          () => undefined,
        );
      await subscription?.unsubscribe();
      await registration?.unregister();
    } catch {
      // The choice still ends here: this browser no longer asks the host for messages.
    } finally {
      setEnabled(hostId, false);
      setBusy(false);
    }
  }

  /**
   * Tells the host again what this browser chose, and gives it a new address if the browser made one.
   * Runs when the host is online and when the level or the mute changes.
   */
  async function sync(): Promise<void> {
    const hostId = options.hostId();
    const request = options.request();
    if (!hostId || !request || busy() || availability() !== "ready" || !enabledHosts().includes(hostId)) return;
    if (Notification.permission !== "granted") {
      setEnabled(hostId, false);
      return;
    }
    try {
      await register(hostId, request);
    } catch {
      // The next change or connection tries again.
    }
  }

  /** The page hears the service worker when the user taps a notification while the page is open. */
  function listen(): () => void {
    if (!isWebPushBrowserSupported()) return () => {};
    const receive = (event: MessageEvent) => {
      const data = event.data;
      if (
        isDynamicRecord(data) &&
        data.type === WEB_PUSH_OPEN_MESSAGE &&
        isString(data.hostId) &&
        isString(data.agentId)
      )
        options.onOpenChat(data.hostId, data.agentId);
      // The host holds the old address. The same call as at each connect gives it the new one.
      else if (isDynamicRecord(data) && data.type === WEB_PUSH_CHANGED_MESSAGE) void sync();
    };
    navigator.serviceWorker.addEventListener("message", receive);
    return () => navigator.serviceWorker.removeEventListener("message", receive);
  }

  return {
    availability,
    enabled: () => {
      const hostId = options.hostId();
      return hostId !== null && enabledHosts().includes(hostId);
    },
    /** Whether the page should leave the notification of an event to the push message. */
    pushes: (hostId: string) =>
      enabledHosts().includes(hostId) && isWebPushBrowserSupported() && Notification.permission === "granted",
    busy,
    failure,
    enable,
    disable,
    sync,
    listen,
  };
}
