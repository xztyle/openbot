import {
  AGENT_MAIL_LIMITS,
  AGENT_MAIL_SEND_PATH,
  decodeOutboundMail,
  mailDeliveryId,
  type OutboundMail,
  signAgentMail,
  verifyAgentMail,
} from "@openbot/contracts/agent-mail";
import { inboundMail } from "./inbound";

/** The `send_email` binding of Cloudflare Email Sending, as far as this Worker uses it. */
export interface MailSender {
  send(message: {
    to: string;
    from: { email: string; name?: string };
    subject: string;
    text: string;
    headers?: Record<string, string>;
  }): Promise<{ messageId?: string }>;
}

export interface Env {
  /** The host's webhook inbox for mail: `https://<connector gateway>/hooks/<mail route id>`. */
  HOST_INBOX_URL: string;
  /** The mail secret that settings show once; it signs both directions. */
  MAIL_SECRET: string;
  /** The domains the host may send from, comma-separated, such as `aprendivo.com,delynith.com`. */
  SENDER_DOMAINS: string;
  EMAIL: MailSender;
}

/** The parts of Email Routing's message that the Worker uses. */
export interface IncomingMail {
  readonly from: string;
  readonly to: string;
  readonly raw: ReadableStream<Uint8Array>;
  readonly rawSize: number;
  setReject(reason: string): void;
}

const HOST_TIMEOUT_MS = 15_000;

/** What a sender reads in the bounce for each answer of the host. */
function rejection(status: number) {
  if (status === 200 || status === 202) return null;
  if (status === 404) return "No mailbox has this address.";
  if (status === 413) return "The message is too large.";
  if (status === 429) return "Too many messages to this address now. Try again later.";
  if (status >= 500) return "The mailbox is unavailable now. Try again later.";
  return "The mailbox did not accept this message.";
}

/** One inbound message: parse, post it signed to the host, and bounce it when the host does not take it. */
/** A `fetch` as far as the Worker uses it; tests pass their own. */
export type HostFetch = (url: string, init: RequestInit) => Promise<Response>;

export async function receiveMail(
  message: IncomingMail,
  env: Env,
  fetcher: HostFetch = (url, init) => fetch(url, init),
): Promise<void> {
  if (message.rawSize > AGENT_MAIL_LIMITS.rawBytes) {
    message.setReject(`The message is larger than ${AGENT_MAIL_LIMITS.rawBytes / 1024} KB.`);
    return;
  }
  let mail: Awaited<ReturnType<typeof inboundMail>>;
  try {
    const raw = await new Response(message.raw).arrayBuffer();
    mail = await inboundMail(raw, { from: message.from, to: message.to });
  } catch {
    message.setReject("The message could not be read.");
    return;
  }
  if (!mail) {
    message.setReject("The message has no valid sender or recipient.");
    return;
  }
  const body = JSON.stringify(mail);
  if (new TextEncoder().encode(body).byteLength > AGENT_MAIL_LIMITS.body) {
    message.setReject("The message is too large.");
    return;
  }
  const headers = await signAgentMail(env.MAIL_SECRET, await mailDeliveryId(mail.messageId), body);
  let status = 503;
  try {
    const response = await fetcher(env.HOST_INBOX_URL, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body,
      signal: AbortSignal.timeout(HOST_TIMEOUT_MS),
    });
    status = response.status;
  } catch {
    status = 503;
  }
  const reason = rejection(status);
  if (reason) message.setReject(reason);
}

function json(status: number, value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

function senderDomains(env: Env): Set<string> {
  return new Set(
    env.SENDER_DOMAINS.split(",")
      .map((domain) => domain.trim().toLowerCase())
      .filter(Boolean),
  );
}

/** The headers of one outbound mail: threading for a reply, an unsubscribe for a first contact. */
export function outboundHeaders(mail: OutboundMail): Record<string, string> {
  const headers: Record<string, string> = {};
  if (mail.inReplyTo) headers["In-Reply-To"] = `<${mail.inReplyTo}>`;
  const references = [...mail.references, ...(mail.inReplyTo ? [mail.inReplyTo] : [])].filter(
    (id, index, all) => all.indexOf(id) === index,
  );
  if (references.length) headers.References = references.map((id) => `<${id}>`).join(" ");
  if (mail.listUnsubscribe) headers["List-Unsubscribe"] = mail.listUnsubscribe;
  headers["X-Atelier-Agent-Mail"] = "1";
  return headers;
}

/** `POST /send`: one mail from the host, signed with the mail secret, sent with Email Sending. */
export async function handleSend(request: Request, env: Env): Promise<Response> {
  const body = await request.text();
  if (body.length > AGENT_MAIL_LIMITS.body) return json(413, { error: "too_large" });
  const valid = await verifyAgentMail(env.MAIL_SECRET, (name) => request.headers.get(name), body);
  if (!valid) return json(401, { error: "signature" });
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    return json(400, { error: "body" });
  }
  const mail = decodeOutboundMail(value);
  if (!mail) return json(400, { error: "body" });
  const domain = mail.from.address.split("@")[1] ?? "";
  if (!senderDomains(env).has(domain)) return json(403, { error: "sender_domain" });
  try {
    const result = await env.EMAIL.send({
      to: mail.to,
      from: { email: mail.from.address, ...(mail.from.name ? { name: mail.from.name } : {}) },
      subject: mail.subject,
      text: mail.text,
      headers: outboundHeaders(mail),
    });
    return json(200, { messageId: result.messageId ?? null });
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? String(error.code) : "send_failed";
    return json(502, { error: code.slice(0, 64) });
  }
}

export default {
  async email(message: IncomingMail, env: Env): Promise<void> {
    await receiveMail(message, env);
  },
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/health") return json(200, { ok: true });
    if (url.pathname === AGENT_MAIL_SEND_PATH && request.method === "POST") return handleSend(request, env);
    return json(404, { error: "not_found" });
  },
};
