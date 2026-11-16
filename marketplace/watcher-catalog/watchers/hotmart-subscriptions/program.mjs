import { pathToFileURL } from "node:url";

// Read-only check of Hotmart subscriptions. It lists the subscriptions in the chosen statuses: the
// cancelled ones (by the customer, the seller or Hotmart) whose cancellation falls in the last days,
// and the late ones (DELAYED, OVERDUE) now. The item ID is `subscriber_code:status`, so a subscription
// wakes the agent once when it reaches a status. Hotmart signs in with OAuth client credentials: the
// program asks for one access token for each run and keeps it only in memory.
const OFFICIAL_API_BASE_URL = "https://developers.hotmart.com";
const SANDBOX_API_BASE_URL = "https://sandbox.hotmart.com";
const OFFICIAL_AUTH_BASE_URL = "https://api-sec-vlc.hotmart.com";
const TOKEN_PATH = "/security/oauth/token";
const SUBSCRIPTIONS_PATH = "/payments/api/v1/subscriptions";
// Hotmart reads only the subscriptions that started in the last 30 days unless accession_date is set.
const ALL_SUBSCRIPTIONS_SINCE = Date.UTC(2010, 0, 1);
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 12000;
const MAX_REQUESTS = 40;
const MAX_ITEMS = 2000;
const PAGE_SIZE = 500;
// The longest rate-limit wait inside one run. A longer wait fails with rate_limited, and OpenBot backs off.
const MAX_RATE_WAIT_SECONDS = 5;
// Explicit uncertainty marker, never a user identity. Hotmart does not say who changed a subscription.
export const UNKNOWN_ACTOR = "unknown";
const ERROR_CODES = ["auth", "rate_limited", "config", "upstream"];
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
const CANCELLED = new Set(["CANCELLED_BY_CUSTOMER", "CANCELLED_BY_SELLER", "CANCELLED_BY_ADMIN"]);
const DEFAULT_STATUSES = ["CANCELLED_BY_CUSTOMER", "CANCELLED_BY_SELLER", "CANCELLED_BY_ADMIN", "DELAYED", "OVERDUE"];

/** A failure with fixed wording. The optional code is one of ERROR_CODES; OpenBot maps it to its own text. */
export class WatcherError extends Error {
  constructor(message, code = null) {
    super(message);
    this.code = ERROR_CODES.includes(code) ? code : null;
  }
}

function requireCondition(condition, message, code = null) {
  if (!condition) throw new WatcherError(message, code);
}

function readBaseUrl(env, name, fallback) {
  const override = env[name];
  if (!override) return fallback;
  let url;
  try {
    url = new URL(override);
  } catch {
    throw new WatcherError(`${name} is not valid.`, "config");
  }
  const loopback = url.protocol === "http:" && ["127.0.0.1", "localhost"].includes(url.hostname);
  requireCondition(url.protocol === "https:" || loopback, `${name} must use https.`, "config");
  return url.origin;
}

export function readConfiguration(input) {
  requireCondition(input && typeof input === "object" && !Array.isArray(input), "Expected a JSON object.", "config");
  requireCondition(
    input.cursor === undefined || input.cursor === null || input.cursor === "",
    "Unexpected paging cursor.",
    "config",
  );
  const statuses = String(input.statuses ?? "")
    .split(",")
    .map((status) => status.trim().toUpperCase())
    .filter(Boolean);
  const chosen = statuses.length > 0 ? [...new Set(statuses)] : DEFAULT_STATUSES;
  requireCondition(
    chosen.every((status) => SUBSCRIPTION_STATUSES.includes(status)),
    `statuses must be Hotmart subscription statuses from: ${SUBSCRIPTION_STATUSES.join(", ")}.`,
    "config",
  );
  const productIds = String(input.productIds ?? "")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);
  requireCondition(
    productIds.length <= 5 && productIds.every((id) => /^[0-9]{1,20}$/.test(id)),
    "productIds must be at most 5 numeric Hotmart product IDs separated by commas, or empty for every product.",
    "config",
  );
  const lookback = String(input.lookbackDays ?? "").trim() === "" ? 7 : Number(input.lookbackDays);
  requireCondition(
    Number.isInteger(lookback) && lookback >= 1 && lookback <= 120,
    "lookbackDays must be a whole number from 1 to 120.",
    "config",
  );
  return {
    statuses: chosen,
    productIds,
    lookbackDays: lookback,
    sandbox: String(input.sandbox ?? "false").trim() === "true",
  };
}

/** The three private variables. The Basic value may keep its "Basic " prefix. */
export function readCredentials(env) {
  const values = {};
  for (const name of ["HOTMART_CLIENT_ID", "HOTMART_CLIENT_SECRET", "HOTMART_BASIC"]) {
    const value = typeof env[name] === "string" ? env[name].trim() : "";
    requireCondition(value.length > 0, `Missing ${name} private variable.`, "auth");
    values[name] = name === "HOTMART_BASIC" ? value.replace(/^Basic\s+/i, "") : value;
    requireCondition(!/\s/.test(values[name]), `Invalid ${name} private variable.`, "auth");
  }
  return {
    clientId: values.HOTMART_CLIENT_ID,
    clientSecret: values.HOTMART_CLIENT_SECRET,
    basic: values.HOTMART_BASIC,
  };
}

async function readBody(response) {
  requireCondition(
    response.body && typeof response.body.getReader === "function",
    "Missing API response body.",
    "upstream",
  );
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      total += value.byteLength;
      requireCondition(total <= MAX_RESPONSE_BYTES, "API response exceeds the safe size limit.", "upstream");
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  const text = Buffer.concat(chunks).toString("utf8");
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new WatcherError("Invalid JSON API response.", "upstream");
  }
}

function hotmartFailure(status, body, signIn) {
  const error = typeof body?.error === "string" ? body.error : "";
  if (status === 429 || error === "too_many_requests")
    return new WatcherError("Hotmart rate limit reached.", "rate_limited");
  if (signIn && status >= 400 && status < 500)
    return new WatcherError("Hotmart refused the credentials. Check the three HOTMART_ private variables.", "auth");
  if (status === 401) return new WatcherError("Hotmart refused the access token.", "auth");
  if (status === 403) return new WatcherError("These Hotmart credentials may not read subscriptions.", "auth");
  if (status === 400 || status === 404)
    return new WatcherError("Hotmart refused the request. Check statuses and productIds.", "config");
  return new WatcherError(`Hotmart API HTTP ${status || "error"}.`, "upstream");
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

/** Read-only Hotmart client: one access token per run, GET only, bounded requests, no redirects. */
export function createHotmart({ credentials, sandbox, fetchImpl = fetch, env = process.env }) {
  const base = readBaseUrl(env, "HOTMART_API_BASE_URL", sandbox ? SANDBOX_API_BASE_URL : OFFICIAL_API_BASE_URL);
  const authBase = readBaseUrl(env, "HOTMART_AUTH_BASE_URL", OFFICIAL_AUTH_BASE_URL);
  let requests = 0;
  let accessToken = null;
  async function send(url, init, signIn) {
    for (let attempt = 0; ; attempt += 1) {
      requests += 1;
      requireCondition(
        requests <= MAX_REQUESTS,
        "Too many API requests for one check. Choose fewer statuses.",
        "config",
      );
      let response;
      try {
        response = await fetchImpl(url, {
          ...init,
          redirect: "error",
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
      } catch {
        throw new WatcherError("Hotmart API request failed or timed out.", "upstream");
      }
      const body = await readBody(response);
      if (response.ok) return body;
      const reset = Number(response.headers.get("ratelimit-reset"));
      // A short wait for the next minute fits in one run; a longer one is OpenBot's back-off.
      if (response.status === 429 && attempt === 0 && Number.isFinite(reset) && reset <= MAX_RATE_WAIT_SECONDS) {
        await sleep(reset * 1000);
        continue;
      }
      throw hotmartFailure(response.status, body, signIn);
    }
  }
  async function token() {
    if (accessToken) return accessToken;
    const url = new URL(`${authBase}${TOKEN_PATH}`);
    url.searchParams.set("grant_type", "client_credentials");
    url.searchParams.set("client_id", credentials.clientId);
    url.searchParams.set("client_secret", credentials.clientSecret);
    // The token request is a sign-in; it changes nothing in the account.
    const body = await send(
      url,
      {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          Authorization: `Basic ${credentials.basic}`,
        },
      },
      true,
    );
    requireCondition(
      typeof body?.access_token === "string" && body.access_token && !/\s/.test(body.access_token),
      "Hotmart sent no access token.",
      "upstream",
    );
    accessToken = body.access_token;
    return accessToken;
  }
  async function get(path, query) {
    const url = new URL(`${base}${path}`);
    for (const [key, value] of Object.entries(query))
      if (Array.isArray(value)) for (const item of value) url.searchParams.append(key, String(item));
      else if (value !== undefined && value !== null && value !== "") url.searchParams.set(key, String(value));
    const bearer = await token();
    return send(
      url,
      { method: "GET", headers: { Accept: "application/json", Authorization: `Bearer ${bearer}` } },
      false,
    );
  }
  async function list(path, query) {
    const rows = [];
    let pageToken;
    for (;;) {
      const page = await get(path, { ...query, max_results: PAGE_SIZE, page_token: pageToken });
      requireCondition(Array.isArray(page?.items), "Unexpected Hotmart API list.", "upstream");
      rows.push(...page.items);
      requireCondition(
        rows.length <= MAX_ITEMS,
        "Too many subscriptions for one check. Choose fewer statuses.",
        "config",
      );
      const next = page.page_info?.next_page_token;
      if (typeof next !== "string" || !next || page.items.length === 0) return rows;
      pageToken = next;
    }
  }
  return { list };
}

function isoTime(value) {
  const number = Number(value);
  if (value === undefined || value === null || value === "" || !Number.isFinite(number)) return null;
  return new Date(number < 1e11 ? number * 1000 : number).toISOString();
}

export function subscriptionItem(row) {
  const status = String(row?.status ?? "").toUpperCase();
  const price = Number(row?.price?.value);
  return {
    id: `${row.subscriber_code}:${status}`,
    revision: status,
    actor: UNKNOWN_ACTOR,
    subscriberCode: String(row.subscriber_code),
    subscriptionId: row?.subscription_id ?? null,
    status,
    productId: row?.product?.id ?? null,
    productName: row?.product?.name ?? "",
    planId: row?.plan?.id ?? null,
    planName: row?.plan?.name ?? "",
    recurrencyPeriodDays: row?.plan?.recurrency_period ?? null,
    value: Number.isFinite(price) ? price : null,
    currency: row?.price?.currency_code ?? null,
    trial: row?.trial ?? null,
    transaction: row?.transaction ?? null,
    accessionDate: isoTime(row?.accession_date),
    endAccessionDate: isoTime(row?.end_accession_date),
    dateNextCharge: isoTime(row?.date_next_charge),
    subscriberName: row?.subscriber?.name ?? "",
    subscriberEmail: row?.subscriber?.email ?? "",
  };
}

/** Lists the cancelled subscriptions of the last days and the late ones, and answers one item per subscription and status. */
export async function runWatcher(input, { env = process.env, fetchImpl = fetch, now = () => Date.now() } = {}) {
  const credentials = readCredentials(env);
  const config = readConfiguration(input);
  const hotmart = createHotmart({ credentials, sandbox: config.sandbox, fetchImpl, env });
  const end = now();
  const cancelled = config.statuses.filter((status) => CANCELLED.has(status));
  const others = config.statuses.filter((status) => !CANCELLED.has(status));
  const products = config.productIds.length > 0 ? config.productIds : [undefined];
  const queries = [];
  // The status filter takes several values when the key repeats. Cancellations are read by their date.
  if (cancelled.length > 0)
    queries.push({
      status: cancelled,
      accession_date: ALL_SUBSCRIPTIONS_SINCE,
      cancelation_date: end - config.lookbackDays * 86_400_000,
      end_cancelation_date: end,
    });
  if (others.length > 0) queries.push({ status: others, accession_date: ALL_SUBSCRIPTIONS_SINCE });
  const items = new Map();
  for (const query of queries) {
    for (const productId of products) {
      const rows = await hotmart.list(SUBSCRIPTIONS_PATH, { ...query, product_id: productId });
      for (const row of rows) {
        if (row?.subscriber_code === undefined || row?.subscriber_code === null || row.subscriber_code === "") continue;
        const item = subscriptionItem(row);
        if (!config.statuses.includes(item.status)) continue;
        items.set(item.id, item);
      }
      requireCondition(
        items.size <= MAX_ITEMS,
        "Too many subscriptions for one check. Choose fewer statuses.",
        "config",
      );
    }
  }
  return { items: [...items.values()], hasNextPage: false, cursor: null };
}

async function main() {
  try {
    let stdin = "";
    for await (const chunk of process.stdin) {
      stdin += chunk.toString("utf8");
      requireCondition(Buffer.byteLength(stdin) <= 32768, "Watcher input exceeds the safe size limit.");
    }
    let input;
    try {
      input = JSON.parse(stdin);
    } catch {
      throw new WatcherError("Invalid watcher input JSON.");
    }
    process.stdout.write(JSON.stringify(await runWatcher(input)));
  } catch (error) {
    process.stderr.write(
      `Hotmart subscriptions watcher: ${error instanceof WatcherError ? error.message : "Watcher failed."}\n`,
    );
    // One code, no text from Hotmart: OpenBot maps it to its own message.
    if (error instanceof WatcherError && error.code) process.stderr.write(`openbot-error: ${error.code}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
