import { pathToFileURL } from "node:url";

// Read-only performance check for one Meta ad account. It reads the Marketing API insights (Meta's own
// numbers for spend, clicks and purchases) and answers one item for each rule that a campaign, ad set
// or the account breaks. An item ID holds the rule, the object and the day (or the hour block for
// "no purchases"), so one breach wakes the agent once in that period. Nothing is changed in Meta.
const DEFAULT_API_VERSION = "v27.0";
const OFFICIAL_BASE_URL = "https://graph.facebook.com";
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 12000;
const MAX_REQUESTS = 30;
const MAX_ITEMS = 2000;
// Explicit uncertainty marker, never a user identity. A metric has no author.
export const UNKNOWN_ACTOR = "unknown";
const ERROR_CODES = ["auth", "rate_limited", "config", "upstream"];
const RATE_LIMIT_CODES = new Set([4, 17, 32, 613]);
const CURRENCY_OFFSET_ONE = new Set(["CLP", "COP", "CRC", "HUF", "ISK", "IDR", "JPY", "KRW", "PYG", "TWD", "VND"]);
const PURCHASE_ACTION_TYPES = [
  "omni_purchase",
  "purchase",
  "offsite_conversion.fb_pixel_purchase",
  "onsite_web_purchase",
  "onsite_conversion.purchase",
];
const DATE_PRESETS = ["today", "yesterday", "last_3d", "last_7d", "last_14d", "last_30d", "this_month"];
const LEVELS = {
  account: "account_id,account_name",
  campaign: "campaign_id,campaign_name",
  adset: "campaign_id,campaign_name,adset_id,adset_name",
};

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

function optionalNumber(value, name, minimum, maximum) {
  if (value === undefined || value === null || String(value).trim() === "") return null;
  const number = Number(String(value).trim());
  requireCondition(
    Number.isFinite(number) && number >= minimum && number <= maximum,
    `${name} must be a number from ${minimum} to ${maximum}, or empty.`,
    "config",
  );
  return number;
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
  const account = /^(?:act_)?([0-9]{1,30})$/.exec(String(input.adAccountId ?? "").trim());
  requireCondition(account, "adAccountId must look like act_1234567890.", "config");
  const level = String(input.level ?? "").trim() || "campaign";
  requireCondition(Object.hasOwn(LEVELS, level), "level must be account, campaign or adset.", "config");
  const datePreset = String(input.datePreset ?? "").trim() || "today";
  requireCondition(
    DATE_PRESETS.includes(datePreset),
    `datePreset must be one of ${DATE_PRESETS.join(", ")}.`,
    "config",
  );
  const apiVersion = String(input.apiVersion ?? "").trim() || DEFAULT_API_VERSION;
  requireCondition(/^v[0-9]{1,3}\.[0-9]$/.test(apiVersion), "apiVersion must look like v27.0.", "config");
  const campaignIds = String(input.campaignIds ?? "")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);
  requireCondition(
    campaignIds.length <= 50 && campaignIds.every((id) => /^[0-9]{1,30}$/.test(id)),
    "campaignIds must be at most 50 numeric campaign IDs separated by commas.",
    "config",
  );
  const purchaseActionType = String(input.purchaseActionType ?? "").trim();
  requireCondition(
    purchaseActionType === "" || /^[a-z0-9_.]{1,100}$/.test(purchaseActionType),
    "purchaseActionType must be an action type such as purchase or omni_purchase.",
    "config",
  );
  const config = {
    accountId: `act_${account[1]}`,
    level,
    datePreset,
    apiVersion,
    campaignIds,
    purchaseActionType: purchaseActionType || null,
    includePaused: String(input.includePaused ?? "false").trim() === "true",
    maxCostPerPurchase: optionalNumber(input.maxCostPerPurchase, "maxCostPerPurchase", 0.01, 1e9),
    minRoas: optionalNumber(input.minRoas, "minRoas", 0.01, 1000),
    maxSpendPercentOfBudget: optionalNumber(input.maxSpendPercentOfBudget, "maxSpendPercentOfBudget", 1, 1000),
    minCtr: optionalNumber(input.minCtr, "minCtr", 0.001, 100),
    noPurchaseHours: optionalNumber(input.noPurchaseHours, "noPurchaseHours", 1, 72),
    minSpend: optionalNumber(input.minSpend, "minSpend", 0, 1e9) ?? 10,
    minImpressions: optionalNumber(input.minImpressions, "minImpressions", 1, 1e12) ?? 1000,
  };
  requireCondition(
    config.noPurchaseHours === null || Number.isInteger(config.noPurchaseHours),
    "noPurchaseHours must be a whole number of hours.",
    "config",
  );
  requireCondition(
    [
      config.maxCostPerPurchase,
      config.minRoas,
      config.maxSpendPercentOfBudget,
      config.minCtr,
      config.noPurchaseHours,
    ].some((value) => value !== null),
    "Set at least one rule: maxCostPerPurchase, minRoas, maxSpendPercentOfBudget, minCtr or noPurchaseHours.",
    "config",
  );
  return config;
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
      "The access token lacks a permission (ads_read) or the ad account is not assigned to it.",
      "auth",
    );
  if (code === 100 || status === 404 || status === 400)
    return new WatcherError("Meta refused the request. Check adAccountId, campaignIds and apiVersion.", "config");
  return new WatcherError(`Meta API HTTP ${status || "error"}.`, "upstream");
}

/** Read-only Graph API client: GET only, bounded requests, full pagination, no redirects. */
export function createGraph({ token, apiVersion, fetchImpl = fetch, env = process.env }) {
  const base = readBaseUrl(env);
  let requests = 0;
  async function get(pathOrUrl, query = {}) {
    requests += 1;
    requireCondition(
      requests <= MAX_REQUESTS,
      "Too many API requests for one check. Narrow it with campaignIds.",
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
    let page = await get(path, { ...query, limit: 200 });
    for (;;) {
      requireCondition(Array.isArray(page?.data), "Unexpected Meta API list.", "upstream");
      rows.push(...page.data);
      requireCondition(rows.length <= 5000, "Too many rows for one check. Narrow it with campaignIds.", "config");
      const next = page.paging?.next;
      if (typeof next !== "string" || page.data.length === 0) return rows;
      page = await get(next);
    }
  }
  return { get, list };
}

function actionValue(entries, types) {
  if (!Array.isArray(entries)) return { type: null, value: 0 };
  for (const type of types) {
    const entry = entries.find((candidate) => candidate?.action_type === type);
    if (entry) return { type, value: Number(entry.value) || 0 };
  }
  return { type: null, value: 0 };
}

export function metricsOf(row, purchaseActionType) {
  const types = purchaseActionType ? [purchaseActionType] : PURCHASE_ACTION_TYPES;
  const spend = Number(row.spend) || 0;
  const impressions = Number(row.impressions) || 0;
  const clicks = Number(row.clicks) || 0;
  const purchases = actionValue(row.actions, types);
  const value = actionValue(row.action_values, purchases.type ? [purchases.type] : types);
  const ctr = row.ctr !== undefined ? Number(row.ctr) : impressions > 0 ? (clicks / impressions) * 100 : 0;
  return {
    spend: round(spend),
    impressions,
    clicks,
    ctr: round(ctr),
    purchases: purchases.value,
    purchaseValue: round(value.value),
    costPerPurchase: purchases.value > 0 ? round(spend / purchases.value) : null,
    roas: spend > 0 ? round(value.value / spend) : null,
  };
}

function round(value) {
  return Math.round(value * 100) / 100;
}

function entityOf(row, level, accountId) {
  if (level === "account") return { id: accountId, name: row.account_name ?? accountId, campaignId: null };
  if (level === "campaign") return { id: row.campaign_id, name: row.campaign_name ?? "", campaignId: row.campaign_id };
  return { id: row.adset_id, name: row.adset_name ?? "", campaignId: row.campaign_id };
}

/** The local time of the ad account, as a Date whose UTC fields read as the account's wall clock. */
function accountClock(account, nowMs) {
  const offset = Number(account.timezone_offset_hours_utc) || 0;
  return new Date(nowMs + offset * 3600 * 1000);
}

/** Every rule that one object breaks now. */
export function evaluate({ config, account, rows, todayRows, hourly, budgets, statuses, nowMs }) {
  const currency = account.currency ?? null;
  const clock = accountClock(account, nowMs);
  const day = clock.toISOString().slice(0, 10);
  const items = [];
  const add = (rule, entity, period, threshold, value, metrics, extra = {}) => {
    items.push({
      id: `${rule}:${config.level}:${entity.id}:${period}`,
      revision: "breach",
      actor: UNKNOWN_ACTOR,
      rule,
      level: config.level,
      objectId: entity.id,
      objectName: entity.name,
      campaignId: entity.campaignId,
      accountId: config.accountId,
      currency,
      day,
      threshold,
      value,
      metrics,
      ...extra,
    });
  };
  const active = (entity) => config.level === "account" || config.includePaused || statuses.get(entity.id) === "ACTIVE";
  for (const row of rows) {
    const entity = entityOf(row, config.level, config.accountId);
    if (!entity.id || !active(entity)) continue;
    const metrics = metricsOf(row, config.purchaseActionType);
    const window = { datePreset: config.datePreset };
    if (config.maxCostPerPurchase !== null && metrics.spend >= config.minSpend) {
      if (metrics.purchases > 0 && metrics.costPerPurchase > config.maxCostPerPurchase)
        add("cost_per_purchase_high", entity, day, config.maxCostPerPurchase, metrics.costPerPurchase, metrics, window);
      else if (metrics.purchases === 0 && metrics.spend > config.maxCostPerPurchase)
        add("cost_per_purchase_high", entity, day, config.maxCostPerPurchase, null, metrics, {
          ...window,
          note: "Spent more than the target cost per purchase with no purchase.",
        });
    }
    if (config.minRoas !== null && metrics.spend >= config.minSpend && (metrics.roas ?? 0) < config.minRoas)
      add("roas_low", entity, day, config.minRoas, metrics.roas ?? 0, metrics, window);
    if (config.minCtr !== null && metrics.impressions >= config.minImpressions && metrics.ctr < config.minCtr)
      add("ctr_low", entity, day, config.minCtr, metrics.ctr, metrics, window);
  }
  if (config.maxSpendPercentOfBudget !== null) {
    for (const row of todayRows) {
      const entity = entityOf(row, config.level, config.accountId);
      if (!entity.id || !active(entity)) continue;
      const budget = budgets.get(entity.id);
      if (!budget) continue;
      const metrics = metricsOf(row, config.purchaseActionType);
      const percent = round((metrics.spend / budget) * 100);
      if (percent >= config.maxSpendPercentOfBudget)
        add("spend_over_budget", entity, day, config.maxSpendPercentOfBudget, percent, metrics, {
          datePreset: "today",
          dailyBudget: budget,
        });
    }
  }
  if (config.noPurchaseHours !== null) {
    const hours = config.noPurchaseHours;
    const windowStart = clock.getTime() - hours * 3600 * 1000;
    const block = Math.floor(clock.getTime() / (hours * 3600 * 1000));
    const sums = new Map();
    for (const row of hourly) {
      const entity = entityOf(row, config.level, config.accountId);
      const hour = /^(\d{2}):/.exec(String(row.hourly_stats_aggregated_by_advertiser_time_zone ?? ""));
      if (!entity.id || !hour || !/^\d{4}-\d{2}-\d{2}$/.test(String(row.date_start))) continue;
      const start = Date.parse(`${row.date_start}T${hour[1]}:00:00Z`);
      if (!(start + 3600 * 1000 > windowStart) || start > clock.getTime()) continue;
      const metrics = metricsOf(row, config.purchaseActionType);
      const sum = sums.get(entity.id) ?? { entity, spend: 0, purchases: 0 };
      sum.spend += metrics.spend;
      sum.purchases += metrics.purchases;
      sums.set(entity.id, sum);
    }
    for (const { entity, spend, purchases } of sums.values()) {
      if (!active(entity) || purchases > 0 || spend < config.minSpend) continue;
      add("no_purchases", entity, `${hours}h-${block}`, hours, 0, { spend: round(spend), purchases }, { hours });
    }
  }
  requireCondition(items.length <= MAX_ITEMS, "Too many breaches for one check. Narrow it with campaignIds.", "config");
  return items;
}

function insightsQuery(config, extra) {
  const query = {
    level: config.level,
    fields: `${LEVELS[config.level]},spend,impressions,clicks,ctr,actions,action_values`,
    ...extra,
  };
  if (config.campaignIds.length > 0 && config.level !== "account")
    query.filtering = [{ field: "campaign.id", operator: "IN", value: config.campaignIds }];
  return query;
}

/** The daily budget of each campaign (its own, or the sum of its active ad sets), ad set, or the account. */
export function dailyBudgets(config, campaigns, adsets, offset) {
  const budgets = new Map();
  const adsetSums = new Map();
  for (const adset of adsets) {
    const budget = Number(adset.daily_budget) || 0;
    if (budget > 0) budgets.set(adset.id, budget / offset);
    if (adset.effective_status === "ACTIVE" && budget > 0)
      adsetSums.set(adset.campaign_id, (adsetSums.get(adset.campaign_id) ?? 0) + budget);
  }
  let accountTotal = 0;
  for (const campaign of campaigns) {
    const own = Number(campaign.daily_budget) || 0;
    const total = own > 0 ? own : (adsetSums.get(campaign.id) ?? 0);
    if (total > 0) budgets.set(campaign.id, total / offset);
    if (campaign.effective_status === "ACTIVE") accountTotal += total;
  }
  if (config.level === "account" && accountTotal > 0) budgets.set(config.accountId, accountTotal / offset);
  return budgets;
}

/** Reads the account and answers the breaches. Read-only. */
export async function runWatcher(input, { env = process.env, fetchImpl = fetch, now = () => Date.now() } = {}) {
  const token = env.META_ACCESS_TOKEN;
  requireCondition(
    typeof token === "string" && token.trim().length > 0,
    "Missing META_ACCESS_TOKEN private variable.",
    "auth",
  );
  requireCondition(!/\s/.test(token.trim()), "Invalid META_ACCESS_TOKEN private variable.", "auth");
  const config = readConfiguration(input);
  const graph = createGraph({ token: token.trim(), apiVersion: config.apiVersion, fetchImpl, env });
  const account = await graph.get(config.accountId, {
    fields: "id,name,currency,timezone_name,timezone_offset_hours_utc",
  });
  const offset = CURRENCY_OFFSET_ONE.has(String(account.currency).toUpperCase()) ? 1 : 100;
  const statuses = new Map();
  let budgets = new Map();
  if (config.level !== "account" || config.maxSpendPercentOfBudget !== null) {
    // The campaign filter is applied here, not in the request, so it means the same on every API version.
    const wanted = (campaignId) => config.campaignIds.length === 0 || config.campaignIds.includes(String(campaignId));
    const campaigns = (
      await graph.list(`${config.accountId}/campaigns`, { fields: "id,name,effective_status,daily_budget" })
    ).filter((row) => wanted(row.id));
    const needAdsets = config.level === "adset" || config.maxSpendPercentOfBudget !== null;
    const adsets = needAdsets
      ? (
          await graph.list(`${config.accountId}/adsets`, {
            fields: "id,name,campaign_id,effective_status,daily_budget",
          })
        ).filter((row) => wanted(row.campaign_id))
      : [];
    for (const row of config.level === "adset" ? adsets : campaigns) statuses.set(row.id, row.effective_status);
    budgets = dailyBudgets(config, campaigns, adsets, offset);
  }
  const rows = await graph.list(
    `${config.accountId}/insights`,
    insightsQuery(config, { date_preset: config.datePreset }),
  );
  const todayRows =
    config.maxSpendPercentOfBudget === null
      ? []
      : config.datePreset === "today"
        ? rows
        : await graph.list(`${config.accountId}/insights`, insightsQuery(config, { date_preset: "today" }));
  let hourly = [];
  if (config.noPurchaseHours !== null) {
    const clock = accountClock(account, now());
    const since = new Date(clock.getTime() - config.noPurchaseHours * 3600 * 1000).toISOString().slice(0, 10);
    hourly = await graph.list(
      `${config.accountId}/insights`,
      insightsQuery(config, {
        time_range: { since, until: clock.toISOString().slice(0, 10) },
        breakdowns: "hourly_stats_aggregated_by_advertiser_time_zone",
      }),
    );
  }
  const items = evaluate({ config, account, rows, todayRows, hourly, budgets, statuses, nowMs: now() });
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
      `Meta ads performance watcher: ${error instanceof WatcherError ? error.message : "Watcher failed."}\n`,
    );
    // One code, no text from Meta: OpenBot maps it to its own message.
    if (error instanceof WatcherError && error.code) process.stderr.write(`openbot-error: ${error.code}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
