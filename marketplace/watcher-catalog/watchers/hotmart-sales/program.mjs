import { pathToFileURL } from "node:url";

// Read-only check of the Hotmart sales history. It reads the sales of the last days once for each
// chosen status and answers one item per sale and status. The item ID is `transaction:status`, so a
// sale wakes the agent once when it reaches a status, and once more when its status changes (for
// example APPROVED, then REFUNDED or CHARGEBACK). Hotmart signs in with OAuth client credentials:
// the program asks for one access token for each run and keeps it only in memory.
const OFFICIAL_API_BASE_URL = "https://developers.hotmart.com";
const SANDBOX_API_BASE_URL = "https://sandbox.hotmart.com";
const OFFICIAL_AUTH_BASE_URL = "https://api-sec-vlc.hotmart.com";
const TOKEN_PATH = "/security/oauth/token";
const HISTORY_PATH = "/payments/api/v1/sales/history";
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 12000;
const MAX_REQUESTS = 40;
const MAX_ITEMS = 2000;
const PAGE_SIZE = 500;
// The longest rate-limit wait inside one run. A longer wait fails with rate_limited, and OpenBot backs off.
const MAX_RATE_WAIT_SECONDS = 5;
// Explicit uncertainty marker, never a user identity. A buyer outside the account makes each sale.
export const UNKNOWN_ACTOR = "unknown";
const ERROR_CODES = ["auth", "rate_limited", "config", "upstream"];
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
const DEFAULT_STATUSES = [
  "APPROVED",
  "COMPLETE",
  "REFUNDED",
  "PARTIALLY_REFUNDED",
  "CHARGEBACK",
  "CANCELLED",
  "PROTESTED",
];

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
    chosen.every((status) => SALE_STATUSES.includes(status)),
    `statuses must be Hotmart sale statuses from: ${SALE_STATUSES.join(", ")}.`,
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
  const lookback = String(input.lookbackDays ?? "").trim() === "" ? 30 : Number(input.lookbackDays);
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
  if (status === 403) return new WatcherError("These Hotmart credentials may not read sales.", "auth");
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
      requireCondition(requests <= MAX_REQUESTS, "Too many API requests for one check. Use fewer days.", "config");
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
      if (value !== undefined && value !== null && value !== "") url.searchParams.set(key, String(value));
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
      requireCondition(rows.length <= MAX_ITEMS, "Too many sales for one check. Use fewer lookbackDays.", "config");
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

export function saleItem(sale, status) {
  const purchase = sale?.purchase ?? {};
  const transaction = String(purchase.transaction ?? "");
  const price = Number(purchase.price?.value);
  return {
    id: `${transaction}:${status}`,
    revision: status,
    actor: UNKNOWN_ACTOR,
    transaction,
    status,
    productId: sale?.product?.id ?? null,
    productName: sale?.product?.name ?? "",
    value: Number.isFinite(price) ? price : null,
    currency: purchase.price?.currency_code ?? null,
    paymentType: purchase.payment?.type ?? null,
    installments: purchase.payment?.installments_number ?? null,
    isSubscription: purchase.is_subscription ?? null,
    recurrencyNumber: purchase.recurrency_number ?? null,
    offerCode: purchase.offer?.code ?? null,
    commissionAs: purchase.commission_as ?? null,
    orderDate: isoTime(purchase.order_date),
    approvedDate: isoTime(purchase.approved_date),
    warrantyExpireDate: isoTime(purchase.warranty_expire_date),
    src: purchase.tracking?.source ?? null,
    sck: purchase.tracking?.source_sck ?? null,
    xcod: purchase.tracking?.external_code ?? null,
    buyerName: sale?.buyer?.name ?? "",
    buyerEmail: sale?.buyer?.email ?? "",
  };
}

/** Reads the sales of the last days for each status (and each product) and answers one item per sale and status. */
export async function runWatcher(input, { env = process.env, fetchImpl = fetch, now = () => Date.now() } = {}) {
  const credentials = readCredentials(env);
  const config = readConfiguration(input);
  const hotmart = createHotmart({ credentials, sandbox: config.sandbox, fetchImpl, env });
  const end = now();
  const start = end - config.lookbackDays * 86_400_000;
  const products = config.productIds.length > 0 ? config.productIds : [undefined];
  const items = new Map();
  // Hotmart documents transaction_status as one value and answers only APPROVED and COMPLETE without
  // it, so each status is its own query.
  for (const status of config.statuses) {
    for (const productId of products) {
      const sales = await hotmart.list(HISTORY_PATH, {
        transaction_status: status,
        product_id: productId,
        start_date: start,
        end_date: end,
      });
      for (const sale of sales) {
        // The sale's own status counts. A sale in a status the user did not choose is left out.
        const actual = String(sale?.purchase?.status ?? status).toUpperCase();
        if (!sale?.purchase?.transaction || !config.statuses.includes(actual)) continue;
        const item = saleItem(sale, actual);
        items.set(item.id, item);
      }
      requireCondition(items.size <= MAX_ITEMS, "Too many sales for one check. Use fewer lookbackDays.", "config");
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
      `Hotmart sales watcher: ${error instanceof WatcherError ? error.message : "Watcher failed."}\n`,
    );
    // One code, no text from Hotmart: OpenBot maps it to its own message.
    if (error instanceof WatcherError && error.code) process.stderr.write(`openbot-error: ${error.code}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
