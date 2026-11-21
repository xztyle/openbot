import { pathToFileURL } from "node:url";

// Read-only competitor watch over the Meta Ad Library API (`ads_archive`). For each search term it
// lists the ads that reach the chosen countries, newest first, and answers one item per ad. The
// revision is the ad's age bucket (new, then proven once it has run for `longRunningDays`), so the
// agent wakes once for a new competitor ad and once more when it has run long enough to be proven,
// and not again for the same ad. It never logs in to Facebook and changes nothing. Meta asks for at
// most a request every few seconds, so the requests are paced and one check stays under its deadline.
const DEFAULT_API_VERSION = "v27.0";
const OFFICIAL_BASE_URL = "https://graph.facebook.com";
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 8000;
const REQUEST_GAP_MS = 3500;
const MAX_REQUESTS = 8;
const CHECK_BUDGET_MS = 32000;
const MAX_TERMS = 6;
const MAX_ITEMS = 2000;
const TEXT_LIMIT = 400;
const DAY_MS = 86400000;
// Explicit uncertainty marker, never a user identity: the Ad Library does not say who changed an ad.
export const UNKNOWN_ACTOR = "unknown";
const ERROR_CODES = ["auth", "rate_limited", "config", "upstream"];
const RATE_LIMIT_CODES = new Set([4, 17, 32, 613]);
const AD_TYPES = [
  "ALL",
  "POLITICAL_AND_ISSUE_ADS",
  "EMPLOYMENT_ADS",
  "HOUSING_ADS",
  "FINANCIAL_PRODUCTS_AND_SERVICES_ADS",
];
const FIELDS = [
  "id",
  "ad_creation_time",
  "ad_delivery_start_time",
  "ad_delivery_stop_time",
  "page_id",
  "page_name",
  "ad_creative_bodies",
  "ad_creative_link_titles",
  "ad_creative_link_captions",
  "ad_creative_link_descriptions",
  "ad_snapshot_url",
  "publisher_platforms",
  "languages",
].join(",");

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

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

function readBaseUrl(env) {
  const override = env.META_GRAPH_BASE_URL;
  if (!override) return OFFICIAL_BASE_URL;
  let url;
  try {
    url = new URL(override);
  } catch {
    throw new WatcherError("META_GRAPH_BASE_URL is not valid.", "config");
  }
  const loopback = url.protocol === "http:" && ["127.0.0.1", "localhost"].includes(url.hostname);
  requireCondition(url.protocol === "https:" || loopback, "META_GRAPH_BASE_URL must use https.", "config");
  return url.origin;
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
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new WatcherError("Invalid JSON API response.", "upstream");
  }
}

function graphFailure(status, error) {
  const code = Number(error?.code) || 0;
  if (status === 429 || RATE_LIMIT_CODES.has(code) || (code >= 80000 && code <= 80014))
    return new WatcherError("Meta API rate limit reached.", "rate_limited");
  if (code === 190 || code === 102 || status === 401)
    return new WatcherError("Meta refused the access token. Check META_ACCESS_TOKEN.", "auth");
  if (code === 10 || code === 294 || (code >= 200 && code < 300) || status === 403)
    return new WatcherError(
      "The access token cannot read the Ad Library. Confirm your identity for the Ad Library API and use that account's token.",
      "auth",
    );
  if (code === 100 || status === 404 || status === 400)
    return new WatcherError("Meta refused the request. Check searchTerms, countries, adType and apiVersion.", "config");
  return new WatcherError(`Meta API HTTP ${status || "error"}.`, "upstream");
}

/** Read-only Graph API client: GET only, bounded requests, full pagination, no redirects. */
export function createGraph({ token, apiVersion, fetchImpl = fetch, env = process.env }) {
  const base = readBaseUrl(env);
  let requests = 0;
  let last = 0;
  async function get(pathOrUrl, query = {}) {
    requests += 1;
    // One request every few seconds: the Ad Library is rate limited per token and per address.
    const wait = last + REQUEST_GAP_MS - Date.now();
    if (last > 0 && wait > 0) await sleep(wait);
    last = Date.now();
    requireCondition(requests <= MAX_REQUESTS, "Too many API requests for one check.", "upstream");
    const url = pathOrUrl.startsWith("http") ? new URL(pathOrUrl) : new URL(`${base}/${apiVersion}/${pathOrUrl}`);
    requireCondition(url.origin === base, "Meta sent a paging address on another host.", "upstream");
    url.searchParams.delete("access_token");
    for (const [key, value] of Object.entries(query))
      url.searchParams.set(key, typeof value === "object" ? JSON.stringify(value) : String(value));
    let response;
    try {
      response = await fetchImpl(url, {
        method: "GET",
        redirect: "error",
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        headers: { Accept: "application/json", Authorization: `Bearer ${token}` },
      });
    } catch {
      throw new WatcherError("Meta API request failed or timed out.", "upstream");
    }
    const body = await readBody(response);
    if (!response.ok || body?.error) throw graphFailure(response.status, body?.error);
    return body;
  }
  /** At most `pages` pages, and none that would start after the deadline. */
  async function list(path, query, pages, deadline) {
    const rows = [];
    let page = await get(path, { ...query, limit: 100 });
    for (let read = 1; ; read += 1) {
      requireCondition(Array.isArray(page?.data), "Unexpected Meta API list.", "upstream");
      rows.push(...page.data);
      const next = page.paging?.next;
      if (typeof next !== "string" || page.data.length === 0 || read >= pages || requests >= MAX_REQUESTS) return rows;
      if (Date.now() + REQUEST_GAP_MS + REQUEST_TIMEOUT_MS > deadline) return rows;
      page = await get(next);
    }
  }
  return { get, list, requests: () => requests };
}

function list(value, what, limit) {
  const entries = String(value ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  requireCondition(entries.length <= limit, `At most ${limit} ${what}.`, "config");
  return [...new Set(entries)];
}

export function readConfiguration(input) {
  requireCondition(input && typeof input === "object" && !Array.isArray(input), "Expected a JSON object.", "config");
  requireCondition(
    input.cursor === undefined || input.cursor === null || input.cursor === "",
    "Unexpected paging cursor.",
    "config",
  );
  const terms = list(input.searchTerms, "search terms", MAX_TERMS);
  requireCondition(terms.length > 0, "searchTerms needs at least one keyword.", "config");
  requireCondition(
    terms.every((term) => term.length <= 100),
    "Each search term has at most 100 characters.",
    "config",
  );
  const countries = list(input.countries, "countries", 20).map((country) => country.toUpperCase());
  requireCondition(countries.length > 0, "countries needs at least one ISO country code.", "config");
  requireCondition(
    countries.every((country) => /^[A-Z]{2}$/.test(country)),
    "countries are ISO codes such as ES or MX.",
    "config",
  );
  const adType =
    String(input.adType ?? "")
      .trim()
      .toUpperCase() || "ALL";
  requireCondition(AD_TYPES.includes(adType), `adType is one of ${AD_TYPES.join(", ")}.`, "config");
  const apiVersion = String(input.apiVersion ?? "").trim() || DEFAULT_API_VERSION;
  requireCondition(/^v[0-9]{1,3}\.[0-9]$/.test(apiVersion), "apiVersion must look like v27.0.", "config");
  const longRunningDays = Number(String(input.longRunningDays ?? "").trim() || 14);
  requireCondition(
    Number.isInteger(longRunningDays) && longRunningDays >= 3 && longRunningDays <= 365,
    "longRunningDays is a whole number from 3 to 365.",
    "config",
  );
  const pagesPerTerm = Number(String(input.pagesPerTerm ?? "").trim() || 1);
  requireCondition(
    Number.isInteger(pagesPerTerm) && pagesPerTerm >= 1 && pagesPerTerm <= 3,
    "pagesPerTerm is 1, 2 or 3.",
    "config",
  );
  const language = String(input.language ?? "")
    .trim()
    .toLowerCase();
  requireCondition(language === "" || /^[a-z]{2}$/.test(language), "language is a code such as es.", "config");
  return {
    terms,
    countries,
    adType,
    apiVersion,
    longRunningDays,
    pagesPerTerm,
    language,
    activeOnly: String(input.activeOnly ?? "true").trim() !== "false",
  };
}

function firstText(value) {
  const text = Array.isArray(value) ? value.find((entry) => typeof entry === "string" && entry.trim()) : null;
  return text ? text.trim().slice(0, TEXT_LIMIT) : null;
}

function time(value) {
  const parsed = typeof value === "string" ? Date.parse(value) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : null;
}

/** One item per ad. Two terms that find the same ad give one item with both terms. */
export function buildItems(found, config, now = Date.now()) {
  const byId = new Map();
  for (const { term, ad } of found) {
    if (typeof ad?.id !== "string" || !ad.id) continue;
    const known = byId.get(ad.id);
    if (known) {
      if (!known.terms.includes(term)) known.terms.push(term);
      continue;
    }
    const started = time(ad.ad_delivery_start_time) ?? time(ad.ad_creation_time);
    const stopped = time(ad.ad_delivery_stop_time);
    const days = started === null ? null : Math.max(0, Math.floor(((stopped ?? now) - started) / DAY_MS));
    const proven = days !== null && days >= config.longRunningDays;
    const languages = Array.isArray(ad.languages) ? ad.languages : [];
    if (config.language && languages.length > 0 && !languages.includes(config.language)) continue;
    byId.set(ad.id, {
      id: `ad:${ad.id}`,
      revision: proven ? "proven" : "new",
      actor: UNKNOWN_ACTOR,
      adId: ad.id,
      status: proven ? "proven" : "new",
      terms: [term],
      pageId: ad.page_id ?? null,
      pageName: ad.page_name ?? null,
      body: firstText(ad.ad_creative_bodies),
      title: firstText(ad.ad_creative_link_titles),
      description: firstText(ad.ad_creative_link_descriptions),
      // The link caption is the domain of the offer, such as pay.hotmart.com or a landing page.
      offer: firstText(ad.ad_creative_link_captions),
      startedAt: started === null ? null : new Date(started).toISOString().slice(0, 10),
      stoppedAt: stopped === null ? null : new Date(stopped).toISOString().slice(0, 10),
      daysRunning: days,
      platforms: Array.isArray(ad.publisher_platforms) ? ad.publisher_platforms : [],
      languages,
      snapshotUrl:
        typeof ad.ad_snapshot_url === "string" ? ad.ad_snapshot_url.replace(/access_token=[^&]*/g, "") : null,
    });
  }
  const items = [...byId.values()];
  requireCondition(items.length <= MAX_ITEMS, "Too many ads for one check. Use narrower search terms.", "config");
  return items;
}

/** Reads the Ad Library for each term and answers every ad found. Read-only. */
export async function runWatcher(input, { env = process.env, fetchImpl = fetch, now = Date.now() } = {}) {
  const token = env.META_ACCESS_TOKEN;
  requireCondition(
    typeof token === "string" && token.trim().length > 0,
    "Missing META_ACCESS_TOKEN private variable.",
    "auth",
  );
  requireCondition(!/\s/.test(token.trim()), "Invalid META_ACCESS_TOKEN private variable.", "auth");
  const config = readConfiguration(input);
  const graph = createGraph({ token: token.trim(), apiVersion: config.apiVersion, fetchImpl, env });
  const deadline = Date.now() + CHECK_BUDGET_MS;
  const found = [];
  for (const term of config.terms) {
    // A term that would start after the deadline is left for the next check, never half read.
    requireCondition(
      Date.now() + REQUEST_TIMEOUT_MS < deadline,
      "The search terms need more time than one check has. Use fewer terms.",
      "config",
    );
    const ads = await graph.list(
      "ads_archive",
      {
        search_terms: term,
        ad_reached_countries: config.countries,
        ad_type: config.adType,
        ad_active_status: config.activeOnly ? "ACTIVE" : "ALL",
        fields: FIELDS,
      },
      config.pagesPerTerm,
      deadline,
    );
    for (const ad of ads) found.push({ term, ad });
  }
  return { items: buildItems(found, config, now), hasNextPage: false, cursor: null };
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
      `Meta Ad Library watcher: ${error instanceof WatcherError ? error.message : "Watcher failed."}\n`,
    );
    // One code, no text from Meta: OpenBot maps it to its own message.
    if (error instanceof WatcherError && error.code) process.stderr.write(`openbot-error: ${error.code}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
