import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";

// Read-only review check for one Meta ad account. It answers one item for each ad with a problem status
// (for example DISAPPROVED, WITH_ISSUES or PENDING_BILLING_INFO) with Meta's review feedback, one for
// each campaign or ad set WITH_ISSUES, and one for the account when it is not active. The revision
// holds the status and a hash of the feedback, so the agent wakes when a problem starts or changes.
const DEFAULT_API_VERSION = "v27.0";
const OFFICIAL_BASE_URL = "https://graph.facebook.com";
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 12000;
const MAX_REQUESTS = 30;
const MAX_ITEMS = 2000;
// Explicit uncertainty marker, never a user identity. Meta does not say who caused a review status.
export const UNKNOWN_ACTOR = "unknown";
const ERROR_CODES = ["auth", "rate_limited", "config", "upstream"];
const RATE_LIMIT_CODES = new Set([4, 17, 32, 613]);
const AD_STATUSES = [
  "DISAPPROVED",
  "WITH_ISSUES",
  "PENDING_BILLING_INFO",
  "PENDING_REVIEW",
  "IN_PROCESS",
  "PREAPPROVED",
  "ADSET_PAUSED",
  "CAMPAIGN_PAUSED",
  "PAUSED",
  "ACTIVE",
];
const ACCOUNT_STATUS = {
  1: "ACTIVE",
  2: "DISABLED",
  3: "UNSETTLED",
  7: "PENDING_RISK_REVIEW",
  8: "PENDING_SETTLEMENT",
  9: "IN_GRACE_PERIOD",
  100: "PENDING_CLOSURE",
  101: "CLOSED",
  201: "ANY_ACTIVE",
  202: "ANY_CLOSED",
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
  const apiVersion = String(input.apiVersion ?? "").trim() || DEFAULT_API_VERSION;
  requireCondition(/^v[0-9]{1,3}\.[0-9]$/.test(apiVersion), "apiVersion must look like v27.0.", "config");
  const statuses = String(input.statuses ?? "")
    .split(",")
    .map((status) => status.trim().toUpperCase())
    .filter(Boolean);
  const adStatuses = statuses.length > 0 ? statuses : ["DISAPPROVED", "WITH_ISSUES", "PENDING_BILLING_INFO"];
  requireCondition(
    adStatuses.every((status) => AD_STATUSES.includes(status)),
    `statuses must be ad statuses from: ${AD_STATUSES.join(", ")}.`,
    "config",
  );
  return {
    accountId: `act_${account[1]}`,
    apiVersion,
    adStatuses,
    includeAccount: String(input.includeAccount ?? "true").trim() !== "false",
    includeCampaignsAndAdSets: String(input.includeCampaignsAndAdSets ?? "true").trim() !== "false",
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
    return new WatcherError("Meta refused the request. Check adAccountId, statuses and apiVersion.", "config");
  return new WatcherError(`Meta API HTTP ${status || "error"}.`, "upstream");
}

/** Read-only Graph API client: GET only, bounded requests, full pagination, no redirects. */
export function createGraph({ token, apiVersion, fetchImpl = fetch, env = process.env }) {
  const base = readBaseUrl(env);
  let requests = 0;
  async function get(pathOrUrl, query = {}) {
    requests += 1;
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
  async function list(path, query) {
    const rows = [];
    let page = await get(path, { ...query, limit: 200 });
    for (;;) {
      requireCondition(Array.isArray(page?.data), "Unexpected Meta API list.", "upstream");
      rows.push(...page.data);
      requireCondition(rows.length <= MAX_ITEMS, "Too many objects with problems for one check.", "upstream");
      const next = page.paging?.next;
      if (typeof next !== "string" || page.data.length === 0) return rows;
      page = await get(next);
    }
  }
  return { get, list };
}

function shortHash(value) {
  return createHash("sha256")
    .update(JSON.stringify(value ?? null))
    .digest("hex")
    .slice(0, 16);
}

function issues(value) {
  return (Array.isArray(value) ? value : []).map((issue) => ({
    level: issue?.level ?? null,
    errorCode: issue?.error_code ?? null,
    summary: issue?.error_summary ?? null,
    message: issue?.error_message ?? null,
    type: issue?.error_type ?? null,
  }));
}

/** Meta's review feedback: `global` and `placement_specific` reasons, kept as plain text pairs. */
function feedback(value) {
  if (!value || typeof value !== "object") return [];
  const entries = [];
  for (const [scope, reasons] of Object.entries(value)) {
    if (!reasons || typeof reasons !== "object") continue;
    for (const [policy, text] of Object.entries(reasons))
      entries.push({ scope, policy, reason: typeof text === "string" ? text : JSON.stringify(text) });
  }
  return entries;
}

export function buildItems({ account, campaigns, adsets, ads }) {
  const items = [];
  if (account && Number(account.account_status) !== 1) {
    const status = ACCOUNT_STATUS[Number(account.account_status)] ?? String(account.account_status);
    items.push({
      id: `account:${account.id}`,
      revision: `${status}:${account.disable_reason ?? 0}`,
      actor: UNKNOWN_ACTOR,
      kind: "account",
      objectId: account.id,
      name: account.name ?? "",
      status,
      disableReason: account.disable_reason ?? null,
    });
  }
  for (const [kind, rows] of [
    ["campaign", campaigns],
    ["adset", adsets],
  ]) {
    for (const row of rows) {
      const found = issues(row.issues_info);
      items.push({
        id: `${kind}:${row.id}`,
        revision: `${row.effective_status}:${shortHash(found)}`,
        actor: UNKNOWN_ACTOR,
        kind,
        objectId: row.id,
        name: row.name ?? "",
        campaignId: row.campaign_id ?? (kind === "campaign" ? row.id : null),
        status: row.effective_status,
        issues: found,
      });
    }
  }
  for (const ad of ads) {
    const found = issues(ad.issues_info);
    const reasons = feedback(ad.ad_review_feedback);
    items.push({
      id: `ad:${ad.id}`,
      revision: `${ad.effective_status}:${ad.updated_time ?? ""}:${shortHash([reasons, found])}`,
      actor: UNKNOWN_ACTOR,
      kind: "ad",
      objectId: ad.id,
      name: ad.name ?? "",
      campaignId: ad.campaign_id ?? null,
      adsetId: ad.adset_id ?? null,
      status: ad.effective_status,
      configuredStatus: ad.configured_status ?? null,
      reviewFeedback: reasons,
      issues: found,
    });
  }
  requireCondition(items.length <= MAX_ITEMS, "Too many objects with problems for one check.", "upstream");
  return items;
}

/** Reads the account and answers every object with a problem. Read-only. */
export async function runWatcher(input, { env = process.env, fetchImpl = fetch } = {}) {
  const token = env.META_ACCESS_TOKEN;
  requireCondition(
    typeof token === "string" && token.trim().length > 0,
    "Missing META_ACCESS_TOKEN private variable.",
    "auth",
  );
  requireCondition(!/\s/.test(token.trim()), "Invalid META_ACCESS_TOKEN private variable.", "auth");
  const config = readConfiguration(input);
  const graph = createGraph({ token: token.trim(), apiVersion: config.apiVersion, fetchImpl, env });
  const account = config.includeAccount
    ? await graph.get(config.accountId, { fields: "id,name,account_status,disable_reason" })
    : null;
  const withIssues = { effective_status: ["WITH_ISSUES"] };
  const campaigns = config.includeCampaignsAndAdSets
    ? await graph.list(`${config.accountId}/campaigns`, {
        fields: "id,name,effective_status,issues_info",
        ...withIssues,
      })
    : [];
  const adsets = config.includeCampaignsAndAdSets
    ? await graph.list(`${config.accountId}/adsets`, {
        fields: "id,name,campaign_id,effective_status,issues_info",
        ...withIssues,
      })
    : [];
  const ads = await graph.list(`${config.accountId}/ads`, {
    fields:
      "id,name,adset_id,campaign_id,effective_status,configured_status,ad_review_feedback,issues_info,updated_time",
    effective_status: config.adStatuses,
  });
  return { items: buildItems({ account, campaigns, adsets, ads }), hasNextPage: false, cursor: null };
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
      `Meta ads review watcher: ${error instanceof WatcherError ? error.message : "Watcher failed."}\n`,
    );
    // One code, no text from Meta: OpenBot maps it to its own message.
    if (error instanceof WatcherError && error.code) process.stderr.write(`openbot-error: ${error.code}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
