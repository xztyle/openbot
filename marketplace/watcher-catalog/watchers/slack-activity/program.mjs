import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// Read-only Slack check. Every request is a GET to the official Web API.
// One run does all its work and prints one page: it either covers the whole recent
// window or fails with a safe message. It never prints a partial window.
const API = "https://slack.com/api/";
const MAX_INPUT_BYTES = 65536;
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 8000;
// The host stops a program after 40 seconds. Stop sending requests well before that.
const RUN_BUDGET_MS = 30000;
const MAX_ITEMS = 2000;
const MAX_OUTPUT_BYTES = 400000;
const PAGE_SIZE = 200;
const SEARCH_PAGE_SIZE = 100;
const MAX_CONTEXT_GROUPS = 10;
const MAX_NAME_LOOKUPS = 12;
const MAX_KEYWORDS = 10;
const MAX_CHANNELS = 15;
const MAX_TEXT = 300;
const MAX_COOLDOWN_MS = 3600 * 1000;
const DEFAULT_COOLDOWN_MS = 60 * 1000;
// A human message has no subtype, or one of these. Joins, topic changes and the like are skipped.
const CONTENT_SUBTYPES = new Set(["thread_broadcast", "file_share", "me_message", "bot_message"]);
// Local, fixed wording for the Slack error codes we know. Server text never reaches stderr.
const KNOWN_ERRORS = {
  invalid_auth: "Slack rejected the token.",
  not_authed: "Slack rejected the token.",
  token_revoked: "The Slack token was revoked.",
  token_expired: "The Slack token expired.",
  account_inactive: "The Slack account is inactive.",
  missing_scope: "The Slack token is missing a required read scope.",
  no_permission: "The Slack token has no permission for this request.",
  access_denied: "Slack denied access for this request.",
  team_access_not_granted: "Slack denied access for this request.",
  channel_not_found: "Slack cannot find the channel, or the user is not in it.",
  not_in_channel: "The Slack user is not in the channel.",
  is_archived: "The Slack channel is archived.",
  fatal_error: "Slack reported an internal error.",
  internal_error: "Slack reported an internal error.",
  service_unavailable: "Slack is temporarily unavailable.",
};

// Which of ERROR_CODES each known Slack error code means.
const KNOWN_ERROR_CODES = {
  invalid_auth: "auth",
  not_authed: "auth",
  token_revoked: "auth",
  token_expired: "auth",
  account_inactive: "auth",
  missing_scope: "auth",
  no_permission: "auth",
  access_denied: "auth",
  team_access_not_granted: "auth",
  channel_not_found: "config",
  not_in_channel: "config",
  is_archived: "config",
  fatal_error: "upstream",
  internal_error: "upstream",
  service_unavailable: "upstream",
};

export const UNKNOWN_ACTOR = "unknown";

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

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function readFlag(value, name, fallback) {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value === "boolean") return value;
  const text = typeof value === "string" ? value.trim().toLowerCase() : "";
  requireCondition(text === "true" || text === "false", `${name} must be "true" or "false".`);
  return text === "true";
}

function readInteger(value, name, fallback, minimum, maximum) {
  if (value === undefined || value === null || value === "") return fallback;
  const number = typeof value === "number" ? value : Number(String(value).trim());
  requireCondition(
    Number.isInteger(number) && number >= minimum && number <= maximum,
    `${name} must be a whole number from ${minimum} to ${maximum}.`,
  );
  return number;
}

function readList(value) {
  if (value === undefined || value === null) return [];
  requireCondition(typeof value === "string", "A list setting must be text.");
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

/**
 * The private variable holds one of two things. An app user token starts with xoxp-. A browser token
 * starts with xoxc- and only works together with the browser's `d` cookie (it starts with xoxd-), so
 * the value is the token, a semicolon, and the cookie: xoxc-...; d=xoxd-...
 * The value is never printed. A malformed value gets a fixed message that does not repeat it.
 */
export function readCredentials(raw) {
  requireCondition(
    typeof raw === "string" && raw.trim().length > 0,
    "Missing SLACK_USER_TOKEN private variable.",
    "auth",
  );
  const parts = raw.split(";").map((part) => part.trim());
  requireCondition(
    parts.length <= 2 && !parts.some((part) => /[^\x21-\x7e]/.test(part)),
    "Invalid SLACK_USER_TOKEN private variable.",
    "auth",
  );
  const token = parts[0];
  requireCondition(/^xox[pc]-[A-Za-z0-9-]{8,}$/.test(token), "The Slack token must start with xoxp- or xoxc-.", "auth");
  if (!token.startsWith("xoxc-")) {
    requireCondition(parts.length === 1, "An xoxp- token takes no cookie.", "auth");
    return { token, cookie: null };
  }
  const cookiePart = (parts[1] ?? "").replace(/^d=/, "");
  requireCondition(
    /^xoxd-[A-Za-z0-9%+/=_.-]{8,}$/.test(cookiePart),
    "A Slack browser token (xoxc-) needs its d cookie after a semicolon: xoxc-...; d=xoxd-...",
    "auth",
  );
  // The browser stores the cookie URL-encoded. A pasted decoded value is encoded again.
  return { token, cookie: cookiePart.includes("%") ? cookiePart : encodeURIComponent(cookiePart) };
}

/** The address of the Web API. Only a slack.com workspace address is accepted, so a token cannot be sent elsewhere. */
function apiBase(config) {
  if (!config.workspaceDomain) return API;
  return `https://${config.workspaceDomain}/api/`;
}

export function readConfiguration(input) {
  requireCondition(isRecord(input), "Expected a JSON object.");
  requireCondition(
    input.cursor === undefined || input.cursor === null || input.cursor === "",
    "Invalid paging cursor.",
  );
  const instanceId = typeof input.instanceId === "string" ? input.instanceId.trim() : "";
  requireCondition(instanceId.length > 0 && instanceId.length <= 128, "Missing or invalid instanceId.");
  const userId = typeof input.userId === "string" ? input.userId.trim() : "";
  requireCondition(/^[UW][A-Z0-9]{2,20}$/.test(userId), "Missing or invalid userId.");
  const workspaceDomain = typeof input.workspaceDomain === "string" ? input.workspaceDomain.trim().toLowerCase() : "";
  requireCondition(
    workspaceDomain === "" || /^[a-z0-9][a-z0-9-]*(\.enterprise)?\.slack\.com$/.test(workspaceDomain),
    "workspaceDomain must be a slack.com address, such as example.slack.com.",
  );
  const config = {
    instanceId,
    userId,
    workspaceDomain,
    watchMentions: readFlag(input.watchMentions, "watchMentions", true),
    watchDirectMessages: readFlag(input.watchDirectMessages, "watchDirectMessages", true),
    watchChannels: readFlag(input.watchChannels, "watchChannels", false),
    includeThreadReplies: readFlag(input.includeThreadReplies, "includeThreadReplies", false),
    keywords: readList(input.keywords),
    channelIds: readList(input.channelIds),
    maxConversations: readInteger(input.maxConversations, "maxConversations", 30, 1, 100),
    contextMessages: readInteger(input.contextMessages, "contextMessages", 8, 0, 20),
    maxRequests: readInteger(input.maxRequests, "maxRequests", 80, 4, 200),
    threadLookbackHours: readInteger(input.threadLookbackHours, "threadLookbackHours", 24, 1, 168),
  };
  requireCondition(config.keywords.length <= MAX_KEYWORDS, `keywords can hold at most ${MAX_KEYWORDS} terms.`);
  requireCondition(
    config.keywords.every((term) => term.length <= 100 && !/\p{Cc}/u.test(term)),
    "Each keyword must be at most 100 characters.",
  );
  requireCondition(config.channelIds.length <= MAX_CHANNELS, `channelIds can hold at most ${MAX_CHANNELS} channels.`);
  requireCondition(
    config.channelIds.every((id) => /^[CGD][A-Z0-9]{2,20}$/.test(id)),
    "channelIds must be Slack channel IDs.",
  );
  config.channelIds = [...new Set(config.channelIds)];
  if (config.watchChannels)
    requireCondition(config.channelIds.length > 0, "watchChannels needs at least one channel ID in channelIds.");
  requireCondition(
    config.watchMentions || config.watchDirectMessages || config.watchChannels,
    "Turn on at least one of watchMentions, watchDirectMessages or watchChannels.",
  );
  return config;
}

function readWindow(input) {
  const since = typeof input.since === "string" ? Date.parse(input.since) : NaN;
  const until = typeof input.until === "string" ? Date.parse(input.until) : NaN;
  requireCondition(
    Number.isFinite(since) && Number.isFinite(until) && since < until,
    "Missing or invalid since/until window.",
  );
  return { since, until };
}

// A Slack timestamp is "seconds.microseconds" text. Keep it as text for IDs.
function parseTs(ts) {
  requireCondition(typeof ts === "string" && /^\d{9,11}\.\d{1,6}$/.test(ts), "Unexpected Slack response.");
  const [seconds, fraction] = ts.split(".");
  return Number(seconds) * 1000 + Math.floor(Number(fraction.padEnd(6, "0")) / 1000);
}

function formatTs(ms) {
  const whole = Math.max(0, Math.floor(ms));
  return `${Math.floor(whole / 1000)}.${String(whole % 1000).padStart(3, "0")}000`;
}

function preview(value) {
  const text = typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
  return text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT - 1)}…` : text;
}

// Only a server-directed cooldown timestamp persists, for one saved instance.
// No messages, credentials or checkpoints are stored here.
export function createCooldownStore(directory) {
  const filename = (instanceId) => path.join(directory, createHash("sha256").update(instanceId).digest("hex"));
  return {
    async read(instanceId) {
      try {
        const timestamp = Number(await fs.readFile(filename(instanceId), "utf8"));
        requireCondition(Number.isFinite(timestamp) && timestamp >= 0, "Invalid API cooldown state.");
        return timestamp;
      } catch (error) {
        if (error instanceof WatcherError) throw error;
        if (error?.code === "ENOENT") return 0;
        throw new WatcherError("Cannot read API cooldown state.");
      }
    },
    async write(instanceId, timestamp) {
      const target = filename(instanceId);
      const temporary = `${target}.${randomUUID()}.tmp`;
      try {
        await fs.mkdir(directory, { recursive: true, mode: 0o700 });
        await fs.writeFile(temporary, String(timestamp), { mode: 0o600, flag: "wx" });
        await fs.rename(temporary, target);
      } catch {
        await fs.unlink(temporary).catch(() => {});
        throw new WatcherError("Cannot save API cooldown state.");
      }
    },
  };
}

function defaultCooldownDirectory() {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), ".slack-activity-cooldowns");
}

async function readJson(response) {
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

async function saveCooldown(response, ctx) {
  let wait = DEFAULT_COOLDOWN_MS;
  const seconds = Number(response.headers.get("retry-after"));
  if (response.headers.get("retry-after") && Number.isFinite(seconds) && seconds >= 0)
    wait = Math.max(1000, seconds * 1000);
  await ctx.store.write(ctx.config.instanceId, ctx.now() + Math.min(wait, MAX_COOLDOWN_MS));
  throw new WatcherError(
    "Slack API rate limit reached; a cooldown is active and no request will be sent until it passes.",
    "rate_limited",
  );
}

/** One read-only Web API call. Counts against the request cap and the run budget. */
async function call(ctx, method, params) {
  requireCondition(
    ctx.requests < ctx.config.maxRequests,
    "The check needs more requests than maxRequests allows. Raise maxRequests or watch less.",
    "config",
  );
  requireCondition(
    ctx.now() - ctx.startedAt < RUN_BUDGET_MS,
    "The check ran out of time before it covered the whole window.",
    "config",
  );
  ctx.requests += 1;
  const url = new URL(method, apiBase(ctx.config));
  for (const [key, value] of Object.entries(params))
    if (value !== undefined && value !== null && value !== "") url.searchParams.set(key, String(value));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let response;
  let body;
  try {
    response = await ctx.fetchImpl(url.toString(), {
      method: "GET",
      redirect: "error",
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${ctx.token}`,
        Accept: "application/json",
        ...(ctx.cookie ? { Cookie: `d=${ctx.cookie}` } : {}),
      },
    });
    if (response.status === 429) await saveCooldown(response, ctx);
    if (!response.ok)
      throw new WatcherError(
        `Slack API HTTP ${Number(response.status) || "error"} for ${method}.`,
        response.status === 401 || response.status === 403 ? "auth" : "upstream",
      );
    body = await readJson(response);
  } catch (error) {
    // Only locally authored messages may reach stderr; never echo fetch or server errors.
    if (error instanceof WatcherError) throw error;
    throw new WatcherError("Slack API request failed or timed out.", "upstream");
  } finally {
    clearTimeout(timer);
  }
  requireCondition(isRecord(body), "Invalid JSON API result.", "upstream");
  if (body.ok === true) return body;
  requireCondition(body.ok === false, "Unexpected Slack response.", "upstream");
  if (body.error === "ratelimited") await saveCooldown(response, ctx);
  const known =
    typeof body.error === "string" && Object.hasOwn(KNOWN_ERRORS, body.error)
      ? KNOWN_ERRORS[body.error]
      : "Slack returned an error.";
  throw new WatcherError(
    `${known} (${method})`,
    typeof body.error === "string" && Object.hasOwn(KNOWN_ERROR_CODES, body.error)
      ? KNOWN_ERROR_CODES[body.error]
      : "upstream",
  );
}

function nextCursor(body) {
  const cursor = body.response_metadata?.next_cursor;
  return typeof cursor === "string" && cursor.length > 0 ? cursor : null;
}

/** Follows Slack cursors until the list ends. A repeated cursor is an error, never a silent stop. */
async function cursorPages(ctx, method, params, onPage) {
  let cursor = null;
  const seen = new Set();
  while (true) {
    const body = await call(ctx, method, { ...params, cursor });
    await onPage(body);
    const next = nextCursor(body);
    if (!next) return;
    requireCondition(!seen.has(next) && next !== cursor, "Slack pagination did not advance.");
    seen.add(next);
    cursor = next;
  }
}

function actorOf(message) {
  if (message.subtype === "bot_message") return UNKNOWN_ACTOR;
  return typeof message.user === "string" && /^[UW][A-Z0-9]{2,20}$/.test(message.user) ? message.user : UNKNOWN_ACTOR;
}

function revisionOf(message) {
  const ts = message.edited?.ts;
  return typeof ts === "string" && /^\d{9,11}\.\d{1,6}$/.test(ts) ? ts : "0";
}

function permalinkOf(message) {
  return typeof message.permalink === "string" &&
    message.permalink.startsWith("https://") &&
    message.permalink.length <= 512
    ? message.permalink
    : undefined;
}

function isContent(message) {
  return isRecord(message) && (message.subtype === undefined || CONTENT_SUBTYPES.has(message.subtype));
}

function createCollector() {
  const items = new Map();
  return {
    items,
    add(item) {
      const existing = items.get(item.id);
      if (!existing) {
        items.set(item.id, item);
        return;
      }
      // The same message can come from two sources. An edit stamp from either one wins.
      if (existing.revision === "0" && item.revision !== "0") existing.revision = item.revision;
      for (const key of ["channelName", "permalink", "threadTs"])
        if (existing[key] === undefined && item[key] !== undefined) existing[key] = item[key];
    },
  };
}

function toItem(message, channel, kind, extra = {}) {
  return {
    id: `${channel.id}:${message.ts}`,
    revision: revisionOf(message),
    actor: actorOf(message),
    kind,
    channel: channel.id,
    channelName: channel.name,
    text: preview(message.text),
    permalink: permalinkOf(message),
    ...extra,
  };
}

function inWindow(message, window) {
  const ms = parseTs(message.ts);
  return ms >= window.since && ms <= window.until;
}

function searchTerm(term) {
  return /\s/.test(term) && !/^".*"$/.test(term) ? `"${term}"` : term;
}

async function collectSearch(ctx, collector, window, query, kind) {
  for (let page = 1; ; page += 1) {
    const body = await call(ctx, "search.messages", {
      query,
      sort: "timestamp",
      sort_dir: "desc",
      count: SEARCH_PAGE_SIZE,
      page,
    });
    const matches = body.messages?.matches;
    const paging = body.messages?.paging;
    requireCondition(
      Array.isArray(matches) && isRecord(paging) && Number.isInteger(paging.pages),
      "Unexpected Slack response.",
    );
    let reachedOlder = false;
    for (const match of matches) {
      if (!isContent(match) || !isRecord(match.channel) || typeof match.channel.id !== "string") continue;
      const ms = parseTs(match.ts);
      if (ms < window.since) {
        reachedOlder = true;
        continue;
      }
      if (ms > window.until) continue;
      const channel = {
        id: match.channel.id,
        name: typeof match.channel.name === "string" ? match.channel.name : undefined,
      };
      collector.add(toItem(match, channel, kind));
    }
    // Results are newest first, so the first page that holds an old message ends the window.
    if (reachedOlder || page >= paging.pages) return;
    requireCondition(matches.length > 0, "Slack pagination did not advance.");
  }
}

async function listConversations(ctx) {
  const found = [];
  await cursorPages(
    ctx,
    "conversations.list",
    { types: "im,mpim", exclude_archived: "true", limit: PAGE_SIZE },
    (body) => {
      requireCondition(Array.isArray(body.channels), "Unexpected Slack response.");
      for (const channel of body.channels) {
        requireCondition(isRecord(channel) && typeof channel.id === "string", "Unexpected Slack response.");
        if (channel.is_user_deleted === true || channel.is_archived === true) continue;
        found.push({
          id: channel.id,
          name: typeof channel.name === "string" ? channel.name : undefined,
          kind: channel.is_mpim === true ? "group_dm" : "dm",
        });
      }
    },
  );
  return found;
}

const MAX_CATCH_UP_MS = 24 * 3600 * 1000;
const MAX_ROTATION_ENTRIES = 1000;

/** Reads the conversations that were read longest ago first. A conversation that was never read comes before all. */
function pickBatch(found, checked, limit) {
  return [...found]
    .sort((a, b) => (checked[a.id] ?? 0) - (checked[b.id] ?? 0) || (a.id < b.id ? -1 : 1))
    .slice(0, limit);
}

/** A conversation that was skipped for a few checks is read from when it was last read, up to one day back. */
function conversationWindow(window, lastChecked) {
  if (!Number.isFinite(lastChecked) || lastChecked >= window.since) return window;
  return { since: Math.max(lastChecked, window.until - MAX_CATCH_UP_MS), until: window.until };
}

/** Per check: when each direct conversation was last read. Only used when there are more than one check can read. */
export function createRotationStore(directory) {
  const filename = (instanceId) =>
    path.join(directory, `${createHash("sha256").update(`rotation:${instanceId}`).digest("hex")}.json`);
  return {
    async read(instanceId) {
      try {
        const parsed = JSON.parse(await fs.readFile(filename(instanceId), "utf8"));
        const checked = {};
        if (isRecord(parsed) && isRecord(parsed.checked))
          for (const [id, value] of Object.entries(parsed.checked))
            if (typeof value === "number" && Number.isFinite(value) && value >= 0) checked[id] = value;
        return checked;
      } catch {
        // Missing or damaged state only means every conversation counts as not read yet.
        return {};
      }
    },
    async write(instanceId, checked) {
      const target = filename(instanceId);
      const temporary = `${target}.${randomUUID()}.tmp`;
      try {
        await fs.mkdir(directory, { recursive: true, mode: 0o700 });
        await fs.writeFile(temporary, JSON.stringify({ checked }), { mode: 0o600 });
        await fs.rename(temporary, target);
      } catch {
        await fs.unlink(temporary).catch(() => {});
        throw new WatcherError("Cannot save which direct conversations were read.", "config");
      }
    },
  };
}

/** Reads one conversation's recent messages, and the threads that had new replies. */
async function collectHistory(ctx, collector, window, channel, kind) {
  const oldest = ctx.config.includeThreadReplies
    ? window.since - ctx.config.threadLookbackHours * 3600 * 1000
    : window.since;
  const threads = [];
  await cursorPages(
    ctx,
    "conversations.history",
    {
      channel: channel.id,
      oldest: formatTs(oldest),
      latest: formatTs(window.until),
      limit: PAGE_SIZE,
    },
    (body) => {
      requireCondition(Array.isArray(body.messages), "Unexpected Slack response.");
      for (const message of body.messages) {
        if (!isContent(message)) continue;
        if (inWindow(message, window)) collector.add(toItem(message, channel, kind));
        if (
          ctx.config.includeThreadReplies &&
          message.thread_ts === message.ts &&
          Number(message.reply_count) > 0 &&
          typeof message.latest_reply === "string" &&
          parseTs(message.latest_reply) >= window.since
        )
          threads.push(message.ts);
      }
    },
  );
  for (const threadTs of threads) {
    await cursorPages(
      ctx,
      "conversations.replies",
      {
        channel: channel.id,
        ts: threadTs,
        oldest: formatTs(window.since),
        latest: formatTs(window.until),
        limit: PAGE_SIZE,
      },
      (body) => {
        requireCondition(Array.isArray(body.messages), "Unexpected Slack response.");
        for (const message of body.messages) {
          if (!isContent(message) || message.ts === threadTs || !inWindow(message, window)) continue;
          collector.add(toItem(message, channel, "thread", { threadTs }));
        }
      },
    );
  }
}

/** The display name of a person, or null. Best effort: a failed lookup never fails a check. */
async function personName(ctx, id) {
  try {
    const body = await call(ctx, "users.info", { user: id });
    const profile = isRecord(body.user) && isRecord(body.user.profile) ? body.user.profile : {};
    for (const candidate of [profile.display_name, profile.real_name, body.user?.real_name, body.user?.name]) {
      const name = preview(candidate);
      if (name) return name.slice(0, 80);
    }
  } catch {
    // Names are a convenience.
  }
  return null;
}

/**
 * Earlier messages of the same conversation, oldest first, so an event is not read without what was
 * said before it. A message that the configured person wrote has fromMe true. Best effort: it only
 * adds fields, it reads at most one conversation per group, and an error never fails the check.
 */
async function attachContext(ctx, items) {
  const limit = ctx.config.contextMessages;
  if (limit === 0 || items.length === 0) return;
  const groups = new Map();
  for (const item of items) {
    const key = item.threadTs ? `${item.channel}:${item.threadTs}` : item.channel;
    const group = groups.get(key) ?? { channel: item.channel, threadTs: item.threadTs, items: [] };
    group.items.push(item);
    groups.set(key, group);
  }
  const newestFirst = [...groups.values()].sort(
    (a, b) => Math.max(...b.items.map(tsOfItem)) - Math.max(...a.items.map(tsOfItem)),
  );
  const names = new Map();
  let lookups = 0;
  const nameOf = async (id) => {
    if (id === UNKNOWN_ACTOR || id === ctx.config.userId) return null;
    if (!names.has(id)) {
      if (lookups >= MAX_NAME_LOOKUPS || ctx.requests >= ctx.config.maxRequests) return null;
      lookups += 1;
      names.set(id, await personName(ctx, id));
    }
    return names.get(id);
  };
  for (const group of newestFirst.slice(0, MAX_CONTEXT_GROUPS)) {
    if (ctx.requests >= ctx.config.maxRequests) break;
    const newest = Math.max(...group.items.map(tsOfItem));
    const params = {
      channel: group.channel,
      latest: formatTs(newest + 1000),
      inclusive: "true",
      limit: Math.min(100, limit + group.items.length + 1),
    };
    let messages;
    try {
      const body = group.threadTs
        ? await call(ctx, "conversations.replies", { ...params, ts: group.threadTs })
        : await call(ctx, "conversations.history", params);
      if (!Array.isArray(body.messages)) continue;
      messages = body.messages.filter((message) => isContent(message) && typeof message.ts === "string");
    } catch {
      continue;
    }
    const earlier = messages
      .map((message) => ({ message, ms: parseTsOrNaN(message.ts) }))
      .filter((entry) => Number.isFinite(entry.ms))
      .sort((a, b) => a.ms - b.ms);
    for (const item of group.items) {
      const before = earlier.filter((entry) => entry.ms < tsOfItem(item) && entry.message.ts !== item.id.split(":")[1]);
      const recent = before.slice(-limit);
      if (recent.length === 0) continue;
      item.context = [];
      for (const { message } of recent) {
        const actor = actorOf(message);
        const entry = { ts: message.ts, user: actor, fromMe: actor === ctx.config.userId, text: preview(message.text) };
        const name = await nameOf(actor);
        if (name) entry.name = name;
        item.context.push(entry);
      }
      const senderName = await nameOf(item.actor);
      if (senderName) item.actorName = senderName;
    }
  }
}

function tsOfItem(item) {
  return parseTs(item.id.split(":")[1]);
}

function parseTsOrNaN(ts) {
  try {
    return parseTs(ts);
  } catch {
    return Number.NaN;
  }
}

async function channelName(ctx, id) {
  const body = await call(ctx, "conversations.info", { channel: id });
  return isRecord(body.channel) && typeof body.channel.name === "string" ? body.channel.name : undefined;
}

export async function runWatcher(
  input,
  {
    token = process.env.SLACK_USER_TOKEN,
    fetchImpl = fetch,
    now = () => Date.now(),
    cooldownDir = defaultCooldownDirectory(),
    store = createCooldownStore(cooldownDir),
    rotation = createRotationStore(cooldownDir),
  } = {},
) {
  const credentials = readCredentials(token);
  const config = tagged("config", () => readConfiguration(input));
  const window = readWindow(input);
  requireCondition(
    (await store.read(config.instanceId)) <= now(),
    "Slack API cooldown is active; no request was sent.",
  );
  const ctx = {
    config,
    token: credentials.token,
    cookie: credentials.cookie,
    fetchImpl,
    now,
    store,
    startedAt: now(),
    requests: 0,
  };

  // The token must belong to the configured person, so this check cannot read another account.
  const auth = await call(ctx, "auth.test", {});
  requireCondition(auth.user_id === config.userId, "The Slack token does not belong to the configured userId.");

  const collector = createCollector();
  let rotated = null;
  if (config.watchMentions) {
    await collectSearch(ctx, collector, window, `<@${config.userId}>`, "mention");
    for (const term of config.keywords) await collectSearch(ctx, collector, window, searchTerm(term), "keyword");
  }
  if (config.watchDirectMessages) {
    const found = await listConversations(ctx);
    // With more conversations than one check may read, each check reads the next batch and the list starts over.
    const rotating = found.length > config.maxConversations;
    const checked = rotating ? await rotation.read(config.instanceId) : {};
    const batch = rotating ? pickBatch(found, checked, config.maxConversations) : found;
    for (const conversation of batch) {
      await collectHistory(
        ctx,
        collector,
        conversationWindow(window, checked[conversation.id]),
        conversation,
        conversation.kind,
      );
    }
    if (rotating) {
      const known = new Set(found.map((conversation) => conversation.id));
      const next = Object.fromEntries(Object.entries(checked).filter(([id]) => known.has(id)));
      for (const conversation of batch) next[conversation.id] = window.until;
      rotated = Object.fromEntries(
        Object.entries(next)
          .sort((a, b) => b[1] - a[1])
          .slice(0, MAX_ROTATION_ENTRIES),
      );
    }
  }
  if (config.watchChannels) {
    for (const id of config.channelIds) {
      const channel = { id, name: await channelName(ctx, id) };
      await collectHistory(ctx, collector, window, channel, id.startsWith("D") ? "dm" : "channel");
    }
  }

  // Oldest first, so the agent reads the conversation in order.
  const items = [...collector.items.values()].sort((a, b) => parseTs(a.id.split(":")[1]) - parseTs(b.id.split(":")[1]));
  requireCondition(items.length <= MAX_ITEMS, "Too many new messages for one check.", "config");
  await attachContext(ctx, items);
  const result = { items, hasNextPage: false, cursor: null };
  // Context is a convenience: when it makes the result too large, the events go out without it.
  if (Buffer.byteLength(JSON.stringify(result)) > MAX_OUTPUT_BYTES)
    for (const item of items) {
      delete item.context;
      delete item.actorName;
    }
  requireCondition(
    Buffer.byteLength(JSON.stringify(result)) <= MAX_OUTPUT_BYTES,
    "Too many new messages for one check.",
    "config",
  );
  // Saved last: a check that failed before this point reads the same batch again.
  if (rotated) await rotation.write(config.instanceId, rotated);
  return result;
}

async function main() {
  try {
    let stdin = "";
    for await (const chunk of process.stdin) {
      stdin += chunk.toString("utf8");
      requireCondition(Buffer.byteLength(stdin) <= MAX_INPUT_BYTES, "Watcher input exceeds the safe size limit.");
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
      `Slack activity watcher: ${error instanceof WatcherError ? error.message : "Watcher failed."}\n`,
    );
    // One code, no text from Slack: OpenBot maps it to its own message.
    if (error instanceof WatcherError && error.code) process.stderr.write(`openbot-error: ${error.code}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
