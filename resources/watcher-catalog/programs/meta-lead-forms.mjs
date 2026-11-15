import { pathToFileURL } from "node:url";

// Read-only check for new leads from Meta (Facebook and Instagram) lead forms of one page. It reads the
// leads of the last hours from each chosen form and answers one item per lead. The lead ID is the item
// ID, so each lead wakes the agent once. Lead answers are personal data from people outside.
const DEFAULT_API_VERSION = "v27.0";
const OFFICIAL_BASE_URL = "https://graph.facebook.com";
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 12000;
const MAX_REQUESTS = 30;
const MAX_ITEMS = 2000;
// Explicit uncertainty marker, never a user identity. A lead comes from a person outside the account.
export const UNKNOWN_ACTOR = "unknown";
const ERROR_CODES = ["auth", "rate_limited", "config", "upstream"];
const RATE_LIMIT_CODES = new Set([4, 17, 32, 613]);

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

export function readConfiguration(input) {
  requireCondition(input && typeof input === "object" && !Array.isArray(input), "Expected a JSON object.", "config");
  requireCondition(
    input.cursor === undefined || input.cursor === null || input.cursor === "",
    "Unexpected paging cursor.",
    "config",
  );
  const pageId = String(input.pageId ?? "").trim();
  requireCondition(/^[0-9]{1,30}$/.test(pageId), "pageId must be the numeric Facebook page ID.", "config");
  const formIds = String(input.formIds ?? "")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);
  requireCondition(
    formIds.length <= 20 && formIds.every((id) => /^[0-9]{1,30}$/.test(id)),
    "formIds must be at most 20 numeric lead form IDs separated by commas, or empty for every active form.",
    "config",
  );
  const lookback = String(input.lookbackHours ?? "").trim() === "" ? 72 : Number(input.lookbackHours);
  requireCondition(
    Number.isInteger(lookback) && lookback >= 1 && lookback <= 720,
    "lookbackHours must be a whole number from 1 to 720.",
    "config",
  );
  const apiVersion = String(input.apiVersion ?? "").trim() || DEFAULT_API_VERSION;
  requireCondition(/^v[0-9]{1,3}\.[0-9]$/.test(apiVersion), "apiVersion must look like v27.0.", "config");
  return { pageId, formIds, lookbackHours: lookback, apiVersion };
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
      "The access token lacks leads_retrieval or a page permission, or the page is not assigned to it.",
      "auth",
    );
  if (code === 100 || status === 404 || status === 400)
    return new WatcherError("Meta refused the request. Check pageId, formIds and apiVersion.", "config");
  return new WatcherError(`Meta API HTTP ${status || "error"}.`, "upstream");
}

/** Read-only Graph API client: GET only, bounded requests, full pagination, no redirects. */
export function createGraph({ token, apiVersion, fetchImpl = fetch, env = process.env, budget = { requests: 0 } }) {
  const base = readBaseUrl(env);
  async function get(pathOrUrl, query = {}) {
    budget.requests += 1;
    requireCondition(
      budget.requests <= MAX_REQUESTS,
      "Too many API requests for one check. Name fewer forms.",
      "config",
    );
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
  async function list(path, query) {
    const rows = [];
    let page = await get(path, { ...query, limit: 100 });
    for (;;) {
      requireCondition(Array.isArray(page?.data), "Unexpected Meta API list.", "upstream");
      rows.push(...page.data);
      requireCondition(rows.length <= MAX_ITEMS, "Too many leads for one check. Use fewer lookbackHours.", "config");
      const next = page.paging?.next;
      if (typeof next !== "string" || page.data.length === 0) return rows;
      page = await get(next);
    }
  }
  return { get, list };
}

export function leadItem(lead, form) {
  const answers = {};
  for (const field of Array.isArray(lead.field_data) ? lead.field_data : []) {
    if (typeof field?.name !== "string") continue;
    answers[field.name] = Array.isArray(field.values) ? field.values.map(String).join(", ") : "";
  }
  return {
    id: `lead:${lead.id}`,
    revision: "new",
    actor: UNKNOWN_ACTOR,
    leadId: lead.id,
    createdTime: lead.created_time ?? null,
    formId: form.id,
    formName: form.name ?? "",
    answers,
    adId: lead.ad_id ?? null,
    adName: lead.ad_name ?? null,
    campaignId: lead.campaign_id ?? null,
    campaignName: lead.campaign_name ?? null,
    platform: lead.platform ?? null,
    isOrganic: lead.is_organic ?? null,
  };
}

/** Reads the chosen forms and answers every lead of the last hours. Read-only. */
export async function runWatcher(input, { env = process.env, fetchImpl = fetch, now = () => Date.now() } = {}) {
  const token = env.META_ACCESS_TOKEN;
  requireCondition(
    typeof token === "string" && token.trim().length > 0,
    "Missing META_ACCESS_TOKEN private variable.",
    "auth",
  );
  requireCondition(!/\s/.test(token.trim()), "Invalid META_ACCESS_TOKEN private variable.", "auth");
  const config = readConfiguration(input);
  const budget = { requests: 0 };
  const userGraph = createGraph({ token: token.trim(), apiVersion: config.apiVersion, fetchImpl, env, budget });
  // Leads belong to the page. A system user that the page is assigned to can read a page token, which
  // has the page's permissions. Without one, the system user token reads the leads itself.
  let page = {};
  try {
    page = await userGraph.get(config.pageId, { fields: "id,name,access_token" });
  } catch (error) {
    if (error instanceof WatcherError && error.code === "rate_limited") throw error;
  }
  const graph =
    typeof page.access_token === "string" && page.access_token && !/\s/.test(page.access_token)
      ? createGraph({ token: page.access_token, apiVersion: config.apiVersion, fetchImpl, env, budget })
      : userGraph;
  let forms;
  if (config.formIds.length > 0) {
    forms = [];
    for (const id of config.formIds) forms.push(await graph.get(id, { fields: "id,name,status" }));
  } else {
    forms = (await graph.list(`${config.pageId}/leadgen_forms`, { fields: "id,name,status" })).filter(
      (form) => form.status === "ACTIVE",
    );
  }
  const since = Math.floor((now() - config.lookbackHours * 3600 * 1000) / 1000);
  const items = [];
  for (const form of forms) {
    const leads = await graph.list(`${form.id}/leads`, {
      fields: "id,created_time,field_data,ad_id,ad_name,campaign_id,campaign_name,form_id,platform,is_organic",
      filtering: [{ field: "time_created", operator: "GREATER_THAN", value: since }],
    });
    for (const lead of leads) items.push(leadItem(lead, form));
    requireCondition(items.length <= MAX_ITEMS, "Too many leads for one check. Use fewer lookbackHours.", "config");
  }
  return { items, hasNextPage: false, cursor: null };
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
      `Meta lead forms watcher: ${error instanceof WatcherError ? error.message : "Watcher failed."}\n`,
    );
    // One code, no text from Meta: OpenBot maps it to its own message.
    if (error instanceof WatcherError && error.code) process.stderr.write(`openbot-error: ${error.code}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
