// Runs the hotmart helper of the openbot-hotmart managed skill and the two Hotmart event check programs
// against a fake Hotmart API and sign-in service on 127.0.0.1 (HOTMART_API_BASE_URL, HOTMART_AUTH_BASE_URL).
// Checks the client-credentials sign-in and the token cache, a new token after a 401, sales paging with
// one status per query, the totals per status and currency, the approval guard and its audit lines,
// rate-limit backoff, that no output holds a credential or an access token, the Meta Conversions API
// recipe through the meta-ads helper (fake Graph API on the same port), and that the watcher items have
// stable IDs through the host's own program launcher and baseline comparison.
// `bun scripts/hotmart-e2e.ts`. HOTMART_E2E_NODE selects the Node.js binary (default: node on PATH).
// Writes .openbot-build/hotmart-e2e/report.json.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
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
const OUT = join(ROOT, ".openbot-build/hotmart-e2e");
const CLI = join(ROOT, "resources/managed-skills/openbot-hotmart/hotmart.mjs");
const META_CLI = join(ROOT, "resources/managed-skills/openbot-meta-ads/meta-ads.mjs");
const CATALOG = join(ROOT, "resources/watcher-catalog");
const NODE = process.env.HOTMART_E2E_NODE ?? "node";
const CLIENT_ID = "e2e-client-id-4f1d2a7c";
const CLIENT_SECRET = "e2e-client-secret-9b8e77d1";
const BASIC = "ZTJlLWJhc2ljLXRva2VuLTVhNmM=";
const META_TOKEN = "e2e-meta-token-31c0aa";
const ACCESS_PREFIX = "e2e-access-token-";
const PAGE_LIMIT = 2;
const DAY = 86_400_000;

interface Sale {
  transaction: string;
  status: string;
  productId: number;
  productName: string;
  value: number;
  currency: string;
  daysAgo: number;
  buyer: { name: string; email: string; ucode: string };
}
interface Subscription {
  code: string;
  status: string;
  cancelledDaysAgo: number | null;
}
interface Recorded {
  method: string;
  path: string;
  query: URLSearchParams;
  body: string;
  auth: string;
}

// ---------- fake Hotmart API, sign-in service and Graph API ----------

const BUYERS = {
  ana: { name: "Ana Maria Silva", email: "ana@example.com", ucode: "buyer-ana-0001" },
  bob: { name: "Bob Stone", email: "bob@example.com", ucode: "buyer-bob-0002" },
};

function initialSales(): Sale[] {
  const sale = (
    transaction: string,
    status: string,
    productId: number,
    value: number,
    currency: string,
    daysAgo: number,
    buyer: Sale["buyer"],
  ): Sale => ({
    transaction,
    status,
    productId,
    productName: productId === 1111111 ? "Course A" : "Ebook B",
    value,
    currency,
    daysAgo,
    buyer,
  });
  return [
    sale("HP0001", "APPROVED", 1111111, 97, "BRL", 1, BUYERS.ana),
    sale("HP0002", "APPROVED", 1111111, 97, "BRL", 2, BUYERS.bob),
    sale("HP0003", "COMPLETE", 2222222, 19.9, "USD", 3, BUYERS.bob),
    sale("HP0004", "APPROVED", 2222222, 19.9, "USD", 4, BUYERS.ana),
    sale("HP0005", "REFUNDED", 1111111, 97, "BRL", 5, BUYERS.bob),
    sale("HP0006", "CHARGEBACK", 2222222, 19.9, "USD", 6, BUYERS.ana),
    sale("HP0007", "WAITING_PAYMENT", 1111111, 97, "BRL", 1, BUYERS.bob),
    sale("HP0008", "APPROVED", 1111111, 97, "BRL", 40, BUYERS.ana),
  ];
}

function initialSubscriptions(): Subscription[] {
  return [
    { code: "SUBA", status: "CANCELLED_BY_CUSTOMER", cancelledDaysAgo: 2 },
    { code: "SUBB", status: "DELAYED", cancelledDaysAgo: null },
    { code: "SUBC", status: "CANCELLED_BY_SELLER", cancelledDaysAgo: 30 },
    { code: "SUBD", status: "ACTIVE", cancelledDaysAgo: null },
  ];
}

interface FakeState {
  sales: Sale[];
  subscriptions: Subscription[];
  requests: Recorded[];
  tokens: Set<string>;
  tokenCount: number;
  rateLimitNext: number;
  rateLimitReset: string;
  failNext: number;
  graphEvents: string[];
}
const state: FakeState = {
  sales: initialSales(),
  subscriptions: initialSubscriptions(),
  requests: [],
  tokens: new Set<string>(),
  tokenCount: 0,
  rateLimitNext: 0,
  rateLimitReset: "0",
  failNext: 0,
  graphEvents: [],
};

function resetState() {
  state.sales = initialSales();
  state.subscriptions = initialSubscriptions();
  state.requests = [];
  state.rateLimitNext = 0;
  state.rateLimitReset = "0";
  state.failNext = 0;
}

function json(response: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
  response.writeHead(status, {
    "content-type": "application/json",
    "ratelimit-limit": "500",
    "ratelimit-remaining": "480",
    "ratelimit-reset": "30",
    ...headers,
  });
  response.end(JSON.stringify(body));
}

function hotmartError(response: ServerResponse, status: number, error: string, headers: Record<string, string> = {}) {
  json(response, status, { error, error_description: `Fake ${error}.` }, headers);
}

function saleJson(sale: Sale): DynamicRecord {
  const time = Date.now() - sale.daysAgo * DAY;
  return {
    product: { id: sale.productId, name: sale.productName },
    buyer: sale.buyer,
    producer: { name: "Producer", ucode: "producer-0001" },
    purchase: {
      transaction: sale.transaction,
      order_date: time,
      approved_date: time + 60_000,
      status: sale.status,
      recurrency_number: 1,
      is_subscription: false,
      commission_as: "PRODUCER",
      price: { value: sale.value, currency_code: sale.currency },
      payment: { method: "PIX", installments_number: 1, type: "PIX" },
      tracking: { source: "meta", source_sck: "HOTMART_PRODUCT_PAGE", external_code: "xcod-1" },
      warranty_expire_date: time + 7 * DAY,
      offer: { payment_mode: "UNIQUE_PAYMENT", code: "off1" },
      hotmart_fee: { total: 9.9, fixed: 1, currency_code: sale.currency, base: sale.value, percentage: 9.9 },
    },
  };
}

/** One page of a Hotmart list: at most PAGE_LIMIT items, and page_token as the offset. */
function paged(response: ServerResponse, query: URLSearchParams, rows: readonly DynamicRecord[]) {
  const limit = Math.min(Number(query.get("max_results") ?? 10), PAGE_LIMIT);
  const offset = Number(Buffer.from(query.get("page_token") ?? "", "base64").toString("utf8") || 0);
  const items = rows.slice(offset, offset + limit);
  const next = offset + limit < rows.length ? Buffer.from(String(offset + limit)).toString("base64") : undefined;
  json(response, 200, {
    items,
    page_info: {
      total_results: rows.length,
      results_per_page: items.length,
      ...(next ? { next_page_token: next } : {}),
    },
  });
}

/** The sales that a sales endpoint query selects, as the docs describe the filters. */
function selectedSales(query: URLSearchParams): Sale[] | null {
  const statuses = query.getAll("transaction_status");
  if (statuses.length > 1) return null;
  const transaction = query.get("transaction");
  const start = Number(query.get("start_date") ?? Number.NEGATIVE_INFINITY);
  const end = Number(query.get("end_date") ?? Number.POSITIVE_INFINITY);
  const product = query.get("product_id");
  return state.sales.filter((sale) => {
    const time = Date.now() - sale.daysAgo * DAY;
    if (transaction) return sale.transaction === transaction;
    const wanted = statuses[0] ? [statuses[0]] : ["APPROVED", "COMPLETE"];
    return (
      wanted.includes(sale.status) && time >= start && time <= end && (!product || String(sale.productId) === product)
    );
  });
}

function subscriptionJson(subscription: Subscription): DynamicRecord {
  return {
    subscriber_code: subscription.code,
    subscription_id: subscription.code.charCodeAt(3),
    status: subscription.status,
    accession_date: Date.now() - 200 * DAY,
    request_date: Date.now() - 200 * DAY,
    date_next_charge: Date.now() + 10 * DAY,
    trial: false,
    transaction: `HPS${subscription.code}`,
    plan: { name: "Monthly", id: 726420, recurrency_period: 30 },
    product: { id: 3333333, name: "Club", ucode: "club-ucode" },
    price: { value: 49.9, currency_code: "BRL" },
    subscriber: { name: `Subscriber ${subscription.code}`, email: `${subscription.code.toLowerCase()}@example.com` },
  };
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

async function handle(request: IncomingMessage, response: ServerResponse, base: string) {
  const url = new URL(request.url ?? "/", base);
  const query = url.searchParams;
  const body = await readBody(request);
  const auth = String(request.headers.authorization ?? "");
  const path = url.pathname;
  const method = request.method ?? "GET";
  state.requests.push({ method, path, query, body, auth });

  // Meta Graph API, for the Conversions API recipe.
  if (path === "/v27.0/601/events" && method === "POST") {
    if (auth !== `Bearer ${META_TOKEN}`) return json(response, 400, { error: { code: 190, message: "Bad token." } });
    state.graphEvents.push(new URLSearchParams(body).get("data") ?? "[]");
    return json(response, 200, { events_received: 1, fbtrace_id: "trace" });
  }

  // Hotmart sign-in: client credentials in the query, the Basic token in the header.
  if (path === "/security/oauth/token") {
    if (method !== "POST" || query.get("grant_type") !== "client_credentials")
      return hotmartError(response, 400, "invalid_request");
    if (
      auth !== `Basic ${BASIC}` ||
      query.get("client_id") !== CLIENT_ID ||
      query.get("client_secret") !== CLIENT_SECRET
    )
      return hotmartError(response, 401, "unauthorized");
    state.tokenCount += 1;
    const token = `${ACCESS_PREFIX}${state.tokenCount}`;
    state.tokens.add(token);
    return json(response, 200, {
      access_token: token,
      token_type: "bearer",
      expires_in: 172799,
      scope: "read write",
      jti: "jti",
    });
  }

  if (!auth.startsWith("Bearer ") || !state.tokens.has(auth.slice(7)))
    return hotmartError(response, 401, "invalid_token");
  if (path.startsWith("/payments/api/v1/sales/") && method === "GET") {
    if (state.rateLimitNext > 0) {
      state.rateLimitNext -= 1;
      return hotmartError(response, 429, "too_many_requests", { "ratelimit-reset": state.rateLimitReset });
    }
    if (state.failNext > 0) {
      state.failNext -= 1;
      return hotmartError(response, 500, "internal_server_error");
    }
  }
  if (method === "GET") {
    if (path === "/user/api/v1/me")
      return json(response, 200, {
        id: 42,
        name: "E2E Producer",
        email: "producer@example.com",
        currency_code_commission: "BRL",
        ucode: "producer-0001",
        time_zone: "America/Sao_Paulo",
        locale: "pt_BR",
      });
    if (path === "/products/api/v1/products")
      return paged(response, query, [
        {
          id: 1111111,
          name: "Course A",
          status: "ACTIVE",
          created_at: Date.now() - 300 * DAY,
          format: "ONLINE_COURSE",
        },
        { id: 2222222, name: "Ebook B", status: "ACTIVE", created_at: Date.now() - 100 * DAY, format: "EBOOK" },
        { id: 3333333, name: "Club", status: "ACTIVE", created_at: Date.now() - 400 * DAY, format: "COMMUNITY" },
      ]);
    const sales = path.startsWith("/payments/api/v1/sales/") ? selectedSales(query) : [];
    if (sales === null) return hotmartError(response, 400, "invalid_value_parameter");
    if (path === "/payments/api/v1/sales/history") return paged(response, query, sales.map(saleJson));
    if (path === "/payments/api/v1/sales/users")
      return paged(
        response,
        query,
        sales.map((sale) => ({
          transaction: sale.transaction,
          product: { id: sale.productId, name: sale.productName },
          users: [
            {
              role: "BUYER",
              user: {
                ...sale.buyer,
                cellphone: "(31) 98888-7777",
                locale: "pt_BR",
                documents: [{ type: "CPF", value: "00000000000" }],
                address: { country: "Brasil", city: "Belo Horizonte", state: "MG", zip_code: "30000000" },
              },
            },
            { role: "PRODUCER", user: { name: "Producer", ucode: "producer-0001", email: "producer@example.com" } },
          ],
        })),
      );
    if (path === "/payments/api/v1/sales/price/details")
      return paged(
        response,
        query,
        sales.map((sale) => ({
          transaction: sale.transaction,
          product: { id: sale.productId, name: sale.productName },
          base: { value: sale.value, currency_code: sale.currency },
          total: { value: sale.value, currency_code: sale.currency },
          fee: { value: 9.9, currency_code: sale.currency },
        })),
      );
    if (path === "/payments/api/v1/sales/commissions")
      return paged(
        response,
        query,
        sales.map((sale) => ({
          transaction: sale.transaction,
          product: { id: sale.productId, name: sale.productName },
          commissions: [
            {
              commission: { currency_value: sale.currency, value: sale.value - 9.9 },
              user: { ucode: "producer-0001", name: "Producer" },
              source: "PRODUCER",
            },
          ],
        })),
      );
    if (path === "/payments/api/v1/sales/summary") {
      const totals = new Map<string, { count: number; value: number }>();
      for (const sale of sales) {
        const entry = totals.get(sale.currency) ?? { count: 0, value: 0 };
        totals.set(sale.currency, { count: entry.count + 1, value: entry.value + sale.value });
      }
      return paged(
        response,
        query,
        [...totals].map(([currency, entry]) => ({
          total_items: entry.count,
          total_value: { currency_code: currency, value: entry.value },
        })),
      );
    }
    if (path === "/payments/api/v1/subscriptions") {
      // accession_date is required here: without it Hotmart reads only the last 30 days.
      if (!query.get("accession_date")) return hotmartError(response, 400, "invalid_parameter");
      const statuses = query.getAll("status");
      const since = query.get("cancelation_date");
      const rows = state.subscriptions.filter((subscription) => {
        if (statuses.length > 0 && !statuses.includes(subscription.status)) return false;
        if (since === null) return true;
        return (
          subscription.cancelledDaysAgo !== null && Date.now() - subscription.cancelledDaysAgo * DAY >= Number(since)
        );
      });
      return paged(response, query, rows.map(subscriptionJson));
    }
  }
  const refund = /^\/payments\/api\/v1\/sales\/([A-Za-z0-9]+)\/refund$/.exec(path);
  if (refund && method === "PUT") {
    const sale = state.sales.find((candidate) => candidate.transaction === refund[1]);
    if (!sale) return hotmartError(response, 400, "purchase_not_found");
    sale.status = "REFUNDED";
    return json(response, 200, {});
  }
  const cancel = /^\/payments\/api\/v1\/subscriptions\/([A-Za-z0-9]+)\/cancel$/.exec(path);
  if (cancel && method === "POST") return json(response, 200, { status: "INACTIVE", subscriber_code: cancel[1] });
  if (/^\/products\/api\/v1\/product\/[0-9]+\/coupon$/.test(path) && method === "POST") return json(response, 200, {});
  return hotmartError(response, 404, "not_found");
}

// ---------- helpers ----------

interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
  json: EventCheckData;
}

function run(script: string, env: Record<string, string>, args: string[]): Promise<CliResult> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(NODE, [script, ...args], { env: { PATH: process.env.PATH ?? "", TZ: "UTC", ...env } });
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

function requests(method: string, path: string): Recorded[] {
  return state.requests.filter((request) => request.method === method && request.path === path);
}

async function auditLines(home: string): Promise<EventCheckData[]> {
  const text = await readFile(join(home, "audit.jsonl"), "utf8").catch(() => "");
  return text
    .split("\n")
    .filter(Boolean)
    .map((line) => decodeTeamProtocolV2Json(JSON.parse(line)));
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

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

function assertNoSecrets(texts: readonly string[], what: string) {
  for (const text of texts)
    for (const secret of [CLIENT_ID, CLIENT_SECRET, BASIC, ACCESS_PREFIX, META_TOKEN])
      assert.ok(!text.includes(secret), `${what} holds a credential or an access token.`);
}

// ---------- the test ----------

const report: { passed: boolean; checks: string[]; failure?: string } = { passed: false, checks: [] };
const check = (name: string) => report.checks.push(name);
const scratch = await mkdtemp(join(tmpdir(), "openbot-hotmart-e2e-"));
let baseUrl = "";
const server = createServer((request, response) => {
  handle(request, response, baseUrl).catch((error) => {
    response.writeHead(500);
    response.end(String(error));
  });
});
await new Promise<void>((resolvePromise) => server.listen(0, "127.0.0.1", resolvePromise));
const address = server.address();
assert.ok(address !== null && typeof address === "object", "The fake Hotmart API listens on a TCP port.");
baseUrl = `http://127.0.0.1:${address.port}`;

try {
  const home = join(scratch, "home");
  const secretFile = async (name: string, value: string) => {
    const path = join(scratch, name);
    await writeFile(path, `${value}\n`, { mode: 0o600 });
    return path;
  };
  const env = {
    HOTMART_API_BASE_URL: baseUrl,
    HOTMART_AUTH_BASE_URL: baseUrl,
    HOTMART_CLIENT_ID_FILE: await secretFile("HOTMART_CLIENT_ID", CLIENT_ID),
    HOTMART_CLIENT_SECRET_FILE: await secretFile("HOTMART_CLIENT_SECRET", CLIENT_SECRET),
    // The credentials page shows the Basic token with its "Basic " prefix; the helper accepts both.
    HOTMART_BASIC_FILE: await secretFile("HOTMART_BASIC", `Basic ${BASIC}`),
    HOTMART_HOME: home,
    HOTMART_BACKOFF_BASE_MS: "20",
    HOTMART_ACTOR: "e2e-agent",
  };
  const outputs: string[] = [];
  const cli = async (...args: string[]) => {
    const result = await run(CLI, env, args);
    outputs.push(result.stdout, result.stderr);
    return result;
  };

  // Settings and the sandbox address (no network).
  let result = await run(CLI, { HOTMART_HOME: home }, ["config", "show", "--sandbox"]);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(at(result.json, "apiBase"), "https://sandbox.hotmart.com");
  result = await run(CLI, { HOTMART_HOME: home }, ["config", "show"]);
  assert.equal(at(result.json, "apiBase"), "https://developers.hotmart.com");
  result = await run(CLI, { HOTMART_HOME: home, HOTMART_API_BASE_URL: "http://example.com" }, ["whoami"]);
  assert.equal(result.code, 1, "A plain-http address other than this computer is refused.");
  result = await cli("config", "set", "timezone", "America/Sao_Paulo");
  assert.equal(result.code, 0, result.stderr);
  check("config: sandbox and production addresses, https only, timezone");

  // Sign-in and the token cache.
  result = await cli("whoami");
  assert.equal(result.code, 0, result.stderr);
  assert.equal(at(result.json, "name"), "E2E Producer");
  assert.equal(state.tokenCount, 1);
  const token = requests("POST", "/security/oauth/token")[0];
  assert.equal(token?.auth, `Basic ${BASIC}`, "The Basic token goes in the Authorization header.");
  assert.equal(token?.query.get("grant_type"), "client_credentials");
  result = await cli("products");
  assert.equal(result.code, 0, result.stderr);
  assert.equal(at(result.json, "count"), 3, "Every page of the product list is read.");
  assert.equal(state.tokenCount, 1, "The second command uses the cached access token.");
  const cachePath = join(home, ".token-cache.json");
  assert.equal((await stat(cachePath)).mode & 0o777, 0o600, "Only the owner can read the token cache.");
  const cache = await readFile(cachePath, "utf8");
  assert.ok(!cache.includes(CLIENT_SECRET) && !cache.includes(BASIC) && !cache.includes(CLIENT_ID));
  state.tokens.clear();
  result = await cli("whoami");
  assert.equal(result.code, 0, `A 401 gets a new token and one retry: ${result.stderr}`);
  assert.equal(state.tokenCount, 2);
  check("auth: client credentials with Basic, cached token, new token after a 401");

  // Sales: one status per query, paging, totals per status and currency.
  let before = state.requests.length;
  result = await cli("sales", "--status", "paid,refunds", "--days", "30");
  assert.equal(result.code, 0, result.stderr);
  const history = state.requests.slice(before).filter((request) => request.path === "/payments/api/v1/sales/history");
  assert.ok(
    history.every((request) => request.query.getAll("transaction_status").length === 1),
    "Each query asks for one status.",
  );
  assert.deepEqual([...new Set(history.map((request) => request.query.get("transaction_status")))].sort(), [
    "APPROVED",
    "CHARGEBACK",
    "COMPLETE",
    "PARTIALLY_REFUNDED",
    "PROTESTED",
    "REFUNDED",
  ]);
  assert.ok(
    history.some((request) => request.query.get("page_token")),
    "The next page is read with page_token.",
  );
  assert.deepEqual(
    entries(at(result.json, "data"))
      .map((row) => at(row, "transaction"))
      .sort(),
    ["HP0001", "HP0002", "HP0003", "HP0004", "HP0005", "HP0006"],
  );
  assert.deepEqual(at(result.json, "totals", "paid_by_currency"), {
    BRL: { count: 2, value: 194 },
    USD: { count: 2, value: 39.8 },
  });
  assert.deepEqual(at(result.json, "totals", "refunded_by_currency"), {
    BRL: { count: 1, value: 97 },
    USD: { count: 1, value: 19.9 },
  });
  assert.equal(at(result.json, "totals", "by_status", "APPROVED", "count"), 3);
  assert.equal(at(result.json, "data", 0, "buyer_email"), "ana@example.com", "The helper shows the buyer email.");
  result = await cli("sales");
  assert.equal(at(result.json, "count"), 4, "Without --status only paid sales of the last 7 days.");
  result = await cli("sales", "--status", "all", "--days", "60", "--product", "2222222");
  assert.equal(at(result.json, "count"), 3);
  assert.ok(state.requests.at(-1)?.query.get("product_id") === "2222222");
  result = await cli("sales", "--status", "NOPE");
  assert.equal(result.code, 2, "An unknown status is a usage error.");
  check("sales: one status per query, paging, totals per status and currency, filters");

  result = await cli("sale", "HP0005");
  assert.equal(result.code, 0, result.stderr);
  assert.equal(at(result.json, "sale", "status"), "REFUNDED");
  assert.equal(at(result.json, "participants", 0, "role"), "BUYER");
  assert.equal(at(result.json, "participants", 0, "documents"), undefined, "Documents only with --full.");
  assert.equal(at(result.json, "commissions", 0, "source"), "PRODUCER");
  result = await cli("summary", "--status", "APPROVED", "--days", "30");
  assert.deepEqual(at(result.json, "data", 0, "by_currency", "BRL"), { count: 2, value: 194 });
  check("sale and summary: one sale with price, commissions and participants");

  // Rate limits.
  state.rateLimitNext = 1;
  before = state.requests.length;
  result = await cli("sales");
  assert.equal(result.code, 0, result.stderr);
  // APPROVED has 3 sales of the last 7 days (2 pages) and COMPLETE has 1: 3 reads and 1 repeat.
  assert.equal(
    state.requests.slice(before).filter((request) => request.path === "/payments/api/v1/sales/history").length,
    4,
    "The rate-limited call is sent again after a wait.",
  );
  assert.equal(at(result.json, "count"), 4);
  state.rateLimitNext = 50;
  result = await cli("sales", "--max-wait", "0");
  assert.equal(result.code, 4, "A rate limit longer than --max-wait stops with exit code 4.");
  state.rateLimitNext = 0;
  check("rate limits: wait and retry, exit code 4 past --max-wait");

  // Errors: credentials and their redaction.
  const wrongSecret = await secretFile("wrong-secret", "e2e-wrong-secret-000000");
  result = await cli("whoami", "--client-secret-file", wrongSecret);
  assert.equal(result.code, 1);
  assert.equal(at(result.json, "error", "status"), 401);
  assert.equal(at(result.json, "error", "during"), "sign-in (access token)");
  assert.ok(String(at(result.json, "error", "hint")).includes("HOTMART_CLIENT_SECRET"));
  result = await cli("subscriptions", "--status", "DELAYED,ACTIVE");
  assert.equal(result.code, 0, result.stderr);
  const listed = requests("GET", "/payments/api/v1/subscriptions").at(-1);
  assert.deepEqual(listed?.query.getAll("status"), ["DELAYED", "ACTIVE"], "Several statuses repeat the key.");
  assert.deepEqual(at(result.json, "by_status"), { DELAYED: 1, ACTIVE: 1 });
  assert.deepEqual(at(result.json, "active_monthly_value_by_currency"), { BRL: 49.9 });
  check("errors: refused credentials with a hint; subscriptions with several statuses");

  // Changes need --approved.
  result = await cli("refund", "HP0001");
  assert.equal(result.code, 3, "A refund without --approved is refused.");
  assert.equal(at(result.json, "refused"), true);
  result = await cli("refund", "HP0001", "--dry-run");
  assert.equal(result.code, 0, result.stderr);
  assert.equal(at(result.json, "request", "method"), "PUT");
  assert.equal(requests("PUT", "/payments/api/v1/sales/HP0001/refund").length, 0, "Nothing is sent before approval.");
  result = await cli("refund", "HP0001", "--approved", "--reason", "approved in chat");
  assert.equal(result.code, 0, result.stderr);
  assert.equal(requests("PUT", "/payments/api/v1/sales/HP0001/refund").length, 1);
  result = await cli("refund", "HP0005", "--approved");
  assert.equal(result.code, 1, "A refunded sale is not refunded again.");
  assert.equal(requests("PUT", "/payments/api/v1/sales/HP0005/refund").length, 0);
  result = await cli("cancel-subscription", "SUBB");
  assert.equal(result.code, 3);
  result = await cli("cancel-subscription", "SUBB", "--send-mail", "--approved");
  assert.equal(result.code, 0, result.stderr);
  assert.equal(requests("POST", "/payments/api/v1/subscriptions/SUBB/cancel")[0]?.body, '{"send_mail":true}');
  result = await cli("create-coupon", "1111111", "--code", "BLACK10", "--discount", "10", "--approved");
  assert.equal(result.code, 0, result.stderr);
  assert.equal(
    JSON.parse(requests("POST", "/products/api/v1/product/1111111/coupon")[0]?.body ?? "{}").discount,
    0.1,
    "A percent is sent as a fraction.",
  );
  const audit = await auditLines(home);
  const actions = audit.map((line) => `${at(line, "action")}:${at(line, "result")}`);
  for (const expected of ["refund:refused", "refund:ok", "cancel-subscription:refused", "cancel-subscription:ok"])
    assert.ok(actions.includes(expected), `The audit log has ${expected}.`);
  const refunded = audit.find((line) => at(line, "action") === "refund" && at(line, "result") === "ok");
  assert.equal(at(refunded, "reason"), "approved in chat");
  assert.equal(at(refunded, "actor"), "e2e-agent");
  assert.equal(at(refunded, "details", "value"), 97);
  check(`changes: --approved guard, --dry-run, refund pre-check, audit (${audit.length} lines)`);

  // The Meta Conversions API recipe: capi-event, then meta-ads capi-send --data @file.
  const metaEnv = {
    META_GRAPH_BASE_URL: baseUrl,
    META_ACCESS_TOKEN_FILE: await secretFile("META_ACCESS_TOKEN", META_TOKEN),
    META_ADS_HOME: join(scratch, "meta-home"),
    META_ADS_ACTOR: "e2e-agent",
  };
  const eventFile = join(scratch, "event.json");
  result = await cli("capi-event", "HP0002", "--out", eventFile);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(at(result.json, "event", "event_id"), "HP0002");
  const meta = await run(META_CLI, metaEnv, [
    "capi-send",
    "--pixel",
    "601",
    "--data",
    `@${eventFile}`,
    "--reason",
    "Hotmart purchase HP0002",
  ]);
  outputs.push(meta.stdout, meta.stderr);
  assert.equal(meta.code, 0, meta.stderr);
  const sent = decodeTeamProtocolV2Json(JSON.parse(state.graphEvents.at(-1) ?? "[]"));
  assert.equal(at(sent, 0, "event_name"), "Purchase");
  assert.equal(at(sent, 0, "event_id"), "HP0002", "The transaction code is the deduplication ID.");
  assert.equal(at(sent, 0, "action_source"), "website");
  assert.equal(at(sent, 0, "custom_data", "value"), 97);
  assert.equal(at(sent, 0, "custom_data", "currency"), "BRL");
  assert.equal(at(sent, 0, "custom_data", "order_id"), "HP0002");
  assert.equal(at(sent, 0, "user_data", "em", 0), sha256("bob@example.com"), "The email is hashed.");
  assert.equal(at(sent, 0, "user_data", "ph", 0), sha256("5531988887777"), "A Brazilian phone gets 55.");
  assert.equal(at(sent, 0, "user_data", "country", 0), sha256("br"));
  assert.ok(!(state.graphEvents.at(-1) ?? "").includes("bob@example.com"), "No plain email reaches Meta.");
  const eventTime = Number(at(sent, 0, "event_time"));
  const flags = await run(META_CLI, metaEnv, [
    "capi-send",
    "--pixel",
    "601",
    "--event",
    "Purchase",
    "--event-id",
    "HP0002",
    "--event-time",
    String(eventTime),
    "--value",
    "97",
    "--currency",
    "BRL",
    "--email",
    "bob@example.com",
    "--action-source",
    "website",
  ]);
  outputs.push(flags.stdout, flags.stderr);
  assert.equal(flags.code, 0, flags.stderr);
  const flagged = decodeTeamProtocolV2Json(JSON.parse(state.graphEvents.at(-1) ?? "[]"));
  assert.equal(at(flagged, 0, "event_id"), "HP0002");
  assert.equal(at(flagged, 0, "user_data", "em", 0), sha256("bob@example.com"));
  assert.deepEqual(at(flagged, 0, "custom_data"), { value: 97, currency: "BRL" });
  result = await cli("capi-event", "HP0006");
  assert.equal(result.code, 1, "A chargeback is never sent as a purchase.");
  check("meta recipe: capi-event then capi-send, transaction as event_id, value, currency, hashed buyer data");

  assertNoSecrets([...outputs, JSON.stringify(audit), await readFile(join(home, "audit.jsonl"), "utf8")], "Output");
  check("secrets: no output or audit line holds a credential or an access token");

  // Watchers, through the host's launcher and baseline comparison.
  resetState();
  const templates = decodeEventCheckTemplateList(JSON.parse(await readFile(join(CATALOG, "catalog.json"), "utf8")));
  const variables = {
    HOTMART_CLIENT_ID: CLIENT_ID,
    HOTMART_CLIENT_SECRET: CLIENT_SECRET,
    HOTMART_BASIC: BASIC,
    HOTMART_API_BASE_URL: baseUrl,
    HOTMART_AUTH_BASE_URL: baseUrl,
  };
  const salesTemplate = templates.find((template) => template.slug === "hotmart-sales");
  assert.ok(salesTemplate);
  const salesConfiguration = Object.fromEntries(salesTemplate.configuration.map((field) => [field.name, field.value]));
  let tokensBefore = state.tokenCount;
  const first = await runWatcher("hotmart-sales", salesConfiguration, variables);
  assert.ok(first.ok, `sales watcher failed: ${first.code}`);
  assert.equal(state.tokenCount - tokensBefore, 1, "One sign-in for the whole run.");
  const firstItems = items(first.value);
  assert.deepEqual(firstItems.map((item) => at(item, "id")).sort(), [
    "HP0001:APPROVED",
    "HP0002:APPROVED",
    "HP0003:COMPLETE",
    "HP0004:APPROVED",
    "HP0005:REFUNDED",
    "HP0006:CHARGEBACK",
  ]);
  const approved = firstItems.find((item) => at(item, "id") === "HP0001:APPROVED");
  assert.equal(at(approved, "value"), 97);
  assert.equal(at(approved, "currency"), "BRL");
  assert.equal(at(approved, "buyerName"), "Ana Maria Silva");
  // The host masks email addresses in every event check result; the agent reads them with the helper.
  assert.equal(at(approved, "buyerEmail"), "[redacted-email]");
  const baseline = observeCheck(firstItems, salesTemplate.selection, null).baseline;
  const second = await runWatcher("hotmart-sales", salesConfiguration, variables);
  const again = observeCheck(items(second.value), salesTemplate.selection, baseline);
  assert.equal(again.changed.length, 0, "A sale in the same status wakes the agent once.");
  const changedSale = state.sales.find((sale) => sale.transaction === "HP0002");
  if (changedSale) changedSale.status = "REFUNDED";
  const third = await runWatcher("hotmart-sales", salesConfiguration, variables);
  const afterRefund = observeCheck(items(third.value), salesTemplate.selection, again.baseline);
  assert.deepEqual(
    afterRefund.changed.map((item) => at(item, "id")),
    ["HP0002:REFUNDED"],
    "A new status wakes the agent once more.",
  );
  assertNoSecrets([JSON.stringify(first.value), JSON.stringify(third.value)], "Watcher output");
  check("hotmart-sales: one item per sale and status, one sign-in per run, a refund wakes again");

  state.rateLimitNext = 1;
  state.rateLimitReset = "0";
  const shortLimit = await runWatcher("hotmart-sales", salesConfiguration, variables);
  assert.ok(shortLimit.ok, "A short rate limit is waited out inside the run.");
  state.rateLimitNext = 1;
  state.rateLimitReset = "60";
  const longLimit = await runWatcher("hotmart-sales", salesConfiguration, variables);
  assert.equal(longLimit.code, "rate_limited");
  state.rateLimitNext = 0;
  const badBasic = await runWatcher("hotmart-sales", salesConfiguration, { ...variables, HOTMART_BASIC: "d3Jvbmc=" });
  assert.equal(badBasic.code, "auth");
  const missing = await runWatcher("hotmart-sales", salesConfiguration, { ...variables, HOTMART_BASIC: "" });
  assert.equal(missing.code, "auth");
  const badStatus = await runWatcher("hotmart-sales", { ...salesConfiguration, statuses: "PAID" }, variables);
  assert.equal(badStatus.code, "config");
  const insecure = await runWatcher("hotmart-sales", salesConfiguration, {
    ...variables,
    HOTMART_API_BASE_URL: "http://example.com",
  });
  assert.equal(insecure.code, "config");
  state.failNext = 1;
  const down = await runWatcher("hotmart-sales", salesConfiguration, variables);
  assert.equal(down.code, "upstream");
  state.failNext = 0;
  check("hotmart-sales: rate_limited, auth, config and upstream error codes");

  const subscriptionsTemplate = templates.find((template) => template.slug === "hotmart-subscriptions");
  assert.ok(subscriptionsTemplate);
  const subscriptionConfiguration = Object.fromEntries(
    subscriptionsTemplate.configuration.map((field) => [field.name, field.value]),
  );
  tokensBefore = state.tokenCount;
  const subscriptions = await runWatcher("hotmart-subscriptions", subscriptionConfiguration, variables);
  assert.ok(subscriptions.ok, `subscriptions watcher failed: ${subscriptions.code}`);
  assert.equal(state.tokenCount - tokensBefore, 1, "One sign-in for the whole run.");
  const subscriptionItems = items(subscriptions.value);
  assert.deepEqual(subscriptionItems.map((item) => at(item, "id")).sort(), [
    "SUBA:CANCELLED_BY_CUSTOMER",
    "SUBB:DELAYED",
  ]);
  const cancelledQuery = requests("GET", "/payments/api/v1/subscriptions").find((request) =>
    request.query.has("cancelation_date"),
  );
  assert.deepEqual(cancelledQuery?.query.getAll("status"), [
    "CANCELLED_BY_CUSTOMER",
    "CANCELLED_BY_SELLER",
    "CANCELLED_BY_ADMIN",
  ]);
  const subscriptionBaseline = observeCheck(subscriptionItems, subscriptionsTemplate.selection, null).baseline;
  const leaving = state.subscriptions.find((subscription) => subscription.code === "SUBD");
  if (leaving) Object.assign(leaving, { status: "CANCELLED_BY_SELLER", cancelledDaysAgo: 0 });
  const nextSubscriptions = await runWatcher("hotmart-subscriptions", subscriptionConfiguration, variables);
  const churn = observeCheck(items(nextSubscriptions.value), subscriptionsTemplate.selection, subscriptionBaseline);
  assert.deepEqual(
    churn.changed.map((item) => at(item, "id")),
    ["SUBD:CANCELLED_BY_SELLER"],
    "A new cancellation wakes the agent once.",
  );
  assertNoSecrets([JSON.stringify(subscriptions.value)], "Watcher output");
  check("hotmart-subscriptions: recent cancellations and late payments, stable IDs, a new cancellation wakes");

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
