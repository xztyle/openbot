import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  AGENT_MAIL_LIMITS,
  AGENT_MAIL_SEND_PATH,
  AGENT_MAIL_VERSION,
  cleanMessageId,
  decodeInboundMail,
  type InboundMail,
  normalizeMailAddress,
  type OutboundMail,
  signAgentMail,
  verifyAgentMail,
} from "@openbot/contracts/agent-mail";
import { isDynamicRecord, isNumber, isString } from "@openbot/contracts/runtime-values";
import { WEBHOOK_DELIVERY_ID_HEADER } from "@openbot/contracts/signal-protocol/webhook-route";
import {
  AGENT_MAILBOX_LIMIT,
  AGENT_MAILBOX_NAME_LIMIT,
  type AgentMailboxesState,
  type AgentMailboxInput,
  type AgentMailboxMode,
} from "@openbot/contracts/team-protocol/agent-mailboxes-v1";
import { sourceText } from "@openbot/i18n/source";
import { createOpenBotLogger, registerSecretValue, toLogValue } from "@openbot/logging";
import { Effect } from "effect";
import type { AgentMailPort, MailCallPlan, MailToolCall } from "../../backend/agent/mail-tools";
import { parseStoredJson, writeJsonFileAtomically } from "../../backend/atomic-json-file";
import { isMissingFileError } from "../../backend/file-errors";
import { readBodyWithin } from "../http-body";
import type { SecretCipher } from "../provider-credential-store";
import { asksToOptOut, inboundMailNote, optOutFooter, replySubject } from "./agent-mail-text";

const logger = createOpenBotLogger("agent-mail");

/** Outbound mail of one agent: a new sending domain earns its reputation slowly. */
export const AGENT_MAIL_RATE = { perHour: 20, perDay: 100, firstContactsPerDay: 10 } as const;
const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
const SEND_TIMEOUT_MS = 20_000;
const THREADS_LIMIT = 2_000;
const CONTACTS_LIMIT = 5_000;
const SEEN_LIMIT = 1_000;
const THREAD_IDS_LIMIT = 40;
/** A mail with no matching Message-ID joins the same sender's thread of the same subject this long. */
const SUBJECT_THREAD_MS = 30 * DAY_MS;

interface StoredMailbox {
  id: string;
  address: string;
  displayName: string;
  agentId: string;
  mode: AgentMailboxMode;
  createdAt: number;
  lastMailAt: number | null;
  received: number;
}

interface StoredThread {
  id: string;
  mailboxId: string;
  peer: string;
  subject: string;
  /** Every Message-ID seen in the thread, both ways, newest last. */
  messageIds: string[];
  /** The customer's last Message-ID, which a reply names in `In-Reply-To`. */
  lastInboundId: string | null;
  references: string[];
  updatedAt: number;
}

interface StoredContact {
  mailboxId: string;
  address: string;
  approvedAt: number | null;
  optedOutAt: number | null;
}

interface StoredSend {
  key: string;
  agentId: string;
  mailboxId: string;
  at: number;
  firstContact: boolean;
  result: Record<string, string>;
}

interface StoredFile {
  version: 1;
  routeId: string;
  secretCiphertext: string | null;
  workerUrl: string | null;
  lastMailAt: number | null;
  lastStatus: number | null;
  mailboxes: StoredMailbox[];
  threads: StoredThread[];
  contacts: StoredContact[];
  sends: StoredSend[];
  seen: string[];
}

export interface AgentMailHooks {
  /** The agent with its space, or null when it is gone or hidden. */
  agent(agentId: string): { id: string; name: string; spaceId: string } | null;
  /** Puts the note in the agent's chat as an `inbound-email` notice; the key makes a retry send once. */
  deliver(input: { agentId: string; text: string; clientMessageId: string }): Promise<void>;
  /** Files the mail in the space's customer-inbox loop, when there is one. */
  loopCard(input: { agentId: string; threadId: string; title: string; from: string; question: string }): void;
}

export class AgentMailboxRejected extends Error {}

const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter(isString) : []);
const numberOrNull = (value: unknown): number | null => (isNumber(value) ? value : null);

function decodeFile(value: unknown): StoredFile | null {
  if (!isDynamicRecord(value) || !isString(value.routeId)) return null;
  const records = (list: unknown) => (Array.isArray(list) ? list.filter(isDynamicRecord) : []);
  return {
    version: 1,
    routeId: value.routeId,
    secretCiphertext: isString(value.secretCiphertext) ? value.secretCiphertext : null,
    workerUrl: isString(value.workerUrl) ? value.workerUrl : null,
    lastMailAt: numberOrNull(value.lastMailAt),
    lastStatus: numberOrNull(value.lastStatus),
    mailboxes: records(value.mailboxes).flatMap((item) =>
      isString(item.id) && isString(item.address) && isString(item.agentId)
        ? [
            {
              id: item.id,
              address: item.address,
              displayName: isString(item.displayName) ? item.displayName : "",
              agentId: item.agentId,
              mode: item.mode === "write-first" ? "write-first" : "reply",
              createdAt: numberOrNull(item.createdAt) ?? 0,
              lastMailAt: numberOrNull(item.lastMailAt),
              received: numberOrNull(item.received) ?? 0,
            } satisfies StoredMailbox,
          ]
        : [],
    ),
    threads: records(value.threads).flatMap((item) =>
      isString(item.id) && isString(item.mailboxId) && isString(item.peer)
        ? [
            {
              id: item.id,
              mailboxId: item.mailboxId,
              peer: item.peer,
              subject: isString(item.subject) ? item.subject : "",
              messageIds: strings(item.messageIds),
              lastInboundId: isString(item.lastInboundId) ? item.lastInboundId : null,
              references: strings(item.references),
              updatedAt: numberOrNull(item.updatedAt) ?? 0,
            },
          ]
        : [],
    ),
    contacts: records(value.contacts).flatMap((item) =>
      isString(item.mailboxId) && isString(item.address)
        ? [
            {
              mailboxId: item.mailboxId,
              address: item.address,
              approvedAt: numberOrNull(item.approvedAt),
              optedOutAt: numberOrNull(item.optedOutAt),
            },
          ]
        : [],
    ),
    sends: records(value.sends).flatMap((item) =>
      isString(item.key) && isString(item.agentId) && isString(item.mailboxId) && isNumber(item.at)
        ? [
            {
              key: item.key,
              agentId: item.agentId,
              mailboxId: item.mailboxId,
              at: item.at,
              firstContact: item.firstContact === true,
              result: isDynamicRecord(item.result)
                ? Object.fromEntries(
                    Object.entries(item.result).filter((entry): entry is [string, string] => isString(entry[1])),
                  )
                : {},
            },
          ]
        : [],
    ),
    seen: strings(value.seen),
  };
}

function normalizedSubject(subject: string): string {
  return subject
    .replace(/^((re|aw|fw|fwd|rv)\s*:\s*)+/iu, "")
    .trim()
    .toLowerCase();
}

/** A Worker address: https, or a loopback http address for a local test. */
export function workerOrigin(value: string): string | null {
  try {
    const url = new URL(value.trim());
    const local = url.hostname === "127.0.0.1" || url.hostname === "localhost";
    if (url.protocol !== "https:" && !(local && url.protocol === "http:")) return null;
    if (url.username || url.password || url.search || url.hash) return null;
    return `${url.origin}${url.pathname.replace(/\/+$/u, "")}`;
  } catch {
    return null;
  }
}

/** The Worker's answer to `/send`: the message id, or Cloudflare's error code. */
async function workerAnswer(response: Response): Promise<{ messageId: string | null; error: string }> {
  let value: unknown = null;
  try {
    value = await response.json();
  } catch {
    // Not JSON: a proxy's error page.
  }
  if (!isDynamicRecord(value)) return { messageId: null, error: "" };
  return {
    messageId: cleanMessageId(isString(value.messageId) ? value.messageId : null),
    error: isString(value.error) ? value.error.slice(0, 64) : "",
  };
}

function answer(response: ServerResponse, status: number): void {
  response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  response.end(JSON.stringify({ status }));
}

/**
 * Agent mailboxes: a business address, such as `ventas@aprendivo.com`, bound to one agent. The mail
 * Worker (`apps/email-app`) posts each inbound message to `/hooks/<route id>` on the connector
 * gateway, signed with the mail secret; the message becomes an `inbound-email` note in the agent's
 * chat, threaded by Message-ID and References, and a card in the space's customer-inbox loop.
 * `email_reply` and `email_send` go back through the Worker's `/send`, within per-agent limits and
 * after the owner's OK for a new recipient. The state is one JSON file of the profile; the secret is
 * encrypted with the host's secret storage.
 */
export class AgentMail {
  readonly #file: string;
  readonly #cipher: SecretCipher;
  readonly #hooks: AgentMailHooks;
  readonly #gateway: { listening(): boolean; publicUrl(): string | null };
  readonly #now: () => number;
  readonly #fetch: (url: string, init: RequestInit) => Promise<Response>;
  #state: StoredFile;
  #writing: Promise<void> = Promise.resolve();

  constructor(options: {
    file: string;
    cipher: SecretCipher;
    hooks: AgentMailHooks;
    gateway: { listening(): boolean; publicUrl(): string | null };
    now?: () => number;
    fetch?: (url: string, init: RequestInit) => Promise<Response>;
  }) {
    this.#file = options.file;
    this.#cipher = options.cipher;
    this.#hooks = options.hooks;
    this.#gateway = options.gateway;
    this.#now = options.now ?? Date.now;
    this.#fetch = options.fetch ?? ((url, init) => fetch(url, init));
    this.#state = this.#read();
  }

  // --- Settings ---

  state(): AgentMailboxesState {
    const base = this.#gateway.listening() ? this.#gateway.publicUrl() : null;
    const dayAgo = this.#now() - DAY_MS;
    return {
      gateway: { listening: this.#gateway.listening(), publicUrl: this.#gateway.publicUrl() },
      inboxUrl: base ? `${base}/hooks/${this.#state.routeId}` : null,
      workerUrl: this.#state.workerUrl,
      hasSecret: this.#state.secretCiphertext !== null,
      lastMailAt: this.#state.lastMailAt,
      lastStatus: this.#state.lastStatus,
      mailboxes: this.#state.mailboxes.map((mailbox) => {
        const agent = this.#hooks.agent(mailbox.agentId);
        return {
          id: mailbox.id,
          address: mailbox.address,
          displayName: mailbox.displayName,
          agentId: mailbox.agentId,
          agentName: (agent?.name ?? mailbox.agentId).slice(0, 200),
          spaceId: agent?.spaceId ?? "",
          mode: mailbox.mode,
          createdAt: mailbox.createdAt,
          lastMailAt: mailbox.lastMailAt,
          received: mailbox.received,
          sentToday: this.#state.sends.filter((send) => send.mailboxId === mailbox.id && send.at > dayAgo).length,
        };
      }),
    };
  }

  async saveMailbox(input: AgentMailboxInput): Promise<AgentMailboxesState> {
    const address = normalizeMailAddress(input.address);
    if (!address) throw new AgentMailboxRejected(sourceText("error.team.mailboxAddressInvalid"));
    if (!this.#hooks.agent(input.agentId)) throw new AgentMailboxRejected(sourceText("error.team.mailboxAgentUnknown"));
    const taken = this.#state.mailboxes.find((mailbox) => mailbox.address === address && mailbox.id !== input.id);
    if (taken) throw new AgentMailboxRejected(sourceText("error.team.mailboxAddressTaken", { address }));
    const existing = input.id ? this.#state.mailboxes.find((mailbox) => mailbox.id === input.id) : undefined;
    if (input.id && !existing) throw new AgentMailboxRejected(sourceText("error.team.mailboxGone"));
    if (!existing && this.#state.mailboxes.length >= AGENT_MAILBOX_LIMIT)
      throw new AgentMailboxRejected(sourceText("error.team.mailboxLimit", { limit: String(AGENT_MAILBOX_LIMIT) }));
    const next: StoredMailbox = {
      id: existing?.id ?? `mbx_${randomUUID()}`,
      address,
      displayName: (input.displayName ?? "")
        .replace(/[\r\n<>"]+/gu, " ")
        .trim()
        .slice(0, AGENT_MAILBOX_NAME_LIMIT),
      agentId: input.agentId,
      mode: input.mode,
      createdAt: existing?.createdAt ?? this.#now(),
      lastMailAt: existing?.lastMailAt ?? null,
      received: existing?.received ?? 0,
    };
    this.#state = {
      ...this.#state,
      mailboxes: existing
        ? this.#state.mailboxes.map((mailbox) => (mailbox.id === next.id ? next : mailbox))
        : [...this.#state.mailboxes, next],
    };
    await this.#save();
    return this.state();
  }

  async removeMailbox(id: string): Promise<AgentMailboxesState> {
    this.#state = {
      ...this.#state,
      mailboxes: this.#state.mailboxes.filter((mailbox) => mailbox.id !== id),
      threads: this.#state.threads.filter((thread) => thread.mailboxId !== id),
      contacts: this.#state.contacts.filter((contact) => contact.mailboxId !== id),
    };
    await this.#save();
    return this.state();
  }

  async setWorker(value: string): Promise<AgentMailboxesState> {
    const workerUrl = value.trim() ? workerOrigin(value) : null;
    if (value.trim() && !workerUrl) throw new AgentMailboxRejected(sourceText("error.team.mailboxWorkerUrlInvalid"));
    this.#state = { ...this.#state, workerUrl };
    await this.#save();
    return this.state();
  }

  /** A new mail secret, shown once. The old one stops working at once. */
  async newSecret(): Promise<{ state: AgentMailboxesState; secret: string }> {
    const secret = `ams_${randomBytes(32).toString("base64url")}`;
    registerSecretValue(secret);
    this.#state = { ...this.#state, secretCiphertext: this.#cipher.encrypt(secret).toString("base64") };
    await this.#save();
    return { state: this.state(), secret };
  }

  #secret(): string | null {
    if (!this.#state.secretCiphertext) return null;
    const secret = this.#cipher.decrypt(Buffer.from(this.#state.secretCiphertext, "base64"));
    registerSecretValue(secret);
    return secret;
  }

  // --- Inbound ---

  /** The mail inbox is this path of the gateway's `/hooks/`. */
  owns(path: string): boolean {
    return path === `/hooks/${this.#state.routeId}` || path === `/hooks/${this.#state.routeId}/`;
  }

  async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (request.method !== "POST") return answer(response, 405);
    const body = await readBodyWithin(request, AGENT_MAIL_LIMITS.body);
    if (body === null) return await this.#answer(response, 413);
    const status = await this.#receive(request, body.toString("utf8")).catch((error: unknown) => {
      logger.warn("A mail did not reach its agent.", toLogValue(error));
      return 503;
    });
    await this.#answer(response, status);
  }

  /** Answers after the status is saved, so nothing writes the file once the request is done. */
  async #answer(response: ServerResponse, status: number): Promise<void> {
    if (status !== 401) {
      this.#state = { ...this.#state, lastMailAt: this.#now(), lastStatus: status };
      await this.#save();
    }
    answer(response, status);
  }

  async #receive(request: IncomingMessage, body: string): Promise<number> {
    const secret = this.#secret();
    if (!secret) return 503;
    const header = (name: string) => {
      const raw = request.headers[name];
      return (Array.isArray(raw) ? raw[0] : raw) ?? null;
    };
    if (!(await verifyAgentMail(secret, header, body, this.#now()))) return 401;
    let value: unknown;
    try {
      value = JSON.parse(body);
    } catch {
      return 400;
    }
    const mail = decodeInboundMail(value);
    if (!mail) return 400;
    const deliveryId = header(WEBHOOK_DELIVERY_ID_HEADER) ?? "";
    if (this.#state.seen.includes(deliveryId)) return 200;
    const mailbox = this.#state.mailboxes.find((item) => item.address === mail.to);
    if (!mailbox || !this.#hooks.agent(mailbox.agentId)) return 404;
    return this.#accept(mailbox, mail, deliveryId);
  }

  async #accept(mailbox: StoredMailbox, mail: InboundMail, deliveryId: string): Promise<number> {
    const now = this.#now();
    const known = this.#threadFor(mailbox, mail);
    const thread: StoredThread = known ?? {
      id: `mt_${randomBytes(9).toString("base64url")}`,
      mailboxId: mailbox.id,
      peer: mail.from.address,
      subject: mail.subject,
      messageIds: [],
      lastInboundId: null,
      references: [],
      updatedAt: now,
    };
    const optedOut = asksToOptOut(mail);
    // An out-of-office, a bounce or a newsletter is kept out of the agent's chat: answering it loops.
    if (!mail.automated) {
      await this.#hooks.deliver({
        agentId: mailbox.agentId,
        text: inboundMailNote({ mail, threadId: thread.id, optedOut, followUp: known !== null }),
        clientMessageId: deliveryId,
      });
      try {
        const from = mail.from.name ? `${mail.from.name} <${mail.from.address}>` : mail.from.address;
        this.#hooks.loopCard({
          agentId: mailbox.agentId,
          threadId: thread.id,
          title: (mail.subject || from).slice(0, 200),
          from,
          question: mail.text.slice(0, 2_000),
        });
      } catch (error) {
        logger.warn("A mail was not filed in the customer inbox loop.", toLogValue(error));
      }
    }
    const nextThread: StoredThread = {
      ...thread,
      messageIds: [...thread.messageIds.filter((id) => id !== mail.messageId), mail.messageId].slice(-THREAD_IDS_LIMIT),
      lastInboundId: mail.messageId,
      references: [...mail.references.filter((id) => id !== mail.messageId), mail.messageId].slice(
        -AGENT_MAIL_LIMITS.references,
      ),
      updatedAt: now,
    };
    this.#state = {
      ...this.#state,
      mailboxes: this.#state.mailboxes.map((item) =>
        item.id === mailbox.id ? { ...item, lastMailAt: now, received: item.received + 1 } : item,
      ),
      threads: [...this.#state.threads.filter((item) => item.id !== thread.id), nextThread]
        .sort((a, b) => a.updatedAt - b.updatedAt)
        .slice(-THREADS_LIMIT),
      contacts: optedOut ? this.#withContact(mailbox.id, mail.from.address, { optedOutAt: now }) : this.#state.contacts,
      seen: [...this.#state.seen, deliveryId].slice(-SEEN_LIMIT),
    };
    await this.#save();
    return 202;
  }

  #threadFor(mailbox: StoredMailbox, mail: InboundMail): StoredThread | null {
    const ids = new Set([...(mail.inReplyTo ? [mail.inReplyTo] : []), ...mail.references]);
    const threads = this.#state.threads.filter((thread) => thread.mailboxId === mailbox.id);
    const byId = threads.find((thread) => thread.messageIds.some((id) => ids.has(id)));
    if (byId) return byId;
    const subject = normalizedSubject(mail.subject);
    return (
      threads
        .filter(
          (thread) =>
            thread.peer === mail.from.address &&
            subject !== "" &&
            normalizedSubject(thread.subject) === subject &&
            this.#now() - thread.updatedAt < SUBJECT_THREAD_MS,
        )
        .at(-1) ?? null
    );
  }

  #contact(mailboxId: string, address: string): StoredContact | undefined {
    return this.#state.contacts.find((contact) => contact.mailboxId === mailboxId && contact.address === address);
  }

  #withContact(mailboxId: string, address: string, change: Partial<StoredContact>): StoredContact[] {
    const existing = this.#contact(mailboxId, address) ?? { mailboxId, address, approvedAt: null, optedOutAt: null };
    return [
      ...this.#state.contacts.filter((contact) => contact !== this.#contact(mailboxId, address)),
      { ...existing, ...change },
    ].slice(-CONTACTS_LIMIT);
  }

  // --- Outbound (the tools) ---

  readonly port: AgentMailPort = {
    plan: (agentId, call) => {
      const resolved = this.#resolve(agentId, call);
      return "message" in resolved ? { ok: false, message: resolved.message } : { ok: true, plan: resolved.plan };
    },
    send: (agentId, call, options) => this.#send(agentId, call, options),
  };

  #resolve(
    agentId: string,
    call: MailToolCall,
  ):
    | { message: string }
    | { plan: MailCallPlan; mailbox: StoredMailbox; thread: StoredThread | null; firstContact: boolean } {
    const own = this.#state.mailboxes.filter((mailbox) => mailbox.agentId === agentId);
    if (own.length === 0)
      return { message: "You have no mail address. The owner adds one in Secrets, under Agent mailboxes." };
    if (!this.#state.workerUrl || !this.#state.secretCiphertext)
      return { message: "Mail cannot leave yet: the owner has not linked the mail Worker in Secrets. Tell the owner." };
    let mailbox: StoredMailbox;
    let thread: StoredThread | null = null;
    let to: string;
    let subject: string;
    if (call.tool === "email_reply") {
      const found = this.#state.threads.find((item) => item.id === call.input.threadId);
      const owner = found ? own.find((item) => item.id === found.mailboxId) : undefined;
      if (!found || !owner)
        return {
          message: `No mail thread ${call.input.threadId} reached your address. Use the threadId from the mail note.`,
        };
      mailbox = owner;
      thread = found;
      to = found.peer;
      subject = replySubject(found.subject);
    } else {
      const writers = own.filter((item) => item.mode === "write-first");
      const from = call.input.from ? normalizeMailAddress(call.input.from) : null;
      const chosen = from ? writers.find((item) => item.address === from) : writers[0];
      if (!chosen)
        return {
          message: `None of your addresses (${own.map((item) => item.address).join(", ")}) may write first: the owner set them to reply only. Answer mail with email_reply instead.`,
        };
      const recipient = normalizeMailAddress(call.input.to);
      if (!recipient) return { message: `${call.input.to} is not a mail address.` };
      if (this.#state.mailboxes.some((item) => item.address === recipient))
        return { message: "That is an Atelier mailbox: message the agent with send_message instead." };
      if (this.#contact(chosen.id, recipient)?.optedOutAt)
        return { message: `${recipient} asked for no more mail. Do not write to them.` };
      mailbox = chosen;
      to = recipient;
      subject = call.input.subject.replace(/[\r\n]+/gu, " ").trim();
    }
    const now = this.#now();
    const mine = this.#state.sends.filter((send) => send.agentId === agentId);
    if (mine.filter((send) => send.at > now - HOUR_MS).length >= AGENT_MAIL_RATE.perHour)
      return { message: `You sent ${AGENT_MAIL_RATE.perHour} mails in the last hour, the limit. Send the rest later.` };
    if (mine.filter((send) => send.at > now - DAY_MS).length >= AGENT_MAIL_RATE.perDay)
      return { message: `You sent ${AGENT_MAIL_RATE.perDay} mails today, the limit. Send the rest tomorrow.` };
    const firstContact =
      call.tool === "email_send" &&
      !this.#state.threads.some((item) => item.mailboxId === mailbox.id && item.peer === to);
    if (
      firstContact &&
      mine.filter((send) => send.firstContact && send.at > now - DAY_MS).length >= AGENT_MAIL_RATE.firstContactsPerDay
    )
      return {
        message: `You wrote first to ${AGENT_MAIL_RATE.firstContactsPerDay} new people today, the limit. Write to the rest tomorrow.`,
      };
    const needsApproval = !this.#contact(mailbox.id, to)?.approvedAt;
    return { plan: { from: mailbox.address, to, subject, needsApproval }, mailbox, thread, firstContact };
  }

  async #send(
    agentId: string,
    call: MailToolCall,
    options: { approved: boolean; key: string },
  ): Promise<{ ok: true; result: Record<string, string> } | { ok: false; message: string }> {
    const done = this.#state.sends.find((send) => send.key === options.key && send.agentId === agentId);
    if (done) return { ok: true, result: done.result };
    const resolved = this.#resolve(agentId, call);
    if ("message" in resolved) return { ok: false, message: resolved.message };
    const { plan, mailbox, thread, firstContact } = resolved;
    if (plan.needsApproval && !options.approved)
      return { ok: false, message: `The first mail to ${plan.to} needs the owner's OK.` };
    const secret = this.#secret();
    const workerUrl = this.#state.workerUrl;
    if (!secret || !workerUrl) return { ok: false, message: "Mail cannot leave yet. Tell the owner." };
    const agentName = this.#hooks.agent(agentId)?.name ?? "";
    const outbound: OutboundMail = {
      version: AGENT_MAIL_VERSION,
      from: {
        address: mailbox.address,
        name: (mailbox.displayName || agentName).slice(0, AGENT_MAIL_LIMITS.name) || null,
      },
      to: plan.to,
      subject: plan.subject.slice(0, AGENT_MAIL_LIMITS.subject),
      text: `${call.input.text.trim()}${firstContact ? `\n${optOutFooter()}` : ""}`.slice(
        0,
        AGENT_MAIL_LIMITS.sendText,
      ),
      inReplyTo: thread?.lastInboundId ?? null,
      references: thread?.references ?? [],
      listUnsubscribe: firstContact ? `<mailto:${mailbox.address}?subject=unsubscribe>` : null,
    };
    const body = JSON.stringify(outbound);
    let response: Response;
    try {
      response = await this.#fetch(`${workerUrl}${AGENT_MAIL_SEND_PATH}`, {
        method: "POST",
        headers: { "content-type": "application/json", ...(await signAgentMail(secret, `send_${randomUUID()}`, body)) },
        body,
        signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
      });
    } catch (error) {
      logger.warn("The mail Worker did not answer.", toLogValue(error));
      return { ok: false, message: "The mail Worker did not answer. The mail was not sent; try again later." };
    }
    const { messageId, error: code } = await workerAnswer(response);
    if (!response.ok) {
      const domain = mailbox.address.split("@")[1] ?? "";
      const why =
        response.status === 401
          ? "the Worker refused the host's signature: the mail secret in the Worker and in Atelier differ"
          : response.status === 403
            ? `the Worker does not send for ${domain}: add it to SENDER_DOMAINS`
            : `Cloudflare refused it (${code || response.status}); Email Sending may not be set up for ${domain}`;
      return { ok: false, message: `The mail was not sent: ${why}. Tell the owner.` };
    }
    const now = this.#now();
    const nextThread: StoredThread = thread
      ? {
          ...thread,
          messageIds: messageId ? [...thread.messageIds, messageId].slice(-THREAD_IDS_LIMIT) : thread.messageIds,
          updatedAt: now,
        }
      : {
          id: `mt_${randomBytes(9).toString("base64url")}`,
          mailboxId: mailbox.id,
          peer: plan.to,
          subject: plan.subject,
          messageIds: messageId ? [messageId] : [],
          lastInboundId: null,
          references: [],
          updatedAt: now,
        };
    const result: Record<string, string> = {
      status: "sent",
      to: plan.to,
      subject: plan.subject,
      threadId: nextThread.id,
      ...(messageId ? { messageId } : {}),
    };
    this.#state = {
      ...this.#state,
      threads: [...this.#state.threads.filter((item) => item.id !== nextThread.id), nextThread].slice(-THREADS_LIMIT),
      contacts: options.approved ? this.#withContact(mailbox.id, plan.to, { approvedAt: now }) : this.#state.contacts,
      sends: [
        ...this.#state.sends.filter((send) => send.at > now - DAY_MS),
        { key: options.key, agentId, mailboxId: mailbox.id, at: now, firstContact, result },
      ],
    };
    await this.#save();
    return { ok: true, result };
  }

  // --- File ---

  #save(): Promise<void> {
    const snapshot = this.#state;
    this.#writing = this.#writing
      .catch(() => undefined)
      .then(() => Effect.runPromise(writeJsonFileAtomically(this.#file, snapshot, { createDirectory: true })));
    return this.#writing.catch((error: unknown) => {
      logger.warn("The mailbox file was not saved.", toLogValue(error));
    });
  }

  #read(): StoredFile {
    const fresh = (): StoredFile => ({
      version: 1,
      routeId: `mail_${randomBytes(18).toString("base64url")}`,
      secretCiphertext: null,
      workerUrl: null,
      lastMailAt: null,
      lastStatus: null,
      mailboxes: [],
      threads: [],
      contacts: [],
      sends: [],
      seen: [],
    });
    try {
      return parseStoredJson(this.#file, readFileSync(this.#file, "utf8"), decodeFile) ?? fresh();
    } catch (error) {
      const state = fresh();
      if (!isMissingFileError(error)) {
        // An unreadable file is kept for the operator; nothing is written over it until a change.
        logger.warn("The mailbox file could not be read.", toLogValue(error));
        return state;
      }
      // The route id must stay the same across restarts, so a fresh one is saved at once.
      Effect.runFork(
        writeJsonFileAtomically(this.#file, state, { createDirectory: true }).pipe(Effect.catch(() => Effect.void)),
      );
      return state;
    }
  }
}
