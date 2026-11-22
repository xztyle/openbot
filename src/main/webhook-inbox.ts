import { readFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { isDynamicRecord, isNumber, isOneOf, isString } from "@openbot/contracts/runtime-values";
import {
  WEBHOOK_DELIVERY_ID_HEADER,
  WEBHOOK_SIGNATURE_HEADER,
  WEBHOOK_TIMESTAMP_HEADER,
} from "@openbot/contracts/signal-protocol/webhook-route";
import { sourceText } from "@openbot/i18n/source";
import { createOpenBotLogger, registerSecretValue, toLogValue } from "@openbot/logging";
import { Effect } from "effect";
import { parseStoredJson, writeJsonFileAtomically } from "../backend/atomic-json-file";
import { runCauseEffect } from "../backend/effect-boundary";
import { isMissingFileError } from "../backend/file-errors";
import type { HostEventsService } from "./host-events-service";
import { readBodyWithin } from "./http-body";
import type { SecretCipher } from "./provider-credential-store";
import { verifyInboxScheme, WEBHOOK_INBOX_SCHEMES, type WebhookInboxScheme } from "./webhook-inbox-schemes";

const logger = createOpenBotLogger("webhook-inbox");

/** Stripe and Hotmart events are larger than Atelier's own; the routine still bounds what the agent reads. */
const BODY_LIMIT_BYTES = 256 * 1024;
export const WEBHOOK_INBOX_SECRET_LIMIT = 512;
const HOOK_PATH = /^\/hooks\/([A-Za-z0-9_-]{1,128})\/?$/u;
/** A result is written at most this often for one inbox, so a burst does not rewrite the file each time. */
const RESULT_WRITE_MS = 30_000;

/** How one webhook routine takes events from a business system directly, without the relay. */
interface StoredInbox {
  routeId: string;
  scheme: WebhookInboxScheme;
  /** The sender's secret (Stripe's signing secret, Hotmart's hottok, the WebSub secret), encrypted, in base64. */
  secretCiphertext: string | null;
  lastEventAt: number | null;
  lastStatus: number | null;
}

interface StoredFile {
  version: 1;
  inboxes: StoredInbox[];
}

export interface WebhookInboxState {
  routeId: string;
  scheme: WebhookInboxScheme;
  hasSecret: boolean;
  lastEventAt: number | null;
  lastStatus: number | null;
}

function storedInbox(value: unknown): StoredInbox | null {
  if (!isDynamicRecord(value) || !isString(value.routeId) || !isOneOf(WEBHOOK_INBOX_SCHEMES, value.scheme)) return null;
  return {
    routeId: value.routeId,
    scheme: value.scheme,
    secretCiphertext: isString(value.secretCiphertext) ? value.secretCiphertext : null,
    lastEventAt: isNumber(value.lastEventAt) ? value.lastEventAt : null,
    lastStatus: isNumber(value.lastStatus) ? value.lastStatus : null,
  };
}

export class WebhookInboxSecretMissing extends Error {
  constructor() {
    super(sourceText("error.team.webhookInboxSecretMissing"));
  }
}

export class WebhookInboxGone extends Error {
  constructor() {
    super(sourceText("error.team.webhookInboxGone"));
  }
}

/**
 * Webhook inboxes: the public `/hooks/<route id>` address of a webhook routine on the connector
 * gateway. A business system posts to it with its own signature, which the relay cannot pass: Stripe's
 * `Stripe-Signature`, Hotmart's hottok, YouTube's WebSub `X-Hub-Signature`. Atelier's own scheme works
 * too, with the routine's secret. A verified event starts the routine like a relayed one, so its event
 * type, filters, receipts, quiet runs and hourly limit apply, and the agent reads the event as data.
 */
export class WebhookInbox {
  readonly #file: string;
  readonly #cipher: SecretCipher;
  readonly #events: Pick<HostEventsService, "receive" | "receiveVerified" | "inboxRoutes">;
  readonly #now: () => number;
  #inboxes: StoredInbox[];

  constructor(options: {
    file: string;
    cipher: SecretCipher;
    events: Pick<HostEventsService, "receive" | "receiveVerified" | "inboxRoutes">;
    now?: () => number;
  }) {
    this.#file = options.file;
    this.#cipher = options.cipher;
    this.#events = options.events;
    this.#now = options.now ?? Date.now;
    this.#inboxes = this.#read();
  }

  /** The setting of each webhook routine. A routine with none takes Atelier's own scheme. */
  list(): WebhookInboxState[] {
    return this.#events.inboxRoutes().map(({ routeId }) => {
      const inbox = this.#inboxes.find((item) => item.routeId === routeId);
      return {
        routeId,
        scheme: inbox?.scheme ?? "openbot",
        hasSecret: Boolean(inbox?.secretCiphertext),
        lastEventAt: inbox?.lastEventAt ?? null,
        lastStatus: inbox?.lastStatus ?? null,
      };
    });
  }

  /** Sets who sends to a routine. A new secret replaces the old one; no secret keeps the saved one. */
  readonly configure = Effect.fn("WebhookInbox.configure")(function* (
    this: WebhookInbox,
    input: { routeId: string; scheme: WebhookInboxScheme; secret?: string },
  ) {
    if (!this.#events.inboxRoutes().some((route) => route.routeId === input.routeId))
      return yield* Effect.fail(new WebhookInboxGone());
    const existing = this.#inboxes.find((item) => item.routeId === input.routeId);
    const secret = input.secret?.trim();
    let secretCiphertext = existing?.scheme === input.scheme ? (existing.secretCiphertext ?? null) : null;
    if (secret) {
      registerSecretValue(secret);
      secretCiphertext = this.#cipher.encrypt(secret).toString("base64");
    }
    if (input.scheme !== "openbot" && !secretCiphertext) return yield* Effect.fail(new WebhookInboxSecretMissing());
    const next: StoredInbox = {
      routeId: input.routeId,
      scheme: input.scheme,
      secretCiphertext: input.scheme === "openbot" ? null : secretCiphertext,
      lastEventAt: existing?.lastEventAt ?? null,
      lastStatus: existing?.lastStatus ?? null,
    };
    yield* this.#write([...this.#inboxes.filter((item) => item.routeId !== input.routeId), next]);
  }).bind(this);

  /** Answers one request under `/hooks/`. */
  async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? "/", "http://localhost");
    const routeId = HOOK_PATH.exec(url.pathname)?.[1];
    const routes = this.#events.inboxRoutes();
    if (!routeId || !routes.some((route) => route.routeId === routeId)) return answer(response, 404);
    const inbox = this.#inboxes.find((item) => item.routeId === routeId);
    const scheme = inbox?.scheme ?? "openbot";
    // WebSub checks a new subscription with a GET that the endpoint answers with the challenge.
    if (request.method === "GET" && scheme === "youtube") {
      const challenge = url.searchParams.get("hub.challenge");
      const topic = url.searchParams.get("hub.topic") ?? "";
      if (!challenge || !/^https:\/\/www\.youtube\.com\/xml\/feeds\/videos\.xml\?channel_id=/u.test(topic))
        return answer(response, 404);
      response.writeHead(200, { "content-type": "text/plain" });
      response.end(challenge.slice(0, 512));
      return;
    }
    if (request.method !== "POST") return answer(response, 405);
    const body = await readBodyWithin(request, BODY_LIMIT_BYTES);
    if (body === null) return answer(response, 413);
    const status = await this.#receive(routeId, scheme, inbox, request, body).catch((error: unknown) => {
      logger.warn("A webhook inbox request failed.", toLogValue(error));
      return 503;
    });
    this.#noteResult(routeId, status);
    answer(response, status);
  }

  async #receive(
    routeId: string,
    scheme: WebhookInboxScheme,
    inbox: StoredInbox | undefined,
    request: IncomingMessage,
    body: Buffer,
  ): Promise<number> {
    if (scheme === "openbot") {
      const value = (name: string) => {
        const raw = request.headers[name];
        return (Array.isArray(raw) ? raw[0] : raw) ?? "";
      };
      const { status } = await runCauseEffect(
        this.#events.receive({
          routeId,
          timestamp: value(WEBHOOK_TIMESTAMP_HEADER),
          deliveryId: value(WEBHOOK_DELIVERY_ID_HEADER),
          signature: value(WEBHOOK_SIGNATURE_HEADER),
          body: new Uint8Array(body),
        }),
      );
      return status;
    }
    if (!inbox?.secretCiphertext) return 503;
    const secret = this.#cipher.decrypt(Buffer.from(inbox.secretCiphertext, "base64"));
    registerSecretValue(secret);
    const verified = verifyInboxScheme(scheme, secret, { headers: request.headers, body, nowMs: this.#now() });
    if (!verified.ok) return verified.status;
    const { status } = await runCauseEffect(this.#events.receiveVerified(routeId, verified.event));
    return status;
  }

  #noteResult(routeId: string, status: number): void {
    const inbox = this.#inboxes.find((item) => item.routeId === routeId);
    const now = this.#now();
    if (inbox && inbox.lastStatus === status && inbox.lastEventAt !== null && now - inbox.lastEventAt < RESULT_WRITE_MS)
      return;
    const next: StoredInbox = {
      ...(inbox ?? { routeId, scheme: "openbot", secretCiphertext: null }),
      lastEventAt: now,
      lastStatus: status,
    };
    Effect.runFork(
      this.#write([...this.#inboxes.filter((item) => item.routeId !== routeId), next]).pipe(
        Effect.catch((error) =>
          Effect.sync(() => logger.warn("A webhook inbox result was not saved.", toLogValue(error))),
        ),
      ),
    );
  }

  #write(inboxes: StoredInbox[]) {
    // Inboxes of routines that are gone go with the next write.
    const live = new Set(this.#events.inboxRoutes().map((route) => route.routeId));
    const kept = inboxes.filter((item) => live.has(item.routeId));
    return writeJsonFileAtomically<StoredFile>(
      this.#file,
      { version: 1, inboxes: kept },
      { createDirectory: true },
    ).pipe(Effect.tap(() => Effect.sync(() => (this.#inboxes = kept))));
  }

  #read(): StoredInbox[] {
    try {
      return parseStoredJson(this.#file, readFileSync(this.#file, "utf8"), (value) =>
        isDynamicRecord(value) && Array.isArray(value.inboxes)
          ? value.inboxes.map(storedInbox).filter((item): item is StoredInbox => item !== null)
          : [],
      );
    } catch (error) {
      if (!isMissingFileError(error)) logger.warn("The webhook inbox file could not be read.", toLogValue(error));
      return [];
    }
  }
}

function answer(response: ServerResponse, status: number): void {
  response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  response.end(JSON.stringify({ status }));
}
