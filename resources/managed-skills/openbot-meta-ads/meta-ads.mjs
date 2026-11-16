#!/usr/bin/env node
// meta-ads: a helper for the Meta (Facebook and Instagram) Marketing API, for OpenBot agents.
// It has no dependencies and runs on Node.js 18 or later. Every answer is JSON on standard output.
// Errors are JSON on standard error. The access token is read from a file and is never printed.
// Changes that can raise spend pass the spend guard, and every change goes to an audit log.
// Run `node meta-ads.mjs help` for the commands. The openbot-meta-ads skill explains the use.
import { createHash, createHmac } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir, userInfo } from "node:os";
import { basename, join, sep } from "node:path";
import { pathToFileURL } from "node:url";

const DEFAULT_API_VERSION = "v27.0";
const OFFICIAL_BASE_URL = "https://graph.facebook.com";
const REQUEST_TIMEOUT_MS = 60_000;
const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;
const MAX_LIST_ITEMS = 5000;
const EXIT = { ok: 0, error: 1, usage: 2, refused: 3, rateLimited: 4 };

// Meta keeps budgets and bids in the smallest unit of the account currency. These currencies have
// no smaller unit, so 1 unit is 1. Every other currency has 100. Source: Meta "Currencies" reference.
const CURRENCY_OFFSET_ONE = new Set(["CLP", "COP", "CRC", "HUF", "ISK", "IDR", "JPY", "KRW", "PYG", "TWD", "VND"]);
const MONEY_FIELDS = ["daily_budget", "lifetime_budget", "budget_remaining", "spend_cap", "bid_amount"];
const PURCHASE_ACTION_TYPES = [
  "omni_purchase",
  "purchase",
  "offsite_conversion.fb_pixel_purchase",
  "onsite_web_purchase",
  "onsite_conversion.purchase",
];
const LEAD_ACTION_TYPES = ["lead", "onsite_conversion.lead_grouped", "offsite_conversion.fb_pixel_lead"];
const RATE_LIMIT_CODES = new Set([4, 17, 32, 613]);

const FIELDS = {
  account:
    "id,account_id,name,account_status,disable_reason,currency,timezone_name,timezone_offset_hours_utc,amount_spent,spend_cap,balance,business",
  campaign:
    "id,name,objective,status,effective_status,daily_budget,lifetime_budget,budget_remaining,bid_strategy,buying_type,special_ad_categories,spend_cap,start_time,stop_time,created_time,updated_time,issues_info",
  adset:
    "id,name,campaign_id,status,effective_status,daily_budget,lifetime_budget,budget_remaining,bid_strategy,bid_amount,billing_event,optimization_goal,promoted_object,targeting,start_time,end_time,created_time,updated_time,issues_info",
  ad: "id,name,adset_id,campaign_id,status,effective_status,creative{id,name},ad_review_feedback,issues_info,created_time,updated_time",
  creative:
    "id,name,status,object_story_spec,asset_feed_spec,image_hash,image_url,thumbnail_url,video_id,call_to_action_type,effective_object_story_id,instagram_user_id",
  audience:
    "id,name,subtype,description,approximate_count_lower_bound,approximate_count_upper_bound,delivery_status,operation_status,retention_days,time_updated",
  insights:
    "spend,impressions,reach,frequency,clicks,inline_link_clicks,ctr,cpc,cpm,actions,action_values,cost_per_action_type,purchase_roas,date_start,date_stop",
};
// The fields that tell what kind of object an ID is. A field that the object does not have is an
// error (code 100), so the first set that reads answers the type. `metadata=1` is deprecated since v25.
const TYPE_PROBES = [
  ["adset", "id,name,status,effective_status,daily_budget,lifetime_budget,bid_strategy,bid_amount,campaign_id"],
  ["campaign", "id,name,status,effective_status,daily_budget,lifetime_budget,bid_strategy,spend_cap,objective"],
  ["ad", "id,name,status,effective_status,adset_id,campaign_id"],
];
const LEVEL_ID_FIELDS = {
  account: "account_id,account_name",
  campaign: "campaign_id,campaign_name",
  adset: "campaign_id,campaign_name,adset_id,adset_name",
  ad: "campaign_id,campaign_name,adset_id,adset_name,ad_id,ad_name",
};
const BOOLEAN_FLAGS = new Set([
  "approved",
  "activate",
  "dry-run",
  "validate",
  "deep",
  "raw",
  "help",
  "all",
  "budget-sharing",
  "no-budget-sharing",
  "include-archived",
]);

const HELP = `meta-ads: the Meta Marketing API helper for OpenBot agents (JSON output).

Setup and reading
  help                                   This text.
  config show | config set <key> <value> Settings: adAccountId, apiVersion, pageId, pixelId,
                                         guard.maxDailyIncreasePercent, guard.dailyBudgetCap, guard.maxBidIncreasePercent
  whoami                                 The user or system user of the token.
  accounts                               The ad accounts that the token can use.
  account                                The configured ad account (status, currency, time zone).
  campaigns | adsets | ads | creatives   Lists. Filters: --status ACTIVE,PAUSED --campaign ID --adset ID --limit N --fields a,b
  get <id> [--fields a,b]                One object.
  insights [--object ID] [--level account|campaign|adset|ad] [--preset last_7d | --since YYYY-MM-DD --until YYYY-MM-DD]
           [--breakdowns age,gender] [--time-increment 1|all_days] [--fields a,b] [--action-type purchase] [--limit N]
  review                                 Account, campaigns, ad sets and ads with problems, with Meta's review feedback.
  audiences                              Custom audiences.
  lead-forms [--page ID]                 Lead forms of the page.
  leads <form_id> [--hours N | --since ISO] [--page ID]
  audit [--tail N]                       The last changes from the audit log.

Changes (new objects are always PAUSED; --activate also needs --approved)
  create-campaign --name N --objective OUTCOME_SALES [--daily-budget 50] [--lifetime-budget X] [--bid-strategy S]
                  [--special-ad-categories A,B] [--params JSON]
  create-adset --campaign ID --name N --optimization-goal OFFSITE_CONVERSIONS [--billing-event IMPRESSIONS]
               [--daily-budget 20] [--bid-amount 1.5] [--targeting JSON|@file] [--promoted-object JSON]
               [--start-time ISO] [--end-time ISO] [--params JSON]
  create-creative --name N --page-id ID (--link URL --image-hash H | --video-id ID --image-url URL)
                  [--message T] [--headline T] [--description T] [--cta SHOP_NOW] [--instagram-user-id ID] [--spec JSON]
  create-ad --adset ID --creative ID --name N [--params JSON]
  pause <id>...                          Never needs approval.
  resume <id>... --approved              Activation raises spend.
  set-budget <id> (--daily X | --lifetime X)    In normal currency units, for example 25.50.
  set-bid <adset_id> --bid X
  update <id> --params JSON
  duplicate <id> [--deep] [--to-campaign ID | --to-adset ID] [--suffix " - copy"] [--activate]
  upload-image <file>                    Answers the image hash.
  upload-video (<file> | --url URL) [--name N]
  create-audience --name N [--subtype CUSTOM] [--description T] [--rule JSON] [--origin ID --lookalike-spec JSON] [--params JSON]
  add-audience-users <audience_id> (--emails-file F | --phones-file F)   Values are hashed before they leave.
  capi-send --pixel ID --event Purchase [--value 10 --currency USD] [--email E] [--phone P] [--external-id X]
            [--event-id ID] [--event-time UNIX] [--action-source website] [--event-source-url URL]
            [--client-ip IP --user-agent UA --fbc C --fbp P] [--test-code CODE] [--data JSON]

Common options
  --account act_123     Ad account (default: settings adAccountId or META_AD_ACCOUNT_ID).
  --token-file PATH     Token file (default: META_ACCESS_TOKEN_FILE, or the META_ACCESS_TOKEN value).
  --app-secret-file P   Adds appsecret_proof (or META_APP_SECRET_FILE).
  --home DIR            Settings and audit folder (default: META_ADS_HOME, else <OpenBot shared>/meta-ads).
  --approved            The person approved this spend change (or you decided in a hands-off channel).
  --reason TEXT         Why, for the audit log. --actor NAME (or META_ADS_ACTOR) says who.
  --dry-run             Show the request and the spend guard result; send nothing.
  --validate            Ask Meta to validate the change without saving it.
  --max-wait SECONDS    The longest rate-limit wait before failing (default 120).
  --type T              campaign, adset or ad: skips the type lookup of an ID.
  --api-version vNN.0   Overrides the apiVersion setting for one command.

Exit codes: 0 ok, 1 error, 2 usage, 3 refused by the spend guard, 4 rate limited.
`;

class CliError extends Error {
  constructor(message, { exit = EXIT.error, details = undefined } = {}) {
    super(message);
    this.exit = exit;
    this.details = details;
  }
}

class GraphError extends Error {
  constructor(status, error, headers) {
    super(typeof error?.message === "string" ? error.message : `Graph API HTTP ${status}`);
    this.status = status;
    this.code = Number(error?.code) || null;
    this.subcode = Number(error?.error_subcode) || null;
    this.type = typeof error?.type === "string" ? error.type : null;
    this.userTitle = typeof error?.error_user_title === "string" ? error.error_user_title : null;
    this.userMessage = typeof error?.error_user_msg === "string" ? error.error_user_msg : null;
    this.fbtraceId = typeof error?.fbtrace_id === "string" ? error.fbtrace_id : null;
    this.transient = error?.is_transient === true;
    this.headers = headers;
  }
  get rateLimited() {
    return (
      this.status === 429 ||
      RATE_LIMIT_CODES.has(this.code) ||
      (this.code !== null && this.code >= 80000 && this.code <= 80014)
    );
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

function readJsonOption(options, name) {
  const value = options[name];
  if (value === undefined) return undefined;
  const text = String(value).startsWith("@") ? readFileSync(String(value).slice(1), "utf8") : String(value);
  try {
    return JSON.parse(text);
  } catch {
    throw new CliError(`--${name} must be JSON (or @file with JSON).`, { exit: EXIT.usage });
  }
}

function list(value) {
  if (value === undefined || value === true) return [];
  return String(value)
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
}

function positiveNumber(value, name) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0)
    throw new CliError(`${name} must be a number above 0.`, { exit: EXIT.usage });
  return number;
}

function graphId(value, name) {
  const text = String(value ?? "").trim();
  if (!/^[0-9]{1,30}$/.test(text)) throw new CliError(`${name} must be a numeric Meta ID.`, { exit: EXIT.usage });
  return text;
}

export function normalizeAccountId(value) {
  const text = String(value ?? "").trim();
  const match = /^(?:act_)?([0-9]{1,30})$/.exec(text);
  if (!match) throw new CliError("The ad account ID must look like act_1234567890.", { exit: EXIT.usage });
  return `act_${match[1]}`;
}

// ---------- settings, token and audit ----------

/**
 * The shared folder of the space of the agent that runs this helper, or null. OpenBot keeps one shared
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
      if (typeof folder === "string" && folder) return folder;
    } catch {
      // No index: an OpenBot before spaces.
    }
  }
  const spaces = parts.lastIndexOf("Spaces");
  if (spaces > 0 && parts[spaces + 2] === "Shared") return parts.slice(0, spaces + 3).join(sep);
  return null;
}

function defaultHome() {
  if (process.env.META_ADS_HOME) return process.env.META_ADS_HOME;
  const space = spaceSharedFolder();
  if (space) return join(space, "meta-ads");
  // An OpenBot before spaces. The server image keeps the shared folder here; on a computer it is ~/OpenBot/Shared.
  if (existsSync("/data/OpenBot/Shared")) return "/data/OpenBot/Shared/meta-ads";
  return join(homedir(), "OpenBot", "Shared", "meta-ads");
}

const DEFAULT_SETTINGS = {
  adAccountId: "",
  apiVersion: DEFAULT_API_VERSION,
  pageId: "",
  pixelId: "",
  guard: { maxDailyIncreasePercent: 20, dailyBudgetCap: null, maxBidIncreasePercent: 20 },
};

function loadSettings(home) {
  const path = join(home, "settings.json");
  if (!existsSync(path)) return structuredClone(DEFAULT_SETTINGS);
  let saved;
  try {
    saved = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new CliError(`The settings file ${path} is not valid JSON. Fix it or remove it.`);
  }
  return { ...DEFAULT_SETTINGS, ...saved, guard: { ...DEFAULT_SETTINGS.guard, ...(saved.guard ?? {}) } };
}

function saveSettings(home, settings) {
  mkdirSync(home, { recursive: true });
  const path = join(home, "settings.json");
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(settings, null, 2)}\n`);
  renameSync(temporary, path);
}

function readSecretFile(path, name) {
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    throw new CliError(`Cannot read the ${name} file. Check the path from openbot.list_api_keys.`);
  }
  const value = text.trim();
  if (!value || /\s/.test(value)) throw new CliError(`The ${name} file must hold one value with no spaces.`);
  return value;
}

function readToken(options) {
  const file = options["token-file"] ?? process.env.META_ACCESS_TOKEN_FILE;
  if (file) return readSecretFile(String(file), "META_ACCESS_TOKEN");
  const value = (process.env.META_ACCESS_TOKEN ?? "").trim();
  if (!value)
    throw new CliError(
      "No access token. Set META_ACCESS_TOKEN_FILE to the path of the shared key META_ACCESS_TOKEN (openbot.list_api_keys), or pass --token-file.",
    );
  if (/\s/.test(value)) throw new CliError("META_ACCESS_TOKEN must hold one value with no spaces.");
  return value;
}

function readAppSecret(options) {
  const file = options["app-secret-file"] ?? process.env.META_APP_SECRET_FILE;
  return file ? readSecretFile(String(file), "META_APP_SECRET") : null;
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

// ---------- Graph API client ----------

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function parseJsonHeader(headers, name) {
  const value = headers?.get?.(name);
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

/** The usage that Meta reports in its headers, as the highest percent and the longest wait it asks for. */
export function readUsage(headers) {
  let percent = 0;
  let regainSeconds = 0;
  const business = parseJsonHeader(headers, "x-business-use-case-usage");
  if (business && typeof business === "object") {
    for (const entries of Object.values(business)) {
      for (const entry of Array.isArray(entries) ? entries : []) {
        percent = Math.max(
          percent,
          Number(entry?.call_count) || 0,
          Number(entry?.total_cputime) || 0,
          Number(entry?.total_time) || 0,
        );
        regainSeconds = Math.max(regainSeconds, (Number(entry?.estimated_time_to_regain_access) || 0) * 60);
      }
    }
  }
  const account = parseJsonHeader(headers, "x-ad-account-usage");
  if (account) {
    percent = Math.max(percent, Number(account.acc_id_util_pct) || 0);
    if (percent >= 100) regainSeconds = Math.max(regainSeconds, Number(account.reset_time_duration) || 0);
  }
  const app = parseJsonHeader(headers, "x-app-usage");
  if (app) percent = Math.max(percent, Number(app.call_count) || 0, Number(app.total_time) || 0);
  const insights = parseJsonHeader(headers, "x-fb-ads-insights-throttle");
  if (insights)
    percent = Math.max(percent, Number(insights.app_id_util_pct) || 0, Number(insights.acc_id_util_pct) || 0);
  return { percent, regainSeconds };
}

function graphBaseUrl() {
  const override = process.env.META_GRAPH_BASE_URL;
  if (!override) return OFFICIAL_BASE_URL;
  let url;
  try {
    url = new URL(override);
  } catch {
    throw new CliError("META_GRAPH_BASE_URL is not a valid address.");
  }
  const local = url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !local) throw new CliError("META_GRAPH_BASE_URL must use https.");
  return url.origin;
}

export class Graph {
  constructor({ token, appSecret = null, version, maxWaitSeconds = 120, backoffBaseMs = 2000 }) {
    if (!/^v[0-9]{1,3}\.[0-9]$/.test(version))
      throw new CliError("apiVersion must look like v27.0.", { exit: EXIT.usage });
    this.token = token;
    this.appSecretProof = appSecret ? createHmac("sha256", appSecret).update(token).digest("hex") : null;
    this.version = version;
    this.base = graphBaseUrl();
    this.maxWaitSeconds = maxWaitSeconds;
    this.backoffBaseMs = backoffBaseMs;
    this.waitedSeconds = 0;
  }

  url(path, query = {}) {
    const url = path.startsWith("http") ? new URL(path) : new URL(`${this.base}/${this.version}/${path}`);
    if (url.origin !== this.base)
      throw new CliError("Meta sent a paging address on another host; it was not followed.");
    url.searchParams.delete("access_token");
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined || value === null) continue;
      url.searchParams.set(key, typeof value === "object" ? JSON.stringify(value) : String(value));
    }
    if (this.appSecretProof) url.searchParams.set("appsecret_proof", this.appSecretProof);
    return url;
  }

  async request(method, path, { query = {}, form = null, multipart = null } = {}) {
    const url = this.url(path, method === "GET" ? query : {});
    let body;
    if (multipart) body = multipart;
    else if (method !== "GET") {
      body = new URLSearchParams();
      for (const [key, value] of Object.entries({ ...query, ...(form ?? {}) })) {
        if (value === undefined || value === null) continue;
        body.set(key, typeof value === "object" ? JSON.stringify(value) : String(value));
      }
    }
    for (let attempt = 0; ; attempt += 1) {
      let response;
      let text;
      try {
        response = await fetch(url, {
          method,
          body,
          redirect: "error",
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
          headers: { Authorization: `Bearer ${this.token}`, Accept: "application/json" },
        });
        text = await response.text();
      } catch {
        // A write that timed out may have happened, so only a read is sent again.
        if (method === "GET" && attempt < 2) {
          await sleep(this.backoffBaseMs * 2 ** attempt);
          continue;
        }
        throw new CliError("The Meta Graph API did not answer (network error or timeout).");
      }
      let json = null;
      try {
        json = text ? JSON.parse(text) : {};
      } catch {
        json = null;
      }
      const usage = readUsage(response.headers);
      if (response.ok && json && !json.error) {
        await this.#slowDown(usage);
        return json;
      }
      const error = new GraphError(response.status, json?.error, response.headers);
      if (error.rateLimited) {
        const wait = Math.max(usage.regainSeconds, (this.backoffBaseMs / 1000) * 2 ** attempt);
        if (attempt >= 5 || this.waitedSeconds + wait > this.maxWaitSeconds)
          throw new CliError(
            `Meta rate limit reached (code ${error.code ?? response.status}). Wait ${Math.ceil(Math.max(wait, 60) / 60)} minutes, then try again with fewer calls.`,
            { exit: EXIT.rateLimited, details: describeGraphError(error) },
          );
        this.waitedSeconds += wait;
        await sleep(wait * 1000);
        continue;
      }
      const retryable = method === "GET" && (response.status >= 500 || error.transient) && attempt < 2;
      if (retryable) {
        await sleep(this.backoffBaseMs * 2 ** attempt);
        continue;
      }
      throw error;
    }
  }

  async #slowDown(usage) {
    // Close to a limit, wait a little so that the next call does not lock the account out.
    if (usage.percent < 90) return;
    const wait = Math.min(Math.max(usage.regainSeconds, (this.backoffBaseMs / 1000) * 4), 60);
    if (this.waitedSeconds + wait > this.maxWaitSeconds) return;
    this.waitedSeconds += wait;
    await sleep(wait * 1000);
  }

  get(path, query) {
    return this.request("GET", path, { query });
  }

  post(path, form) {
    return this.request("POST", path, { form });
  }

  async list(path, query = {}, limit = 200) {
    const max = Math.min(Math.max(1, limit), MAX_LIST_ITEMS);
    const rows = [];
    let page = await this.get(path, { ...query, limit: Math.min(max, 100) });
    for (;;) {
      if (!Array.isArray(page?.data)) throw new CliError("Meta sent an unexpected list answer.");
      rows.push(...page.data);
      const next = page.paging?.next;
      if (rows.length >= max || typeof next !== "string" || page.data.length === 0) break;
      page = await this.get(next);
    }
    return { data: rows.slice(0, max), truncated: rows.length > max || (rows.length >= max && !!page.paging?.next) };
  }
}

function describeGraphError(error) {
  const hints = {
    190: "The access token is not valid or has expired. Ask the person for a new system user token (request_api_key META_ACCESS_TOKEN).",
    102: "The session is not valid. Ask the person for a new token.",
    10: "The token does not have the permission for this. Check the token's permissions and the assets assigned to the system user.",
    200: "The token does not have the permission for this. Check ads_management, ads_read and the assets assigned to the system user.",
    294: "Managing ads needs the ads_management permission on the token.",
    100: "A parameter is not valid. Read the message, fix the request and try again.",
    2635: "This API version is no longer available. Set a newer apiVersion with: config set apiVersion vNN.0",
    1487390: "The ad account is not active or has a payment problem.",
  };
  return {
    status: error.status,
    code: error.code,
    subcode: error.subcode,
    type: error.type,
    message: error.message,
    userTitle: error.userTitle,
    userMessage: error.userMessage,
    fbtraceId: error.fbtraceId,
    hint: hints[error.code] ?? (error.code >= 200 && error.code < 300 ? hints[200] : null),
  };
}

// ---------- money, actions and metrics ----------

export function currencyOffset(currency) {
  return CURRENCY_OFFSET_ONE.has(String(currency).toUpperCase()) ? 1 : 100;
}

export function toMinor(amount, offset) {
  return Math.round(positiveNumber(amount, "The amount") * offset);
}

function withMoney(row, offset) {
  if (!row || typeof row !== "object") return row;
  const result = { ...row };
  for (const field of MONEY_FIELDS) {
    if (row[field] !== undefined && row[field] !== null && row[field] !== "" && Number.isFinite(Number(row[field])))
      result[`${field}_amount`] = Number(row[field]) / offset;
  }
  return result;
}

function actionValue(entries, types) {
  if (!Array.isArray(entries)) return { type: null, value: 0 };
  for (const type of types) {
    const entry = entries.find((candidate) => candidate?.action_type === type);
    if (entry) return { type, value: Number(entry.value) || 0 };
  }
  return { type: null, value: 0 };
}

/** Adds purchases, purchase value, cost per purchase, ROAS and leads to one insights row. */
export function deriveMetrics(row, purchaseActionType = null) {
  const types = purchaseActionType ? [purchaseActionType] : PURCHASE_ACTION_TYPES;
  const spend = Number(row.spend) || 0;
  const purchases = actionValue(row.actions, types);
  const value = actionValue(row.action_values, purchases.type ? [purchases.type] : types);
  const leads = actionValue(row.actions, LEAD_ACTION_TYPES);
  const reportedRoas = actionValue(row.purchase_roas, types);
  const roas = spend > 0 && value.value > 0 ? value.value / spend : reportedRoas.value || (spend > 0 ? 0 : null);
  return {
    ...row,
    purchases: purchases.value,
    purchase_action_type: purchases.type,
    purchase_value: value.value,
    cost_per_purchase: purchases.value > 0 ? round(spend / purchases.value) : null,
    roas: roas === null ? null : round(roas),
    leads: leads.value,
    cost_per_lead: leads.value > 0 ? round(spend / leads.value) : null,
  };
}

function round(value) {
  return Math.round(value * 10000) / 10000;
}

// ---------- context ----------

class Context {
  constructor(options) {
    this.options = options;
    this.home = String(options.home ?? defaultHome());
    this.settings = loadSettings(this.home);
    this.actor = String(options.actor ?? process.env.META_ADS_ACTOR ?? safeUser());
    this.accountCache = null;
  }

  get graph() {
    if (!this.graphClient) {
      const maxWait = this.options["max-wait"] === undefined ? 120 : Number(this.options["max-wait"]);
      this.graphClient = new Graph({
        token: readToken(this.options),
        appSecret: readAppSecret(this.options),
        version: String(this.options["api-version"] ?? this.settings.apiVersion ?? DEFAULT_API_VERSION),
        maxWaitSeconds: Number.isFinite(maxWait) && maxWait >= 0 ? maxWait : 120,
        backoffBaseMs: Number(process.env.META_ADS_BACKOFF_BASE_MS) || 2000,
      });
    }
    return this.graphClient;
  }

  get accountId() {
    const value = this.options.account ?? process.env.META_AD_ACCOUNT_ID ?? this.settings.adAccountId;
    if (!value)
      throw new CliError("No ad account. Run: config set adAccountId act_<id> (find it with the accounts command).", {
        exit: EXIT.usage,
      });
    return normalizeAccountId(value);
  }

  async account() {
    if (!this.accountCache) this.accountCache = await this.graph.get(this.accountId, { fields: FIELDS.account });
    return this.accountCache;
  }

  async offset() {
    return currencyOffset((await this.account()).currency ?? "USD");
  }

  audit(entry) {
    appendAudit(this.home, {
      actor: this.actor,
      account: entry.account ?? this.options.account ?? this.settings.adAccountId ?? null,
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

// ---------- spend guard ----------

/** The total daily budget of the active campaigns and of the active ad sets that have their own budget. */
async function activeDailyBudget(context) {
  const active = { effective_status: ["ACTIVE"] };
  const campaigns = await context.graph.list(
    `${context.accountId}/campaigns`,
    { fields: "id,daily_budget", ...active },
    MAX_LIST_ITEMS,
  );
  const adsets = await context.graph.list(
    `${context.accountId}/adsets`,
    { fields: "id,daily_budget", ...active },
    MAX_LIST_ITEMS,
  );
  const byId = new Map();
  for (const row of [...campaigns.data, ...adsets.data]) byId.set(row.id, Number(row.daily_budget) || 0);
  return byId;
}

/** The value of a field 24 hours ago, from the audit log: the start of the window for the daily increase limit. */
function valueDayAgo(context, objectId, field, current) {
  const since = Date.now() - 24 * 3600 * 1000;
  for (const entry of readAudit(context.home)) {
    if (entry.objectId !== objectId || entry.result !== "ok" || Date.parse(entry.time) < since) continue;
    const change = entry.changes?.[field];
    if (change && change.from !== undefined && change.from !== null) return Number(change.from);
  }
  return current;
}

/**
 * Says why a change needs the person's approval, or nothing when it does not raise spend beyond the
 * guard. `before` is the object now (null for a new one), `after` the fields that the change sets.
 */
export async function spendGuard(context, { objectId, before, after }) {
  const guard = context.settings.guard ?? DEFAULT_SETTINGS.guard;
  const reasons = [];
  const increasePercent = Number(guard.maxDailyIncreasePercent ?? 20);
  const bidPercent = Number(guard.maxBidIncreasePercent ?? 20);
  const wasActive = before ? before.status === "ACTIVE" : false;
  if (after.status === "ACTIVE" && !wasActive)
    reasons.push("It turns on delivery (status ACTIVE), so the object starts to spend.");
  if (after.daily_budget !== undefined) {
    const from = Number(before?.daily_budget) || 0;
    const to = Number(after.daily_budget);
    if (before && from > 0 && to > from) {
      const start = valueDayAgo(context, objectId, "daily_budget", from);
      if (to > start * (1 + increasePercent / 100))
        reasons.push(
          `The daily budget rises more than ${increasePercent}% in 24 hours (from ${start} to ${to} in the smallest currency unit).`,
        );
    }
    if (wasActive && from === 0 && to > 0) reasons.push("It adds a daily budget to an active object that had none.");
  }
  if (after.lifetime_budget !== undefined && before) {
    const from = Number(before.lifetime_budget) || 0;
    const to = Number(after.lifetime_budget);
    if (from > 0 && to > from * (1 + increasePercent / 100))
      reasons.push(`The lifetime budget rises more than ${increasePercent}%.`);
  }
  if (after.bid_amount !== undefined && before) {
    const from = Number(before.bid_amount) || 0;
    const to = Number(after.bid_amount);
    if (from > 0 && to > from * (1 + bidPercent / 100)) reasons.push(`The bid rises more than ${bidPercent}%.`);
  }
  for (const field of ["bid_strategy", "bid_constraints", "spend_cap"]) {
    if (after[field] !== undefined && before && JSON.stringify(after[field]) !== JSON.stringify(before[field]))
      reasons.push(`It changes ${field}, which can raise spend.`);
  }
  const cap = guard.dailyBudgetCap;
  const raisesDaily =
    after.daily_budget !== undefined && Number(after.daily_budget) > (Number(before?.daily_budget) || 0);
  const activates = after.status === "ACTIVE" && !wasActive;
  // A paused object does not spend, so only an active one, or one that this change turns on, counts.
  if (cap !== null && cap !== undefined && cap !== "" && ((wasActive && raisesDaily) || activates)) {
    const offset = await context.offset();
    const budgets = await activeDailyBudget(context);
    const ownNow = budgets.get(objectId) ?? 0;
    let total = 0;
    for (const value of budgets.values()) total += value;
    const ownAfter = Number(after.daily_budget ?? before?.daily_budget ?? 0) || 0;
    const projected = total - ownNow + ownAfter;
    const capMinor = Math.round(Number(cap) * offset);
    if (projected > capMinor)
      reasons.push(
        `The total active daily budget would be ${projected / offset}, above the cap of ${Number(cap)} (guard.dailyBudgetCap).`,
      );
  }
  return reasons;
}

/** Runs one change: the guard, then the request, then the audit line. */
async function change(context, { action, objectId, objectType, before, after, send }) {
  const changes = {};
  for (const [field, value] of Object.entries(after)) changes[field] = { from: before?.[field] ?? null, to: value };
  const reasons = await spendGuard(context, { objectId, before, after });
  const approved = context.options.approved === true;
  if (context.options["dry-run"])
    return {
      dryRun: true,
      action,
      objectId,
      objectType,
      changes,
      guard: { needsApproval: reasons.length > 0, reasons, approved },
    };
  if (reasons.length > 0 && !approved) {
    context.audit({ action, objectId, objectType, changes, approved: false, result: "refused", guard: reasons });
    throw new CliError("The spend guard refused this change. It needs the person's approval.", {
      exit: EXIT.refused,
      details: {
        refused: true,
        reasons,
        hint: "Ask the person with openbot.ask_ui (in a hands-off channel decide and call openbot.log_decision), then run the same command with --approved.",
      },
    });
  }
  const validate = context.options.validate === true;
  try {
    const response = await send(validate ? { execution_options: ["validate_only"] } : {});
    context.audit({
      action,
      objectId: objectId ?? response?.id ?? null,
      objectType,
      changes,
      approved,
      guard: reasons,
      result: validate ? "validated" : "ok",
      response: summarize(response),
    });
    return { ok: true, validated: validate || undefined, action, objectType, changes, response };
  } catch (error) {
    context.audit({
      action,
      objectId,
      objectType,
      changes,
      approved,
      guard: reasons,
      result: "error",
      error: error instanceof GraphError ? { code: error.code, subcode: error.subcode } : String(error.message),
    });
    throw error;
  }
}

function summarize(response) {
  if (!response || typeof response !== "object") return response;
  const keep = {};
  for (const [key, value] of Object.entries(response))
    if (typeof value !== "object" || value === null) keep[key] = value;
  if (Array.isArray(response.ad_object_ids)) keep.ad_object_ids = response.ad_object_ids;
  if (response.images) keep.images = response.images;
  return keep;
}

async function objectState(context, id, type = null) {
  const probes = type ? TYPE_PROBES.filter(([name]) => name === type) : TYPE_PROBES;
  if (type && probes.length === 0) throw new CliError("--type must be campaign, adset or ad.", { exit: EXIT.usage });
  let lastError = null;
  for (const [name, fields] of probes) {
    try {
      return { type: name, state: await context.graph.get(id, { fields }) };
    } catch (error) {
      if (error instanceof GraphError && error.code === 100) {
        lastError = error;
        continue;
      }
      throw error;
    }
  }
  throw lastError ?? new CliError("The object was not found.");
}

// ---------- commands ----------

const commands = {
  help: async () => ({ help: HELP }),

  async config(context, args) {
    const [sub, key, value] = args;
    if (sub === "show" || sub === undefined)
      return { home: context.home, settings: context.settings, auditLog: auditPath(context.home) };
    if (sub !== "set" || !key || value === undefined)
      throw new CliError("Use: config show, or config set <key> <value>.", { exit: EXIT.usage });
    const settings = structuredClone(context.settings);
    const before = JSON.stringify(settings);
    const loosens = [];
    if (key === "adAccountId") settings.adAccountId = normalizeAccountId(value);
    else if (key === "apiVersion") {
      if (!/^v[0-9]{1,3}\.[0-9]$/.test(value))
        throw new CliError("apiVersion must look like v27.0.", { exit: EXIT.usage });
      settings.apiVersion = value;
    } else if (key === "pageId") settings.pageId = graphId(value, "pageId");
    else if (key === "pixelId") settings.pixelId = graphId(value, "pixelId");
    else if (key.startsWith("guard.")) {
      const name = key.slice(6);
      if (!Object.hasOwn(DEFAULT_SETTINGS.guard, name))
        throw new CliError(`Unknown setting ${key}.`, { exit: EXIT.usage });
      const next = value === "none" || value === "null" ? null : Number(value);
      if (next !== null && (!Number.isFinite(next) || next < 0))
        throw new CliError(`${key} must be a number of 0 or more, or none.`, { exit: EXIT.usage });
      if (name !== "dailyBudgetCap" && next === null)
        throw new CliError(`${key} needs a number.`, { exit: EXIT.usage });
      const current = settings.guard[name];
      if (current !== null && (next === null || next > current))
        loosens.push(`${key} goes from ${current} to ${next}.`);
      settings.guard[name] = next;
    } else throw new CliError(`Unknown setting ${key}.`, { exit: EXIT.usage });
    if (loosens.length > 0 && context.options.approved !== true) {
      context.audit({
        action: "config",
        changes: { [key]: value },
        approved: false,
        result: "refused",
        guard: loosens,
      });
      throw new CliError(
        "A weaker spend guard needs the person's approval. Run again with --approved after they agree.",
        {
          exit: EXIT.refused,
          details: { refused: true, reasons: loosens },
        },
      );
    }
    if (JSON.stringify(settings) !== before) {
      saveSettings(context.home, settings);
      context.audit({
        action: "config",
        changes: { [key]: value },
        approved: context.options.approved === true,
        result: "ok",
      });
    }
    return { home: context.home, settings };
  },

  whoami: (context) => context.graph.get("me", { fields: "id,name" }),

  async accounts(context) {
    const result = await context.graph.list(
      "me/adaccounts",
      { fields: FIELDS.account },
      Number(context.options.limit ?? 200),
    );
    return { ...result, data: result.data.map((row) => withMoney(row, currencyOffset(row.currency))) };
  },

  async account(context) {
    const account = await context.account();
    return withMoney(account, currencyOffset(account.currency));
  },

  campaigns: (context) => listObjects(context, "campaigns", "campaign"),
  adsets: (context) => listObjects(context, "adsets", "adset"),
  ads: (context) => listObjects(context, "ads", "ad"),
  creatives: (context) => listObjects(context, "adcreatives", "creative"),
  audiences: (context) => listObjects(context, "customaudiences", "audience"),

  async get(context, args) {
    const id = args[0];
    if (!id) throw new CliError("Use: get <id> [--fields a,b].", { exit: EXIT.usage });
    const row = context.options.fields
      ? await context.graph.get(id, { fields: context.options.fields })
      : (await objectState(context, id, context.options.type ?? null)).state;
    return withMoney(row, await context.offset().catch(() => 100));
  },

  async insights(context) {
    const { options } = context;
    const level = String(options.level ?? "campaign");
    if (!LEVEL_ID_FIELDS[level])
      throw new CliError("--level must be account, campaign, adset or ad.", { exit: EXIT.usage });
    const query = {
      level,
      fields: options.fields ? String(options.fields) : `${LEVEL_ID_FIELDS[level]},${FIELDS.insights}`,
    };
    if (options.since || options.until) {
      if (
        !/^\d{4}-\d{2}-\d{2}$/.test(String(options.since ?? "")) ||
        !/^\d{4}-\d{2}-\d{2}$/.test(String(options.until ?? ""))
      )
        throw new CliError("--since and --until must both be dates like 2026-11-01.", { exit: EXIT.usage });
      query.time_range = { since: options.since, until: options.until };
    } else query.date_preset = String(options.preset ?? "last_7d");
    if (options.breakdowns) query.breakdowns = list(options.breakdowns).join(",");
    if (options["action-breakdowns"]) query.action_breakdowns = list(options["action-breakdowns"]).join(",");
    if (options["time-increment"]) query.time_increment = String(options["time-increment"]);
    if (options.filtering) query.filtering = readJsonOption(options, "filtering");
    if (options.sort) query.sort = list(options.sort);
    const object = options.object ? String(options.object) : context.accountId;
    const result = await context.graph.list(`${object}/insights`, query, Number(options.limit ?? 500));
    const actionType = options["action-type"] ? String(options["action-type"]) : null;
    const rows = result.data.map((row) => deriveMetrics(row, actionType));
    const totals = rows.reduce(
      (sum, row) => ({
        spend: sum.spend + (Number(row.spend) || 0),
        impressions: sum.impressions + (Number(row.impressions) || 0),
        clicks: sum.clicks + (Number(row.clicks) || 0),
        purchases: sum.purchases + row.purchases,
        purchase_value: sum.purchase_value + row.purchase_value,
        leads: sum.leads + row.leads,
      }),
      { spend: 0, impressions: 0, clicks: 0, purchases: 0, purchase_value: 0, leads: 0 },
    );
    const account = await context.account().catch(() => null);
    return {
      currency: account?.currency ?? null,
      level,
      period: query.time_range ?? query.date_preset,
      data: options.raw ? result.data : rows,
      truncated: result.truncated,
      totals: {
        ...totals,
        spend: round(totals.spend),
        cost_per_purchase: totals.purchases > 0 ? round(totals.spend / totals.purchases) : null,
        roas: totals.spend > 0 ? round(totals.purchase_value / totals.spend) : null,
        ctr: totals.impressions > 0 ? round((totals.clicks / totals.impressions) * 100) : null,
      },
    };
  },

  async review(context) {
    const account = await context.account();
    const problems = { account: null, campaigns: [], adsets: [], ads: [] };
    if (Number(account.account_status) !== 1)
      problems.account = {
        id: account.id,
        name: account.name,
        account_status: account.account_status,
        disable_reason: account.disable_reason,
      };
    const withIssues = ["WITH_ISSUES"];
    problems.campaigns = (
      await context.graph.list(
        `${context.accountId}/campaigns`,
        { fields: "id,name,effective_status,issues_info", effective_status: withIssues },
        500,
      )
    ).data;
    problems.adsets = (
      await context.graph.list(
        `${context.accountId}/adsets`,
        { fields: "id,name,campaign_id,effective_status,issues_info", effective_status: withIssues },
        500,
      )
    ).data;
    const statuses = list(context.options.status ?? "DISAPPROVED,WITH_ISSUES,PENDING_BILLING_INFO");
    problems.ads = (
      await context.graph.list(
        `${context.accountId}/ads`,
        {
          fields:
            "id,name,adset_id,campaign_id,effective_status,configured_status,ad_review_feedback,issues_info,updated_time",
          effective_status: statuses,
        },
        1000,
      )
    ).data;
    return problems;
  },

  async "lead-forms"(context) {
    const page = pageIdOf(context);
    const pageGraph = await pageScopedGraph(context, page);
    return pageGraph.list(
      `${page}/leadgen_forms`,
      { fields: "id,name,status,leads_count,created_time" },
      Number(context.options.limit ?? 200),
    );
  },

  async leads(context, args) {
    const form = graphId(args[0], "form_id");
    const page = context.options.page ?? context.settings.pageId;
    const graph = page ? await pageScopedGraph(context, graphId(page, "--page")) : context.graph;
    const since = context.options.since
      ? Date.parse(String(context.options.since))
      : Date.now() - Number(context.options.hours ?? 24) * 3600 * 1000;
    if (!Number.isFinite(since)) throw new CliError("--since must be an ISO time.", { exit: EXIT.usage });
    return graph.list(
      `${form}/leads`,
      {
        fields:
          "id,created_time,field_data,ad_id,ad_name,adset_id,campaign_id,campaign_name,form_id,platform,is_organic",
        filtering: [{ field: "time_created", operator: "GREATER_THAN", value: Math.floor(since / 1000) }],
      },
      Number(context.options.limit ?? 500),
    );
  },

  async audit(context) {
    const tail = Number(context.options.tail ?? 20);
    const entries = readAudit(context.home);
    return { path: auditPath(context.home), entries: entries.slice(-Math.max(1, tail)) };
  },

  async "create-campaign"(context) {
    const { options } = context;
    const offset = await context.offset();
    const params = {
      name: requireOption(options, "name"),
      objective: requireOption(options, "objective", "For example OUTCOME_SALES, OUTCOME_LEADS or OUTCOME_TRAFFIC."),
      special_ad_categories: list(options["special-ad-categories"]),
      ...(readJsonOption(options, "params") ?? {}),
    };
    if (options["daily-budget"]) params.daily_budget = toMinor(options["daily-budget"], offset);
    if (options["lifetime-budget"]) params.lifetime_budget = toMinor(options["lifetime-budget"], offset);
    if (options["bid-strategy"]) params.bid_strategy = String(options["bid-strategy"]);
    if (
      params.daily_budget === undefined &&
      params.lifetime_budget === undefined &&
      params.is_adset_budget_sharing_enabled === undefined
    )
      params.is_adset_budget_sharing_enabled = options["budget-sharing"] === true;
    return createObject(context, "campaign", `${context.accountId}/campaigns`, params);
  },

  async "create-adset"(context) {
    const { options } = context;
    const offset = await context.offset();
    const params = {
      name: requireOption(options, "name"),
      campaign_id: graphId(requireOption(options, "campaign"), "--campaign"),
      optimization_goal: requireOption(options, "optimization-goal", "For example OFFSITE_CONVERSIONS or LINK_CLICKS."),
      billing_event: String(options["billing-event"] ?? "IMPRESSIONS"),
      ...(readJsonOption(options, "params") ?? {}),
    };
    const targeting = readJsonOption(options, "targeting");
    if (targeting) params.targeting = targeting;
    const promoted = readJsonOption(options, "promoted-object");
    if (promoted) params.promoted_object = promoted;
    if (options["daily-budget"]) params.daily_budget = toMinor(options["daily-budget"], offset);
    if (options["lifetime-budget"]) params.lifetime_budget = toMinor(options["lifetime-budget"], offset);
    if (options["bid-amount"]) params.bid_amount = toMinor(options["bid-amount"], offset);
    if (options["bid-strategy"]) params.bid_strategy = String(options["bid-strategy"]);
    if (options["start-time"]) params.start_time = String(options["start-time"]);
    if (options["end-time"]) params.end_time = String(options["end-time"]);
    if (!params.targeting)
      throw new CliError('--targeting is required, for example {"geo_locations":{"countries":["US"]}}.', {
        exit: EXIT.usage,
      });
    return createObject(context, "adset", `${context.accountId}/adsets`, params);
  },

  async "create-creative"(context) {
    const { options } = context;
    let spec = readJsonOption(options, "spec");
    if (!spec) {
      const pageId = graphId(options["page-id"] ?? context.settings.pageId, "--page-id");
      const cta = options.cta ? { type: String(options.cta), value: { link: options.link } } : undefined;
      if (options["video-id"]) {
        spec = {
          page_id: pageId,
          video_data: {
            video_id: graphId(options["video-id"], "--video-id"),
            message: options.message,
            title: options.headline,
            link_description: options.description,
            image_url: options["image-url"],
            image_hash: options["image-hash"],
            call_to_action: cta ?? (options.link ? { type: "LEARN_MORE", value: { link: options.link } } : undefined),
          },
        };
      } else {
        spec = {
          page_id: pageId,
          link_data: {
            link: requireOption(options, "link"),
            message: options.message,
            name: options.headline,
            description: options.description,
            image_hash: requireOption(options, "image-hash", "Upload the image first with upload-image."),
            call_to_action: cta,
          },
        };
      }
      if (options["instagram-user-id"])
        spec.instagram_user_id = graphId(options["instagram-user-id"], "--instagram-user-id");
    }
    const params = {
      name: requireOption(options, "name"),
      object_story_spec: dropEmpty(spec),
      ...(readJsonOption(options, "params") ?? {}),
    };
    return createObject(context, "creative", `${context.accountId}/adcreatives`, params);
  },

  async "create-ad"(context) {
    const { options } = context;
    const params = {
      name: requireOption(options, "name"),
      adset_id: graphId(requireOption(options, "adset"), "--adset"),
      creative: { creative_id: graphId(requireOption(options, "creative"), "--creative") },
      ...(readJsonOption(options, "params") ?? {}),
    };
    return createObject(context, "ad", `${context.accountId}/ads`, params);
  },

  pause: (context, args) => setStatus(context, args, "PAUSED"),
  resume: (context, args) => setStatus(context, args, "ACTIVE"),

  async "set-budget"(context, args) {
    const id = graphId(args[0], "<id>");
    const { type, state } = await objectState(context, id, context.options.type ?? null);
    if (type === "ad") throw new CliError("An ad has no budget. Change its ad set or campaign.", { exit: EXIT.usage });
    const offset = await context.offset();
    const after = {};
    if (context.options.daily) after.daily_budget = toMinor(context.options.daily, offset);
    else if (context.options.lifetime) after.lifetime_budget = toMinor(context.options.lifetime, offset);
    else throw new CliError("Use --daily X or --lifetime X (normal currency units).", { exit: EXIT.usage });
    const result = await change(context, {
      action: "set-budget",
      objectId: id,
      objectType: type,
      before: state,
      after,
      send: (extra) => context.graph.post(id, { ...after, ...extra }),
    });
    return { ...result, currencyOffset: offset };
  },

  async "set-bid"(context, args) {
    const id = graphId(args[0], "<adset_id>");
    const { type, state } = await objectState(context, id, "adset");
    const after = { bid_amount: toMinor(requireOption(context.options, "bid"), await context.offset()) };
    return change(context, {
      action: "set-bid",
      objectId: id,
      objectType: type,
      before: state,
      after,
      send: (extra) => context.graph.post(id, { ...after, ...extra }),
    });
  },

  async update(context, args) {
    const id = graphId(args[0], "<id>");
    const after = readJsonOption(context.options, "params");
    if (!after || typeof after !== "object" || Array.isArray(after))
      throw new CliError("--params must be a JSON object of the fields to change.", { exit: EXIT.usage });
    const { type, state } = await objectState(context, id, context.options.type ?? null);
    const before = { ...state };
    // A field that the type probe did not read is read now, so the guard compares real values.
    const unread = Object.keys(after).filter(
      (field) =>
        before[field] === undefined &&
        ["bid_constraints", "spend_cap", "lifetime_budget", "daily_budget"].includes(field),
    );
    if (unread.length > 0)
      Object.assign(before, await context.graph.get(id, { fields: unread.join(",") }).catch(() => ({})));
    return change(context, {
      action: "update",
      objectId: id,
      objectType: type,
      before,
      after,
      send: (extra) => context.graph.post(id, { ...after, ...extra }),
    });
  },

  async duplicate(context, args) {
    const id = graphId(args[0], "<id>");
    const { options } = context;
    const { type, state } = await objectState(context, id, options.type ?? null);
    const activate = options.activate === true;
    const params = {
      status_option: activate ? "ACTIVE" : "PAUSED",
      rename_options: { rename_suffix: String(options.suffix ?? " - copy") },
    };
    if (options.deep && type !== "ad") params.deep_copy = true;
    if (options["to-campaign"] && type === "adset")
      params.campaign_id = graphId(options["to-campaign"], "--to-campaign");
    if (options["to-adset"] && type === "ad") params.adset_id = graphId(options["to-adset"], "--to-adset");
    return change(context, {
      action: "duplicate",
      objectId: id,
      objectType: type,
      // A copy is a new object: it spends only when it is turned on.
      before: { ...state, status: "PAUSED", daily_budget: undefined },
      after: activate ? { status: "ACTIVE" } : {},
      send: (extra) => context.graph.post(`${id}/copies`, { ...params, ...extra }),
    });
  },

  async "upload-image"(context, args) {
    const file = args[0];
    if (!file) throw new CliError("Use: upload-image <file>.", { exit: EXIT.usage });
    const bytes = readUpload(file);
    const name = basename(file);
    return change(context, {
      action: "upload-image",
      objectId: null,
      objectType: "image",
      before: null,
      after: {},
      send: (extra) =>
        context.graph.post(`${context.accountId}/adimages`, { bytes: bytes.toString("base64"), name, ...extra }),
    }).then((result) => {
      const images = result.response?.images ?? {};
      const first = Object.values(images)[0];
      return { ...result, hash: first?.hash ?? null, url: first?.url ?? null };
    });
  },

  async "upload-video"(context, args) {
    const { options } = context;
    const name = options.name ? String(options.name) : args[0] ? basename(args[0]) : "video";
    let send;
    if (options.url)
      send = (extra) =>
        context.graph.post(`${context.accountId}/advideos`, { file_url: String(options.url), name, ...extra });
    else {
      if (!args[0]) throw new CliError("Use: upload-video <file> or --url URL.", { exit: EXIT.usage });
      const bytes = readUpload(args[0]);
      send = () => {
        const form = new FormData();
        form.append("name", name);
        form.append("source", new Blob([bytes]), basename(args[0]));
        return context.graph.request("POST", `${context.accountId}/advideos`, { multipart: form });
      };
    }
    return change(context, {
      action: "upload-video",
      objectId: null,
      objectType: "video",
      before: null,
      after: {},
      send,
    });
  },

  async "create-audience"(context) {
    const { options } = context;
    const params = {
      name: requireOption(options, "name"),
      subtype: String(options.subtype ?? "CUSTOM"),
      description: options.description,
      ...(readJsonOption(options, "params") ?? {}),
    };
    if (params.subtype === "CUSTOM" && !params.customer_file_source) params.customer_file_source = "USER_PROVIDED_ONLY";
    const rule = readJsonOption(options, "rule");
    if (rule) params.rule = rule;
    if (options.origin) {
      params.subtype = "LOOKALIKE";
      params.origin_audience_id = graphId(options.origin, "--origin");
      params.lookalike_spec = readJsonOption(options, "lookalike-spec");
      if (!params.lookalike_spec) throw new CliError("A lookalike needs --lookalike-spec JSON.", { exit: EXIT.usage });
      delete params.customer_file_source;
    }
    return change(context, {
      action: "create-audience",
      objectId: null,
      objectType: "audience",
      before: null,
      after: {},
      send: (extra) => context.graph.post(`${context.accountId}/customaudiences`, { ...dropEmpty(params), ...extra }),
    });
  },

  async "add-audience-users"(context, args) {
    const id = graphId(args[0], "<audience_id>");
    const { options } = context;
    let schema;
    let values;
    if (options["emails-file"]) {
      schema = "EMAIL_SHA256";
      values = readLines(String(options["emails-file"])).map((value) => hashValue(value, "email"));
    } else if (options["phones-file"]) {
      schema = "PHONE_SHA256";
      values = readLines(String(options["phones-file"])).map((value) => hashValue(value, "phone"));
    } else throw new CliError("Use --emails-file F or --phones-file F (one value per line).", { exit: EXIT.usage });
    values = values.filter(Boolean);
    if (values.length === 0 || values.length > 10000)
      throw new CliError("Send 1 to 10000 values in one call.", { exit: EXIT.usage });
    const result = await change(context, {
      action: "add-audience-users",
      objectId: id,
      objectType: "audience",
      before: null,
      after: {},
      send: (extra) =>
        context.graph.post(`${id}/users`, { payload: { schema, data: values.map((value) => [value]) }, ...extra }),
    });
    return { ...result, sent: values.length };
  },

  async "capi-send"(context) {
    const { options } = context;
    const pixel = graphId(options.pixel ?? context.settings.pixelId, "--pixel");
    let data = readJsonOption(options, "data");
    if (!data) {
      const userData = dropEmpty({
        em: options.email ? [hashValue(String(options.email), "email")] : undefined,
        ph: options.phone ? [hashValue(String(options.phone), "phone")] : undefined,
        external_id: options["external-id"] ? [hashValue(String(options["external-id"]), "text")] : undefined,
        client_ip_address: options["client-ip"],
        client_user_agent: options["user-agent"],
        fbc: options.fbc,
        fbp: options.fbp,
      });
      if (Object.keys(userData).length === 0)
        throw new CliError(
          "Give at least one customer value: --email, --phone, --external-id, --client-ip with --user-agent, --fbc or --fbp.",
          {
            exit: EXIT.usage,
          },
        );
      data = [
        dropEmpty({
          event_name: requireOption(options, "event"),
          event_time: Number(options["event-time"] ?? Math.floor(Date.now() / 1000)),
          event_id: options["event-id"],
          action_source: String(options["action-source"] ?? "website"),
          event_source_url: options["event-source-url"],
          user_data: userData,
          custom_data:
            options.value !== undefined
              ? { value: Number(options.value), currency: requireOption(options, "currency") }
              : undefined,
        }),
      ];
    } else {
      data = (Array.isArray(data) ? data : [data]).map(hashEventUserData);
    }
    return change(context, {
      action: "capi-send",
      objectId: pixel,
      objectType: "pixel",
      before: null,
      after: {},
      send: (extra) =>
        context.graph.post(`${pixel}/events`, {
          data,
          test_event_code: options["test-code"],
          ...extra,
        }),
    });
  },
};

async function listObjects(context, edge, type) {
  const { options } = context;
  let parent = context.accountId;
  if (options.adset && type === "ad") parent = graphId(options.adset, "--adset");
  else if (options.campaign && (type === "adset" || type === "ad")) parent = graphId(options.campaign, "--campaign");
  const query = { fields: String(options.fields ?? FIELDS[type]) };
  const statuses = list(options.status);
  if (statuses.length > 0) query.effective_status = statuses;
  const result = await context.graph.list(`${parent}/${edge}`, query, Number(options.limit ?? 200));
  const offset = await context.offset().catch(() => 100);
  return { ...result, count: result.data.length, data: result.data.map((row) => withMoney(row, offset)) };
}

async function createObject(context, type, path, params) {
  const activate = context.options.activate === true;
  const after = { ...params, status: activate ? "ACTIVE" : "PAUSED" };
  if (type === "creative") delete after.status;
  const guarded = {};
  for (const field of ["status", "daily_budget", "lifetime_budget", "bid_amount"])
    if (after[field] !== undefined) guarded[field] = after[field];
  return change(context, {
    action: `create-${type}`,
    objectId: null,
    objectType: type,
    before: null,
    after: guarded,
    send: (extra) => context.graph.post(path, { ...after, ...extra }),
  });
}

async function setStatus(context, args, status) {
  if (args.length === 0)
    throw new CliError(`Use: ${status === "PAUSED" ? "pause" : "resume"} <id>...`, { exit: EXIT.usage });
  const results = [];
  for (const raw of args) {
    const id = graphId(raw, "<id>");
    const { type, state } = await objectState(context, id, context.options.type ?? null);
    results.push(
      await change(context, {
        action: status === "PAUSED" ? "pause" : "resume",
        objectId: id,
        objectType: type,
        before: state,
        after: { status },
        send: (extra) => context.graph.post(id, { status, ...extra }),
      }),
    );
  }
  return { results };
}

function pageIdOf(context) {
  return graphId(context.options.page ?? context.settings.pageId, "--page (or config set pageId)");
}

/** Lead forms belong to the page. A page token, when the system user may read it, has the page's permissions. */
async function pageScopedGraph(context, pageId) {
  const page = await context.graph.get(pageId, { fields: "access_token" }).catch(() => null);
  if (!page?.access_token) return context.graph;
  const graph = new Graph({
    token: page.access_token,
    appSecret: readAppSecret(context.options),
    version: context.graph.version,
    maxWaitSeconds: context.graph.maxWaitSeconds,
    backoffBaseMs: context.graph.backoffBaseMs,
  });
  graph.pageToken = true;
  return graph;
}

function readUpload(file) {
  let info;
  try {
    info = statSync(file);
  } catch {
    throw new CliError(`Cannot read ${file}.`, { exit: EXIT.usage });
  }
  if (!info.isFile() || info.size > MAX_UPLOAD_BYTES)
    throw new CliError("Upload a regular file of at most 100 MB. For a larger video use --url.", { exit: EXIT.usage });
  return readFileSync(file);
}

function readLines(file) {
  return readFileSync(file, "utf8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

/** Meta wants customer data normalized and hashed with SHA-256. A value that is already a hash stays. */
export function hashValue(value, kind) {
  const text = String(value).trim();
  if (/^[a-f0-9]{64}$/.test(text)) return text;
  let normal = text.toLowerCase();
  if (kind === "phone") normal = text.replace(/[^0-9]/g, "").replace(/^0+/, "");
  if (!normal) return null;
  return createHash("sha256").update(normal).digest("hex");
}

function hashEventUserData(event) {
  if (!event || typeof event !== "object" || !event.user_data) return event;
  const user = { ...event.user_data };
  for (const [field, kind] of [
    ["em", "email"],
    ["ph", "phone"],
    ["external_id", "text"],
    ["fn", "text"],
    ["ln", "text"],
    ["ct", "text"],
    ["st", "text"],
    ["zp", "text"],
    ["country", "text"],
  ]) {
    if (user[field] === undefined) continue;
    const values = Array.isArray(user[field]) ? user[field] : [user[field]];
    user[field] = values.map((value) => hashValue(value, kind)).filter(Boolean);
  }
  return { ...event, user_data: user };
}

function dropEmpty(value) {
  if (Array.isArray(value)) return value.map(dropEmpty);
  if (!value || typeof value !== "object") return value;
  const result = {};
  for (const [key, entry] of Object.entries(value))
    if (entry !== undefined && entry !== null && entry !== "") result[key] = dropEmpty(entry);
  return result;
}

// ---------- main ----------

function redact(text, secrets) {
  let result = String(text);
  for (const secret of secrets) if (secret && secret.length >= 8) result = result.split(secret).join("[REDACTED]");
  return result;
}

export async function main(argv) {
  let context = null;
  const write = (stream, value) => {
    const secrets = [context?.graphClient?.token];
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
    if (!command) throw new CliError(`Unknown command ${name}. Run: meta-ads help`, { exit: EXIT.usage });
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
    if (error instanceof GraphError) {
      write(process.stderr, { error: describeGraphError(error) });
      return EXIT.error;
    }
    write(process.stderr, {
      error: { message: "Unexpected failure in meta-ads.", detail: String(error?.message ?? error) },
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
