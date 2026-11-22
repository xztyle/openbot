#!/usr/bin/env node
// hotmart: a helper for the Hotmart Developers API, for OpenBot agents.
// It has no dependencies and runs on Node.js 18 or later. Every answer is JSON on standard output.
// Errors are JSON on standard error. The three credentials are read from files and are never printed.
// Changes that move money or change a buyer's access need --approved, and every change goes to an
// audit log. Run `node hotmart.mjs help` for the commands. The openbot-hotmart skill explains the use.
import { createHash } from "node:crypto";
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, userInfo } from "node:os";
import { join, sep } from "node:path";
import { pathToFileURL } from "node:url";

// Sources: developers.hotmart.com/docs/en/start/app-auth/ (token), /start/sandbox/ (sandbox base),
// /start/rate-limit/ (500 calls a minute, RateLimit-* headers), /start/pagination/ (page_token).
// Affiliate reads: /v1/sales/sales-history/, /v1/sales/sales-commissions/ and /v1/sales/sales-users/ take
// commission_as (PRODUCER, COPRODUCER or AFFILIATE: how the credential's user earned on the sale);
// /v1/sales/sales-summary/ does not. The v1 reference has no endpoint for affiliations or affiliation
// requests, and /v1/product/product-list/ lists only the creator's own products.
const OFFICIAL_API_BASE_URL = "https://developers.hotmart.com";
const SANDBOX_API_BASE_URL = "https://sandbox.hotmart.com";
const OFFICIAL_AUTH_BASE_URL = "https://api-sec-vlc.hotmart.com";
const TOKEN_PATH = "/security/oauth/token";
const REQUEST_TIMEOUT_MS = 60_000;
const PAGE_SIZE = 500;
const MAX_LIST_ITEMS = 10_000;
// A cached access token is used only while it has at least this much time left.
const TOKEN_MARGIN_MS = 5 * 60 * 1000;
// `accession_date` defaults to 30 days ago in Hotmart. This start date asks for every subscription.
const ALL_SUBSCRIPTIONS_SINCE = Date.UTC(2010, 0, 1);
const EXIT = { ok: 0, error: 1, usage: 2, refused: 3, rateLimited: 4 };

// The sale statuses of /payments/api/v1/sales/history (transaction_status).
const SALE_STATUSES = [
  "APPROVED",
  "BLOCKED",
  "CANCELLED",
  "CHARGEBACK",
  "COMPLETE",
  "EXPIRED",
  "NO_FUNDS",
  "OVERDUE",
  "PARTIALLY_REFUNDED",
  "PRE_ORDER",
  "PRINTED_BILLET",
  "PROCESSING_TRANSACTION",
  "PROTESTED",
  "REFUNDED",
  "STARTED",
  "UNDER_ANALISYS",
  "WAITING_PAYMENT",
];
const STATUS_GROUPS = {
  paid: ["APPROVED", "COMPLETE"],
  refunds: ["REFUNDED", "PARTIALLY_REFUNDED", "CHARGEBACK", "PROTESTED"],
  all: SALE_STATUSES,
};
const PAID = new Set(STATUS_GROUPS.paid);
const LOST = new Set(["REFUNDED", "PARTIALLY_REFUNDED", "CHARGEBACK"]);
const SUBSCRIPTION_STATUSES = [
  "ACTIVE",
  "INACTIVE",
  "DELAYED",
  "CANCELLED_BY_CUSTOMER",
  "CANCELLED_BY_SELLER",
  "CANCELLED_BY_ADMIN",
  "STARTED",
  "OVERDUE",
];
// Hotmart gives the buyer's country as a name. Meta wants the two-letter ISO code.
const COUNTRY_CODES = {
  brasil: "br",
  brazil: "br",
  portugal: "pt",
  españa: "es",
  espana: "es",
  spain: "es",
  méxico: "mx",
  mexico: "mx",
  colombia: "co",
  argentina: "ar",
  chile: "cl",
  perú: "pe",
  peru: "pe",
  ecuador: "ec",
  uruguay: "uy",
  paraguay: "py",
  bolivia: "bo",
  "estados unidos": "us",
  "united states": "us",
  italia: "it",
  italy: "it",
  france: "fr",
  francia: "fr",
  germany: "de",
  alemania: "de",
  "reino unido": "gb",
  "united kingdom": "gb",
};
const BOOLEAN_FLAGS = new Set([
  "approved",
  "dry-run",
  "raw",
  "help",
  "sandbox",
  "production",
  "full",
  "send-mail",
  "charge",
  "any-status",
  "no-token-cache",
]);

const HELP = `hotmart: the Hotmart Developers API helper for OpenBot agents (JSON output).

Setup and reading
  help                                   This text.
  config show | config set <key> <value> Settings: sandbox (true|false), timezone (for example America/Sao_Paulo)
  whoami                                 The Hotmart user of the credentials.
  products [--status ACTIVE] [--id ID] [--format ONLINE_COURSE]
  sales [--status APPROVED,COMPLETE | paid | refunds | all] [period] [--product ID] [--buyer-email E]
        [--transaction HP...] [--offer CODE] [--payment-type PIX] [--src CODE] [--limit N] [--raw]
                                         Rows and totals per status and currency (value paid by the buyer).
  sale <transaction> [--full]            One sale with its price details, commissions and participants.
  affiliate-stats [--status ...] [period] [--product ID]   Per product, the sales you made as an affiliate:
                                         count, value paid by the buyer, your commission, refunds and chargebacks.
  affiliate-products [--status ...] [period, default --days 365]   The products you sold as an affiliate.
  summary [--status ...] [period] [--product ID]   Your commission totals per currency (Hotmart's numbers).
  commissions [--status ...] [period] [--product ID] [--transaction HP...] [--as PRODUCER]
  price-details [--status ...] [period] [--product ID] [--transaction HP...]
  participants [--status ...] [period] [--product ID] [--transaction HP...] [--buyer-email E] [--full]
  subscriptions [--status ACTIVE,DELAYED] [--product ID] [--plan-id ID] [--subscriber CODE] [--email E]
                [--since D] [--until D] [--cancelled-since D] [--cancelled-until D] [--trial true|false] [--limit N]
  subscription-summary [--product ID] [--subscriber CODE] [--since D] [--until D]
  subscription-purchases <subscriber_code>
  coupons <product_id> [--code CODE]
  capi-event <transaction> [--out FILE] [--event Purchase] [--event-source-url URL] [--any-status]
                                         A Meta Conversions API event for meta-ads capi-send --data @FILE.
  audit [--tail N]                       The last changes from the audit log.

Period (for sales, summary, commissions, price-details, participants)
  --days N (the last N days up to now; the default is 7) | --preset today|yesterday|last_7d|last_30d|this_month|last_month
  | --since 2026-11-01 [--until 2026-11-14]. Calendar days use the timezone setting.

Changes (each needs --approved; add --reason, and --dry-run to see the request first)
  refund <transaction>                   Refunds an APPROVED or COMPLETE sale. Cannot be undone.
  cancel-subscription <subscriber_code>... [--send-mail]
  reactivate-subscription <subscriber_code>... [--charge]   Hotmart asks the subscriber to accept by email.
  create-coupon <product_id> --code CODE --discount 10 [--start ISO] [--end ISO] [--offer-ids a,b] [--affiliate ID]
  delete-coupon <coupon_id>

Common options
  --client-id-file P, --client-secret-file P, --basic-file P   Credential files (default: HOTMART_CLIENT_ID_FILE,
                        HOTMART_CLIENT_SECRET_FILE, HOTMART_BASIC_FILE, or the HOTMART_CLIENT_ID, ... values).
  --sandbox | --production   Overrides the sandbox setting for one command.
  --home DIR            Settings and audit folder (default: HOTMART_HOME, else <OpenBot shared>/hotmart).
  --approved            The person approved this change (or you decided in a hands-off channel).
  --reason TEXT         Why, for the audit log. --actor NAME (or HOTMART_ACTOR) says who.
  --dry-run             Show the request; send nothing.
  --max-wait SECONDS    The longest rate-limit wait before failing (default 120).
  --timezone TZ         Overrides the timezone setting for one command.
  --no-token-cache      Do not read or write the access token cache.

Exit codes: 0 ok, 1 error, 2 usage, 3 refused (needs --approved), 4 rate limited.
`;

class CliError extends Error {
  constructor(message, { exit = EXIT.error, details = undefined } = {}) {
    super(message);
    this.exit = exit;
    this.details = details;
  }
}

class HotmartError extends Error {
  constructor(status, body, { auth = false } = {}) {
    const description = typeof body?.error_description === "string" ? body.error_description : null;
    super(description ?? `Hotmart API HTTP ${status}`);
    this.status = status;
    this.error = typeof body?.error === "string" ? body.error : null;
    this.description = description;
    this.auth = auth;
  }
  get rateLimited() {
    return this.status === 429 || this.error === "too_many_requests";
  }
}

// ---------- arguments ----------

export function parseArgs(argv) {
  const positional = [];
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--") {
      positional.push(...argv.slice(index + 1));
      break;
    }
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }
    const equals = arg.indexOf("=");
    const name = equals > 0 ? arg.slice(2, equals) : arg.slice(2);
    if (equals > 0) options[name] = arg.slice(equals + 1);
    else if (BOOLEAN_FLAGS.has(name)) options[name] = true;
    else {
      const value = argv[index + 1];
      if (value === undefined) throw new CliError(`--${name} needs a value.`, { exit: EXIT.usage });
      options[name] = value;
      index += 1;
    }
  }
  return { positional, options };
}

function requireOption(options, name, hint = "") {
  const value = options[name];
  if (value === undefined || value === true || String(value).trim() === "")
    throw new CliError(`--${name} is required.${hint ? ` ${hint}` : ""}`, { exit: EXIT.usage });
  return String(value).trim();
}

function list(value) {
  if (value === undefined || value === true) return [];
  return String(value)
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
}

function numericId(value, name) {
  const text = String(value ?? "").trim();
  if (!/^[0-9]{1,20}$/.test(text)) throw new CliError(`${name} must be a numeric Hotmart ID.`, { exit: EXIT.usage });
  return text;
}

function transactionCode(value) {
  const text = String(value ?? "").trim();
  if (!/^[A-Za-z0-9]{4,40}$/.test(text))
    throw new CliError("The transaction must be a Hotmart transaction code like HP17715690036014.", {
      exit: EXIT.usage,
    });
  return text;
}

function subscriberCode(value) {
  const text = String(value ?? "").trim();
  if (!/^[A-Za-z0-9]{2,40}$/.test(text))
    throw new CliError("The subscriber code must be letters and digits, like 9W2LNSG2.", { exit: EXIT.usage });
  return text;
}

/** The statuses that a command asks for: a list, a group (paid, refunds, all), or the default. */
export function saleStatuses(value, fallback = STATUS_GROUPS.paid) {
  const parts = list(value).map((part) => part.toUpperCase());
  if (parts.length === 0) return [...fallback];
  const statuses = new Set();
  for (const part of parts) {
    const group = STATUS_GROUPS[part.toLowerCase()];
    if (group) for (const status of group) statuses.add(status);
    else if (SALE_STATUSES.includes(part)) statuses.add(part);
    else
      throw new CliError(`Unknown sale status ${part}. Use paid, refunds, all, or: ${SALE_STATUSES.join(", ")}.`, {
        exit: EXIT.usage,
      });
  }
  return [...statuses];
}

// ---------- time ----------

function checkTimezone(timezone) {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone });
    return timezone;
  } catch {
    throw new CliError(`Unknown timezone ${timezone}. Use an IANA name such as America/Sao_Paulo.`, {
      exit: EXIT.usage,
    });
  }
}

function zonedParts(milliseconds, timezone) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date(milliseconds));
  const value = (type) => Number(parts.find((part) => part.type === type)?.value);
  return {
    year: value("year"),
    month: value("month"),
    day: value("day"),
    hour: value("hour"),
    minute: value("minute"),
    second: value("second"),
  };
}

function zoneOffset(milliseconds, timezone) {
  const part = zonedParts(milliseconds, timezone);
  const local = Date.UTC(part.year, part.month - 1, part.day, part.hour, part.minute, part.second);
  return local - Math.floor(milliseconds / 1000) * 1000;
}

/** The instant of local midnight on a calendar day in the timezone. Day numbers may overflow. */
export function zonedMidnight(year, month, day, timezone) {
  const guess = Date.UTC(year, month - 1, day);
  const first = guess - zoneOffset(guess, timezone);
  const second = guess - zoneOffset(first, timezone);
  return second;
}

/** The period of a read as epoch milliseconds, from --days, --preset or --since/--until. */
export function resolvePeriod(options, timezone, now = Date.now(), defaultDays = 7) {
  const today = zonedParts(now, timezone);
  const day = (offset) => zonedMidnight(today.year, today.month, today.day + offset, timezone);
  const parseDay = (value, end) => {
    const text = String(value).trim();
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
    if (match) {
      const [year, month, date] = [Number(match[1]), Number(match[2]), Number(match[3])];
      return end ? zonedMidnight(year, month, date + 1, timezone) - 1 : zonedMidnight(year, month, date, timezone);
    }
    const parsed = Date.parse(text);
    if (!Number.isFinite(parsed))
      throw new CliError(`${end ? "--until" : "--since"} must be a date like 2026-11-01 or an ISO time.`, {
        exit: EXIT.usage,
      });
    return parsed;
  };
  let start;
  let end;
  let label;
  if (options.since !== undefined) {
    start = parseDay(options.since, false);
    end = options.until !== undefined ? parseDay(options.until, true) : now;
    label = "custom";
  } else if (options.preset !== undefined) {
    label = String(options.preset);
    const presets = {
      today: () => [day(0), now],
      yesterday: () => [day(-1), day(0) - 1],
      last_7d: () => [day(-7), day(0) - 1],
      last_30d: () => [day(-30), day(0) - 1],
      this_month: () => [zonedMidnight(today.year, today.month, 1, timezone), now],
      last_month: () => [
        zonedMidnight(today.year, today.month - 1, 1, timezone),
        zonedMidnight(today.year, today.month, 1, timezone) - 1,
      ],
    };
    if (!presets[label])
      throw new CliError("--preset must be today, yesterday, last_7d, last_30d, this_month or last_month.", {
        exit: EXIT.usage,
      });
    [start, end] = presets[label]();
  } else {
    const days = options.days === undefined ? defaultDays : Number(options.days);
    if (!Number.isFinite(days) || days <= 0 || days > 3660)
      throw new CliError("--days must be a number from 1 to 3660.", { exit: EXIT.usage });
    start = now - Math.round(days * 86_400_000);
    end = now;
    label = `last ${days} days`;
  }
  if (start > end) throw new CliError("The period starts after it ends.", { exit: EXIT.usage });
  return { start, end, label, timezone, from: new Date(start).toISOString(), to: new Date(end).toISOString() };
}

/** Hotmart dates are epoch milliseconds; some subscription samples show seconds. Text dates stay. */
export function isoTime(value) {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value === "string" && !/^\d+$/.test(value)) return value;
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  return new Date(number < 1e11 ? number * 1000 : number).toISOString();
}

function epochMilliseconds(value) {
  if (value === undefined || value === null || value === "") return null;
  const number = Number(value);
  if (Number.isFinite(number)) return number < 1e11 ? number * 1000 : number;
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? parsed : null;
}

function dateOption(options, name) {
  if (options[name] === undefined) return undefined;
  const text = String(options[name]).trim();
  const parsed = /^\d{4}-\d{2}-\d{2}$/.test(text) ? Date.parse(`${text}T00:00:00Z`) : Date.parse(text);
  if (!Number.isFinite(parsed))
    throw new CliError(`--${name} must be a date like 2026-11-01 or an ISO time.`, { exit: EXIT.usage });
  return parsed;
}

// ---------- settings, credentials and audit ----------

/**
 * The shared folder of the space of the agent that runs this helper, and whether it is General's, or null. OpenBot keeps one shared
 * folder per space; an agent runs its commands in its workspace, `OpenBot/Agents/<agent id>`, and
 * `OpenBot/Spaces/index.json` names the shared folder of each agent's space.
 */
function spaceSharedFolder() {
  const parts = process.cwd().split(sep);
  const agents = parts.lastIndexOf("Agents");
  if (agents > 0 && parts[agents + 1]) {
    try {
      const index = JSON.parse(
        readFileSync(join(parts.slice(0, agents).join(sep) || sep, "Spaces", "index.json"), "utf8"),
      );
      const folder = index?.agents?.[parts[agents + 1]] ?? index?.general;
      if (typeof folder === "string" && folder) return { folder, general: folder === index?.general };
    } catch {
      // No index: an OpenBot before spaces.
    }
  }
  const spaces = parts.lastIndexOf("Spaces");
  if (spaces > 0 && parts[spaces + 2] === "Shared")
    return { folder: parts.slice(0, spaces + 3).join(sep), general: parts[spaces + 1] === "general" };
  return null;
}

function defaultHome() {
  if (process.env.HOTMART_HOME) return process.env.HOTMART_HOME;
  // The old global shared folder: the server image keeps it here; on a computer it is ~/OpenBot/Shared.
  const legacy = existsSync("/data/OpenBot/Shared")
    ? "/data/OpenBot/Shared/hotmart"
    : join(homedir(), "OpenBot", "Shared", "hotmart");
  const space = spaceSharedFolder();
  if (!space) return legacy;
  const own = join(space.folder, "hotmart");
  // An agent of General keeps the settings of the old folder until they are moved into General's.
  return space.general && !existsSync(own) && existsSync(legacy) ? legacy : own;
}

const DEFAULT_SETTINGS = { sandbox: false, timezone: "" };

function loadSettings(home) {
  const path = join(home, "settings.json");
  if (!existsSync(path)) return structuredClone(DEFAULT_SETTINGS);
  try {
    return { ...DEFAULT_SETTINGS, ...JSON.parse(readFileSync(path, "utf8")) };
  } catch {
    throw new CliError(`The settings file ${path} is not valid JSON. Fix it or remove it.`);
  }
}

function writePrivate(path, text) {
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, text, { mode: 0o600 });
  renameSync(temporary, path);
}

function saveSettings(home, settings) {
  mkdirSync(home, { recursive: true });
  writePrivate(join(home, "settings.json"), `${JSON.stringify(settings, null, 2)}\n`);
}

function readSecretFile(path, name) {
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    throw new CliError(`Cannot read the ${name} file. Check the path from openbot.list_api_keys.`);
  }
  return text.trim();
}

function readSecret(options, flag, name) {
  const file = options[flag] ?? process.env[`${name}_FILE`];
  const value = file ? readSecretFile(String(file), name) : (process.env[name] ?? "").trim();
  if (!value)
    throw new CliError(
      `No ${name}. Set ${name}_FILE to the path of the shared key ${name} (openbot.list_api_keys), or pass --${flag}.`,
    );
  return value;
}

/** The three credentials of Hotmart → Tools → Developer Credentials. The Basic value may keep its "Basic " prefix. */
export function readCredentials(options) {
  const names = [
    ["client-id-file", "HOTMART_CLIENT_ID"],
    ["client-secret-file", "HOTMART_CLIENT_SECRET"],
    ["basic-file", "HOTMART_BASIC"],
  ];
  const missing = names
    .filter(([flag, name]) => !options[flag] && !process.env[`${name}_FILE`] && !(process.env[name] ?? "").trim())
    .map(([, name]) => name);
  if (missing.length > 0)
    throw new CliError(
      `No ${missing.join(", ")}. Set ${missing.map((name) => `${name}_FILE`).join(", ")} to the paths of the shared keys (openbot.list_api_keys).`,
      { details: { needs: missing.map((name) => `credential ${name} (save with openbot.request_api_key, shared)`) } },
    );
  const clientId = readSecret(options, "client-id-file", "HOTMART_CLIENT_ID");
  const clientSecret = readSecret(options, "client-secret-file", "HOTMART_CLIENT_SECRET");
  const basic = readSecret(options, "basic-file", "HOTMART_BASIC").replace(/^Basic\s+/i, "");
  for (const [name, value] of [
    ["HOTMART_CLIENT_ID", clientId],
    ["HOTMART_CLIENT_SECRET", clientSecret],
    ["HOTMART_BASIC", basic],
  ])
    if (/\s/.test(value)) throw new CliError(`${name} must hold one value with no spaces.`);
  return { clientId, clientSecret, basic };
}

function auditPath(home) {
  return join(home, "audit.jsonl");
}

function appendAudit(home, entry) {
  mkdirSync(home, { recursive: true });
  appendFileSync(auditPath(home), `${JSON.stringify({ time: new Date().toISOString(), ...entry })}\n`);
}

function readAudit(home) {
  const path = auditPath(home);
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line)];
      } catch {
        return [];
      }
    });
}

// ---------- Hotmart client ----------

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

/** An origin from an environment override: https, or http on this computer for tests. */
function baseOverride(name) {
  const override = process.env[name];
  if (!override) return null;
  let url;
  try {
    url = new URL(override);
  } catch {
    throw new CliError(`${name} is not a valid address.`);
  }
  const local = url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !local) throw new CliError(`${name} must use https.`);
  return url.origin;
}

export function apiBaseUrl(sandbox) {
  return baseOverride("HOTMART_API_BASE_URL") ?? (sandbox ? SANDBOX_API_BASE_URL : OFFICIAL_API_BASE_URL);
}

function authBaseUrl() {
  return baseOverride("HOTMART_AUTH_BASE_URL") ?? OFFICIAL_AUTH_BASE_URL;
}

/** Seconds until the rate limit resets, from Hotmart's RateLimit-Reset header. */
function resetSeconds(headers) {
  const value = Number(headers?.get?.("ratelimit-reset"));
  return Number.isFinite(value) && value >= 0 ? value : null;
}

export class Hotmart {
  constructor({ credentials, sandbox = false, maxWaitSeconds = 120, backoffBaseMs = 2000, cachePath = null }) {
    this.credentials = credentials;
    this.sandbox = sandbox;
    this.base = apiBaseUrl(sandbox);
    this.authBase = authBaseUrl();
    this.maxWaitSeconds = maxWaitSeconds;
    this.backoffBaseMs = backoffBaseMs;
    this.cachePath = cachePath;
    this.waitedSeconds = 0;
    this.accessToken = null;
    this.expiresAt = 0;
    // The cache entry belongs to one credential and one environment, so a new credential never reuses it.
    this.cacheKey = createHash("sha256")
      .update(
        [
          credentials.clientId,
          credentials.clientSecret,
          credentials.basic,
          sandbox ? "sandbox" : "production",
          this.authBase,
        ].join("\n"),
      )
      .digest("hex")
      .slice(0, 32);
  }

  secrets() {
    const { clientId, clientSecret, basic } = this.credentials;
    return [clientId, clientSecret, basic, this.accessToken];
  }

  readCache() {
    if (!this.cachePath || !existsSync(this.cachePath)) return null;
    try {
      const saved = JSON.parse(readFileSync(this.cachePath, "utf8"));
      if (saved?.key !== this.cacheKey || typeof saved.accessToken !== "string") return null;
      if (!(Number(saved.expiresAt) > Date.now() + TOKEN_MARGIN_MS)) return null;
      return saved;
    } catch {
      return null;
    }
  }

  writeCache() {
    if (!this.cachePath) return;
    try {
      writePrivate(
        this.cachePath,
        JSON.stringify({ key: this.cacheKey, accessToken: this.accessToken, expiresAt: this.expiresAt }),
      );
      chmodSync(this.cachePath, 0o600);
    } catch {
      // A cache that cannot be written only costs one more token request next time.
    }
  }

  dropToken() {
    this.accessToken = null;
    this.expiresAt = 0;
    if (this.cachePath) rmSync(this.cachePath, { force: true });
  }

  /** The access token: from memory, then the cache file, then a new client-credentials request. */
  async token() {
    if (this.accessToken && this.expiresAt > Date.now() + TOKEN_MARGIN_MS) return this.accessToken;
    const cached = this.readCache();
    if (cached) {
      this.accessToken = cached.accessToken;
      this.expiresAt = Number(cached.expiresAt);
      return this.accessToken;
    }
    const url = new URL(`${this.authBase}${TOKEN_PATH}`);
    url.searchParams.set("grant_type", "client_credentials");
    url.searchParams.set("client_id", this.credentials.clientId);
    url.searchParams.set("client_secret", this.credentials.clientSecret);
    for (let attempt = 0; ; attempt += 1) {
      let response;
      let text;
      try {
        response = await fetch(url, {
          method: "POST",
          redirect: "error",
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
          headers: {
            Authorization: `Basic ${this.credentials.basic}`,
            "Content-Type": "application/json",
            Accept: "application/json",
          },
        });
        text = await response.text();
      } catch {
        if (attempt < 2) {
          await sleep(this.backoffBaseMs * 2 ** attempt);
          continue;
        }
        throw new CliError("The Hotmart sign-in service did not answer (network error or timeout).");
      }
      let json = null;
      try {
        json = text ? JSON.parse(text) : {};
      } catch {
        json = null;
      }
      if (response.ok && typeof json?.access_token === "string" && json.access_token) {
        this.accessToken = json.access_token;
        const seconds = Number(json.expires_in);
        this.expiresAt = Date.now() + (Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 3600_000);
        this.writeCache();
        return this.accessToken;
      }
      const error = new HotmartError(response.status, json, { auth: true });
      if (error.rateLimited && (await this.#waitForLimit(response.headers, attempt, error))) continue;
      if (response.status >= 500 && attempt < 2) {
        await sleep(this.backoffBaseMs * 2 ** attempt);
        continue;
      }
      throw error;
    }
  }

  /** Waits for a rate limit when the wait fits in --max-wait; answers false when it does not. */
  async #waitForLimit(headers, attempt, error) {
    const wait = Math.max(resetSeconds(headers) ?? 0, (this.backoffBaseMs / 1000) * 2 ** attempt);
    if (attempt >= 5 || this.waitedSeconds + wait > this.maxWaitSeconds)
      throw new CliError(
        `Hotmart rate limit reached (500 calls a minute). Wait ${Math.max(1, Math.ceil(wait / 60))} minute(s), then try again with fewer calls.`,
        { exit: EXIT.rateLimited, details: describeHotmartError(error) },
      );
    this.waitedSeconds += wait;
    await sleep(wait * 1000);
    return true;
  }

  url(path, query = {}) {
    const url = new URL(`${this.base}${path}`);
    if (url.origin !== this.base) throw new CliError("A request address left the Hotmart API host; it was not sent.");
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined || value === null || value === "") continue;
      // A list is sent as the same key again, which the subscriptions endpoint documents for status.
      if (Array.isArray(value)) for (const item of value) url.searchParams.append(key, String(item));
      else url.searchParams.set(key, String(value));
    }
    return url;
  }

  async request(method, path, { query = {}, body = undefined } = {}) {
    const url = this.url(path, query);
    let renewed = false;
    for (let attempt = 0; ; attempt += 1) {
      const token = await this.token();
      let response;
      let text;
      try {
        response = await fetch(url, {
          method,
          body: body === undefined ? undefined : JSON.stringify(body),
          redirect: "error",
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: "application/json",
            "Content-Type": "application/json",
          },
        });
        text = await response.text();
      } catch {
        // A change that timed out may have happened, so only a read is sent again.
        if (method === "GET" && attempt < 2) {
          await sleep(this.backoffBaseMs * 2 ** attempt);
          continue;
        }
        throw new CliError("The Hotmart API did not answer (network error or timeout).");
      }
      let json = null;
      try {
        json = text ? JSON.parse(text) : {};
      } catch {
        json = null;
      }
      if (response.ok && json !== null) {
        await this.#slowDown(response.headers);
        return json;
      }
      const error = new HotmartError(response.status, json);
      // Hotmart answers 401 when the access token expired. It recommends one new token and a retry.
      if (response.status === 401 && !renewed) {
        renewed = true;
        this.dropToken();
        continue;
      }
      if (error.rateLimited && (await this.#waitForLimit(response.headers, attempt, error))) continue;
      // 502 means the query ran longer than 30 seconds: the same query fails again.
      const retryable = method === "GET" && [500, 503, 504].includes(response.status) && attempt < 2;
      if (retryable) {
        await sleep(this.backoffBaseMs * 2 ** attempt);
        continue;
      }
      throw error;
    }
  }

  async #slowDown(headers) {
    // Close to the limit of the minute, wait for the reset so that the next call is not refused.
    const remaining = Number(headers?.get?.("ratelimit-remaining") ?? headers?.get?.("x-ratelimit-remaining-minute"));
    if (!Number.isFinite(remaining) || remaining > 5) return;
    const wait = Math.min(resetSeconds(headers) ?? 5, 60);
    if (this.waitedSeconds + wait > this.maxWaitSeconds) return;
    this.waitedSeconds += wait;
    await sleep(wait * 1000);
  }

  get(path, query) {
    return this.request("GET", path, { query });
  }

  /** Reads every page of a list (items and page_info.next_page_token), up to the limit. */
  async list(path, query = {}, limit = 1000) {
    const max = Math.min(Math.max(1, limit), MAX_LIST_ITEMS);
    const rows = [];
    let pageToken;
    let total = null;
    for (;;) {
      const page = await this.get(path, { ...query, max_results: Math.min(PAGE_SIZE, max), page_token: pageToken });
      const items = Array.isArray(page) ? page : page?.items;
      if (!Array.isArray(items)) throw new CliError("Hotmart sent an unexpected list answer.");
      rows.push(...items);
      if (total === null && Number.isFinite(Number(page?.page_info?.total_results)))
        total = Number(page.page_info.total_results);
      const next = page?.page_info?.next_page_token;
      if (rows.length >= max || typeof next !== "string" || !next || items.length === 0)
        return { data: rows.slice(0, max), truncated: rows.length > max || (rows.length >= max && !!next), total };
      pageToken = next;
    }
  }
}

function describeHotmartError(error) {
  const hints = {
    invalid_token: "The access token is not valid. Run the command again; if it fails, check the three credentials.",
    token_expired: "The access token expired. Run the command again.",
    unauthorized:
      "Hotmart refused the credentials. Check HOTMART_CLIENT_ID, HOTMART_CLIENT_SECRET and HOTMART_BASIC, and that they are for this environment (sandbox or production).",
    unauthorized_client:
      "These credentials may not do this. Check that the credential belongs to the account that owns the product.",
    access_forbidden: "The signed-in Hotmart user may not do this.",
    invalid_parameter: "A parameter is not valid. Read the message, fix the command and try again.",
    invalid_value_parameter: "A filter value is not valid. Check the status names, IDs and dates.",
    not_found: "Hotmart did not find this. Check the ID or code.",
    purchase_not_found: "Hotmart did not find this transaction.",
    subscription_not_found: "Hotmart did not find this subscriber code.",
    product_not_found: "Hotmart did not find this product.",
    invalid_status: "Hotmart refunds only APPROVED or COMPLETE sales.",
    refund_request_time_exceeded: "The refund period of this sale is over.",
    expired_confirmation_time: "The deadline for a refund of this sale is over.",
    refund_request_already_exists: "A refund for this sale was already requested.",
    transaction_refunded: "This sale is already refunded.",
    trial_not_refunded: "A trial purchase cannot be refunded.",
    sepa_direct_debit: "The buyer must ask their bank for the refund (SEPA).",
    bacs_refund: "The buyer must ask their bank for the refund (BACS).",
    too_many_requests: "Hotmart allows 500 calls a minute. Wait a minute and use fewer calls.",
  };
  let hint = hints[error.error] ?? null;
  if (!hint && error.auth) hint = hints.unauthorized;
  if (!hint && error.status === 401) hint = hints.unauthorized;
  if (!hint && error.status === 403) hint = hints.unauthorized_client;
  if (!hint && error.status === 502)
    hint = "The query took longer than 30 seconds at Hotmart. Use a shorter period or add --product.";
  if (!hint && error.status >= 500) hint = "Hotmart had an internal error. Try again later.";
  return {
    status: error.status,
    error: error.error,
    message: error.description ?? error.message,
    during: error.auth ? "sign-in (access token)" : "API request",
    hint,
  };
}

// ---------- rows and totals ----------

function money(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function round(value) {
  return Math.round(value * 100) / 100;
}

/** One sale from /sales/history, flat and with ISO times. */
export function saleRow(item) {
  const purchase = item?.purchase ?? {};
  const payment = purchase.payment ?? {};
  const tracking = purchase.tracking ?? {};
  return {
    transaction: purchase.transaction ?? null,
    status: purchase.status ?? null,
    product_id: item?.product?.id ?? null,
    product_name: item?.product?.name ?? null,
    order_date: isoTime(purchase.order_date),
    approved_date: isoTime(purchase.approved_date),
    value: money(purchase.price?.value),
    currency: purchase.price?.currency_code ?? null,
    payment_type: payment.type ?? null,
    payment_method: payment.method ?? null,
    installments: payment.installments_number ?? null,
    is_subscription: purchase.is_subscription ?? null,
    recurrency_number: purchase.recurrency_number ?? null,
    commission_as: purchase.commission_as ?? null,
    offer_code: purchase.offer?.code ?? null,
    payment_mode: purchase.offer?.payment_mode ?? null,
    src: tracking.source ?? null,
    sck: tracking.source_sck ?? null,
    xcod: tracking.external_code ?? null,
    warranty_expire_date: isoTime(purchase.warranty_expire_date),
    hotmart_fee: money(purchase.hotmart_fee?.total),
    hotmart_fee_currency: purchase.hotmart_fee?.currency_code ?? null,
    buyer_name: item?.buyer?.name ?? null,
    buyer_email: item?.buyer?.email ?? null,
    buyer_ucode: item?.buyer?.ucode ?? null,
  };
}

/** Counts and values per status and currency, and the paid and lost totals per currency. */
export function saleTotals(rows) {
  const byStatus = {};
  const paid = {};
  const lost = {};
  const add = (target, currency, value) => {
    target[currency] ??= { count: 0, value: 0 };
    target[currency].count += 1;
    target[currency].value = round(target[currency].value + value);
  };
  for (const row of rows) {
    const status = row.status ?? "UNKNOWN";
    const currency = row.currency ?? "UNKNOWN";
    const value = row.value ?? 0;
    byStatus[status] ??= { count: 0, by_currency: {} };
    byStatus[status].count += 1;
    add(byStatus[status].by_currency, currency, value);
    if (PAID.has(status)) add(paid, currency, value);
    if (LOST.has(status)) add(lost, currency, value);
  }
  return { count: rows.length, by_status: byStatus, paid_by_currency: paid, refunded_by_currency: lost };
}

function participantRow(entry, full) {
  const user = entry?.user ?? {};
  const address = user.address ?? {};
  return {
    role: entry?.role ?? null,
    ucode: user.ucode ?? null,
    name: user.name ?? null,
    email: user.email ?? null,
    phone: user.phone ?? null,
    cellphone: user.cellphone ?? null,
    locale: user.locale ?? null,
    country: address.country ?? null,
    state: address.state ?? null,
    city: address.city ?? null,
    zip_code: address.zip_code ?? null,
    ...(full ? { trade_name: user.trade_name ?? null, address, documents: user.documents ?? [] } : {}),
  };
}

// ---------- context ----------

class Context {
  constructor(options) {
    this.options = options;
    this.home = String(options.home ?? defaultHome());
    this.settings = loadSettings(this.home);
    this.actor = String(options.actor ?? process.env.HOTMART_ACTOR ?? safeUser());
  }

  get sandbox() {
    if (this.options.sandbox === true) return true;
    if (this.options.production === true) return false;
    return this.settings.sandbox === true;
  }

  get timezone() {
    const zone =
      this.options.timezone || this.settings.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
    return checkTimezone(String(zone));
  }

  get api() {
    if (!this.client) {
      const maxWait = this.options["max-wait"] === undefined ? 120 : Number(this.options["max-wait"]);
      this.client = new Hotmart({
        credentials: readCredentials(this.options),
        sandbox: this.sandbox,
        maxWaitSeconds: Number.isFinite(maxWait) && maxWait >= 0 ? maxWait : 120,
        backoffBaseMs: Number(process.env.HOTMART_BACKOFF_BASE_MS) || 2000,
        cachePath: this.options["no-token-cache"] === true ? null : join(this.home, ".token-cache.json"),
      });
      mkdirSync(this.home, { recursive: true });
    }
    return this.client;
  }

  audit(entry) {
    appendAudit(this.home, {
      actor: this.actor,
      environment: this.sandbox ? "sandbox" : "production",
      reason: this.options.reason ?? null,
      ...entry,
    });
  }
}

function safeUser() {
  try {
    return userInfo().username;
  } catch {
    return "unknown";
  }
}

// ---------- changes ----------

/** Runs one change: refused without --approved, shown with --dry-run, and written to the audit log. */
async function change(context, { action, target, reasons, details = {}, request }) {
  const approved = context.options.approved === true;
  const shown = { method: request.method, path: request.path, body: request.body ?? null };
  if (context.options["dry-run"])
    return { dryRun: true, action, target, details, request: shown, guard: { needsApproval: true, reasons, approved } };
  if (!approved) {
    context.audit({ action, target, details, approved: false, result: "refused", guard: reasons });
    throw new CliError("This change needs the person's approval.", {
      exit: EXIT.refused,
      details: {
        refused: true,
        reasons,
        hint: "Ask the person with openbot.ask_ui (in a hands-off channel decide within their saved rules and call openbot.log_decision), then run the same command with --approved.",
      },
    });
  }
  try {
    const response = await context.api.request(request.method, request.path, { body: request.body });
    context.audit({ action, target, details, approved, guard: reasons, result: "ok", response: summarize(response) });
    return { ok: true, action, target, details, response };
  } catch (error) {
    context.audit({
      action,
      target,
      details,
      approved,
      guard: reasons,
      result: "error",
      error: error instanceof HotmartError ? { status: error.status, error: error.error } : String(error.message),
    });
    throw error;
  }
}

function summarize(response) {
  if (!response || typeof response !== "object" || Array.isArray(response)) return null;
  const keep = {};
  for (const [key, value] of Object.entries(response))
    if ((typeof value !== "object" || value === null) && key !== "subscriber_code") keep[key] = value;
  return keep;
}

// ---------- commands ----------

function salesFilters(context) {
  const { options } = context;
  const query = {};
  if (options.product !== undefined) query.product_id = numericId(options.product, "--product");
  if (options.transaction !== undefined) query.transaction = transactionCode(options.transaction);
  if (options["buyer-email"] !== undefined) query.buyer_email = String(options["buyer-email"]).trim();
  if (options["buyer-name"] !== undefined) query.buyer_name = String(options["buyer-name"]);
  if (options.offer !== undefined) query.offer_code = String(options.offer).trim();
  if (options["payment-type"] !== undefined) query.payment_type = String(options["payment-type"]).toUpperCase();
  if (options.src !== undefined) query.sales_source = String(options.src);
  if (options.as !== undefined) {
    const as = String(options.as).toUpperCase();
    if (!["PRODUCER", "COPRODUCER", "AFFILIATE"].includes(as))
      throw new CliError("--as must be PRODUCER, COPRODUCER or AFFILIATE.", { exit: EXIT.usage });
    query.commission_as = as;
  }
  return query;
}

/**
 * Reads one list endpoint once for each status. Hotmart documents transaction_status as one value,
 * and without it answers only APPROVED and COMPLETE, so every status is its own query.
 */
async function perStatus(context, path, statuses, query, limit) {
  const rows = [];
  let truncated = false;
  for (const status of statuses) {
    const result = await context.api.list(path, { ...query, transaction_status: status }, limit);
    rows.push(...result.data.map((row) => ({ status, row })));
    truncated ||= result.truncated;
  }
  return { rows, truncated };
}

function periodQuery(context, defaultDays = 7) {
  const period = resolvePeriod(context.options, context.timezone, Date.now(), defaultDays);
  return { period, query: { start_date: period.start, end_date: period.end } };
}

/** Reads one sale by its transaction code, in any status. */
async function findSale(context, transaction) {
  const query = { transaction };
  if (context.options.since !== undefined) {
    const { query: dates } = periodQuery(context);
    Object.assign(query, dates);
  }
  const result = await context.api.list("/payments/api/v1/sales/history", query, 20);
  const item = result.data.find((row) => row?.purchase?.transaction === transaction) ?? result.data[0];
  if (!item) throw new CliError(`Hotmart has no sale ${transaction}. Check the code (and --since for an old sale).`);
  return item;
}

/** Meta's country code from Hotmart's country name or code. */
function countryCode(value) {
  const text = String(value ?? "")
    .trim()
    .toLowerCase();
  if (/^[a-z]{2}$/.test(text)) return text;
  return COUNTRY_CODES[text] ?? null;
}

/**
 * The buyer's phone with the country code, as Meta wants it. Hotmart adds the country code only for
 * buyers outside Brazil, so a Brazilian number of 10 or 11 digits gets 55.
 */
function metaPhone(phone, country) {
  const digits = String(phone ?? "").replace(/[^0-9]/g, "");
  if (digits.length < 8) return null;
  if (country === "br" && (digits.length === 10 || digits.length === 11)) return `55${digits}`;
  return digits;
}

const commands = {
  help: async () => ({ help: HELP }),

  async config(context, args) {
    const [sub, key, value] = args;
    const show = () => ({
      home: context.home,
      settings: context.settings,
      environment: context.sandbox ? "sandbox" : "production",
      apiBase: apiBaseUrl(context.sandbox),
      timezone: context.timezone,
      auditLog: auditPath(context.home),
    });
    if (sub === "show" || sub === undefined) return show();
    if (sub !== "set" || !key || value === undefined)
      throw new CliError("Use: config show, or config set <key> <value>.", { exit: EXIT.usage });
    const settings = structuredClone(context.settings);
    if (key === "sandbox") {
      if (value !== "true" && value !== "false")
        throw new CliError("sandbox must be true or false.", { exit: EXIT.usage });
      settings.sandbox = value === "true";
    } else if (key === "timezone") settings.timezone = value === "none" ? "" : checkTimezone(value);
    else throw new CliError(`Unknown setting ${key}. Use sandbox or timezone.`, { exit: EXIT.usage });
    saveSettings(context.home, settings);
    context.settings = settings;
    context.audit({ action: "config", target: key, details: { [key]: value }, approved: true, result: "ok" });
    return show();
  },

  async whoami(context) {
    const me = await context.api.get("/user/api/v1/me");
    return {
      environment: context.sandbox ? "sandbox" : "production",
      id: me?.id ?? null,
      ucode: me?.ucode ?? null,
      name: me?.name ?? null,
      login: me?.login ?? null,
      email: me?.email ?? null,
      currency_code_commission: me?.currency_code_commission ?? null,
      time_zone: me?.time_zone ?? null,
      locale: me?.locale ?? null,
      entity_type: me?.entity_type ?? null,
    };
  },

  async products(context) {
    const { options } = context;
    const query = {};
    if (options.status !== undefined) query.status = String(options.status).toUpperCase();
    if (options.id !== undefined) query.id = numericId(options.id, "--id");
    if (options.format !== undefined) query.format = String(options.format).toUpperCase();
    const result = await context.api.list("/products/api/v1/products", query, Number(options.limit ?? 500));
    return {
      ...result,
      count: result.data.length,
      data: result.data.map((row) => ({ ...row, created_at: isoTime(row?.created_at) })),
    };
  },

  async sales(context) {
    const { options } = context;
    const statuses = saleStatuses(options.status);
    const { period, query } = periodQuery(context);
    const { rows, truncated } = await perStatus(
      context,
      "/payments/api/v1/sales/history",
      statuses,
      { ...query, ...salesFilters(context) },
      Number(options.limit ?? 2000),
    );
    const seen = new Set();
    const sales = [];
    for (const { row } of rows) {
      const sale = saleRow(row);
      const key = `${sale.transaction}:${sale.status}`;
      if (seen.has(key)) continue;
      seen.add(key);
      sales.push(options.raw ? row : sale);
    }
    const flat = options.raw ? sales.map(saleRow) : sales;
    flat.sort((a, b) => String(b.order_date ?? "").localeCompare(String(a.order_date ?? "")));
    return {
      environment: context.sandbox ? "sandbox" : "production",
      period,
      statuses,
      count: sales.length,
      truncated,
      totals: saleTotals(flat),
      data: options.raw ? sales : flat,
    };
  },

  async sale(context, args) {
    const transaction = transactionCode(args[0]);
    const item = await findSale(context, transaction);
    const sale = saleRow(item);
    const query = { transaction };
    const extra = { price: null, commissions: null, participants: null, errors: {} };
    const read = async (name, path, map) => {
      try {
        const result = await context.api.list(path, query, 50);
        extra[name] = map(result.data);
      } catch (error) {
        if (error instanceof CliError && error.exit === EXIT.rateLimited) throw error;
        extra.errors[name] = error instanceof HotmartError ? describeHotmartError(error) : String(error.message);
      }
    };
    await read("price", "/payments/api/v1/sales/price/details", (rows) => rows[0] ?? null);
    await read("commissions", "/payments/api/v1/sales/commissions", (rows) => rows[0]?.commissions ?? []);
    await read("participants", "/payments/api/v1/sales/users", (rows) =>
      (rows[0]?.users ?? []).map((entry) => participantRow(entry, context.options.full === true)),
    );
    if (Object.keys(extra.errors).length === 0) delete extra.errors;
    return { sale, ...extra, raw: context.options.raw ? item : undefined };
  },

  async summary(context) {
    const { options } = context;
    const { period, query } = periodQuery(context);
    const filters = { ...query, ...salesFilters(context) };
    const statuses = options.status === undefined ? [null] : saleStatuses(options.status);
    const results = [];
    for (const status of statuses) {
      const result = await context.api.list(
        "/payments/api/v1/sales/summary",
        status ? { ...filters, transaction_status: status } : filters,
        100,
      );
      results.push({
        status: status ?? "APPROVED,COMPLETE (Hotmart default)",
        by_currency: Object.fromEntries(
          result.data.map((row) => [
            row?.total_value?.currency_code ?? "UNKNOWN",
            { count: Number(row?.total_items) || 0, value: money(row?.total_value?.value) },
          ]),
        ),
      });
    }
    return {
      environment: context.sandbox ? "sandbox" : "production",
      period,
      note: "Commission values of the credential's user, per currency, as Hotmart reports them.",
      data: results,
    };
  },

  async commissions(context) {
    const { options } = context;
    const statuses = saleStatuses(options.status);
    const { period, query } = periodQuery(context);
    const { rows, truncated } = await perStatus(
      context,
      "/payments/api/v1/sales/commissions",
      statuses,
      { ...query, ...salesFilters(context) },
      Number(options.limit ?? 2000),
    );
    const totals = {};
    const data = rows.map(({ status, row }) => {
      for (const entry of Array.isArray(row?.commissions) ? row.commissions : []) {
        const key = `${entry?.source ?? "UNKNOWN"}:${entry?.commission?.currency_value ?? "UNKNOWN"}`;
        totals[key] ??= { count: 0, value: 0 };
        totals[key].count += 1;
        totals[key].value = round(totals[key].value + (money(entry?.commission?.value) ?? 0));
      }
      return { status, ...row };
    });
    return { period, statuses, count: data.length, truncated, totals_by_source_and_currency: totals, data };
  },

  async "price-details"(context) {
    const { options } = context;
    const statuses = saleStatuses(options.status);
    const { period, query } = periodQuery(context);
    const { rows, truncated } = await perStatus(
      context,
      "/payments/api/v1/sales/price/details",
      statuses,
      { ...query, ...salesFilters(context) },
      Number(options.limit ?? 2000),
    );
    return {
      period,
      statuses,
      count: rows.length,
      truncated,
      data: rows.map(({ status, row }) => ({ status, ...row })),
    };
  },

  async participants(context) {
    const { options } = context;
    const statuses = saleStatuses(options.status);
    const { period, query } = periodQuery(context);
    const { rows, truncated } = await perStatus(
      context,
      "/payments/api/v1/sales/users",
      statuses,
      { ...query, ...salesFilters(context) },
      Number(options.limit ?? 2000),
    );
    return {
      period,
      statuses,
      count: rows.length,
      truncated,
      data: rows.map(({ status, row }) => ({
        status,
        transaction: row?.transaction ?? null,
        product: row?.product ?? null,
        users: (row?.users ?? []).map((entry) => participantRow(entry, options.full === true)),
      })),
    };
  },

  async subscriptions(context) {
    const { options } = context;
    const statuses = list(options.status).map((status) => status.toUpperCase());
    for (const status of statuses)
      if (!SUBSCRIPTION_STATUSES.includes(status))
        throw new CliError(`Unknown subscription status ${status}. Use: ${SUBSCRIPTION_STATUSES.join(", ")}.`, {
          exit: EXIT.usage,
        });
    const query = {
      status: statuses.length > 0 ? statuses : undefined,
      product_id: options.product === undefined ? undefined : numericId(options.product, "--product"),
      plan_id: options["plan-id"] === undefined ? undefined : numericId(options["plan-id"], "--plan-id"),
      subscriber_code: options.subscriber === undefined ? undefined : subscriberCode(options.subscriber),
      subscriber_email: options.email === undefined ? undefined : String(options.email).trim(),
      transaction: options.transaction === undefined ? undefined : transactionCode(options.transaction),
      trial: options.trial === undefined ? undefined : String(options.trial) === "true",
      accession_date: dateOption(options, "since") ?? ALL_SUBSCRIPTIONS_SINCE,
      end_accession_date: dateOption(options, "until"),
      cancelation_date: dateOption(options, "cancelled-since"),
      end_cancelation_date: dateOption(options, "cancelled-until"),
      date_next_charge: dateOption(options, "next-charge-since"),
      end_date_next_charge: dateOption(options, "next-charge-until"),
    };
    const result = await context.api.list("/payments/api/v1/subscriptions", query, Number(options.limit ?? 2000));
    const byStatus = {};
    const monthly = {};
    const data = result.data.map((row) => {
      const status = row?.status ?? "UNKNOWN";
      byStatus[status] = (byStatus[status] ?? 0) + 1;
      const value = money(row?.price?.value);
      const period = Number(row?.plan?.recurrency_period);
      if (status === "ACTIVE" && value !== null && period > 0) {
        const currency = row?.price?.currency_code ?? "UNKNOWN";
        monthly[currency] = round((monthly[currency] ?? 0) + (value * 30) / period);
      }
      return {
        ...row,
        accession_date: isoTime(row?.accession_date),
        end_accession_date: isoTime(row?.end_accession_date),
        request_date: isoTime(row?.request_date),
        date_next_charge: isoTime(row?.date_next_charge),
      };
    });
    return {
      environment: context.sandbox ? "sandbox" : "production",
      count: data.length,
      total: result.total,
      truncated: result.truncated,
      by_status: byStatus,
      active_monthly_value_by_currency: monthly,
      data,
    };
  },

  async "subscription-summary"(context) {
    const { options } = context;
    const query = {
      product_id: options.product === undefined ? undefined : numericId(options.product, "--product"),
      subscriber_code: options.subscriber === undefined ? undefined : subscriberCode(options.subscriber),
      accession_date: dateOption(options, "since") ?? ALL_SUBSCRIPTIONS_SINCE,
      end_accession_date: dateOption(options, "until"),
    };
    const result = await context.api.list(
      "/payments/api/v1/subscriptions/summary",
      query,
      Number(options.limit ?? 2000),
    );
    return {
      note: "Hotmart updates this summary with a delay of up to 24 hours.",
      ...result,
      count: result.data.length,
    };
  },

  async "subscription-purchases"(context, args) {
    const code = subscriberCode(args[0]);
    const answer = await context.api.get(`/payments/api/v1/subscriptions/${encodeURIComponent(code)}/purchases`);
    const rows = Array.isArray(answer) ? answer : (answer?.items ?? []);
    return {
      subscriber_code: code,
      count: rows.length,
      data: rows.map((row) => ({ ...row, approved_date: isoTime(row?.approved_date) })),
    };
  },

  async coupons(context, args) {
    const product = numericId(args[0], "<product_id>");
    const query = { code: context.options.code === undefined ? undefined : String(context.options.code) };
    const result = await context.api.list(`/products/api/v1/coupon/product/${product}`, query, 1000);
    return { product_id: product, ...result, count: result.data.length };
  },

  async "capi-event"(context, args) {
    const transaction = transactionCode(args[0]);
    const item = await findSale(context, transaction);
    const sale = saleRow(item);
    if (!PAID.has(sale.status) && context.options["any-status"] !== true)
      throw new CliError(
        `The sale ${transaction} is ${sale.status}. Send a Purchase only for APPROVED or COMPLETE sales (or add --any-status).`,
      );
    let buyer = null;
    try {
      const users = await context.api.list("/payments/api/v1/sales/users", { transaction }, 10);
      buyer = (users.data[0]?.users ?? []).find((entry) => entry?.role === "BUYER")?.user ?? null;
    } catch (error) {
      if (error instanceof CliError && error.exit === EXIT.rateLimited) throw error;
    }
    const country = countryCode(buyer?.address?.country);
    const email = sale.buyer_email ?? buyer?.email ?? null;
    const phone = metaPhone(buyer?.cellphone || buyer?.phone, country);
    const names = String(sale.buyer_name ?? buyer?.name ?? "")
      .trim()
      .split(/\s+/)
      .filter(Boolean);
    const time = epochMilliseconds(item?.purchase?.approved_date) ?? epochMilliseconds(item?.purchase?.order_date);
    if (time === null) throw new CliError("The sale has no approved or order date.");
    if (sale.value === null || !sale.currency) throw new CliError("The sale has no value or currency.");
    const userData = {
      em: email ? [email] : undefined,
      ph: phone ? [phone] : undefined,
      fn: names.length > 0 ? [names[0]] : undefined,
      ln: names.length > 1 ? [names.at(-1)] : undefined,
      country: country ? [country] : undefined,
      external_id: sale.buyer_ucode ? [sale.buyer_ucode] : undefined,
    };
    for (const key of Object.keys(userData)) if (userData[key] === undefined) delete userData[key];
    if (Object.keys(userData).length === 0) throw new CliError("The sale has no buyer data to match in Meta.");
    const event = {
      event_name: String(context.options.event ?? "Purchase"),
      event_time: Math.floor(time / 1000),
      // The transaction code is the event ID, so Meta drops a second copy of the same purchase.
      event_id: transaction,
      action_source: "website",
      event_source_url: context.options["event-source-url"] ? String(context.options["event-source-url"]) : undefined,
      user_data: userData,
      custom_data: {
        value: sale.value,
        currency: sale.currency,
        order_id: transaction,
        content_ids: sale.product_id === null ? undefined : [String(sale.product_id)],
        content_name: sale.product_name ?? undefined,
        content_type: "product",
        num_items: 1,
      },
    };
    if (!event.event_source_url) delete event.event_source_url;
    const warnings = [];
    if (Date.now() - time > 7 * 86_400_000)
      warnings.push("The purchase is older than 7 days. Meta refuses website events older than 7 days.");
    let file = null;
    if (context.options.out !== undefined) {
      file = String(context.options.out);
      writeFileSync(file, `${JSON.stringify([event], null, 2)}\n`, { mode: 0o600 });
    }
    return {
      transaction,
      status: sale.status,
      file,
      event,
      warnings,
      next: file
        ? `meta-ads capi-send --pixel <pixel id> --data @${file} --reason "Hotmart purchase ${transaction}", then delete ${file}`
        : "Add --out FILE, then: meta-ads capi-send --pixel <pixel id> --data @FILE",
    };
  },

  async "affiliate-stats"(context) {
    const { options } = context;
    const statuses = saleStatuses(options.status, [...STATUS_GROUPS.paid, ...STATUS_GROUPS.refunds]);
    const { period, query } = periodQuery(context);
    const filters = { ...query, ...salesFilters(context), commission_as: "AFFILIATE" };
    const limit = Number(options.limit ?? 5000);
    const me = await context.api.get("/user/api/v1/me");
    const sales = await perStatus(context, "/payments/api/v1/sales/history", statuses, filters, limit);
    const paid = await perStatus(context, "/payments/api/v1/sales/commissions", statuses, filters, limit);
    // The commission of the credential's user: the entry with its ucode, or the only AFFILIATE entry.
    const commissionOf = new Map();
    for (const { row } of paid.rows) {
      const entries = Array.isArray(row?.commissions) ? row.commissions : [];
      const affiliates = entries.filter((entry) => entry?.source === "AFFILIATE");
      const own =
        entries.find((entry) => me?.ucode && entry?.user?.ucode === me.ucode) ??
        (affiliates.length === 1 ? affiliates[0] : null);
      if (own && row?.transaction)
        commissionOf.set(row.transaction, {
          value: money(own.commission?.value) ?? 0,
          currency: own.commission?.currency_value ?? "UNKNOWN",
        });
    }
    const add = (target, currency, value) => {
      target[currency] = round((target[currency] ?? 0) + value);
    };
    const counts = () => ({
      sales: 0,
      refunds: 0,
      chargebacks: 0,
      protested: 0,
      buyer_paid_by_currency: {},
      commission_by_currency: {},
      refunded_by_currency: {},
      lost_commission_by_currency: {},
    });
    const products = new Map();
    const totals = counts();
    const seen = new Set();
    let unmatched = 0;
    for (const { row } of sales.rows) {
      const sale = saleRow(row);
      const key = `${sale.transaction}:${sale.status}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const id = sale.product_id ?? "UNKNOWN";
      if (!products.has(id))
        products.set(id, {
          product_id: sale.product_id,
          product_name: sale.product_name,
          producer: row?.producer?.name ?? null,
          ...counts(),
        });
      const product = products.get(id);
      const commission = commissionOf.get(sale.transaction) ?? null;
      if (!commission) unmatched += 1;
      const currency = sale.currency ?? "UNKNOWN";
      for (const target of [product, totals]) {
        if (PAID.has(sale.status)) {
          target.sales += 1;
          add(target.buyer_paid_by_currency, currency, sale.value ?? 0);
          if (commission) add(target.commission_by_currency, commission.currency, commission.value);
        } else if (LOST.has(sale.status)) {
          if (sale.status === "CHARGEBACK") target.chargebacks += 1;
          else target.refunds += 1;
          add(target.refunded_by_currency, currency, sale.value ?? 0);
          if (commission) add(target.lost_commission_by_currency, commission.currency, commission.value);
        } else if (sale.status === "PROTESTED") target.protested += 1;
      }
    }
    // Sorted by the commission in the user's commission currency, then by the sum of all currencies.
    const main = me?.currency_code_commission ?? null;
    const earned = (product) => [
      main ? (product.commission_by_currency[main] ?? 0) : 0,
      Object.values(product.commission_by_currency).reduce((sum, value) => sum + value, 0),
    ];
    const data = [...products.values()].sort((a, b) => {
      const [mainA, allA] = earned(a);
      const [mainB, allB] = earned(b);
      return mainB - mainA || allB - allA;
    });
    return {
      environment: context.sandbox ? "sandbox" : "production",
      role: "AFFILIATE",
      user: { name: me?.name ?? null, ucode: me?.ucode ?? null, currency_code_commission: main },
      period,
      statuses,
      truncated: sales.truncated || paid.truncated,
      totals,
      products: data,
      ...(unmatched > 0 ? { sales_without_commission: unmatched } : {}),
      note: "Sales where the credential's user earned as AFFILIATE (Hotmart commission_as). buyer_paid is what the buyer paid; commission is your share. A refund or chargeback takes the commission back.",
    };
  },

  async "affiliate-products"(context) {
    const { options } = context;
    const statuses = saleStatuses(options.status);
    const { period, query } = periodQuery(context, 365);
    const { rows, truncated } = await perStatus(
      context,
      "/payments/api/v1/sales/history",
      statuses,
      { ...query, ...salesFilters(context), commission_as: "AFFILIATE" },
      Number(options.limit ?? 5000),
    );
    const products = new Map();
    for (const { row } of rows) {
      const sale = saleRow(row);
      const id = sale.product_id ?? "UNKNOWN";
      const product = products.get(id) ?? {
        product_id: sale.product_id,
        product_name: sale.product_name,
        producer_name: row?.producer?.name ?? null,
        producer_ucode: row?.producer?.ucode ?? null,
        sales: 0,
        first_sale: sale.order_date,
        last_sale: sale.order_date,
      };
      product.sales += 1;
      if (String(sale.order_date ?? "") < String(product.first_sale ?? "")) product.first_sale = sale.order_date;
      if (String(sale.order_date ?? "") > String(product.last_sale ?? "")) product.last_sale = sale.order_date;
      products.set(id, product);
    }
    const data = [...products.values()].sort((a, b) =>
      String(b.last_sale ?? "").localeCompare(String(a.last_sale ?? "")),
    );
    return {
      environment: context.sandbox ? "sandbox" : "production",
      period,
      statuses,
      count: data.length,
      truncated,
      data,
      note: "Hotmart's public API has no endpoint for affiliations or affiliation requests. This list comes from your affiliate sales in the period: a product you promote with no sale yet is not in it. Affiliation requests and approvals stay in the Hotmart app.",
    };
  },

  async audit(context) {
    const tail = Number(context.options.tail ?? 20);
    const entries = readAudit(context.home);
    return { path: auditPath(context.home), entries: entries.slice(-Math.max(1, tail)) };
  },

  async refund(context, args) {
    const transaction = transactionCode(args[0]);
    const sale = saleRow(await findSale(context, transaction));
    if (!PAID.has(sale.status))
      throw new CliError(`The sale ${transaction} is ${sale.status}. Hotmart refunds only APPROVED or COMPLETE sales.`);
    return change(context, {
      action: "refund",
      target: transaction,
      reasons: [
        `It returns ${sale.value} ${sale.currency} to the buyer and removes their access to ${sale.product_name ?? "the product"}. It cannot be undone.`,
      ],
      details: { status: sale.status, value: sale.value, currency: sale.currency, product_id: sale.product_id },
      request: { method: "PUT", path: `/payments/api/v1/sales/${encodeURIComponent(transaction)}/refund` },
    });
  },

  async "cancel-subscription"(context, args) {
    if (args.length === 0)
      throw new CliError("Use: cancel-subscription <subscriber_code>... [--send-mail]", { exit: EXIT.usage });
    const results = [];
    for (const raw of args) {
      const code = subscriberCode(raw);
      results.push(
        await change(context, {
          action: "cancel-subscription",
          target: code,
          reasons: ["It stops the subscriber's charges and their access to the product."],
          details: { send_mail: context.options["send-mail"] === true },
          request: {
            method: "POST",
            path: `/payments/api/v1/subscriptions/${encodeURIComponent(code)}/cancel`,
            body: { send_mail: context.options["send-mail"] === true },
          },
        }),
      );
    }
    return { results };
  },

  async "reactivate-subscription"(context, args) {
    if (args.length === 0)
      throw new CliError("Use: reactivate-subscription <subscriber_code>... [--charge]", { exit: EXIT.usage });
    const charge = context.options.charge === true;
    const results = [];
    for (const raw of args) {
      const code = subscriberCode(raw);
      results.push(
        await change(context, {
          action: "reactivate-subscription",
          target: code,
          reasons: [
            charge
              ? "Hotmart asks the subscriber by email to accept, then charges them again."
              : "Hotmart asks the subscriber by email to accept, then restarts the subscription.",
          ],
          details: { charge },
          request: {
            method: "POST",
            path: `/payments/api/v1/subscriptions/${encodeURIComponent(code)}/reactivate`,
            body: { charge },
          },
        }),
      );
    }
    return { results };
  },

  async "create-coupon"(context, args) {
    const { options } = context;
    const product = numericId(args[0], "<product_id>");
    const code = requireOption(options, "code");
    if (code.length > 25 || /\s/.test(code))
      throw new CliError("--code must be at most 25 characters with no spaces.", { exit: EXIT.usage });
    let discount = Number(String(requireOption(options, "discount", "For example 10 (percent).")).replace("%", ""));
    // Hotmart wants a fraction from 0 to 0.99. A value of 1 or more is a percent.
    if (discount >= 1) discount /= 100;
    if (!Number.isFinite(discount) || discount <= 0 || discount >= 0.99)
      throw new CliError("--discount must be a percent above 0 and below 99.", { exit: EXIT.usage });
    const body = {
      code,
      discount: Math.round(discount * 10000) / 10000,
      start_date: dateOption(options, "start"),
      end_date: dateOption(options, "end"),
      affiliate: options.affiliate === undefined ? undefined : Number(numericId(options.affiliate, "--affiliate")),
      offer_ids: options["offer-ids"] === undefined ? undefined : list(options["offer-ids"]),
    };
    for (const key of Object.keys(body)) if (body[key] === undefined) delete body[key];
    return change(context, {
      action: "create-coupon",
      target: product,
      reasons: [`Buyers who use ${code} pay ${Math.round(discount * 100)}% less.`],
      details: body,
      request: { method: "POST", path: `/products/api/v1/product/${product}/coupon`, body },
    });
  },

  async "delete-coupon"(context, args) {
    const id = numericId(args[0], "<coupon_id>");
    return change(context, {
      action: "delete-coupon",
      target: id,
      reasons: ["Buyers can no longer use this coupon."],
      request: { method: "DELETE", path: `/products/api/v1/coupon/${id}` },
    });
  },
};

// ---------- main ----------

function redact(text, secrets) {
  let result = String(text);
  for (const secret of secrets) if (secret && secret.length >= 8) result = result.split(secret).join("[REDACTED]");
  return result;
}

export async function main(argv) {
  let context = null;
  const write = (stream, value) => {
    const secrets = context?.client?.secrets() ?? [];
    stream.write(`${redact(JSON.stringify(value, null, 2), secrets)}\n`);
  };
  try {
    const { positional, options } = parseArgs(argv);
    const [name = "help", ...args] = positional;
    if (options.help || name === "help" || name === "--help") {
      process.stdout.write(HELP);
      return EXIT.ok;
    }
    const command = Object.hasOwn(commands, name) ? commands[name] : null;
    if (!command) throw new CliError(`Unknown command ${name}. Run: hotmart help`, { exit: EXIT.usage });
    context = new Context(options);
    write(process.stdout, await command(context, args));
    return EXIT.ok;
  } catch (error) {
    if (error instanceof CliError) {
      if (error.exit === EXIT.refused) {
        write(process.stdout, { error: error.message, ...error.details });
        return EXIT.refused;
      }
      write(process.stderr, {
        error: { message: error.message, ...(error.details ? { details: error.details } : {}) },
      });
      return error.exit;
    }
    if (error instanceof HotmartError) {
      write(process.stderr, { error: describeHotmartError(error) });
      return EXIT.error;
    }
    write(process.stderr, {
      error: { message: "Unexpected failure in hotmart.", detail: String(error?.message ?? error) },
    });
    return EXIT.error;
  }
}

function invokedDirectly() {
  try {
    return !!process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
  } catch {
    return false;
  }
}
if (invokedDirectly()) process.exitCode = await main(process.argv.slice(2));
