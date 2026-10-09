import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// Read-only health check for one PostHog project. It sends ONE read-only HogQL query that counts
// events in three time windows (now, the window before, and the same window one week earlier)
// and turns a few totals into a status label. It finds big shifts, not subtle ones.
const MAX_RESPONSE_BYTES = 1024 * 1024;
const REQUEST_TIMEOUT_MS = 15000;
// Explicit uncertainty marker, never a user identity. A health metric has no author.
export const UNKNOWN_ACTOR = "unknown";
const EVENT_NAME = /^[A-Za-z0-9_$ .:-]{1,100}$/;

const ERROR_CODES = ["auth", "rate_limited", "config", "upstream"];

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

/** Runs a reader of settings. A failure without a code gets this code, so each check of a setting needs none. */
function tagged(code, read) {
  try {
    return read();
  } catch (error) {
    if (error instanceof WatcherError && error.code === null) error.code = code;
    throw error;
  }
}

function readInteger(value, fallback, minimum, maximum, name) {
  const number = value === undefined || value === null || value === "" ? fallback : Number(value);
  requireCondition(
    Number.isInteger(number) && number >= minimum && number <= maximum,
    `${name} must be an integer from ${minimum} to ${maximum}.`,
  );
  return number;
}

function readHost(value) {
  const text = value === undefined || value === null || value === "" ? "https://us.posthog.com" : String(value).trim();
  let url;
  try {
    url = new URL(text);
  } catch {
    throw new WatcherError("host must be an https address such as https://us.posthog.com.");
  }
  requireCondition(
    url.protocol === "https:" && !url.username && !url.password && url.pathname === "/" && !url.search && !url.hash,
    "host must be an https address with no path, such as https://eu.posthog.com.",
  );
  return url.origin;
}

function readConfiguration(input) {
  requireCondition(input && typeof input === "object" && !Array.isArray(input), "Expected a JSON object.");
  requireCondition(
    typeof input.instanceId === "string" && /^[A-Za-z0-9._-]{1,64}$/.test(input.instanceId),
    "instanceId must be 1 to 64 letters, digits, dots, dashes or underscores.",
  );
  requireCondition(
    typeof input.projectId === "string" && /^[0-9]{1,12}$/.test(input.projectId.trim()),
    "projectId must be the numeric PostHog project ID.",
  );
  requireCondition(
    input.cursor === undefined || input.cursor === null || input.cursor === "",
    "Unexpected paging cursor.",
  );
  const errorEvents = String(input.errorEventNames ?? "")
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean);
  requireCondition(
    errorEvents.length <= 10 && errorEvents.every((name) => EVENT_NAME.test(name)),
    "errorEventNames must list at most 10 event names with letters, digits, spaces and _ $ . : - only.",
  );
  return {
    instanceId: input.instanceId,
    host: readHost(input.host),
    projectId: input.projectId.trim(),
    windowMinutes: readInteger(input.windowMinutes, 60, 5, 1440, "windowMinutes"),
    dropPercent: readInteger(input.dropPercent, 50, 1, 99, "dropPercent"),
    spikePercent: readInteger(input.spikePercent, 200, 1, 10000, "spikePercent"),
    minimumBaseline: readInteger(input.minimumBaseline, 50, 1, 1000000000, "minimumBaseline"),
    minimumUsers: readInteger(input.minimumUsers, 10, 1, 1000000000, "minimumUsers"),
    minimumErrors: readInteger(input.minimumErrors, 10, 1, 1000000000, "minimumErrors"),
    errorEvents,
  };
}

/** The only request this program sends. A read-only HogQL SELECT over three bounded time ranges. */
export function buildQuery(config) {
  const window = config.windowMinutes;
  const columns = [
    "multiIf(timestamp >= now() - toIntervalMinute(" +
      window +
      "), 'current', " +
      "timestamp >= now() - toIntervalMinute(" +
      window * 2 +
      "), 'previous', 'week') AS win",
    "count() AS volume",
    "countIf(event = '$pageview') AS pageviews",
    "uniq(person_id) AS users",
    "countIf(event = '$exception') AS exceptions",
  ];
  if (config.errorEvents.length > 0) {
    columns.push(`countIf(event IN (${config.errorEvents.map((name) => `'${name}'`).join(", ")})) AS errors`);
  }
  return (
    `SELECT ${columns.join(", ")} FROM events WHERE ` +
    `(timestamp >= now() - toIntervalMinute(${window * 2}) AND timestamp < now()) ` +
    `OR (timestamp >= now() - toIntervalDay(7) - toIntervalMinute(${window}) AND timestamp < now() - toIntervalDay(7)) ` +
    "GROUP BY win LIMIT 10"
  );
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
    throw new WatcherError("Invalid JSON API response.", "upstream");
  }
}

// Only a server-directed cooldown timestamp persists, separately per saved instance.
// No account contents, credentials or polling checkpoints are stored here.
function cooldownFilename(instanceId) {
  const key = createHash("sha256").update(instanceId).digest("hex");
  return path.join(path.dirname(fileURLToPath(import.meta.url)), ".posthog-health-cooldowns", key);
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
  await store.write(instanceId, until);
  throw new WatcherError("PostHog API rate limit reached; server-directed cooldown is active.", "rate_limited");
}

function httpFailure(status) {
  const code = Number(status) || 0;
  if (code === 401 || code === 403) {
    return new WatcherError(
      `PostHog rejected the API key (HTTP ${code}). Check POSTHOG_PERSONAL_API_KEY and its query:read scope.`,
      "auth",
    );
  }
  if (code === 404)
    return new WatcherError("PostHog did not find the project (HTTP 404). Check host and projectId.", "config");
  return new WatcherError(`PostHog API HTTP ${code || "error"}.`, "upstream");
}

function count(value) {
  const number = typeof value === "string" && /^[0-9]{1,15}$/.test(value) ? Number(value) : value;
  requireCondition(
    typeof number === "number" && Number.isFinite(number) && number >= 0,
    "Unexpected PostHog query result.",
    "upstream",
  );
  return number;
}

/** Turns the grouped query rows into one set of counts per window. A missing window means no events. */
export function parseWindows(body, config) {
  requireCondition(
    body && typeof body === "object" && Array.isArray(body.results) && body.results.length <= 3,
    "Unexpected PostHog query result.",
    "upstream",
  );
  const names = ["volume", "pageviews", "users", "exceptions", ...(config.errorEvents.length > 0 ? ["errors"] : [])];
  const empty = () => Object.fromEntries(names.map((name) => [name, 0]));
  const windows = { current: empty(), previous: empty(), week: empty() };
  const seen = new Set();
  for (const row of body.results) {
    requireCondition(
      Array.isArray(row) && row.length === names.length + 1 && Object.hasOwn(windows, row[0]) && !seen.has(row[0]),
      "Unexpected PostHog query result.",
    );
    seen.add(row[0]);
    names.forEach((name, index) => {
      windows[row[0]][name] = count(row[index + 1]);
    });
  }
  return windows;
}

const METRICS = [
  { name: "volume", label: "Event volume", low: true, high: true, minimum: "minimumBaseline" },
  { name: "pageviews", label: "Pageviews", low: true, high: false, minimum: "minimumBaseline" },
  { name: "users", label: "Unique users", low: true, high: false, minimum: "minimumUsers" },
  { name: "exceptions", label: "Exceptions", low: false, high: true, minimum: null },
  { name: "errors", label: "Custom error events", low: false, high: true, minimum: null },
];

function percentChange(current, baseline) {
  return baseline > 0 ? Math.round(((current - baseline) / baseline) * 100) : null;
}

/**
 * ok | low | high | unknown. The reference is the same window one week earlier. When that
 * window is too quiet to compare with, the previous window is used. Error metrics may only be
 * high, and zero errors a week ago is a real baseline.
 */
export function classify(metric, windows, config) {
  const current = windows.current[metric.name];
  const week = windows.week[metric.name];
  const previous = windows.previous[metric.name];
  if (!metric.low) {
    return current >= config.minimumErrors && current > (1 + config.spikePercent / 100) * week ? "high" : "ok";
  }
  const minimum = config[metric.minimum];
  const reference = week >= minimum ? week : previous >= minimum ? previous : null;
  if (reference === null) return "unknown";
  if (current < (1 - config.dropPercent / 100) * reference) return "low";
  if (metric.high && current > (1 + config.spikePercent / 100) * reference) return "high";
  return "ok";
}

export function buildItems(windows, config) {
  return METRICS.filter((metric) => metric.name !== "errors" || config.errorEvents.length > 0).map((metric) => {
    const current = windows.current[metric.name];
    const week = windows.week[metric.name];
    const previous = windows.previous[metric.name];
    const status = classify(metric, windows, config);
    return {
      id: `metric:${metric.name}`,
      revision: status,
      actor: UNKNOWN_ACTOR,
      metric: metric.label,
      status,
      windowMinutes: config.windowMinutes,
      current,
      previousWindow: previous,
      sameWindowLastWeek: week,
      changeVsLastWeekPercent: percentChange(current, week),
      changeVsPreviousWindowPercent: percentChange(current, previous),
    };
  });
}

/** Returns the current status of every health metric in one page. Read-only. */
export async function runWatcher(
  input,
  {
    token = process.env.POSTHOG_PERSONAL_API_KEY,
    fetchImpl = fetch,
    store = cooldownStore,
    now = () => Date.now(),
  } = {},
) {
  requireCondition(
    typeof token === "string" && token.trim().length > 0,
    "Missing POSTHOG_PERSONAL_API_KEY private variable.",
    "auth",
  );
  requireCondition(!/[\r\n]/.test(token), "Invalid POSTHOG_PERSONAL_API_KEY private variable.", "auth");
  const config = tagged("config", () => readConfiguration(input));
  requireCondition(
    (await store.read(config.instanceId)) <= now(),
    "PostHog API cooldown is active; no request was sent.",
    "rate_limited",
  );
  let body;
  try {
    const response = await fetchImpl(`${config.host}/api/projects/${config.projectId}/query/`, {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        Authorization: `Bearer ${token.trim()}`,
      },
      body: JSON.stringify({ query: { kind: "HogQLQuery", query: buildQuery(config) }, refresh: "blocking" }),
    });
    if (response.status === 429) await saveCooldown(response, config.instanceId, store, now());
    if (!response.ok) throw httpFailure(response.status);
    body = await readResponse(response);
  } catch (error) {
    // Only these locally authored messages may reach stderr; never echo fetch/server errors.
    if (error instanceof WatcherError) throw error;
    throw new WatcherError("PostHog API request failed or timed out.", "upstream");
  }
  return { items: buildItems(parseWindows(body, config), config), hasNextPage: false, cursor: null };
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
      `PostHog health watcher: ${error instanceof WatcherError ? error.message : "Watcher failed."}\n`,
    );
    // One code, no text from PostHog: OpenBot maps it to its own message.
    if (error instanceof WatcherError && error.code) process.stderr.write(`openbot-error: ${error.code}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
