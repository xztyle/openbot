import {
  AGENT_MAIL_LIMITS,
  AGENT_MAIL_VERSION,
  cleanMessageId,
  type InboundMail,
  MAIL_AUTH_RESULTS,
  type MailAddress,
  type MailAuthResult,
  normalizeMailAddress,
} from "@openbot/contracts/agent-mail";
import PostalMime from "postal-mime";

type Parsed = Awaited<ReturnType<typeof PostalMime.parse>>;

/** The only authentication service whose verdicts count: Email Routing prepends its own header. */
const CLOUDFLARE_AUTHSERV = "mx.cloudflare.net";

/**
 * Cloudflare's SPF, DKIM and DMARC verdicts. Only the first `Authentication-Results` header counts,
 * and only when Email Routing wrote it: a sender can add its own further down.
 */
export function authVerdicts(headers: readonly { key: string; value: string }[]): InboundMail["auth"] {
  const none = { spf: "none", dkim: "none", dmarc: "none" } as const;
  const first = headers.find((header) => header.key.toLowerCase() === "authentication-results");
  if (!first) return none;
  const [authserv = "", ...rest] = first.value.split(";");
  if (authserv.trim().toLowerCase() !== CLOUDFLARE_AUTHSERV) return none;
  const result = (method: string): MailAuthResult => {
    for (const part of rest) {
      const match = new RegExp(`^\\s*${method}\\s*=\\s*([a-z]+)`, "iu").exec(part);
      const value = match?.[1]?.toLowerCase();
      if (value) return MAIL_AUTH_RESULTS.find((known) => known === value) ?? "none";
    }
    return "none";
  };
  return { spf: result("spf"), dkim: result("dkim"), dmarc: result("dmarc") };
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

/**
 * Plain text of an HTML body. Scripts, styles, images and every link target go: the agent reads what
 * a person sees, and nothing that loads from outside.
 */
export function htmlToText(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->/gu, "")
    .replace(/<(script|style|head|title|template|svg|noscript)\b[\s\S]*?<\/\1\s*>/giu, "")
    .replace(/<img\b[^>]*>/giu, "")
    .replace(/<br\s*\/?>/giu, "\n")
    .replace(/<li\b[^>]*>/giu, "\n- ")
    .replace(/<\/(p|div|h[1-6]|tr|table|blockquote|ul|ol|section|article|header|footer)\s*>/giu, "\n")
    .replace(/<[^>]+>/gu, "")
    .replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/giu, (whole, entity: string) => {
      if (entity.startsWith("#x") || entity.startsWith("#X"))
        return safeChar(Number.parseInt(entity.slice(2), 16), whole);
      if (entity.startsWith("#")) return safeChar(Number.parseInt(entity.slice(1), 10), whole);
      return ENTITIES[entity.toLowerCase()] ?? whole;
    });
}

function safeChar(code: number, fallback: string): string {
  return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : fallback;
}

/** Hidden characters that can hide text from the owner but not from a model: zero-width and bidi controls. */
const HIDDEN = /[​-‏‪-‮⁠-⁤⁦-⁩﻿­]/gu;

/** The text the agent reads: no hidden characters, no runs of blank lines, capped. */
export function cleanBody(text: string): { text: string; truncated: boolean } {
  const clean = text
    .replace(/\r\n?/gu, "\n")
    .replace(HIDDEN, "")
    // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what this removes.
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/gu, "")
    .replace(/[ \t]+\n/gu, "\n")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();
  return clean.length > AGENT_MAIL_LIMITS.text
    ? { text: clean.slice(0, AGENT_MAIL_LIMITS.text), truncated: true }
    : { text: clean, truncated: false };
}

function mailbox(value: Parsed["from"] | undefined): MailAddress | null {
  const first = value && "group" in value && value.group ? value.group[0] : value;
  const address = first?.address ? normalizeMailAddress(first.address) : null;
  if (!address) return null;
  const name = (first?.name ?? "")
    .replace(/[\r\n]+/gu, " ")
    .trim()
    .slice(0, AGENT_MAIL_LIMITS.name);
  return { address, name: name || null };
}

function header(parsed: Parsed, name: string): string | null {
  return parsed.headers.find((item) => item.key.toLowerCase() === name)?.value ?? null;
}

/** An out-of-office answer, a bounce, a list or a bulk mail. An agent should not answer it. */
export function isAutomated(parsed: Parsed): boolean {
  const submitted = header(parsed, "auto-submitted")?.trim().toLowerCase();
  if (submitted && submitted !== "no") return true;
  if (/^(bulk|list|junk|auto_reply)$/iu.test(header(parsed, "precedence")?.trim() ?? "")) return true;
  if (header(parsed, "list-id") || header(parsed, "list-unsubscribe")) return true;
  return header(parsed, "x-autoreply") !== null || header(parsed, "x-autorespond") !== null;
}

/** A stable stand-in for a message that has no Message-ID: the hash of its bytes. */
async function stableMessageId(raw: ArrayBuffer | Uint8Array<ArrayBuffer>, to: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", raw));
  const hex = [...digest.slice(0, 16)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `generated.${hex}@${to.split("@")[1] ?? "mail"}`;
}

/** One raw message as the host reads it, or null when it has no usable sender. */
export async function inboundMail(
  raw: ArrayBuffer | Uint8Array<ArrayBuffer>,
  envelope: { from: string; to: string },
): Promise<InboundMail | null> {
  const to = normalizeMailAddress(envelope.to);
  if (!to) return null;
  const parsed = await PostalMime.parse(raw, { maxNestingDepth: 32, maxPartCount: 200 });
  const envelopeFrom = normalizeMailAddress(envelope.from);
  const from = mailbox(parsed.from) ?? (envelopeFrom ? { address: envelopeFrom, name: null } : null);
  if (!from) return null;
  const source = parsed.text?.trim() ? parsed.text : parsed.html ? htmlToText(parsed.html) : "";
  const body = cleanBody(source);
  const references = (parsed.references ?? "")
    .split(/\s+/u)
    .flatMap((item) => {
      const id = cleanMessageId(item);
      return id ? [id] : [];
    })
    .slice(-AGENT_MAIL_LIMITS.references);
  return {
    version: AGENT_MAIL_VERSION,
    to,
    envelopeFrom: envelopeFrom ?? from.address,
    from,
    replyTo: mailbox(parsed.replyTo?.[0]),
    subject: (parsed.subject ?? "")
      .replace(/[\r\n]+/gu, " ")
      .replace(HIDDEN, "")
      .trim()
      .slice(0, AGENT_MAIL_LIMITS.subject),
    messageId: cleanMessageId(parsed.messageId) ?? (await stableMessageId(raw, to)),
    inReplyTo: cleanMessageId(parsed.inReplyTo),
    references,
    date: parsed.date ?? null,
    text: body.text,
    textTruncated: body.truncated,
    attachments: parsed.attachments
      .filter((attachment) => attachment.disposition !== "inline" || !attachment.contentId)
      .slice(0, AGENT_MAIL_LIMITS.attachments)
      .map((attachment) => ({
        filename: (attachment.filename ?? "attachment").slice(0, 200),
        mimeType: attachment.mimeType.slice(0, 100),
        size: typeof attachment.content === "string" ? attachment.content.length : attachment.content.byteLength,
      })),
    auth: authVerdicts(parsed.headers),
    automated: isAutomated(parsed),
  };
}
