import { createHmac, timingSafeEqual } from "node:crypto";
import type { EventJsonValue } from "@openbot/contracts/ipc-events";
import { type DynamicRecord, isDynamicRecord, isNumber, isString } from "@openbot/contracts/runtime-values";

/**
 * How a business system signs the events that it sends to a webhook inbox. `openbot` is Atelier's own
 * scheme (`webhook-security.ts`), signed with the routine's secret; the others use the secret that the
 * system gives the owner, saved with the inbox.
 */
export const WEBHOOK_INBOX_SCHEMES = ["openbot", "stripe", "hotmart", "youtube"] as const;
export type WebhookInboxScheme = (typeof WEBHOOK_INBOX_SCHEMES)[number];

/** A verified event, in the shape that a webhook routine receives. */
export interface InboxEvent {
  deliveryId: string;
  eventType: string;
  occurredAt: string | null;
  data: EventJsonValue;
}

export type SchemeResult = { ok: true; event: InboxEvent } | { ok: false; status: 400 | 401 | 415 };

export interface SchemeRequest {
  headers: Record<string, string | string[] | undefined>;
  body: Buffer;
  nowMs: number;
}

/** Stripe refuses older signatures by default too. */
const STRIPE_TOLERANCE_S = 5 * 60;
const DELIVERY_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;
/** Keys of personal data that an event does not need in the agent's prompt; the agent reads the sale itself. */
const PERSONAL_KEYS = new Set([
  "email",
  "phone",
  "checkout_phone",
  "document",
  "document_type",
  "cpf",
  "address",
  "zip_code",
  "ip",
]);

function header(request: SchemeRequest, name: string): string {
  const value = request.headers[name];
  return (Array.isArray(value) ? value[0] : value) ?? "";
}

function mediaType(request: SchemeRequest): string {
  return header(request, "content-type").split(";", 1)[0]?.trim().toLowerCase() ?? "";
}

function sameText(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

function sameHex(expected: Buffer, given: string): boolean {
  if (!/^[0-9a-f]+$/iu.test(given) || given.length !== expected.length * 2) return false;
  return timingSafeEqual(expected, Buffer.from(given, "hex"));
}

/** The body as a JSON object, or null when it is not one. */
function jsonObject(body: Buffer): DynamicRecord | null {
  let value: DynamicRecord | null = null;
  try {
    const parsed = JSON.parse(body.toString("utf8"));
    if (isDynamicRecord(parsed)) value = parsed;
  } catch {
    // Not JSON: the caller answers 400.
  }
  return value;
}

/** A copy of `value` with personal fields masked, at any depth. */
export function maskPersonalData(value: unknown, depth = 0): EventJsonValue {
  if (depth > 16) return null;
  if (Array.isArray(value)) return value.map((item) => maskPersonalData(item, depth + 1));
  if (!isDynamicRecord(value)) return isString(value) || isNumber(value) || typeof value === "boolean" ? value : null;
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      PERSONAL_KEYS.has(key.toLowerCase()) && item !== null && item !== "" ? "•••" : maskPersonalData(item, depth + 1),
    ]),
  );
}

function deliveryId(value: string): string | null {
  const id = value.slice(0, 256);
  return DELIVERY_ID.test(id) ? id : null;
}

/**
 * Stripe: `Stripe-Signature: t=<seconds>,v1=<hex>[,v1=…]`, an HMAC-SHA256 of `<t>.<body>` with the
 * endpoint's signing secret (`whsec_…`). The event ID is the delivery ID, so a retry runs once.
 * https://docs.stripe.com/webhooks#verify-manually
 */
export function verifyStripe(secret: string, request: SchemeRequest): SchemeResult {
  if (mediaType(request) !== "application/json") return { ok: false, status: 415 };
  const parts = header(request, "stripe-signature").split(",");
  const timestamp = parts.find((part) => part.startsWith("t="))?.slice(2) ?? "";
  const signatures = parts.filter((part) => part.startsWith("v1=")).map((part) => part.slice(3));
  if (!/^\d{1,12}$/u.test(timestamp) || signatures.length === 0) return { ok: false, status: 401 };
  if (Math.abs(Number(timestamp) - request.nowMs / 1000) > STRIPE_TOLERANCE_S) return { ok: false, status: 401 };
  const expected = createHmac("sha256", secret).update(`${timestamp}.`).update(request.body).digest();
  if (!signatures.some((signature) => sameHex(expected, signature))) return { ok: false, status: 401 };
  const event = jsonObject(request.body);
  if (!event || !isString(event.id) || !isString(event.type)) return { ok: false, status: 400 };
  const id = deliveryId(event.id);
  if (!id) return { ok: false, status: 400 };
  const object = isDynamicRecord(event.data) ? event.data.object : null;
  return {
    ok: true,
    event: {
      deliveryId: id,
      eventType: event.type.slice(0, 256),
      occurredAt: isNumber(event.created) ? new Date(event.created * 1000).toISOString() : null,
      data: maskPersonalData({ object, livemode: event.livemode === true }),
    },
  };
}

/**
 * Hotmart (webhook version 2.0.0): the `X-HOTMART-HOTTOK` header carries the account's hottok, which
 * the owner copies from Hotmart's webhook settings. The body's `id` is the delivery ID and `event`,
 * such as PURCHASE_APPROVED, the event type. Buyer contact fields are masked.
 * https://developers.hotmart.com/docs/en/2.0.0/webhook/about-webhook/
 */
export function verifyHotmart(secret: string, request: SchemeRequest): SchemeResult {
  if (mediaType(request) !== "application/json") return { ok: false, status: 415 };
  const hottok = header(request, "x-hotmart-hottok");
  if (!hottok || !sameText(hottok, secret)) return { ok: false, status: 401 };
  const event = jsonObject(request.body);
  if (!event || !isString(event.event)) return { ok: false, status: 400 };
  const purchase = isDynamicRecord(event.data) && isDynamicRecord(event.data.purchase) ? event.data.purchase : {};
  const fallback = isString(purchase.transaction) ? `${purchase.transaction}:${event.event}` : "";
  const id = deliveryId(isString(event.id) ? event.id : fallback);
  if (!id) return { ok: false, status: 400 };
  return {
    ok: true,
    event: {
      deliveryId: id,
      eventType: event.event.slice(0, 256),
      occurredAt: isNumber(event.creation_date) ? new Date(event.creation_date).toISOString() : null,
      data: maskPersonalData(event.data ?? null),
    },
  };
}

/** The text of the first `<tag>` element of a small Atom entry. */
function tag(xml: string, name: string): string | null {
  const match = new RegExp(`<${name}(?:\\s[^>]*)?>([^<]{0,2000})</${name}>`, "u").exec(xml);
  return match?.[1]?.trim() ?? null;
}

/**
 * YouTube push notifications (WebSub): an Atom entry for each new or changed video, signed with
 * `X-Hub-Signature: sha1=<hex>`, the HMAC-SHA1 of the body with the `hub.secret` that the
 * subscription gave. https://developers.google.com/youtube/v3/guides/push_notifications
 */
export function verifyYouTube(secret: string, request: SchemeRequest): SchemeResult {
  const type = mediaType(request);
  if (type !== "application/atom+xml" && type !== "application/xml" && type !== "text/xml")
    return { ok: false, status: 415 };
  const signature = header(request, "x-hub-signature");
  if (!signature.startsWith("sha1=")) return { ok: false, status: 401 };
  const expected = createHmac("sha1", secret).update(request.body).digest();
  if (!sameHex(expected, signature.slice(5))) return { ok: false, status: 401 };
  const xml = request.body.toString("utf8");
  const deleted = xml.includes("at:deleted-entry");
  const videoId = tag(xml, "yt:videoId");
  if (!videoId && !deleted) return { ok: false, status: 400 };
  const updated = tag(xml, "updated") ?? tag(xml, "published") ?? "";
  const id = deliveryId(`yt:${videoId ?? "deleted"}:${updated.replace(/[^0-9A-Za-z]/gu, "")}`);
  if (!id) return { ok: false, status: 400 };
  return {
    ok: true,
    event: {
      deliveryId: id,
      eventType: deleted ? "youtube.video.deleted" : "youtube.video",
      occurredAt: updated && !Number.isNaN(Date.parse(updated)) ? new Date(updated).toISOString() : null,
      data: {
        videoId,
        channelId: tag(xml, "yt:channelId"),
        title: tag(xml, "title"),
        url: videoId ? `https://www.youtube.com/watch?v=${videoId}` : null,
        published: tag(xml, "published"),
      },
    },
  };
}

export function verifyInboxScheme(
  scheme: Exclude<WebhookInboxScheme, "openbot">,
  secret: string,
  request: SchemeRequest,
): SchemeResult {
  if (scheme === "stripe") return verifyStripe(secret, request);
  if (scheme === "hotmart") return verifyHotmart(secret, request);
  return verifyYouTube(secret, request);
}
