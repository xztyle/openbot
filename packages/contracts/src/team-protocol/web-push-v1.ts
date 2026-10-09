// Frozen optional web-push-v1 wire contract.
//
// What it grants, recorded here because freezing it makes it permanent: a signed-in member's browser
// gives the host its Web Push subscription: the address of the browser's push service, the browser's
// public key and an authentication secret. The host keeps it in a file in its own profile until the
// browser removes it, the push service refuses it, or the member leaves. When an agent finishes, needs
// input or approval, or a scheduled run fails, the host sends a message to that address, signed with
// its own VAPID key and encrypted to the browser's key. The message holds the agent's name, a fixed
// phrase for the kind of event, and the agent's id, and never the text of a chat. The push service
// (Google, Apple, Mozilla or Microsoft) sees the host's address, the time and the size, not the
// content. The account service sees nothing. The route names no capability of its own: it shares
// `fork-host-v1`. Widening any of it needs a second capability string.
import {
  type AdminDecoder,
  adminRoute,
  count,
  empty,
  fields,
  nullable,
  type OptionalRouteCodec,
  oneOf,
  string,
} from "./admin-wire";
import { FORK_HOST_CAPABILITY } from "./fork-host-v1";

export const WEB_PUSH_CAPABILITY = FORK_HOST_CAPABILITY;

export const WEB_PUSH_ROUTES = {
  /** The public VAPID key of this host, which the browser needs to subscribe. Made on first use. */
  key: "/v1/web-push/key",
  /** Adds a subscription, or updates the one with the same address. */
  register: "/v1/web-push/subscription",
  remove: "/v1/web-push/subscription/remove",
} as const;

export type WebPushLevel = "all" | "needs-me" | "nothing";

export interface WebPushRegistration {
  endpoint: string;
  p256dh: string;
  auth: string;
  /** What the member wants to hear about. "nothing" keeps the subscription and sends no message. */
  level: WebPushLevel;
  /** The host sends no message until this time, in epoch milliseconds. Null is no mute. */
  mutedUntil: number | null;
  /** The language of the browser, for the words of the message. The host uses English for one it lacks. */
  locale: string;
}

const pattern =
  (expression: RegExp, maximum: number): AdminDecoder =>
  (value) => {
    const text = string(maximum)(value);
    if (typeof text !== "string" || !expression.test(text)) throw new Error("Invalid push value.");
    return text;
  };

/** An `https:` address. The host decides which push services it sends to. */
const endpoint = pattern(/^https:\/\/[^\s]{1,2040}$/u, 2048);
/** An uncompressed P-256 point, 65 bytes as base64url. */
const publicKey = pattern(/^[A-Za-z0-9_-]{87}$/u, 87);
/** 16 bytes as base64url. */
const authSecret = pattern(/^[A-Za-z0-9_-]{22}$/u, 22);

export const WEB_PUSH_CODECS: ReadonlyMap<string, OptionalRouteCodec> = new Map([
  [WEB_PUSH_ROUTES.key, adminRoute(empty, fields({ publicKey }))],
  [
    WEB_PUSH_ROUTES.register,
    adminRoute(
      fields({
        endpoint,
        p256dh: publicKey,
        auth: authSecret,
        level: oneOf("all", "needs-me", "nothing"),
        mutedUntil: nullable(count),
        locale: string(35),
      }),
      empty,
    ),
  ],
  [WEB_PUSH_ROUTES.remove, adminRoute(fields({ endpoint }), empty)],
]);
