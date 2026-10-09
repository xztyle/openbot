import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// Read-only Discord check for a BOT token. Every request is a GET to the official REST API.
// User tokens ("self-bots") break Discord's terms and are not supported.
// One run does all its work and prints one page: it either covers the whole recent
// window or fails with a safe message. It never prints a partial window.
const API = "https://discord.com/api/v10";
const USER_AGENT = "DiscordBot (https://openbot.run, 1.0.0)";
const DISCORD_EPOCH = 1420070400000n;
const MAX_INPUT_BYTES = 65536;
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 8000;
// The host stops a program after 40 seconds. Stop sending requests well before that.
const RUN_BUDGET_MS = 30000;
// A short rate-limit pause is waited out. A longer one becomes a saved cooldown.
const MAX_WAIT_MS = 5000;
const MAX_ITEMS = 2000;
const MAX_OUTPUT_BYTES = 400000;
const MAX_CHANNELS = 20;
const MAX_ROLES = 20;
const MAX_TEXT = 300;
const MAX_COOLDOWN_MS = 3600 * 1000;
const DEFAULT_COOLDOWN_MS = 60 * 1000;
// Message types with human content: default, reply, slash command, context menu command.
const CONTENT_TYPES = new Set([0, 19, 20, 23]);
// Channel types that hold messages: text, voice, group DM, announcement, three thread types, stage.
const CHANNEL_KINDS = new Map([
  [0, "channel"],
  [1, "dm"],
  [2, "channel"],
  [3, "group_dm"],
  [5, "channel"],
  [10, "thread"],
  [11, "thread"],
  [12, "thread"],
  [13, "channel"],
]);

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

function isSnowflake(value) {
  return typeof value === "string" && /^\d{15,25}$/.test(value);
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

function readIds(value, name, maximum) {
  if (value === undefined || value === null || value === "") return [];
  requireCondition(typeof value === "string", `${name} must be text.`);
  const ids = value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  requireCondition(ids.every(isSnowflake), `${name} must be a comma separated list of Discord IDs.`);
  requireCondition(new Set(ids).size <= maximum, `${name} can hold at most ${maximum} IDs.`);
  return [...new Set(ids)];
}

export function readConfiguration(input) {
  requireCondition(isRecord(input), "Expected a JSON object.");
  requireCondition(
    input.cursor === undefined || input.cursor === null || input.cursor === "",
    "Invalid paging cursor.",
  );
  const instanceId = typeof input.instanceId === "string" ? input.instanceId.trim() : "";
  requireCondition(instanceId.length > 0 && instanceId.length <= 128, "Missing or invalid instanceId.");
  const config = {
    instanceId,
    channelIds: readIds(input.channelIds, "channelIds", MAX_CHANNELS),
    mentionsOnly: readFlag(input.mentionsOnly, "mentionsOnly", true),
    includeDirectMessagesToBot: readFlag(input.includeDirectMessagesToBot, "includeDirectMessagesToBot", false),
    mentionRoleIds: readIds(input.mentionRoleIds, "mentionRoleIds", MAX_ROLES),
    perChannelLimit: readInteger(input.perChannelLimit, "perChannelLimit", 50, 1, 100),
    maxRequests: readInteger(input.maxRequests, "maxRequests", 60, 4, 200),
  };
  requireCondition(config.channelIds.length > 0, "channelIds needs at least one Discord channel ID.");
  const userId = typeof input.userId === "string" ? input.userId.trim() : "";
  requireCondition(userId === "" || isSnowflake(userId), "userId must be a Discord user ID.");
  config.userId = userId;
  if (config.mentionsOnly) {
    requireCondition(
      userId !== "" || config.mentionRoleIds.length > 0,
      "mentionsOnly needs your Discord userId or at least one role ID in mentionRoleIds.",
    );
  }
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

/** The smallest snowflake that Discord could create at this time. Messages after it are newer. */
export function snowflakeFromTime(ms) {
  return String((BigInt(Math.max(0, Math.floor(ms))) - DISCORD_EPOCH) << 22n);
}

function timeFromSnowflake(id) {
  return Number((BigInt(id) >> 22n) + DISCORD_EPOCH);
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
  return path.join(path.dirname(fileURLToPath(import.meta.url)), ".discord-activity-cooldowns");
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

function seconds(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

async function saveCooldown(ctx, waitMs) {
  const wait = Math.min(Math.max(1000, waitMs), MAX_COOLDOWN_MS);
  await ctx.store.write(ctx.config.instanceId, ctx.now() + wait);
  throw new WatcherError(
    "Discord API rate limit reached; a cooldown is active and no request will be sent until it passes.",
    "rate_limited",
  );
}

/**
 * One read-only REST call. Counts against the request cap and the run budget.
 * `allowed` lists the HTTP statuses the caller turns into its own message; they return null.
 */
async function call(ctx, route, params, allowed = []) {
  requireCondition(
    ctx.requests < ctx.config.maxRequests,
    "The check needs more requests than maxRequests allows. Raise maxRequests or watch fewer channels.",
    "config",
  );
  // Wait out a short pause that the last response asked for.
  const pause = ctx.pauseUntil - ctx.now();
  ctx.pauseUntil = 0;
  if (pause > 0) await ctx.sleep(pause);
  requireCondition(
    ctx.now() - ctx.startedAt < RUN_BUDGET_MS,
    "The check ran out of time before it covered the whole window.",
    "config",
  );
  ctx.requests += 1;
  const url = new URL(`${API}${route}`);
  for (const [key, value] of Object.entries(params ?? {})) url.searchParams.set(key, String(value));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let response;
  let body = null;
  try {
    response = await ctx.fetchImpl(url.toString(), {
      method: "GET",
      redirect: "error",
      signal: controller.signal,
      headers: { Authorization: `Bot ${ctx.token}`, Accept: "application/json", "User-Agent": USER_AGENT },
    });
    if (response.status === 429) {
      let wait = DEFAULT_COOLDOWN_MS;
      const header = seconds(response.headers.get("retry-after"));
      if (header !== null) wait = header * 1000;
      try {
        const parsed = await readJson(response);
        const retry = isRecord(parsed) ? seconds(parsed.retry_after) : null;
        if (retry !== null) wait = retry * 1000;
      } catch {
        /* The header or the default decides. */
      }
      await saveCooldown(ctx, wait);
    }
    if (!response.ok) {
      if (allowed.includes(response.status)) return { status: response.status, body: null };
      throw new WatcherError(
        `Discord API HTTP ${Number(response.status) || "error"}.`,
        response.status === 401 || response.status === 403 ? "auth" : "upstream",
      );
    }
    body = await readJson(response);
  } catch (error) {
    // Only locally authored messages may reach stderr; never echo fetch or server errors.
    if (error instanceof WatcherError) throw error;
    throw new WatcherError("Discord API request failed or timed out.", "upstream");
  } finally {
    clearTimeout(timer);
  }
  // Honor the bucket headers: pause briefly, or stop with a cooldown when the reset is far away.
  if (response.headers.get("x-ratelimit-remaining") === "0") {
    const reset = seconds(response.headers.get("x-ratelimit-reset-after"));
    if (reset !== null && reset * 1000 > MAX_WAIT_MS) await saveCooldown(ctx, reset * 1000);
    if (reset !== null) ctx.pauseUntil = ctx.now() + reset * 1000;
  }
  return { status: response.status, body };
}

function authorOf(message) {
  return isRecord(message.author) && isSnowflake(message.author.id) ? message.author.id : UNKNOWN_ACTOR;
}

function revisionOf(message) {
  const edited = message.edited_timestamp;
  return typeof edited === "string" && edited.length > 0 && edited.length <= 64 ? edited : "0";
}

function matchesYou(message, config) {
  if (
    config.userId &&
    Array.isArray(message.mentions) &&
    message.mentions.some((user) => isRecord(user) && user.id === config.userId)
  )
    return true;
  if (
    config.mentionRoleIds.length > 0 &&
    Array.isArray(message.mention_roles) &&
    message.mention_roles.some((role) => config.mentionRoleIds.includes(role))
  )
    return true;
  return (
    Boolean(config.userId) &&
    isRecord(message.referenced_message) &&
    isRecord(message.referenced_message.author) &&
    message.referenced_message.author.id === config.userId
  );
}

async function describeChannel(ctx, id) {
  const { status, body } = await call(ctx, `/channels/${id}`, {}, [401, 403, 404]);
  requireCondition(status !== 401, "Discord rejected the bot token.", "auth");
  requireCondition(
    status === 200 && isRecord(body) && body.id === id,
    `Discord channel ${id} is not available to the bot (HTTP ${status}). Check the ID and that the bot is a member.`,
    "config",
  );
  requireCondition(CHANNEL_KINDS.has(body.type), `Discord channel ${id} is not a channel that holds messages.`);
  const kind = CHANNEL_KINDS.get(body.type);
  requireCondition(
    ctx.config.includeDirectMessagesToBot || (kind !== "dm" && kind !== "group_dm"),
    `Discord channel ${id} is a direct message. Turn on includeDirectMessagesToBot to watch it.`,
  );
  return {
    id,
    kind,
    name: typeof body.name === "string" ? body.name : undefined,
    guildId: isSnowflake(body.guild_id) ? body.guild_id : kind === "dm" || kind === "group_dm" ? "@me" : undefined,
  };
}

async function collectChannel(ctx, collector, window, channel) {
  let after = snowflakeFromTime(window.since);
  while (true) {
    const { status, body } = await call(
      ctx,
      `/channels/${channel.id}/messages`,
      {
        limit: ctx.config.perChannelLimit,
        after,
      },
      [401, 403, 404],
    );
    requireCondition(status !== 401, "Discord rejected the bot token.", "auth");
    requireCondition(
      status === 200,
      `Discord channel ${channel.id} cannot be read by the bot (HTTP ${status}). Check that the bot may read message history there.`,
      "config",
    );
    requireCondition(Array.isArray(body) && body.length <= ctx.config.perChannelLimit, "Unexpected Discord response.");
    let newest = null;
    for (const message of body) {
      requireCondition(isRecord(message) && isSnowflake(message.id), "Unexpected Discord response.");
      // Discord sorts a page newest first, but the next page starts after the largest ID either way.
      if (newest === null || BigInt(message.id) > BigInt(newest)) newest = message.id;
      if (timeFromSnowflake(message.id) > window.until) continue;
      if (!CONTENT_TYPES.has(message.type)) continue;
      if (ctx.config.mentionsOnly && !matchesYou(message, ctx.config)) continue;
      collector.set(`${channel.id}:${message.id}`, {
        id: `${channel.id}:${message.id}`,
        revision: revisionOf(message),
        actor: authorOf(message),
        kind: channel.kind,
        channel: channel.id,
        channelName: channel.name,
        author:
          isRecord(message.author) && typeof message.author.username === "string"
            ? preview(message.author.username)
            : undefined,
        text: preview(message.content),
        url: channel.guildId
          ? `https://discord.com/channels/${channel.guildId}/${channel.id}/${message.id}`
          : undefined,
      });
    }
    // A short page is the end of the window. A page that is past `until` also ends it.
    if (body.length < ctx.config.perChannelLimit || newest === null || timeFromSnowflake(newest) > window.until) return;
    requireCondition(BigInt(newest) > BigInt(after), "Discord pagination did not advance.");
    after = newest;
  }
}

export async function runWatcher(
  input,
  {
    token = process.env.DISCORD_BOT_TOKEN,
    fetchImpl = fetch,
    now = () => Date.now(),
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    cooldownDir = defaultCooldownDirectory(),
    store = createCooldownStore(cooldownDir),
  } = {},
) {
  requireCondition(
    typeof token === "string" && token.trim().length > 0,
    "Missing DISCORD_BOT_TOKEN private variable.",
    "auth",
  );
  const cleanToken = token.trim().replace(/^Bot\s+/i, "");
  requireCondition(
    cleanToken.length > 0 && !/[^\x21-\x7e]/.test(cleanToken),
    "Invalid DISCORD_BOT_TOKEN private variable.",
    "auth",
  );
  const config = tagged("config", () => readConfiguration(input));
  const window = readWindow(input);
  requireCondition(
    (await store.read(config.instanceId)) <= now(),
    "Discord API cooldown is active; no request was sent.",
    "rate_limited",
  );
  const ctx = { config, token: cleanToken, fetchImpl, now, sleep, store, startedAt: now(), requests: 0, pauseUntil: 0 };

  // Only a bot account is accepted. A user token is rejected by Discord with this header.
  const me = await call(ctx, "/users/@me", {}, [401]);
  requireCondition(me.status !== 401, "Discord rejected the bot token.", "auth");
  requireCondition(
    isRecord(me.body) && isSnowflake(me.body.id) && me.body.bot === true,
    "The token does not belong to a Discord bot.",
    "auth",
  );

  const channels = [];
  for (const id of config.channelIds) channels.push(await describeChannel(ctx, id));
  const collector = new Map();
  for (const channel of channels) await collectChannel(ctx, collector, window, channel);

  // Oldest first, so the agent reads the conversation in order.
  const items = [...collector.values()].sort((a, b) => {
    const [left, right] = [BigInt(a.id.split(":")[1]), BigInt(b.id.split(":")[1])];
    return left < right ? -1 : left > right ? 1 : 0;
  });
  requireCondition(items.length <= MAX_ITEMS, "Too many new messages for one check.", "config");
  const result = { items, hasNextPage: false, cursor: null };
  requireCondition(
    Buffer.byteLength(JSON.stringify(result)) <= MAX_OUTPUT_BYTES,
    "Too many new messages for one check.",
    "config",
  );
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
      `Discord activity watcher: ${error instanceof WatcherError ? error.message : "Watcher failed."}\n`,
    );
    // One code, no text from Discord: OpenBot maps it to its own message.
    if (error instanceof WatcherError && error.code) process.stderr.write(`openbot-error: ${error.code}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
