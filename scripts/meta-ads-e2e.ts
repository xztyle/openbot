// Runs the meta-ads helper of the openbot-meta-ads managed skill and the three Meta event check
// programs against a fake Graph API on 127.0.0.1 (META_GRAPH_BASE_URL). Checks list paging and
// insights parsing, PAUSED by default, the spend guard and its audit lines, rate-limit backoff, page
// tokens for leads, hashing for the Conversions API, the launch kit (readiness with and without a
// token, reach estimate, targeting search, previews, pixel check), that no output holds the token, and that the
// watcher items have stable IDs through the host's own program launcher and baseline comparison.
// `bun scripts/meta-ads-e2e.ts`. META_ADS_E2E_NODE selects the Node.js binary (default: node on PATH).
// Writes .openbot-build/meta-ads-e2e/report.json.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { decodeEventCheckTemplateList } from "@openbot/contracts/event-check-templates";
import type { DynamicRecord } from "@openbot/contracts/runtime-values";
import { decodeTeamProtocolV2Json } from "@openbot/contracts/team-protocol/v2";
import { Cause, Effect, Exit } from "effect";
import { eventCheckProgramError, runEventCheckProgram } from "../src/backend/event-check-program";
import type { EventCheckArguments, EventCheckData } from "../src/backend/event-check-reader";
import { observeCheck } from "../src/backend/event-check-result";

const ROOT = resolve(import.meta.dirname, "..");
const OUT = join(ROOT, ".openbot-build/meta-ads-e2e");
const CLI = join(ROOT, "resources/managed-skills/openbot-meta-ads/meta-ads.mjs");
const CATALOG = join(ROOT, "resources/watcher-catalog");
const NODE = process.env.META_ADS_E2E_NODE ?? "node";
const TOKEN = "e2e-system-user-token-5b9c1f";
const PAGE_TOKEN = "e2e-page-token-77aa21";
const VERSION = "v27.0";

/** One object of the fake Graph API. */
interface FakeObject {
  id: string;
  type: string;
  [field: string]: unknown;
}
interface Recorded {
  method: string;
  path: string;
  query: Record<string, string>;
  body: Record<string, string>;
  auth: string;
}

// ---------- fake Graph API ----------

function initialObjects(): Map<string, FakeObject> {
  const objects = new Map<string, FakeObject>();
  const add = (row: FakeObject) => objects.set(row.id, row);
  add({
    id: "101",
    type: "campaign",
    name: "Winners",
    status: "ACTIVE",
    effective_status: "ACTIVE",
    daily_budget: "5000",
  });
  add({
    id: "102",
    type: "campaign",
    name: "Losers",
    status: "ACTIVE",
    effective_status: "ACTIVE",
    daily_budget: "3000",
  });
  add({ id: "103", type: "campaign", name: "Old", status: "PAUSED", effective_status: "PAUSED", daily_budget: "2000" });
  add({
    id: "201",
    type: "adset",
    name: "Winners US",
    campaign_id: "101",
    status: "ACTIVE",
    effective_status: "ACTIVE",
  });
  add({
    id: "202",
    type: "adset",
    name: "Losers US",
    campaign_id: "102",
    status: "ACTIVE",
    effective_status: "WITH_ISSUES",
    issues_info: [
      { level: "AD_SET", error_code: 1815869, error_summary: "Ad set has an issue", error_message: "Fix it" },
    ],
  });
  add({
    id: "301",
    type: "ad",
    name: "Bad ad",
    adset_id: "202",
    campaign_id: "102",
    status: "ACTIVE",
    effective_status: "DISAPPROVED",
    configured_status: "ACTIVE",
    updated_time: "2026-11-15T08:00:00+0000",
    ad_review_feedback: { global: { "Misleading claims": "The ad makes a claim that is not true." } },
  });
  add({
    id: "302",
    type: "ad",
    name: "Good ad",
    adset_id: "201",
    campaign_id: "101",
    status: "ACTIVE",
    effective_status: "ACTIVE",
  });
  add({ id: "401", type: "form", name: "Quote form", status: "ACTIVE" });
  add({ id: "501", type: "page", name: "Shop page", access_token: PAGE_TOKEN, is_published: true });
  add({ id: "601", type: "pixel", name: "Shop pixel", last_fired_time: new Date().toISOString() });
  return objects;
}

const INVALID_FIELDS: Record<string, string[]> = {
  campaign: ["bid_amount", "adset_id", "campaign_id"],
  adset: ["adset_id", "objective", "spend_cap"],
  ad: ["daily_budget", "lifetime_budget", "bid_amount", "objective", "spend_cap", "bid_strategy"],
};

const state: {
  objects: Map<string, FakeObject>;
  requests: Recorded[];
  rateLimitNext: number;
  nextId: number;
  funding: boolean;
  pixelEvents: DynamicRecord[];
} = {
  objects: initialObjects(),
  requests: [],
  rateLimitNext: 0,
  nextId: 9000,
  funding: true,
  pixelEvents: [],
};
const PIXEL_EVENTS: DynamicRecord[] = [
  { value: "PageView", count: 120 },
  { value: "Purchase", count: 3 },
];
const PREVIEW_BODY =
  '<iframe src="https://www.facebook.com/ads/api/preview_iframe.php?d=e2e&amp;t=1" width="540" height="690"></iframe>';
/** A delivery estimate curve: spend in cents, as Meta sends it. */
const CURVE: DynamicRecord[] = [0, 500, 1000, 2000, 5000, 10000].map((spend) => ({
  spend,
  reach: spend * 3,
  impressions: spend * 4,
  actions: spend / 1000,
}));

function newId(): string {
  state.nextId += 1;
  return String(state.nextId);
}

function resetState() {
  state.objects = initialObjects();
  state.requests = [];
  state.rateLimitNext = 0;
}

function insightsRows(query: Record<string, string>): DynamicRecord[] {
  const level = query.level ?? "campaign";
  if (query.breakdowns === "hourly_stats_aggregated_by_advertiser_time_zone") {
    const now = new Date();
    const date = now.toISOString().slice(0, 10);
    const hour = String(now.getUTCHours()).padStart(2, "0");
    return [
      {
        campaign_id: "101",
        campaign_name: "Winners",
        date_start: date,
        hourly_stats_aggregated_by_advertiser_time_zone: `${hour}:00:00 - ${hour}:59:59`,
        spend: "20.00",
        actions: [{ action_type: "omni_purchase", value: "2" }],
      },
      {
        campaign_id: "102",
        campaign_name: "Losers",
        date_start: date,
        hourly_stats_aggregated_by_advertiser_time_zone: `${hour}:00:00 - ${hour}:59:59`,
        spend: "25.00",
        actions: [],
      },
    ];
  }
  const rows: DynamicRecord[] = [
    {
      campaign_id: "101",
      campaign_name: "Winners",
      spend: "100.00",
      impressions: "10000",
      clicks: "50",
      ctr: "0.5",
      actions: [
        { action_type: "link_click", value: "40" },
        { action_type: "omni_purchase", value: "10" },
        { action_type: "purchase", value: "10" },
      ],
      action_values: [{ action_type: "omni_purchase", value: "500.00" }],
      purchase_roas: [{ action_type: "omni_purchase", value: "5.0" }],
    },
    {
      campaign_id: "102",
      campaign_name: "Losers",
      spend: "80.00",
      impressions: "4000",
      clicks: "80",
      ctr: "2.0",
      actions: [{ action_type: "link_click", value: "70" }],
    },
    {
      campaign_id: "103",
      campaign_name: "Old",
      spend: "50.00",
      impressions: "3000",
      clicks: "3",
      ctr: "0.1",
      actions: [],
    },
  ];
  if (level === "account")
    return [{ account_id: "123", account_name: "Shop", spend: "230.00", impressions: "17000", clicks: "133" }];
  return rows;
}

function graphError(
  response: ServerResponse,
  status: number,
  error: DynamicRecord,
  headers: Record<string, string> = {},
) {
  response.writeHead(status, { "content-type": "application/json", ...headers });
  response.end(JSON.stringify({ error: { fbtrace_id: "trace", ...error } }));
}

function send(response: ServerResponse, body: unknown) {
  response.writeHead(200, {
    "content-type": "application/json",
    "x-business-use-case-usage": JSON.stringify({
      "123": [
        { type: "ads_management", call_count: 3, total_cputime: 1, total_time: 1, estimated_time_to_regain_access: 0 },
      ],
    }),
  });
  response.end(JSON.stringify(body));
}

function paged(
  base: string,
  path: string,
  query: Record<string, string>,
  rows: readonly DynamicRecord[],
  response: ServerResponse,
) {
  const limit = Math.max(1, Number(query.limit ?? 25));
  const offset = Number(query.after ?? 0);
  const page = rows.slice(offset, offset + limit);
  const next = offset + limit < rows.length ? new URL(`${base}/${VERSION}/${path}`) : null;
  if (next) {
    for (const [key, value] of Object.entries(query)) next.searchParams.set(key, value);
    next.searchParams.set("after", String(offset + limit));
  }
  send(response, { data: page, paging: next ? { cursors: { after: String(offset + limit) }, next: next.href } : {} });
}

function statusFilter(query: Record<string, string>): string[] | null {
  if (query.effective_status) return JSON.parse(query.effective_status);
  return null;
}

async function readBody(request: IncomingMessage): Promise<Record<string, string>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  const text = Buffer.concat(chunks).toString("utf8");
  if ((request.headers["content-type"] ?? "").startsWith("multipart/form-data"))
    return { multipart: String(text.length) };
  return Object.fromEntries(new URLSearchParams(text));
}

function handler(base: () => string) {
  return async (request: IncomingMessage, response: ServerResponse) => {
    const url = new URL(request.url ?? "/", base());
    const query = Object.fromEntries(url.searchParams);
    const body = request.method === "POST" ? await readBody(request) : {};
    const auth = String(request.headers.authorization ?? "");
    const path = url.pathname.replace(`/${VERSION}/`, "");
    state.requests.push({ method: request.method ?? "GET", path, query, body, auth });
    if (auth !== `Bearer ${TOKEN}` && auth !== `Bearer ${PAGE_TOKEN}`)
      return graphError(response, 400, { code: 190, type: "OAuthException", message: "Invalid OAuth access token." });
    if (path.endsWith("/insights") && state.rateLimitNext > 0) {
      state.rateLimitNext -= 1;
      return graphError(
        response,
        400,
        { code: 80004, type: "OAuthException", message: "There have been too many calls to this ad-account." },
        {
          "x-business-use-case-usage": JSON.stringify({
            "123": [
              {
                type: "ads_insights",
                call_count: 100,
                total_cputime: 20,
                total_time: 20,
                estimated_time_to_regain_access: 0,
              },
            ],
          }),
        },
      );
    }
    const objects = [...state.objects.values()];
    const filterRows = (type: string) => {
      const statuses = statusFilter(query);
      return objects.filter(
        (row) => row.type === type && (!statuses || statuses.includes(String(row.effective_status))),
      );
    };
    if (request.method === "GET") {
      if (path === "me") return send(response, { id: "42", name: "OpenBot system user" });
      if (path === "me/adaccounts")
        return paged(base(), path, query, [{ id: "act_123", name: "Shop", currency: "USD" }], response);
      if (path === "act_123")
        return send(response, {
          id: "act_123",
          account_id: "123",
          name: "Shop",
          currency: "USD",
          timezone_name: "Etc/UTC",
          timezone_offset_hours_utc: 0,
          account_status: 1,
          ...(state.funding
            ? { funding_source: "8001", funding_source_details: { display_string: "Visa *4242" } }
            : {}),
        });
      if (path === "me/accounts")
        return paged(base(), path, query, [{ id: "501", tasks: ["ADVERTISE", "ANALYZE", "CREATE_CONTENT"] }], response);
      if (path === "act_123/promote_pages")
        return paged(base(), path, query, [{ id: "501", name: "Shop page" }], response);
      if (path === "601/stats")
        return send(response, {
          data: [{ start_time: new Date().toISOString(), aggregation: "event", data: state.pixelEvents }],
        });
      if (path === "act_123/delivery_estimate" || path === "201/delivery_estimate")
        return send(response, {
          data: [
            {
              estimate_ready: true,
              estimate_dau: 12000,
              estimate_mau_lower_bound: 300000,
              estimate_mau_upper_bound: 350000,
              daily_outcomes_curve: CURVE,
            },
          ],
        });
      if (path === "search") {
        if (query.type === "adinterest")
          return paged(
            base(),
            path,
            query,
            [
              {
                id: "6003",
                name: "Online courses",
                audience_size_lower_bound: 1000000,
                audience_size_upper_bound: 1200000,
                path: ["Interests", "Education", "Online courses"],
              },
            ],
            response,
          );
        if (query.type === "adgeolocation")
          return paged(
            base(),
            path,
            query,
            [{ key: "BR", name: "Brazil", type: "country", country_code: "BR" }],
            response,
          );
        if (query.type === "adTargetingCategory" && query.class === "behaviors")
          return paged(
            base(),
            path,
            query,
            [
              { id: "7001", name: "Engaged shoppers", type: "behaviors", path: ["Purchase behavior"] },
              { id: "7002", name: "Frequent travelers", type: "behaviors", path: ["Travel"] },
            ],
            response,
          );
        return graphError(response, 400, { code: 100, message: "Unknown search type." });
      }
      if (path === "302/previews" || path === "act_123/generatepreviews")
        return send(response, { data: [{ body: PREVIEW_BODY }] });
      if (path === "act_123/campaigns") return paged(base(), path, query, filterRows("campaign"), response);
      if (path === "act_123/adsets") return paged(base(), path, query, filterRows("adset"), response);
      if (path === "act_123/ads") return paged(base(), path, query, filterRows("ad"), response);
      if (path === "act_123/insights") return paged(base(), path, query, insightsRows(query), response);
      if (path === "501/leadgen_forms") return paged(base(), path, query, filterRows("form"), response);
      if (path === "401/leads") {
        if (auth !== `Bearer ${PAGE_TOKEN}`)
          return graphError(response, 403, { code: 200, message: "Requires a page access token." });
        return paged(
          base(),
          path,
          query,
          [
            {
              id: "701",
              created_time: "2026-11-15T09:00:00+0000",
              form_id: "401",
              ad_id: "302",
              campaign_id: "101",
              platform: "ig",
              field_data: [
                { name: "full_name", values: ["Ana Example"] },
                { name: "email", values: ["ana@example.com"] },
              ],
            },
          ],
          response,
        );
      }
      const row = state.objects.get(path);
      if (!row) return graphError(response, 400, { code: 100, error_subcode: 33, message: "Object does not exist." });
      const fields = String(query.fields ?? "id").split(",");
      if (fields.some((field) => INVALID_FIELDS[String(row.type)]?.includes(field)))
        return graphError(response, 400, { code: 100, message: "Tried accessing nonexisting field." });
      return send(
        response,
        Object.fromEntries(fields.filter((field) => field in row).map((field) => [field, row[field]])),
      );
    }
    if (path === "act_123/campaigns" || path === "act_123/adsets" || path === "act_123/ads") {
      const id = newId();
      const type = path.slice("act_123/".length).replace(/s$/, "");
      state.objects.set(id, { id, type, ...body, effective_status: body.status });
      return send(response, { id });
    }
    if (path === "act_123/adcreatives" || path === "act_123/customaudiences") return send(response, { id: newId() });
    if (path === "act_123/adimages")
      return send(response, {
        images: { [body.name ?? "image"]: { hash: "imagehash123", url: "https://example.com/i.png" } },
      });
    if (path === "601/events") return send(response, { events_received: 1, fbtrace_id: "trace" });
    if (path.endsWith("/copies")) return send(response, { copied_campaign_id: newId(), ad_object_ids: [] });
    const row = state.objects.get(path);
    if (!row) return graphError(response, 400, { code: 100, message: "Object does not exist." });
    Object.assign(row, body);
    if (body.status) row.effective_status = body.status;
    return send(response, { success: true });
  };
}

// ---------- helpers ----------

interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
  json: EventCheckData;
}

function run(env: Record<string, string>, args: string[]): Promise<CliResult> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(NODE, [CLI, ...args], { env: { PATH: process.env.PATH ?? "", ...env } });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      let json: EventCheckData = {};
      try {
        json = decodeTeamProtocolV2Json(JSON.parse(stdout || stderr));
      } catch {
        json = {};
      }
      resolvePromise({ code: code ?? -1, stdout, stderr, json });
    });
  });
}

function posts(path: string): Recorded[] {
  return state.requests.filter((request) => request.method === "POST" && request.path === path);
}

async function auditLines(home: string): Promise<EventCheckData[]> {
  const text = await readFile(join(home, "audit.jsonl"), "utf8").catch(() => "");
  return text
    .split("\n")
    .filter(Boolean)
    .map((line) => decodeTeamProtocolV2Json(JSON.parse(line)));
}

/** Reads a path in parsed JSON. A missing step answers undefined. */
function at(value: EventCheckData | undefined, ...path: (string | number)[]): EventCheckData | undefined {
  let current = value;
  for (const key of path) {
    if (current === undefined || current === null || typeof current !== "object") return undefined;
    if (Array.isArray(current)) current = typeof key === "number" ? current[key] : undefined;
    else current = typeof key === "string" && Object.hasOwn(current, key) ? current[key] : undefined;
  }
  return current;
}

function entries(value: EventCheckData | undefined): EventCheckData[] {
  return Array.isArray(value) ? value : [];
}

async function nodeExecutable(): Promise<string> {
  if (NODE.startsWith("/")) return NODE;
  for (const folder of (process.env.PATH ?? "").split(":")) {
    const candidate = join(folder, NODE);
    if (
      await readFile(candidate).then(
        () => true,
        () => false,
      )
    )
      return candidate;
  }
  throw new Error("node was not found on PATH.");
}

async function runWatcher(slug: string, configuration: Record<string, string>, variables: Record<string, string>) {
  const programs = join(CATALOG, "programs");
  const args: EventCheckArguments = { ...configuration };
  const exit = await Effect.runPromiseExit(
    runEventCheckProgram(join(programs, `${slug}.mjs`), programs, variables, args, () => true, await nodeExecutable()),
  );
  if (Exit.isSuccess(exit)) return { ok: true as const, value: exit.value, code: null };
  const error = Exit.isFailure(exit) ? Cause.squash(exit.cause) : null;
  return { ok: false as const, value: null, code: eventCheckProgramError(error)?.code ?? "unknown" };
}

function items(value: EventCheckData | null): EventCheckData[] {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new Error("A watcher answers one JSON object.");
  const list = value.items;
  if (!Array.isArray(list)) throw new Error("A watcher answers items.");
  return list;
}

// ---------- the test ----------

const report: { passed: boolean; checks: string[]; failure?: string } = { passed: false, checks: [] };
const check = (name: string) => report.checks.push(name);
const scratch = await mkdtemp(join(tmpdir(), "openbot-meta-ads-e2e-"));
let baseUrl = "";
const server = createServer((request, response) => {
  handler(() => baseUrl)(request, response).catch((error) => {
    response.writeHead(500);
    response.end(String(error));
  });
});
await new Promise<void>((resolvePromise) => server.listen(0, "127.0.0.1", resolvePromise));
const address = server.address();
assert.ok(address !== null && typeof address === "object", "The fake Graph API listens on a TCP port.");
baseUrl = `http://127.0.0.1:${address.port}`;

try {
  const home = join(scratch, "home");
  const tokenFile = join(scratch, "META_ACCESS_TOKEN");
  await writeFile(tokenFile, `${TOKEN}\n`, { mode: 0o600 });
  const env = {
    META_GRAPH_BASE_URL: baseUrl,
    META_ACCESS_TOKEN_FILE: tokenFile,
    META_ADS_HOME: home,
    META_ADS_BACKOFF_BASE_MS: "20",
    META_ADS_ACTOR: "e2e-agent",
  };
  const outputs: string[] = [];
  const cli = async (...args: string[]) => {
    const result = await run(env, args);
    outputs.push(result.stdout, result.stderr);
    return result;
  };

  // Settings.
  let result = await cli("config", "set", "adAccountId", "123");
  assert.equal(result.code, 0, result.stderr);
  result = await cli("config", "set", "guard.dailyBudgetCap", "200");
  assert.equal(result.code, 0, "A first cap makes the guard stronger, so it needs no approval.");
  result = await cli("config", "set", "guard.maxDailyIncreasePercent", "50");
  assert.equal(result.code, 3, "A weaker guard needs --approved.");
  check("settings: a weaker guard is refused without --approved");

  // Launch kit: the readiness checklist with every step ready, then with problems.
  for (const [key, value] of [
    ["pageId", "501"],
    ["pixelId", "601"],
  ] as const) {
    result = await cli("config", "set", key, value);
    assert.equal(result.code, 0, result.stderr);
  }
  state.pixelEvents = PIXEL_EVENTS;
  result = await cli("readiness");
  assert.equal(result.code, 0, result.stderr);
  assert.equal(at(result.json, "ready"), true, JSON.stringify(at(result.json, "needs")));
  const readySteps = entries(at(result.json, "steps"));
  assert.deepEqual(
    readySteps.map((row) => `${at(row, "step")}:${at(row, "status")}`),
    ["token:ok", "ad account:ok", "page:ok", "pixel:ok", "spend cap:ok"],
  );
  assert.equal(at(readySteps[1], "details", "payment_method"), "Visa *4242");
  assert.equal(at(readySteps[3], "details", "events_24h", 0, "event"), "PageView");
  state.funding = false;
  state.pixelEvents = [];
  result = await cli("readiness");
  assert.equal(result.code, 0, "A checklist with missing steps is still a report.");
  assert.equal(at(result.json, "ready"), false);
  const problemSteps = entries(at(result.json, "steps"));
  assert.ok(String(at(problemSteps[1], "needs")).includes("no payment method"));
  assert.ok(String(at(problemSteps[3], "needs")).includes("no events in 24h"));
  state.funding = true;
  result = await cli("pixel-check");
  assert.equal(result.code, 0, result.stderr);
  assert.equal(at(result.json, "status"), "missing");
  assert.ok(String(at(result.json, "test")).includes("--test-code"));
  state.pixelEvents = PIXEL_EVENTS;
  result = await cli("pixel-check", "--hours", "6");
  assert.equal(at(result.json, "total"), 123);
  assert.equal(at(result.json, "status"), "ok");
  const stats = state.requests.filter((request) => request.path === "601/stats").at(-1);
  assert.equal(stats?.query.aggregation, "event");
  assert.equal(Number(stats?.query.end_time) - Number(stats?.query.start_time), 6 * 3600);
  check("readiness: all steps ok; no payment method and a silent pixel are named; pixel-check");

  result = await cli(
    "reach-estimate",
    "--targeting",
    '{"geo_locations":{"countries":["BR"]}}',
    "--optimization-goal",
    "OFFSITE_CONVERSIONS",
    "--budgets",
    "10,50",
  );
  assert.equal(result.code, 0, result.stderr);
  const estimate = state.requests.filter((request) => request.path === "act_123/delivery_estimate").at(-1);
  assert.equal(estimate?.query.optimization_goal, "OFFSITE_CONVERSIONS");
  assert.equal(estimate?.query.targeting_spec, '{"geo_locations":{"countries":["BR"]}}');
  assert.equal(at(result.json, "estimate_mau_upper_bound"), 350000);
  assert.deepEqual(at(result.json, "daily_outcomes", 0), {
    budget: 10,
    daily_spend: 10,
    reach: 3000,
    impressions: 4000,
    actions: 1,
  });
  assert.equal(at(result.json, "daily_outcomes", 1, "daily_spend"), 50, "The curve's cents become currency units.");
  result = await cli("reach-estimate", "--adset", "201");
  assert.equal(result.code, 0, result.stderr);
  assert.equal(entries(at(result.json, "daily_outcomes")).length, 5, "Without --budgets, five points of the curve.");
  result = await cli("reach-estimate", "--targeting", '{"geo_locations":{"countries":["BR"]}}');
  assert.equal(result.code, 2, "The account estimate needs an optimization goal.");
  check("reach-estimate: account and ad set estimates, curve in currency units");

  result = await cli("targeting-search", "online", "courses");
  assert.equal(result.code, 0, result.stderr);
  assert.equal(at(result.json, "data", 0, "id"), "6003");
  assert.equal(at(result.json, "data", 0, "audience_size_upper_bound"), 1200000);
  assert.equal(state.requests.at(-1)?.query.q, "online courses");
  result = await cli("targeting-search", "brazil", "--type", "geo", "--location-types", "country");
  assert.equal(at(result.json, "data", 0, "id"), "BR");
  assert.equal(state.requests.at(-1)?.query.location_types, '["country"]');
  result = await cli("targeting-search", "shoppers", "--type", "behavior");
  assert.deepEqual(
    entries(at(result.json, "data")).map((row) => at(row, "id")),
    ["7001"],
  );
  check("targeting-search: interests, places and behaviors");

  const previews = join(scratch, "previews");
  result = await cli("preview", "302", "--out", previews);
  assert.equal(result.code, 0, result.stderr);
  const shown = entries(at(result.json, "previews"));
  assert.deepEqual(
    shown.map((row) => at(row, "format")),
    ["MOBILE_FEED_STANDARD", "INSTAGRAM_STANDARD", "INSTAGRAM_STORY"],
  );
  assert.equal(at(shown[0], "src"), "https://www.facebook.com/ads/api/preview_iframe.php?d=e2e&t=1");
  assert.ok((await readFile(String(at(shown[0], "file")), "utf8")).includes("preview_iframe.php"));
  result = await cli(
    "preview",
    "--creative",
    '{"object_story_spec":{"page_id":"501"}}',
    "--format",
    "DESKTOP_FEED_STANDARD",
  );
  assert.equal(result.code, 0, result.stderr);
  const draft = state.requests.filter((request) => request.path === "act_123/generatepreviews").at(-1);
  assert.equal(draft?.method, "GET");
  assert.equal(draft?.query.ad_format, "DESKTOP_FEED_STANDARD");
  assert.equal(draft?.query.creative, '{"object_story_spec":{"page_id":"501"}}');
  assert.ok(String(at(result.json, "previews", 0, "file")).startsWith(join(home, "previews")), "The default folder.");
  assert.equal(
    state.requests.filter((request) => request.method === "POST").length,
    0,
    "The launch kit sends no change.",
  );
  check("preview: saved ad and unsaved creative previews as files with their links; nothing changed");

  // Reading: paging, money fields and insights.
  result = await cli("campaigns", "--limit", "500");
  assert.equal(result.code, 0, result.stderr);
  assert.equal(entries(at(result.json, "data")).length, 3, "Every page of the list is read.");
  assert.equal(at(result.json, "data", 0, "daily_budget_amount"), 50, "Budgets are shown in currency units.");
  check("campaigns: paging and money fields");

  state.rateLimitNext = 1;
  const before = state.requests.length;
  result = await cli("insights", "--level", "campaign", "--preset", "last_7d");
  assert.equal(result.code, 0, result.stderr);
  const insightCalls = state.requests.slice(before).filter((request) => request.path === "act_123/insights");
  assert.equal(insightCalls.length, 2, "A rate-limited call is sent again after a wait.");
  const rows = entries(at(result.json, "data"));
  const winners = rows.find((row) => at(row, "campaign_id") === "101");
  assert.equal(at(winners, "purchases"), 10);
  assert.equal(at(winners, "purchase_action_type"), "omni_purchase");
  assert.equal(at(winners, "purchase_value"), 500);
  assert.equal(at(winners, "cost_per_purchase"), 10);
  assert.equal(at(winners, "roas"), 5);
  const losers = rows.find((row) => at(row, "campaign_id") === "102");
  assert.equal(at(losers, "purchases"), 0);
  assert.equal(at(losers, "cost_per_purchase"), null);
  assert.equal(at(losers, "roas"), 0);
  assert.equal(at(result.json, "totals", "spend"), 230);
  check("insights: purchases, cost per purchase and ROAS from actions; rate-limit backoff");

  state.rateLimitNext = 10;
  result = await cli("insights", "--max-wait", "0");
  assert.equal(result.code, 4, "A rate limit longer than --max-wait stops with exit code 4.");
  state.rateLimitNext = 0;
  check("insights: a long rate limit fails with exit code 4");

  result = await cli("review");
  assert.equal(result.code, 0, result.stderr);
  assert.equal(at(result.json, "ads", 0, "id"), "301");
  assert.equal(entries(at(result.json, "ads")).length, 1, "Only ads with a problem status are listed.");
  assert.equal(at(result.json, "adsets", 0, "id"), "202");
  check("review: rejected ads with feedback");

  // New objects are PAUSED; activation needs approval.
  result = await cli(
    "create-campaign",
    "--name",
    "Test",
    "--objective",
    "OUTCOME_SALES",
    "--daily-budget",
    "20",
    "--reason",
    "e2e",
  );
  assert.equal(result.code, 0, result.stderr);
  let created = posts("act_123/campaigns");
  assert.equal(created.length, 1);
  assert.equal(created[0]?.body.status, "PAUSED", "A new campaign is PAUSED.");
  assert.equal(created[0]?.body.daily_budget, "2000", "The budget is sent in cents.");
  assert.equal(created[0]?.body.special_ad_categories, "[]");
  result = await cli("create-campaign", "--name", "Live", "--objective", "OUTCOME_SALES", "--activate");
  assert.equal(result.code, 3, "Activation without --approved is refused.");
  assert.equal(at(result.json, "refused"), true);
  created = posts("act_123/campaigns");
  assert.equal(created.length, 1, "A refused change sends nothing.");
  check("create: PAUSED by default, --activate refused without --approved");

  // Budget guard with the 24-hour window from the audit log.
  result = await cli("set-budget", "101", "--daily", "70");
  assert.equal(result.code, 3, "+40% is refused.");
  result = await cli("set-budget", "101", "--daily", "55");
  assert.equal(result.code, 0, `+10% is allowed: ${result.stderr}`);
  result = await cli("set-budget", "101", "--daily", "60");
  assert.equal(result.code, 0, "+20% against the value 24 hours ago is allowed.");
  result = await cli("set-budget", "101", "--daily", "66");
  assert.equal(result.code, 3, "Two small steps cannot pass the daily limit.");
  result = await cli("set-budget", "101", "--daily", "64", "--approved", "--reason", "approved in chat");
  assert.equal(result.code, 0, result.stderr);
  assert.equal(posts("101").at(-1)?.body.daily_budget, "6400");
  check("set-budget: +20% in 24 hours, then --approved");

  result = await cli("pause", "102");
  assert.equal(result.code, 0, result.stderr);
  result = await cli("resume", "102");
  assert.equal(result.code, 3, "Resume needs approval.");
  result = await cli("resume", "102", "--approved");
  assert.equal(result.code, 0, result.stderr);
  check("pause and resume: resume needs --approved");

  result = await cli("config", "set", "guard.dailyBudgetCap", "95");
  assert.equal(result.code, 0, "A lower cap needs no approval.");
  result = await cli("set-budget", "102", "--daily", "34");
  assert.equal(result.code, 3, "The account total would pass the cap.");
  assert.ok(String(at(result.json, "reasons")).includes("cap"));
  check("guard: daily budget cap for the account");

  result = await cli("duplicate", "101", "--deep");
  assert.equal(result.code, 0, result.stderr);
  assert.equal(posts("101/copies")[0]?.body.status_option, "PAUSED");
  result = await cli("duplicate", "101", "--activate");
  assert.equal(result.code, 3);
  check("duplicate: paused copy; active copy needs approval");

  const image = join(scratch, "ad.png");
  await writeFile(image, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  result = await cli("upload-image", image);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(at(result.json, "hash"), "imagehash123");
  check("upload-image: answers the hash");

  result = await cli(
    "capi-send",
    "--pixel",
    "601",
    "--event",
    "Purchase",
    "--value",
    "10",
    "--currency",
    "USD",
    "--email",
    " Ana@Example.com ",
    "--test-code",
    "TEST1",
  );
  assert.equal(result.code, 0, result.stderr);
  const events = decodeTeamProtocolV2Json(JSON.parse(posts("601/events")[0]?.body.data ?? "[]"));
  assert.equal(at(events, 0, "user_data", "em", 0), createHash("sha256").update("ana@example.com").digest("hex"));
  assert.equal(posts("601/events")[0]?.body.test_event_code, "TEST1");
  check("capi-send: customer data hashed");

  result = await cli("leads", "401", "--page", "501");
  assert.equal(result.code, 0, result.stderr);
  assert.equal(at(result.json, "data", 0, "id"), "701");
  check("leads: read with the page token");

  const noToken: Record<string, string> = { ...env, META_ADS_HOME: join(scratch, "empty-home") };
  delete noToken.META_ACCESS_TOKEN_FILE;
  const bare = await run(noToken, ["readiness"]);
  outputs.push(bare.stdout, bare.stderr);
  assert.equal(bare.code, 0, "Readiness without a token is still a report.");
  assert.equal(bare.stderr, "");
  assert.equal(
    at(bare.json, "steps", 0, "needs"),
    "credential META_ACCESS_TOKEN (save with openbot.request_api_key, shared)",
  );
  assert.equal(
    at(bare.json, "steps", 1, "needs"),
    "config adAccountId (find it with accounts, then config set adAccountId act_<id>)",
  );
  assert.ok(String(at(bare.json, "steps", 4, "needs")).startsWith("guard.dailyBudgetCap is not set"));
  const tokenless = await run(noToken, ["whoami"]);
  assert.equal(tokenless.code, 1);
  assert.equal(
    at(tokenless.json, "error", "details", "needs", 0),
    "credential META_ACCESS_TOKEN (save with openbot.request_api_key, shared)",
  );
  assert.ok(!tokenless.stderr.includes("    at "), "No stack trace.");
  check("readiness and whoami without a token: a clean needs credential answer");

  const badToken = join(scratch, "bad");
  await writeFile(badToken, "wrong-token-000000\n");
  result = await cli("whoami", "--token-file", badToken);
  assert.equal(result.code, 1);
  assert.equal(at(result.json, "error", "code"), 190);
  assert.ok(String(at(result.json, "error", "hint")).includes("token"));
  check("errors: Graph error code and hint");

  const audit = await auditLines(home);
  const actions = audit.map((line) => `${at(line, "action")}:${at(line, "result")}`);
  assert.ok(actions.includes("create-campaign:ok") && actions.includes("create-campaign:refused"));
  assert.ok(actions.includes("set-budget:refused") && actions.includes("resume:ok"));
  const approved = audit.find((line) => at(line, "action") === "set-budget" && at(line, "approved") === true);
  assert.equal(at(approved, "reason"), "approved in chat");
  assert.equal(at(approved, "actor"), "e2e-agent");
  assert.deepEqual(at(approved, "changes", "daily_budget"), { from: "6000", to: 6400 });
  check(`audit: ${audit.length} lines with action, result, approval, actor and changes`);

  for (const text of [...outputs, JSON.stringify(audit)])
    assert.ok(!text.includes(TOKEN) && !text.includes(PAGE_TOKEN), "No output holds a token.");
  check("secrets: no output or audit line holds a token");

  // Watchers, through the host's launcher and baseline comparison.
  resetState();
  const templates = decodeEventCheckTemplateList(JSON.parse(await readFile(join(CATALOG, "catalog.json"), "utf8")));
  const variables = { META_ACCESS_TOKEN: TOKEN, META_GRAPH_BASE_URL: baseUrl };
  const performance = {
    adAccountId: "act_123",
    maxCostPerPurchase: "15",
    minRoas: "2",
    maxSpendPercentOfBudget: "150",
    minCtr: "1",
    noPurchaseHours: "6",
  };
  const first = await runWatcher("meta-ads-performance", performance, variables);
  assert.ok(first.ok, `performance watcher failed: ${first.code}`);
  const breaches = items(first.value);
  const rules = breaches.map((item) => `${at(item, "rule")}:${at(item, "objectId")}`).sort();
  assert.deepEqual(rules, [
    "cost_per_purchase_high:102",
    "ctr_low:101",
    "no_purchases:102",
    "roas_low:102",
    "spend_over_budget:101",
    "spend_over_budget:102",
  ]);
  const second = await runWatcher("meta-ads-performance", performance, variables);
  assert.deepEqual(
    items(second.value).map((item) => at(item, "id")),
    breaches.map((item) => at(item, "id")),
    "The same breach has the same ID.",
  );
  const performanceTemplate = templates.find((template) => template.slug === "meta-ads-performance");
  assert.ok(performanceTemplate);
  const baseline = observeCheck(breaches, performanceTemplate.selection, null).baseline;
  const again = observeCheck(items(second.value), performanceTemplate.selection, baseline);
  assert.equal(again.changed.length, 0, "A breach wakes the agent once.");
  check("meta-ads-performance: six breaches, stable IDs, one wake each");

  const noRules = await runWatcher("meta-ads-performance", { adAccountId: "act_123" }, variables);
  assert.equal(noRules.code, "config");
  state.rateLimitNext = 1;
  const limited = await runWatcher("meta-ads-performance", performance, variables);
  assert.equal(limited.code, "rate_limited");
  state.rateLimitNext = 0;
  const unauthorized = await runWatcher("meta-ads-performance", performance, {
    ...variables,
    META_ACCESS_TOKEN: "x-bad-token",
  });
  assert.equal(unauthorized.code, "auth");
  check("meta-ads-performance: config, rate_limited and auth error codes");

  const review = await runWatcher("meta-ads-review", { adAccountId: "act_123" }, variables);
  assert.ok(review.ok, `review watcher failed: ${review.code}`);
  const problems = items(review.value);
  assert.deepEqual(problems.map((item) => at(item, "id")).sort(), ["ad:301", "adset:202"]);
  const rejected = problems.find((item) => at(item, "id") === "ad:301");
  assert.equal(at(rejected, "reviewFeedback", 0, "policy"), "Misleading claims");
  const reviewTemplate = templates.find((template) => template.slug === "meta-ads-review");
  assert.ok(reviewTemplate);
  const reviewBaseline = observeCheck(problems, reviewTemplate.selection, null).baseline;
  const ad = state.objects.get("301");
  if (ad) ad.ad_review_feedback = { global: { "Adult content": "Another reason." } };
  const changedReview = observeCheck(
    items((await runWatcher("meta-ads-review", { adAccountId: "act_123" }, variables)).value),
    reviewTemplate.selection,
    reviewBaseline,
  );
  assert.deepEqual(
    changedReview.changed.map((item) => at(item, "id")),
    ["ad:301"],
    "New review feedback wakes the agent again.",
  );
  check("meta-ads-review: rejected ad and ad set with issues; new feedback wakes again");

  const leads = await runWatcher("meta-lead-forms", { pageId: "501" }, variables);
  assert.ok(leads.ok, `lead watcher failed: ${leads.code}`);
  const lead = items(leads.value)[0];
  assert.equal(at(lead, "id"), "lead:701");
  assert.equal(at(lead, "answers", "full_name"), "Ana Example");
  // The host masks email addresses in every event check result; the agent reads them with the helper.
  assert.equal(at(lead, "answers", "email"), "[redacted-email]");
  assert.ok(
    state.requests.some((request) => request.path === "401/leads" && request.auth === `Bearer ${PAGE_TOKEN}`),
    "Leads are read with the page token.",
  );
  check("meta-lead-forms: one item per lead, read with the page token");

  report.passed = true;
} catch (error) {
  report.failure = error instanceof Error ? (error.stack ?? error.message) : String(error);
} finally {
  server.close();
  await mkdir(OUT, { recursive: true });
  await writeFile(join(OUT, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  await rm(scratch, { recursive: true, force: true });
}
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
if (!report.passed) process.exitCode = 1;
