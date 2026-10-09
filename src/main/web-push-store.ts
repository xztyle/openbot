import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { isDynamicRecord, isNumber, isString } from "@openbot/contracts/runtime-values";
import type { WebPushLevel, WebPushRegistration } from "@openbot/contracts/team-protocol/web-push-v1";
import { generateVapidKeys, type VapidKeys } from "./web-push-crypto";

/** One browser of one member that asked for push messages from this host. */
export interface WebPushSubscription extends WebPushRegistration {
  memberId: string;
  /** The Team API protocol of the browser's request, for the agents that this protocol can see. */
  protocol: number;
  createdAt: number;
}

interface StoredWebPush {
  version: 1;
  vapid: VapidKeys | null;
  subscriptions: WebPushSubscription[];
}

function isLevel(value: unknown): value is WebPushLevel {
  return value === "all" || value === "needs-me" || value === "nothing";
}

function isSubscription(value: unknown): value is WebPushSubscription {
  return (
    isDynamicRecord(value) &&
    isString(value.endpoint) &&
    isString(value.p256dh) &&
    isString(value.auth) &&
    isLevel(value.level) &&
    (value.mutedUntil === null || isNumber(value.mutedUntil)) &&
    isString(value.locale) &&
    isString(value.memberId) &&
    isNumber(value.protocol) &&
    isNumber(value.createdAt)
  );
}

function isVapidKeys(value: unknown): value is VapidKeys {
  return (
    isDynamicRecord(value) &&
    isString(value.publicKey) &&
    isDynamicRecord(value.privateJwk) &&
    value.privateJwk.kty === "EC" &&
    value.privateJwk.crv === "P-256" &&
    isString(value.privateJwk.x) &&
    isString(value.privateJwk.y) &&
    isString(value.privateJwk.d)
  );
}

/**
 * The host's VAPID key pair and the push subscriptions, in one small JSON file in its profile that only
 * its user can read: the private key signs every message, and a subscription address is a capability
 * to send to a browser. It is not in the database, so a restore of the database brings back no
 * subscription and an upgrade has nothing to migrate. A file that cannot be read starts empty.
 */
export class WebPushStore {
  readonly #path: string;
  #value: StoredWebPush | undefined;

  constructor(path: string) {
    this.#path = path;
  }

  #read(): StoredWebPush {
    if (this.#value) return this.#value;
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(this.#path, "utf8"));
    } catch {
      parsed = null;
    }
    this.#value = {
      version: 1,
      vapid: isDynamicRecord(parsed) && isVapidKeys(parsed.vapid) ? parsed.vapid : null,
      subscriptions:
        isDynamicRecord(parsed) && Array.isArray(parsed.subscriptions)
          ? parsed.subscriptions.filter(isSubscription)
          : [],
    };
    return this.#value;
  }

  #write(): void {
    const value = this.#read();
    mkdirSync(dirname(this.#path), { recursive: true, mode: 0o700 });
    const temporary = `${this.#path}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(value)}\n`, { mode: 0o600 });
    renameSync(temporary, this.#path);
    chmodSync(this.#path, 0o600);
  }

  /** The key pair of this host. It is made the first time that a browser asks for it, and kept. */
  vapidKeys(): VapidKeys {
    const value = this.#read();
    if (!value.vapid) {
      value.vapid = generateVapidKeys();
      this.#write();
    }
    return value.vapid;
  }

  list(): readonly WebPushSubscription[] {
    return this.#read().subscriptions;
  }

  /** Adds a subscription, or replaces the one with the same address. */
  upsert(subscription: WebPushSubscription): void {
    const value = this.#read();
    value.subscriptions = [
      ...value.subscriptions.filter((item) => item.endpoint !== subscription.endpoint),
      subscription,
    ];
    this.#write();
  }

  /** Removes every subscription that `shouldRemove` names. Returns how many it removed. */
  removeWhere(shouldRemove: (subscription: WebPushSubscription) => boolean): number {
    const value = this.#read();
    const kept = value.subscriptions.filter((item) => !shouldRemove(item));
    const removed = value.subscriptions.length - kept.length;
    if (removed === 0) return 0;
    value.subscriptions = kept;
    this.#write();
    return removed;
  }
}
