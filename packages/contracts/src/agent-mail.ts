// The wire between the mail Worker (`apps/email-app`) and the host's agent mailboxes.
//
// Inbound: the Worker posts one parsed message to the host's webhook inbox
// (`<connector gateway>/hooks/<mail route id>`), signed with Atelier's scheme (`X-OpenBot-*`, see
// docs/webhooks.md) and the shared mail secret. Outbound: the host posts one reply to the Worker's
// `/send`, signed the same way with the same secret. Both bodies are JSON in the shapes below.
// Widening a field needs a new `version`.

import { isDynamicRecord, isOneOf, isString } from "./runtime-values";
import {
  WEBHOOK_DELIVERY_ID_HEADER,
  WEBHOOK_DELIVERY_ID_PATTERN,
  WEBHOOK_MAX_CLOCK_SKEW_SECONDS,
  WEBHOOK_SIGNATURE_HEADER,
  WEBHOOK_SIGNATURE_PATTERN,
  WEBHOOK_TIMESTAMP_HEADER,
  WEBHOOK_TIMESTAMP_PATTERN,
} from "./signal-protocol/webhook-route";

export const AGENT_MAIL_VERSION = 1;
export const AGENT_MAIL_SEND_PATH = "/send";

export const AGENT_MAIL_LIMITS = {
  /** A larger message bounces at the Worker: an agent reads a question, not a file transfer. */
  rawBytes: 1024 * 1024,
  /** The text the agent reads, after HTML is turned into text. */
  text: 24_000,
  subject: 300,
  address: 254,
  name: 120,
  messageId: 998,
  references: 20,
  attachments: 20,
  /** The JSON body of one inbound message or one send. */
  body: 128 * 1024,
  /** One outbound mail's text. */
  sendText: 20_000,
  /** One outbound mail's HTML part, which the host makes from the agent's Markdown. */
  sendHtml: 96_000,
} as const;

export const MAIL_AUTH_RESULTS = ["pass", "fail", "softfail", "neutral", "none", "temperror", "permerror"] as const;
export type MailAuthResult = (typeof MAIL_AUTH_RESULTS)[number];

export interface MailAddress {
  address: string;
  name: string | null;
}

/** One parsed inbound message, as the Worker posts it. */
export interface InboundMail {
  version: typeof AGENT_MAIL_VERSION;
  /** The envelope recipient: the agent's address. */
  to: string;
  /** The envelope sender (MAIL FROM). */
  envelopeFrom: string;
  from: MailAddress;
  replyTo: MailAddress | null;
  subject: string;
  /** Without the angle brackets. */
  messageId: string;
  inReplyTo: string | null;
  references: string[];
  date: string | null;
  /** Plain text only: HTML is turned into text, and remote images and links' targets are dropped. */
  text: string;
  textTruncated: boolean;
  /** Names and sizes only; the Worker does not post the files. */
  attachments: { filename: string; mimeType: string; size: number }[];
  /** Cloudflare Email Routing's verdicts (`Authentication-Results` of `mx.cloudflare.net`). */
  auth: { spf: MailAuthResult; dkim: MailAuthResult; dmarc: MailAuthResult };
  /** `Auto-Submitted`, `Precedence: bulk` or a list header: an out-of-office or a newsletter. */
  automated: boolean;
}

/** One mail that the host asks the Worker to send. */
export interface OutboundMail {
  version: typeof AGENT_MAIL_VERSION;
  from: MailAddress;
  to: string;
  subject: string;
  text: string;
  /**
   * The HTML part, sent beside `text` (multipart/alternative), or null for a text-only mail. The
   * host renders it from the agent's Markdown and escapes the agent's text; a Worker that predates
   * the field ignores it and sends the text only.
   */
  html?: string | null;
  inReplyTo: string | null;
  references: string[];
  /** A `mailto:` for `List-Unsubscribe`, on a first-contact mail. */
  listUnsubscribe: string | null;
}

export interface OutboundMailResult {
  messageId: string | null;
}

const ADDRESS = /^[^\s@<>()",;:]{1,64}@[A-Za-z0-9.-]{1,253}\.[A-Za-z]{2,63}$/u;

/** A plain `local@domain` address, lowercased; null for anything else. */
export function normalizeMailAddress(value: string): string | null {
  const address = value.trim().toLowerCase();
  return address.length <= AGENT_MAIL_LIMITS.address && ADDRESS.test(address) ? address : null;
}

/** A Message-ID without brackets and whitespace, or null. */
export function cleanMessageId(value: string | null | undefined): string | null {
  const id = (value ?? "").trim().replace(/^<|>$/gu, "").trim();
  return id && id.length <= AGENT_MAIL_LIMITS.messageId && !/[\s<>]/u.test(id) ? id : null;
}

function text(value: unknown, limit: number): string {
  return isString(value) ? value.slice(0, limit) : "";
}

function mailAddress(value: unknown): MailAddress | null {
  if (!isDynamicRecord(value) || !isString(value.address)) return null;
  const address = normalizeMailAddress(value.address);
  if (!address) return null;
  const name = isString(value.name)
    ? value.name
        .replace(/[\r\n]+/gu, " ")
        .trim()
        .slice(0, AGENT_MAIL_LIMITS.name)
    : "";
  return { address, name: name || null };
}

function authResult(value: unknown): MailAuthResult {
  return isOneOf(MAIL_AUTH_RESULTS, value) ? value : "none";
}

/** The inbound message of a body, or null when it is not one. */
export function decodeInboundMail(value: unknown): InboundMail | null {
  if (!isDynamicRecord(value) || value.version !== AGENT_MAIL_VERSION) return null;
  const to = isString(value.to) ? normalizeMailAddress(value.to) : null;
  const from = mailAddress(value.from);
  const messageId = cleanMessageId(isString(value.messageId) ? value.messageId : null);
  if (!to || !from || !messageId) return null;
  const auth = isDynamicRecord(value.auth) ? value.auth : {};
  return {
    version: AGENT_MAIL_VERSION,
    to,
    envelopeFrom: (isString(value.envelopeFrom) ? normalizeMailAddress(value.envelopeFrom) : null) ?? from.address,
    from,
    replyTo: mailAddress(value.replyTo),
    subject: text(value.subject, AGENT_MAIL_LIMITS.subject).replace(/[\r\n]+/gu, " "),
    messageId,
    inReplyTo: cleanMessageId(isString(value.inReplyTo) ? value.inReplyTo : null),
    references: (Array.isArray(value.references) ? value.references : [])
      .flatMap((item: unknown) => {
        const id = cleanMessageId(isString(item) ? item : null);
        return id ? [id] : [];
      })
      .slice(-AGENT_MAIL_LIMITS.references),
    date: isString(value.date) ? value.date.slice(0, 64) : null,
    text: text(value.text, AGENT_MAIL_LIMITS.text),
    textTruncated: value.textTruncated === true,
    attachments: (Array.isArray(value.attachments) ? value.attachments : [])
      .flatMap((item: unknown) =>
        isDynamicRecord(item)
          ? [
              {
                filename: text(item.filename, 200) || "attachment",
                mimeType: text(item.mimeType, 100) || "application/octet-stream",
                size: typeof item.size === "number" && Number.isFinite(item.size) ? Math.max(0, item.size) : 0,
              },
            ]
          : [],
      )
      .slice(0, AGENT_MAIL_LIMITS.attachments),
    auth: { spf: authResult(auth.spf), dkim: authResult(auth.dkim), dmarc: authResult(auth.dmarc) },
    automated: value.automated === true,
  };
}

/** Active content that a mail's HTML part never carries: the host's renderer makes none. */
const ACTIVE_HTML =
  /<\s*\/?\s*(script|iframe|object|embed|form|input|button|link|meta\s+http-equiv|base)\b|<[^>]*\son[a-z]+\s*=|<[^>]*(javascript|vbscript|data):/iu;

/** The HTML part of a send, or null when it is missing, too large or carries active content. */
function outboundHtml(value: unknown): string | null {
  if (!isString(value) || !value.trim() || value.length > AGENT_MAIL_LIMITS.sendHtml) return null;
  return ACTIVE_HTML.test(value) ? null : value;
}

/** The mail to send of a body, or null when it is not one. */
export function decodeOutboundMail(value: unknown): OutboundMail | null {
  if (!isDynamicRecord(value) || value.version !== AGENT_MAIL_VERSION) return null;
  const from = mailAddress(value.from);
  const to = isString(value.to) ? normalizeMailAddress(value.to) : null;
  const subject = text(value.subject, AGENT_MAIL_LIMITS.subject)
    .replace(/[\r\n]+/gu, " ")
    .trim();
  const body = text(value.text, AGENT_MAIL_LIMITS.sendText);
  if (!from || !to || !subject || !body.trim()) return null;
  const unsubscribe = isString(value.listUnsubscribe) ? value.listUnsubscribe.trim() : "";
  return {
    version: AGENT_MAIL_VERSION,
    from,
    to,
    subject,
    text: body,
    html: outboundHtml(value.html),
    inReplyTo: cleanMessageId(isString(value.inReplyTo) ? value.inReplyTo : null),
    references: (Array.isArray(value.references) ? value.references : [])
      .flatMap((item: unknown) => {
        const id = cleanMessageId(isString(item) ? item : null);
        return id ? [id] : [];
      })
      .slice(-AGENT_MAIL_LIMITS.references),
    listUnsubscribe: /^<mailto:[^\s<>]{3,300}>$/u.test(unsubscribe) ? unsubscribe : null,
  };
}

// --- Atelier's signature, with Web Crypto so the Worker and the host share it ---

const encoder = new TextEncoder();

async function hmacHex(secret: string, data: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
  ]);
  const signature = new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(data)));
  return [...signature].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function sameText(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let index = 0; index < a.length; index += 1) diff |= a.charCodeAt(index) ^ b.charCodeAt(index);
  return diff === 0;
}

/** The three `X-OpenBot-*` headers of a body: HMAC-SHA256 of `<timestamp>.<deliveryId>.<body>`. */
export async function signAgentMail(
  secret: string,
  deliveryId: string,
  body: string,
  nowMs: number = Date.now(),
): Promise<Record<string, string>> {
  const timestamp = String(Math.floor(nowMs / 1000));
  return {
    [WEBHOOK_TIMESTAMP_HEADER]: timestamp,
    [WEBHOOK_DELIVERY_ID_HEADER]: deliveryId,
    [WEBHOOK_SIGNATURE_HEADER]: `sha256=${await hmacHex(secret, `${timestamp}.${deliveryId}.${body}`)}`,
  };
}

/** Whether the headers sign the body with the secret, within five minutes of `nowMs`. */
export async function verifyAgentMail(
  secret: string,
  header: (name: string) => string | null,
  body: string,
  nowMs: number = Date.now(),
): Promise<boolean> {
  const timestamp = header(WEBHOOK_TIMESTAMP_HEADER) ?? "";
  const deliveryId = header(WEBHOOK_DELIVERY_ID_HEADER) ?? "";
  const signature = header(WEBHOOK_SIGNATURE_HEADER) ?? "";
  if (
    !secret ||
    !WEBHOOK_TIMESTAMP_PATTERN.test(timestamp) ||
    !WEBHOOK_DELIVERY_ID_PATTERN.test(deliveryId) ||
    !WEBHOOK_SIGNATURE_PATTERN.test(signature)
  )
    return false;
  if (Math.abs(nowMs / 1000 - Number(timestamp)) > WEBHOOK_MAX_CLOCK_SKEW_SECONDS) return false;
  const expected = await hmacHex(secret, `${timestamp}.${deliveryId}.${body}`);
  return sameText(`sha256=${expected}`, signature.toLowerCase());
}

/** A delivery id for a Message-ID: the webhook syntax, stable for a retry of the same message. */
export async function mailDeliveryId(messageId: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(messageId)));
  return `mail_${[...digest.slice(0, 16)].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}
