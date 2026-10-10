import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// Read-only Slack check. Every request is a GET to the official Web API.
// One run does all its work and prints one page: it either covers the whole recent
// window or fails with a safe message. It never prints a partial window.
// With `discover: true` in the input it does not check for events. It lists the conversations of
// the token's user, so that a person can pick them in the app instead of copying IDs. With `ids`
// besides, it names only those conversations, so the app can show a saved choice by its name.
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
const MAX_RULES = 50;
const MAX_OPTIONS = 1000;
const MAX_LABEL = 80;
const MAX_DESCRIPTION = 120;
const MAX_DM_LOOKUPS = 60;
const MAX_RESOLVE_PAGES = 5;
// The member list is read in pages of PAGE_SIZE. A workspace of thousands of people is still bounded.
const MAX_USER_PAGES = 15;
// The most conversations a discovery with `ids` resolves, as many as a picker value can hold.
const MAX_DISCOVERY_IDS = 50;
const CONVERSATION_ID = /^[CGD][A-Z0-9]{2,20}$/;
const USER_ID = /^[UW][A-Z0-9]{2,20}$/;
// What a rule can ask for in a conversation: every new message, or only those that mention the person.
const RULE_MODES = new Set(["all", "mentions"]);
const CONVERSATION_TYPES = "public_channel,private_channel,im,mpim";
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
 * `ID:mode` pairs separated by commas, such as C012ABCDE:all,D012ABCDE:mentions. A conversation that
 * is listed twice is a mistake, so it is refused and not merged.
 */
export function readConversationRules(value) {
  const rules = [];
  const seen = new Set();
  for (const entry of readList(value)) {
    const parts = entry.split(":").map((part) => part.trim());
    requireCondition(
      parts.length === 2 && CONVERSATION_ID.test(parts[0]) && RULE_MODES.has(parts[1]),
      "conversationRules must be pairs of a conversation ID and a mode (all or mentions), such as C012ABCDE:mentions.",
    );
    requireCondition(!seen.has(parts[0]), "conversationRules lists a conversation twice.");
    seen.add(parts[0]);
    rules.push({ id: parts[0], mode: parts[1] });
  }
  requireCondition(rules.length <= MAX_RULES, `conversationRules can hold at most ${MAX_RULES} conversations.`);
  return rules;
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

function readUserId(value) {
  const userId = typeof value === "string" ? value.trim() : "";
  requireCondition(USER_ID.test(userId), "Missing or invalid userId.");
  return userId;
}

function readWorkspaceDomain(value) {
  const workspaceDomain = typeof value === "string" ? value.trim().toLowerCase() : "";
  requireCondition(
    workspaceDomain === "" || /^[a-z0-9][a-z0-9-]*(\.enterprise)?\.slack\.com$/.test(workspaceDomain),
    "workspaceDomain must be a slack.com address, such as example.slack.com.",
  );
  return workspaceDomain;
}

export function readConfiguration(input) {
  requireCondition(isRecord(input), "Expected a JSON object.");
  requireCondition(
    input.cursor === undefined || input.cursor === null || input.cursor === "",
    "Invalid paging cursor.",
  );
  const instanceId = typeof input.instanceId === "string" ? input.instanceId.trim() : "";
  requireCondition(instanceId.length > 0 && instanceId.length <= 128, "Missing or invalid instanceId.");
  const userId = readUserId(input.userId);
  const workspaceDomain = readWorkspaceDomain(input.workspaceDomain);
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
    conversationRules: readConversationRules(input.conversationRules),
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
    config.channelIds.every((id) => CONVERSATION_ID.test(id)),
    "channelIds must be Slack channel IDs.",
  );
  config.channelIds = [...new Set(config.channelIds)];
  // A chosen conversation is read whatever the other switches say, so a rule alone is enough to run.
  if (config.watchChannels)
    requireCondition(
      config.channelIds.length > 0 || config.conversationRules.length > 0,
      "watchChannels needs at least one channel ID in channelIds.",
    );
  requireCondition(
    config.watchMentions || config.watchDirectMessages || config.watchChannels || config.conversationRules.length > 0,
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

const STOP = Symbol("stop");

/**
 * Follows Slack cursors until the list ends. A repeated cursor is an error, never a silent stop.
 * A page handler that answers STOP ends the walk: it has all it needs.
 */
async function cursorPages(ctx, method, params, onPage) {
  let cursor = null;
  const seen = new Set();
  while (true) {
    const body = await call(ctx, method, { ...params, cursor });
    if ((await onPage(body)) === STOP) return;
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

/** Whether the text of a message mentions the person: `<@U012ABCDE>`, or the older `<@U012ABCDE|name>`. */
function mentionsUser(message, userId) {
  const text = typeof message.text === "string" ? message.text : "";
  return text.includes(`<@${userId}>`) || text.includes(`<@${userId}|`);
}

/**
 * Reads one conversation's recent messages, and the threads that had new replies. With `mode` set to
 * "mentions" only a message that mentions the person is kept. A thread is still opened when its first
 * message does not, because a reply can.
 */
async function collectHistory(ctx, collector, window, channel, kind, mode = "all") {
  const wanted = (message) => mode === "all" || mentionsUser(message, ctx.config.userId);
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
        if (inWindow(message, window) && wanted(message)) collector.add(toItem(message, channel, kind));
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
          if (!isContent(message) || message.ts === threadTs || !inWindow(message, window) || !wanted(message))
            continue;
          collector.add(toItem(message, channel, "thread", { threadTs }));
        }
      },
    );
  }
}

/** The display name that a Slack user record holds, or null. */
function userDisplayName(user) {
  const profile = isRecord(user) && isRecord(user.profile) ? user.profile : {};
  for (const candidate of [profile.display_name, profile.real_name, user?.real_name, user?.name]) {
    const name = preview(candidate);
    if (name) return name.slice(0, 80);
  }
  return null;
}

/** The display name of a person, or null when Slack has none. A failed request is thrown. */
async function fetchPersonName(ctx, id) {
  const body = await call(ctx, "users.info", { user: id });
  return userDisplayName(body.user);
}

/** The display name of a person, or null. Best effort: a failed lookup never fails a check. */
async function personName(ctx, id) {
  try {
    return await fetchPersonName(ctx, id);
  } catch {
    // Names are a convenience.
    return null;
  }
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

/** What a conversation is, from the fields that Slack puts on it. */
function conversationKind(channel) {
  if (channel.is_im === true) return "dm";
  if (channel.is_mpim === true) return "group_dm";
  return channel.is_private === true || channel.is_group === true ? "private_channel" : "channel";
}

/**
 * The name and kind of each chosen conversation. One walk over the conversations of the person
 * answers most of them with a few requests, and it stops once it has them all. A conversation that
 * it does not list, such as a public channel the person has not joined, is asked for by itself.
 */
async function resolveConversations(ctx, ids, { names = false } = {}) {
  const known = new Map();
  // A check needs no name for a direct conversation. A discovery that names conversations does.
  const wanted = new Set(names ? ids : ids.filter((id) => !id.startsWith("D")));
  if (!names) for (const id of ids) if (id.startsWith("D")) known.set(id, { id, name: undefined, kind: "dm" });
  if (wanted.size > 0) {
    let pages = 0;
    try {
      await cursorPages(
        ctx,
        "users.conversations",
        { types: CONVERSATION_TYPES, exclude_archived: "true", limit: PAGE_SIZE },
        (body) => {
          pages += 1;
          if (!Array.isArray(body.channels)) return STOP;
          for (const channel of body.channels)
            if (isRecord(channel) && wanted.has(channel.id))
              known.set(channel.id, {
                id: channel.id,
                name: typeof channel.name === "string" ? channel.name : undefined,
                kind: conversationKind(channel),
                user: typeof channel.user === "string" ? channel.user : undefined,
              });
          return [...wanted].every((id) => known.has(id)) || pages >= MAX_RESOLVE_PAGES ? STOP : undefined;
        },
      );
    } catch (error) {
      // A rate limit stops the whole check. Any other failure falls back to asking for each one.
      if (error instanceof WatcherError && error.code === "rate_limited") throw error;
    }
  }
  for (const id of ids) {
    if (known.has(id)) continue;
    let body;
    try {
      body = await call(ctx, "conversations.info", { channel: id });
    } catch (error) {
      // A check fails as a whole. A discovery names what it can and leaves the rest out.
      if (!names) throw error;
      if (error instanceof WatcherError && error.code === "rate_limited") throw error;
      if (error instanceof WatcherError && error.code === "auth") break;
      if (ctx.requests >= ctx.config.maxRequests || ctx.now() - ctx.startedAt >= RUN_BUDGET_MS) break;
      continue;
    }
    const channel = isRecord(body.channel) ? body.channel : {};
    known.set(id, {
      id,
      name: typeof channel.name === "string" ? channel.name : undefined,
      kind: conversationKind(channel),
      user: typeof channel.user === "string" ? channel.user : undefined,
    });
  }
  return known;
}

// What the app shows in its pickers is text from Slack that other people wrote. It is cleaned here
// and checked again by the host: no control or formatting character, and a short length.
function cleanLabel(value, limit) {
  const text =
    typeof value === "string"
      ? value
          .replace(/[\t\n\r\u2028\u2029]/g, " ")
          .replace(/[\p{Cc}\p{Cf}]/gu, "")
          .replace(/\s+/g, " ")
          .trim()
      : "";
  const characters = Array.from(text);
  return characters.length > limit ? `${characters.slice(0, limit - 1).join("")}…` : text;
}

/** A group conversation is named `mpdm-alice--bob--carol-1` by Slack. The label lists the people. */
function groupLabel(name) {
  const plain = typeof name === "string" ? name.replace(/^mpdm-/, "").replace(/-\d+$/, "") : "";
  return cleanLabel(plain.split("--").filter(Boolean).join(", "), MAX_LABEL);
}

/**
 * Fills `names` with the display names of `wanted` people from the member list: pages of 200, the
 * same users:read scope as users.info. It stops once it has them all and after MAX_USER_PAGES pages.
 * `found` holds each wanted person that the list had, named or not.
 */
async function listPeopleNames(ctx, wanted, names, found) {
  const pending = new Set(wanted);
  if (pending.size === 0) return;
  let pages = 0;
  await cursorPages(ctx, "users.list", { limit: PAGE_SIZE }, (body) => {
    pages += 1;
    if (!Array.isArray(body.members)) return STOP;
    for (const member of body.members) {
      if (!isRecord(member) || typeof member.id !== "string" || !pending.has(member.id)) continue;
      pending.delete(member.id);
      found.add(member.id);
      const name = userDisplayName(member);
      if (name) names.set(member.id, name);
    }
    return pending.size === 0 || pages >= MAX_USER_PAGES ? STOP : undefined;
  });
}

/**
 * The display names of some people, as far as the request cap and Slack allow. The member list gives
 * most of them in a few requests. A person that it does not hold, such as one from another
 * workspace, is asked for by itself, up to MAX_DM_LOOKUPS. Any failure ends the lookups.
 */
async function lookupNames(ctx, userIds) {
  const names = new Map();
  const found = new Set();
  try {
    await listPeopleNames(ctx, userIds, names, found);
  } catch (error) {
    // A rate limit already saved its cooldown, so nothing more is sent.
    if (error instanceof WatcherError && error.code === "rate_limited") return names;
  }
  const missing = userIds.filter((id) => !found.has(id)).slice(0, MAX_DM_LOOKUPS);
  for (const id of missing) {
    if (ctx.requests >= ctx.config.maxRequests) break;
    try {
      const name = await fetchPersonName(ctx, id);
      if (name) names.set(id, name);
    } catch {
      // A rate limit already saved its cooldown. A missing scope fails every lookup. Labels keep the ID.
      break;
    }
  }
  return names;
}

const GROUP_ORDER = ["channel", "private_channel", "dm", "group_dm"];

function readDiscoveryConfiguration(input) {
  requireCondition(isRecord(input), "Expected a JSON object.");
  const instanceId = typeof input.instanceId === "string" ? input.instanceId.trim() : "";
  requireCondition(instanceId.length <= 128, "Missing or invalid instanceId.");
  const userId = typeof input.userId === "string" ? input.userId.trim() : "";
  return {
    // A draft has no instance yet. Its requests share one cooldown, as they share one token.
    instanceId: instanceId || "discovery",
    userId: userId ? readUserId(userId) : "",
    workspaceDomain: readWorkspaceDomain(input.workspaceDomain),
    maxRequests: readInteger(input.maxRequests, "maxRequests", 80, 4, 200),
  };
}

/** The picker option of one conversation. `channel` has an id and, as Slack gives them, a name and a partner. */
function optionOf(channel, group, names) {
  let label;
  if (group === "dm") {
    const partner = USER_ID.test(channel.user ?? "") ? channel.user : channel.id;
    label = `@${cleanLabel(names.get(partner) ?? partner, MAX_LABEL - 1)}`;
  } else if (group === "group_dm") {
    label = groupLabel(channel.name) || channel.id;
  } else {
    label = `#${cleanLabel(channel.name, MAX_LABEL - 1) || channel.id}`;
  }
  const option = { id: channel.id, label, group };
  if (group === "channel" || group === "private_channel") {
    const description = cleanLabel(channel.purpose?.value || channel.topic?.value, MAX_DESCRIPTION);
    if (description) option.description = description;
  }
  return option;
}

/** The person that the token belongs to, so the app can say whose conversations these are. */
function accountOf(auth) {
  if (typeof auth.user_id !== "string" || !USER_ID.test(auth.user_id)) return undefined;
  const user = cleanLabel(auth.user, MAX_LABEL);
  const team = cleanLabel(auth.team, MAX_LABEL);
  const label = user && team ? `${user} (${team})` : user || team || auth.user_id;
  return { id: auth.user_id, label: cleanLabel(label, MAX_LABEL) };
}

/** The IDs of an input that asks for chosen conversations only, or null for the whole list. */
function readDiscoveryIds(input) {
  if (input.ids === undefined || input.ids === null) return null;
  requireCondition(
    Array.isArray(input.ids) && input.ids.length <= MAX_DISCOVERY_IDS,
    `ids can hold at most ${MAX_DISCOVERY_IDS} conversations.`,
    "config",
  );
  // An ID that cannot be a Slack conversation is left out: there is nothing to name.
  return [...new Set(input.ids.filter((id) => typeof id === "string" && CONVERSATION_ID.test(id)))];
}

/**
 * The names of the conversations in `ids` only: the channels, direct messages and group messages
 * that a person already chose. It costs a few requests, not a walk over the whole list.
 */
async function discoverChosen(ctx, ids) {
  const known = ids.length > 0 ? await resolveConversations(ctx, ids, { names: true }) : new Map();
  const partners = [
    ...new Set(
      [...known.values()]
        .filter((entry) => entry.kind === "dm" && USER_ID.test(entry.user ?? ""))
        .map((entry) => entry.user),
    ),
  ];
  const names = partners.length > 0 ? await lookupNames(ctx, partners) : new Map();
  const options = [];
  for (const id of ids) {
    const entry = known.get(id);
    if (entry) options.push(optionOf({ id, name: entry.name, user: entry.user }, entry.kind, names));
  }
  return options;
}

/**
 * The conversations that the token's user is in, for a picker: public and private channels, direct
 * messages and group direct messages. The list is bounded and cleaned. It sends no secret and no message.
 * With `ids`, only those conversations are named.
 */
async function discoverConversations(ctx, ids) {
  const auth = await call(ctx, "auth.test", {});
  requireCondition(
    ctx.config.userId === "" || auth.user_id === ctx.config.userId,
    "The Slack token does not belong to the configured userId.",
  );
  const account = accountOf(auth);
  if (ids !== null) {
    const options = await discoverChosen(ctx, ids);
    return account ? { options, account } : { options };
  }
  const found = [];
  let truncated = false;
  await cursorPages(
    ctx,
    "users.conversations",
    { types: CONVERSATION_TYPES, exclude_archived: "true", limit: PAGE_SIZE },
    (body) => {
      requireCondition(Array.isArray(body.channels), "Unexpected Slack response.", "upstream");
      for (const channel of body.channels) {
        if (!isRecord(channel) || typeof channel.id !== "string" || !CONVERSATION_ID.test(channel.id)) continue;
        if (channel.is_archived === true || channel.is_user_deleted === true) continue;
        if (found.length >= MAX_OPTIONS) {
          truncated = true;
          return STOP;
        }
        found.push({ channel, group: conversationKind(channel) });
      }
      return undefined;
    },
  );
  const partners = [
    ...new Set(
      found
        .filter((entry) => entry.group === "dm" && typeof entry.channel.user === "string")
        .map((entry) => entry.channel.user)
        .filter((id) => USER_ID.test(id)),
    ),
  ];
  const names = await lookupNames(ctx, partners);
  const options = found.map(({ channel, group }) => optionOf(channel, group, names));
  options.sort(
    (a, b) =>
      GROUP_ORDER.indexOf(a.group) - GROUP_ORDER.indexOf(b.group) ||
      a.label.localeCompare(b.label, "en", { sensitivity: "base" }) ||
      (a.id < b.id ? -1 : 1),
  );
  const result = { options };
  if (account) result.account = account;
  if (truncated) result.truncated = true;
  // The descriptions are a convenience. Without them the list is far under the size that the host reads.
  if (Buffer.byteLength(JSON.stringify(result)) > MAX_OUTPUT_BYTES)
    for (const option of options) delete option.description;
  while (Buffer.byteLength(JSON.stringify(result)) > MAX_OUTPUT_BYTES && options.length > 0) {
    options.length = Math.floor(options.length / 2);
    result.truncated = true;
  }
  return result;
}

/** Lists the conversations of the token's user. `runWatcher` calls it for an input with `discover: true`. */
export async function runDiscovery(
  input,
  {
    token = process.env.SLACK_USER_TOKEN,
    fetchImpl = fetch,
    now = () => Date.now(),
    cooldownDir = defaultCooldownDirectory(),
    store = createCooldownStore(cooldownDir),
  } = {},
) {
  const credentials = readCredentials(token);
  const config = tagged("config", () => readDiscoveryConfiguration(input));
  requireCondition(
    (await store.read(config.instanceId)) <= now(),
    "Slack API cooldown is active; no request was sent.",
    "rate_limited",
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
  return discoverConversations(ctx, readDiscoveryIds(input));
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
  if (isRecord(input) && input.discover === true) return runDiscovery(input, { token, fetchImpl, now, store });
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
    // A direct conversation with a rule of its own is read by that rule, not as one of all.
    const ruled = new Set(config.conversationRules.map((rule) => rule.id));
    const found = (await listConversations(ctx)).filter((conversation) => !ruled.has(conversation.id));
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
      // A conversation with a rule is read by its rule below.
      if (config.conversationRules.some((rule) => rule.id === id)) continue;
      const channel = { id, name: await channelName(ctx, id) };
      await collectHistory(ctx, collector, window, channel, id.startsWith("D") ? "dm" : "channel");
    }
  }
  if (config.conversationRules.length > 0) {
    const known = await resolveConversations(
      ctx,
      config.conversationRules.map((rule) => rule.id),
    );
    for (const rule of config.conversationRules) {
      const conversation = known.get(rule.id);
      const channel = { id: rule.id, name: conversation?.name };
      const direct = conversation?.kind === "dm" || conversation?.kind === "group_dm";
      // A message that a person-only rule kept was found because it mentions the person.
      const kind = direct ? conversation.kind : rule.mode === "mentions" ? "mention" : "channel";
      await collectHistory(ctx, collector, window, channel, kind, rule.mode);
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
