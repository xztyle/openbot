import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// Read-only state check for Render. It lists services (and optionally Postgres and Key Value
// instances), reads the latest deploys, and prints one item per thing with a compact revision.
// The revision changes only when the state is worth waking the agent for.
const API = "https://api.render.com/v1";
const PAGE_SIZE = 100;
const MAX_LIST_PAGES = 10;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 10000;
// The host stops a program after 40 s. Stop starting requests well before that.
const RUN_BUDGET_MS = 30000;
const CONCURRENCY = 5;
const FINISHED_LOOKBACK = 10;
// Explicit uncertainty marker, never a user identity. Render does not tell who changed a state.
export const UNKNOWN_ACTOR = "unknown";
// While a deploy is in one of these states it is "deploying", not finished.
const DEPLOYING = new Set(["created", "build_in_progress", "update_in_progress", "pre_deploy_in_progress"]);
const FINISHED = new Set(["live", "deactivated", "build_failed", "update_failed", "canceled", "pre_deploy_failed"]);

export function hasControl(text) {
  for (const ch of text) {
    const code = ch.charCodeAt(0);
    if (code < 32 || code === 127) return true;
  }
  return false;
}

// Each run of control characters becomes one space.
function controlToSpace(text) {
  let out = "";
  let inRun = false;
  for (const ch of text) {
    const code = ch.charCodeAt(0);
    if (code < 32 || code === 127) {
      if (!inRun) out += " ";
      inRun = true;
    } else {
      out += ch;
      inRun = false;
    }
  }
  return out;
}

class WatcherError extends Error {}

function requireCondition(condition, message) {
  if (!condition) throw new WatcherError(message);
}

function cleanText(value, max) {
  if (typeof value !== "string") return "";
  return controlToSpace(value).trim().slice(0, max);
}

function readBoolean(value, fallback, name) {
  if (value === undefined || value === null || value === "") return fallback;
  requireCondition(value === "true" || value === "false", `${name} must be "true" or "false".`);
  return value === "true";
}

function readConfiguration(input) {
  requireCondition(input && typeof input === "object" && !Array.isArray(input), "Expected a JSON object.");
  requireCondition(
    typeof input.instanceId === "string" && /^[A-Za-z0-9._-]{1,64}$/.test(input.instanceId),
    "instanceId must be 1 to 64 letters, digits, dots, dashes or underscores.",
  );
  const ownerId = input.ownerId === undefined || input.ownerId === null ? "" : String(input.ownerId).trim();
  requireCondition(
    ownerId === "" || /^[A-Za-z0-9_-]{1,64}$/.test(ownerId),
    "ownerId is not a valid Render workspace ID.",
  );
  const names = String(input.serviceNames ?? "")
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean);
  requireCondition(
    names.length <= 50 && names.every((name) => name.length <= 100 && !hasControl(name)),
    "serviceNames must list at most 50 names of at most 100 characters.",
  );
  const maxServices = Number(input.maxServices ?? 50);
  requireCondition(
    Number.isInteger(maxServices) && maxServices >= 1 && maxServices <= 100,
    "maxServices must be an integer from 1 to 100.",
  );
  requireCondition(
    input.cursor === undefined || input.cursor === null || input.cursor === "",
    "Unexpected paging cursor.",
  );
  return {
    instanceId: input.instanceId,
    ownerId,
    names,
    maxServices,
    watchDatabases: readBoolean(input.watchDatabases, true, "watchDatabases"),
    notifyOnDeploying: readBoolean(input.notifyOnDeploying, false, "notifyOnDeploying"),
  };
}

async function readResponse(response) {
  requireCondition(response.body && typeof response.body.getReader === "function", "Missing API response body.");
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      total += value.byteLength;
      requireCondition(total <= MAX_RESPONSE_BYTES, "API response exceeds the safe size limit.");
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new WatcherError("Invalid JSON API response.");
  }
}

// Only a server-directed cooldown timestamp persists, separately per saved instance.
// No account contents, credentials or polling checkpoints are stored here.
function cooldownFilename(instanceId) {
  const key = createHash("sha256").update(instanceId).digest("hex");
  return path.join(path.dirname(fileURLToPath(import.meta.url)), ".render-services-cooldowns", key);
}

const cooldownStore = {
  async read(instanceId) {
    try {
      const timestamp = Number(await fs.readFile(cooldownFilename(instanceId), "utf8"));
      requireCondition(Number.isFinite(timestamp) && timestamp >= 0, "Invalid API cooldown state.");
      return timestamp;
    } catch (error) {
      if (error.code === "ENOENT") return 0;
      if (error instanceof WatcherError) throw error;
      throw new WatcherError("Cannot read API cooldown state.");
    }
  },
  async write(instanceId, timestamp) {
    const filename = cooldownFilename(instanceId);
    const temporary = `${filename}.${randomUUID()}.tmp`;
    try {
      await fs.mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
      await fs.writeFile(temporary, String(timestamp), { mode: 0o600, flag: "wx" });
      await fs.rename(temporary, filename);
    } catch {
      await fs.unlink(temporary).catch(() => {});
      throw new WatcherError("Cannot save API cooldown state.");
    }
  },
};

async function saveCooldown(response, instanceId, store, nowMs) {
  let until = nowMs + 60000;
  const retry = response.headers.get("retry-after");
  if (retry) {
    const seconds = Number(retry);
    const timestamp = Number.isFinite(seconds) ? nowMs + Math.max(0, seconds) * 1000 : Date.parse(retry);
    if (Number.isFinite(timestamp)) until = Math.max(until, timestamp);
  }
  const reset = Number(response.headers.get("ratelimit-reset"));
  if (Number.isFinite(reset) && reset > 0 && reset < 3600) until = Math.max(until, nowMs + reset * 1000);
  await store.write(instanceId, until);
  throw new WatcherError("Render API rate limit reached; server-directed cooldown is active.");
}

function httpFailure(status) {
  const code = Number(status) || 0;
  if (code === 401 || code === 403) {
    return new WatcherError(`Render rejected the API key (HTTP ${code}). Check RENDER_API_KEY.`);
  }
  if (code === 404) return new WatcherError("Render did not find the requested resource (HTTP 404).");
  return new WatcherError(`Render API HTTP ${code || "error"}.`);
}

function createClient({ token, fetchImpl, store, now, config }) {
  const startedAt = now();
  let failed = false;
  /** One read-only GET. Any failure marks the run as failed so that no new request starts. */
  async function get(pathname, query) {
    requireCondition(!failed, "Render check stopped after an earlier failure.");
    requireCondition(now() - startedAt < RUN_BUDGET_MS, "Render check ran out of time; reduce maxServices.");
    const url = new URL(`${API}${pathname}`);
    for (const [name, value] of Object.entries(query))
      if (value !== undefined && value !== "") url.searchParams.set(name, String(value));
    try {
      const response = await fetchImpl(url.toString(), {
        method: "GET",
        redirect: "error",
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        headers: { Accept: "application/json", Authorization: `Bearer ${token.trim()}` },
      });
      if (response.status === 429) await saveCooldown(response, config.instanceId, store, now());
      if (!response.ok) throw httpFailure(response.status);
      const body = await readResponse(response);
      requireCondition(Array.isArray(body), "Unexpected Render API response.");
      return body;
    } catch (error) {
      failed = true;
      // Only these locally authored messages may reach stderr; never echo fetch/server errors.
      if (error instanceof WatcherError) throw error;
      throw new WatcherError("Render API request failed or timed out.");
    }
  }
  return { get };
}

/** Reads every page of a list endpoint, or throws. Render's cursor is the cursor of the last entry. */
async function listAll(client, pathname, wrapperKey, ownerId) {
  const objects = [];
  let cursor;
  for (let page = 0; page < MAX_LIST_PAGES; page += 1) {
    const entries = await client.get(pathname, { limit: PAGE_SIZE, cursor, ownerId });
    requireCondition(entries.length <= PAGE_SIZE, "Unexpected Render API page size.");
    for (const entry of entries) {
      requireCondition(
        entry && typeof entry === "object" && entry[wrapperKey] && typeof entry[wrapperKey] === "object",
        "Unexpected Render API entry.",
      );
      objects.push(entry[wrapperKey]);
    }
    if (entries.length < PAGE_SIZE) return objects;
    const next = entries[entries.length - 1].cursor;
    requireCondition(
      typeof next === "string" && next.length > 0 && next !== cursor,
      "Render API pagination did not advance.",
    );
    cursor = next;
  }
  throw new WatcherError("Render account has more entries than the paging limit; set ownerId or serviceNames.");
}

function requireId(value) {
  requireCondition(typeof value === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(value), "Unexpected Render ID.");
  return value;
}

function suspendedLabel(value) {
  return value === "suspended" || value === "not_suspended" ? value : "unknown";
}

function dashboardUrl(value) {
  return typeof value === "string" && value.length <= 300 && value.startsWith("https://dashboard.render.com/")
    ? value
    : null;
}

function isoOrNull(value) {
  return typeof value === "string" && value.length <= 40 && Number.isFinite(Date.parse(value)) ? value : null;
}

/**
 * Picks the deploy that decides the state. By default a deploy that is still running is skipped,
 * so the state stays on the last finished deploy until the running one ends. With
 * notifyOnDeploying the newest deploy counts, and every running status reads as "deploying".
 */
export function pickDeploy(entries, notifyOnDeploying) {
  const deploys = entries.map((entry) => entry?.deploy).filter((deploy) => deploy && typeof deploy === "object");
  const chosen = notifyOnDeploying ? deploys[0] : deploys.find((deploy) => !DEPLOYING.has(deploy.status));
  if (!chosen) return { id: "none", state: "none", deploy: null };
  const id = typeof chosen.id === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(chosen.id) ? chosen.id : "none";
  const state = DEPLOYING.has(chosen.status) ? "deploying" : FINISHED.has(chosen.status) ? chosen.status : "unknown";
  return { id, state, deploy: chosen };
}

export function serviceItem(service, deployEntries, notifyOnDeploying) {
  const id = requireId(service.id);
  const suspended = suspendedLabel(service.suspended);
  const picked = pickDeploy(deployEntries, notifyOnDeploying);
  const commit = picked.deploy?.commit;
  return {
    id: `svc:${id}`,
    revision: `${suspended}:${picked.state}:${picked.id}`,
    actor: UNKNOWN_ACTOR,
    kind: "service",
    name: cleanText(service.name, 100),
    type: cleanText(service.type, 40),
    suspended,
    deployStatus: cleanText(picked.deploy?.status, 40) || null,
    branch: cleanText(service.branch, 60) || null,
    commitMessage: cleanText(String(commit?.message ?? "").split("\n")[0], 120) || null,
    finishedAt: isoOrNull(picked.deploy?.finishedAt),
    dashboardUrl: dashboardUrl(service.dashboardUrl),
  };
}

export function databaseItem(database, kind) {
  const id = requireId(database.id);
  const status =
    typeof database.status === "string" && /^[a-z_]{1,40}$/.test(database.status) ? database.status : "unknown";
  const suspended = suspendedLabel(database.suspended);
  return {
    id: `db:${id}`,
    revision: `${status}:${suspended}`,
    actor: UNKNOWN_ACTOR,
    kind,
    name: cleanText(database.name, 100),
    status,
    suspended,
    dashboardUrl: dashboardUrl(database.dashboardUrl),
  };
}

async function mapWithLimit(values, limit, work) {
  const results = new Array(values.length);
  let next = 0;
  async function worker() {
    while (next < values.length) {
      const index = next;
      next += 1;
      results[index] = await work(values[index]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, values.length) }, worker));
  return results;
}

function capped(list, config, label) {
  requireCondition(
    list.length <= config.maxServices,
    `Render account has ${list.length} ${label}, more than maxServices (${config.maxServices}). Raise maxServices or narrow ownerId or serviceNames.`,
  );
}

/** Returns the current state of every watched thing in one page. Read-only. */
export async function runWatcher(
  input,
  { token = process.env.RENDER_API_KEY, fetchImpl = fetch, store = cooldownStore, now = () => Date.now() } = {},
) {
  requireCondition(typeof token === "string" && token.trim().length > 0, "Missing RENDER_API_KEY private variable.");
  requireCondition(!/[\r\n]/.test(token), "Invalid RENDER_API_KEY private variable.");
  const config = readConfiguration(input);
  requireCondition(
    (await store.read(config.instanceId)) <= now(),
    "Render API cooldown is active; no request was sent.",
  );
  const client = createClient({ token, fetchImpl, store, now, config });

  let services = await listAll(client, "/services", "service", config.ownerId);
  if (config.names.length > 0) {
    const wanted = new Set(config.names.map((name) => name.toLowerCase()));
    services = services.filter((service) => wanted.has(cleanText(service?.name, 100).toLowerCase()));
    const found = new Set(services.map((service) => cleanText(service.name, 100).toLowerCase()));
    requireCondition(
      [...wanted].every((name) => found.has(name)),
      "A name in serviceNames matches no service.",
    );
  }
  capped(services, config, "services");
  const limit = config.notifyOnDeploying ? 1 : FINISHED_LOOKBACK;
  const items = await mapWithLimit(services, CONCURRENCY, async (service) => {
    const id = requireId(service?.id);
    const deploys = await client.get(`/services/${encodeURIComponent(id)}/deploys`, { limit });
    return serviceItem(service, deploys, config.notifyOnDeploying);
  });

  if (config.watchDatabases) {
    const postgres = await listAll(client, "/postgres", "postgres", config.ownerId);
    capped(postgres, config, "Postgres instances");
    const keyValue = await listAll(client, "/key-value", "keyValue", config.ownerId);
    capped(keyValue, config, "Key Value instances");
    for (const database of postgres) items.push(databaseItem(database, "postgres"));
    for (const database of keyValue) items.push(databaseItem(database, "key-value"));
  }
  requireCondition(new Set(items.map((item) => item.id)).size === items.length, "Duplicate item ID in Render data.");
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
      `Render services watcher: ${error instanceof WatcherError ? error.message : "Watcher failed."}\n`,
    );
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
