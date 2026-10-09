// @vitest-environment node
// Failure modes: a token or server text reaching stderr, a write request being sent, a partial window
// being reported as complete, an edit that does not change the revision, a token of another account
// being read, a rate limit being ignored (requests during a cooldown), and a template the host would
// refuse to install. Every request here goes to a fake `fetch`: nothing was run against live Slack or Discord.
import { spawn } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { type DynamicRecord, isDynamicRecord } from "@openbot/contracts/runtime-values";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadWatcherCatalog } from "../build-watcher-catalog";

const WATCHERS = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "marketplace",
  "watcher-catalog",
  "watchers",
);
const SLACK_FILE = join(WATCHERS, "slack-activity", "program.mjs");
const DISCORD_FILE = join(WATCHERS, "discord-activity", "program.mjs");

interface Item {
  id: string;
  revision: string;
  actor: string;
  kind: string;
  [key: string]: unknown;
}
interface Result {
  items: Item[];
  hasNextPage: boolean;
  cursor: string | null;
}
interface Deps {
  token?: string;
  fetchImpl?: (url: string, init: RequestInit) => Promise<Response>;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  cooldownDir?: string;
}
interface Program {
  runWatcher(input: DynamicRecord, deps: Deps): Promise<Result>;
  snowflakeFromTime?(ms: number): string;
}
function isProgram(value: unknown): value is Program {
  return isDynamicRecord(value) && typeof value.runWatcher === "function";
}
async function load(file: string): Promise<Program> {
  const loaded = await import(/* @vite-ignore */ pathToFileURL(file).href);
  if (!isProgram(loaded)) throw new Error("Not a watcher program.");
  return loaded;
}

const SINCE = Date.parse("2026-10-09T11:50:00.000Z");
const UNTIL = Date.parse("2026-10-09T12:00:00.000Z");
const WINDOW = { since: new Date(SINCE).toISOString(), until: new Date(UNTIL).toISOString() };
const TOKEN = "TOKEN-SHOULD-NEVER-APPEAR-123";
const SERVER_TEXT = "SERVER-TEXT-SHOULD-NEVER-APPEAR";

let temporary: string;
beforeEach(async () => {
  temporary = await mkdtemp(join(tmpdir(), "chat-watchers-"));
});
afterEach(async () => {
  await rm(temporary, { recursive: true, force: true });
});

interface Recorded {
  httpMethod: string;
  url: URL;
  headers: Headers;
}
/** A fake fetch. The handler answers a request with a status, JSON body and headers. */
function fakeFetch(
  handler: (request: Recorded) => { status?: number; body?: unknown; headers?: Record<string, string> },
) {
  const requests: Recorded[] = [];
  const fetchImpl = async (url: string, init: RequestInit): Promise<Response> => {
    const request: Recorded = {
      httpMethod: init.method ?? "GET",
      url: new URL(url),
      headers: new Headers(init.headers),
    };
    requests.push(request);
    expect(init.redirect).toBe("error");
    const answer = handler(request);
    return new Response(JSON.stringify(answer.body ?? {}), { status: answer.status ?? 200, headers: answer.headers });
  };
  return { requests, fetchImpl };
}
async function failureOf(run: Promise<unknown>): Promise<string> {
  const error = await run.then(
    () => null,
    (reason: unknown) => reason,
  );
  if (!(error instanceof Error)) throw new Error("Expected a failure.");
  return error.message;
}
function expectSafe(message: string) {
  expect(message).not.toContain(TOKEN);
  expect(message).not.toContain(SERVER_TEXT);
}

describe("slack-activity", () => {
  const ME = "U111AAAA";
  const base = {
    instanceId: "t1",
    userId: ME,
    watchMentions: "true",
    keywords: "",
    watchDirectMessages: "false",
    watchChannels: "false",
    channelIds: "",
    includeThreadReplies: "false",
    ...WINDOW,
  };
  const ts = (offsetSeconds: number, micro = 100) =>
    `${Math.floor(SINCE / 1000) + offsetSeconds}.${String(micro).padStart(6, "0")}`;
  const ok = (body: DynamicRecord) => ({ body: { ok: true, ...body } });
  const READ_METHODS = new Set([
    "auth.test",
    "search.messages",
    "conversations.list",
    "conversations.history",
    "conversations.replies",
    "conversations.info",
  ]);
  let program: Program;
  beforeEach(async () => {
    program = await load(SLACK_FILE);
  });
  const run = (input: DynamicRecord, deps: Deps) =>
    program.runWatcher(input, { token: TOKEN, now: () => UNTIL, cooldownDir: join(temporary, "cooldowns"), ...deps });
  const methodOf = (request: Recorded) => request.url.pathname.replace("/api/", "");

  function workspace(request: Recorded) {
    const method = methodOf(request);
    const params = request.url.searchParams;
    const channel = params.get("channel");
    if (method === "auth.test") return ok({ user_id: ME });
    if (method === "search.messages") {
      const query = params.get("query");
      const page = Number(params.get("page"));
      const channelInfo = { id: "C100", name: "general" };
      if (query === `<@${ME}>`) {
        return page === 1
          ? ok({
              messages: {
                paging: { page: 1, pages: 2 },
                matches: [
                  {
                    ts: ts(300),
                    text: `hello <@${ME}>`,
                    user: "U222BBBB",
                    channel: channelInfo,
                    permalink: "https://example.slack.com/p1",
                  },
                ],
              },
            })
          : ok({
              messages: {
                paging: { page: 2, pages: 2 },
                matches: [
                  { ts: ts(200), text: "second", user: "U333CCCC", channel: channelInfo },
                  { ts: ts(-3600), text: "too old", user: "U333CCCC", channel: channelInfo },
                ],
              },
            });
      }
      return ok({
        messages: {
          paging: { page: 1, pages: 1 },
          matches: [{ ts: ts(300), text: `hello <@${ME}> deploy`, user: "U222BBBB", channel: channelInfo }],
        },
      });
    }
    if (method === "conversations.list") {
      return ok({
        channels: [
          { id: "D1", is_im: true },
          { id: "G1", is_mpim: true },
        ],
      });
    }
    if (method === "conversations.info") return ok({ channel: { id: channel, name: "ops" } });
    if (method === "conversations.history" && channel === "D1") {
      return params.get("cursor") === "next-page"
        ? ok({ messages: [{ ts: ts(100), text: "older dm", user: "U444DDDD" }] })
        : ok({
            messages: [{ ts: ts(400), text: "newer dm", user: "U444DDDD" }],
            has_more: true,
            response_metadata: { next_cursor: "next-page" },
          });
    }
    if (method === "conversations.history" && channel === "G1") return ok({ messages: [] });
    if (method === "conversations.history") {
      return ok({
        messages: [
          { ts: ts(500), text: "edited text", user: "U555EEEE", edited: { user: "U555EEEE", ts: ts(520) } },
          { ts: ts(450), subtype: "channel_join", text: "joined", user: "U666FFFF" },
          { ts: ts(430), subtype: "bot_message", text: "build passed", bot_id: "B1" },
        ],
      });
    }
    return { status: 500, body: { ok: false } };
  }

  it("collects mentions, keywords, direct messages and channels from one recent window", async () => {
    const { requests, fetchImpl } = fakeFetch(workspace);
    const result = await run(
      { ...base, keywords: "deploy", watchDirectMessages: "true", watchChannels: "true", channelIds: "C100" },
      { fetchImpl },
    );
    expect(result.hasNextPage).toBe(false);
    expect(result.cursor).toBeNull();
    const byId = new Map(result.items.map((item) => [item.id, item]));
    expect([...byId.keys()].sort()).toEqual(
      [
        `C100:${ts(300)}`,
        `C100:${ts(200)}`,
        `D1:${ts(400)}`,
        `D1:${ts(100)}`,
        `C100:${ts(500)}`,
        `C100:${ts(430)}`,
      ].sort(),
    );
    // The same message found by the mention search, the keyword search and the history is one item.
    expect(byId.get(`C100:${ts(300)}`)).toMatchObject({
      revision: "0",
      actor: "U222BBBB",
      kind: "mention",
      channel: "C100",
      channelName: "general",
      permalink: "https://example.slack.com/p1",
    });
    expect(byId.get(`D1:${ts(400)}`)).toMatchObject({ actor: "U444DDDD", kind: "dm", text: "newer dm" });
    expect(byId.get(`C100:${ts(430)}`)).toMatchObject({ actor: "unknown" });
    expect(byId.has(`C100:${ts(450)}`)).toBe(false);
    // Every request is a read-only GET. The token travels in the header, never in the URL.
    for (const request of requests) {
      expect(request.httpMethod).toBe("GET");
      expect(request.url.origin).toBe("https://slack.com");
      expect(READ_METHODS.has(methodOf(request))).toBe(true);
      expect(request.url.toString()).not.toContain(TOKEN);
      expect(request.headers.get("authorization")).toBe(`Bearer ${TOKEN}`);
    }
    const history = requests.filter((request) => methodOf(request) === "conversations.history");
    expect(history.map((request) => request.url.searchParams.get("cursor"))).toEqual([null, "next-page", null, null]);
  });

  it("changes the revision when a message is edited", async () => {
    const { fetchImpl } = fakeFetch(workspace);
    const result = await run(
      { ...base, watchMentions: "false", watchChannels: "true", channelIds: "C100" },
      { fetchImpl },
    );
    expect(result.items.find((item) => item.id === `C100:${ts(500)}`)?.revision).toBe(ts(520));
  });

  it("reads new thread replies only when asked", async () => {
    const parent = {
      ts: ts(100),
      thread_ts: ts(100),
      reply_count: 2,
      latest_reply: ts(300),
      text: "parent",
      user: "U444DDDD",
    };
    const handler = (request: Recorded) => {
      const method = methodOf(request);
      if (method === "conversations.history") return ok({ messages: [parent] });
      if (method === "conversations.replies") {
        expect(request.url.searchParams.get("ts")).toBe(ts(100));
        return ok({
          messages: [parent, { ts: ts(300), thread_ts: ts(100), text: "reply", user: "U777GGGG" }],
        });
      }
      return workspace(request);
    };
    const off = fakeFetch(handler);
    const withoutReplies = await run(
      { ...base, watchMentions: "false", watchChannels: "true", channelIds: "C100" },
      { fetchImpl: off.fetchImpl },
    );
    expect(withoutReplies.items.map((item) => item.kind)).toEqual(["channel"]);
    const on = fakeFetch(handler);
    const withReplies = await run(
      { ...base, watchMentions: "false", watchChannels: "true", channelIds: "C100", includeThreadReplies: "true" },
      { fetchImpl: on.fetchImpl },
    );
    expect(withReplies.items.map((item) => [item.kind, item.actor, item.threadTs])).toEqual([
      ["channel", "U444DDDD", undefined],
      ["thread", "U777GGGG", ts(100)],
    ]);
    // History looks back further than the window so that older threads with new replies are found.
    const history = on.requests.find((request) => methodOf(request) === "conversations.history");
    expect(Number(history?.url.searchParams.get("oldest"))).toBeLessThan(SINCE / 1000 - 3600);
  });

  it("refuses a token that belongs to another user, before it reads anything else", async () => {
    const { requests, fetchImpl } = fakeFetch((request) =>
      methodOf(request) === "auth.test" ? ok({ user_id: "U999OTHER" }) : workspace(request),
    );
    const message = await failureOf(run(base, { fetchImpl }));
    expect(message).toMatch(/does not belong/);
    expect(requests.map(methodOf)).toEqual(["auth.test"]);
  });

  it("saves a cooldown on HTTP 429 and sends no request until it ends", async () => {
    let clock = UNTIL;
    const limited = fakeFetch(() => ({
      status: 429,
      headers: { "Retry-After": "30" },
      body: { ok: false, error: "ratelimited" },
    }));
    expectSafe(await failureOf(run(base, { fetchImpl: limited.fetchImpl, now: () => clock })));
    expect(limited.requests).toHaveLength(1);

    const during = fakeFetch(workspace);
    clock = UNTIL + 10_000;
    expect(await failureOf(run(base, { fetchImpl: during.fetchImpl, now: () => clock }))).toMatch(/cooldown is active/);
    expect(during.requests).toHaveLength(0);

    clock = UNTIL + 31_000;
    const after = fakeFetch(workspace);
    await run(base, { fetchImpl: after.fetchImpl, now: () => clock });
    expect(after.requests.length).toBeGreaterThan(0);
  });

  it("treats ok:false ratelimited like a 429", async () => {
    const limited = fakeFetch(() => ({ headers: { "Retry-After": "5" }, body: { ok: false, error: "ratelimited" } }));
    await failureOf(run(base, { fetchImpl: limited.fetchImpl }));
    const after = fakeFetch(workspace);
    expect(await failureOf(run(base, { fetchImpl: after.fetchImpl }))).toMatch(/cooldown is active/);
    expect(after.requests).toHaveLength(0);
  });

  it("never prints the token or server text in a failure", async () => {
    const cases: Array<() => Promise<unknown>> = [
      () =>
        run(base, {
          fetchImpl: fakeFetch(() => ({ body: { ok: false, error: `${SERVER_TEXT} ${TOKEN}` } })).fetchImpl,
        }),
      () =>
        run(base, {
          fetchImpl: fakeFetch(() => ({ body: { ok: false, error: "missing_scope", needed: SERVER_TEXT } })).fetchImpl,
        }),
      () =>
        run(base, {
          fetchImpl: fakeFetch(() => ({ status: 500, body: { message: `${SERVER_TEXT} ${TOKEN}` } })).fetchImpl,
        }),
      () =>
        run(base, {
          fetchImpl: async () => {
            throw new Error(`${SERVER_TEXT} ${TOKEN}`);
          },
        }),
      () => run(base, { fetchImpl: async () => new Response(`${SERVER_TEXT} ${TOKEN}`, { status: 200 }) }),
    ];
    const messages: string[] = [];
    for (const attempt of cases) messages.push(await failureOf(attempt()));
    for (const message of messages) expectSafe(message);
    expect(messages[1]).toMatch(/missing a required read scope/);
    expect(messages[2]).toMatch(/HTTP 500/);
  });

  it("stops with a message instead of reporting a partial window when a cap is reached", async () => {
    const tooMany = fakeFetch((request) =>
      methodOf(request) === "conversations.list"
        ? ok({
            channels: [
              { id: "D1", is_im: true },
              { id: "D2", is_im: true },
              { id: "D3", is_im: true },
            ],
          })
        : workspace(request),
    );
    expect(
      await failureOf(
        run(
          { ...base, watchMentions: "false", watchDirectMessages: "true", maxConversations: "2" },
          { fetchImpl: tooMany.fetchImpl },
        ),
      ),
    ).toMatch(/maxConversations/);
    expect(tooMany.requests.map(methodOf)).toEqual(["auth.test", "conversations.list"]);

    const budget = fakeFetch(workspace);
    expect(
      await failureOf(run({ ...base, watchDirectMessages: "true", maxRequests: "4" }, { fetchImpl: budget.fetchImpl })),
    ).toMatch(/maxRequests/);
    expect(budget.requests).toHaveLength(4);

    let clock = UNTIL;
    const slow = fakeFetch((request) => {
      clock += 31_000;
      return workspace(request);
    });
    expect(await failureOf(run(base, { fetchImpl: slow.fetchImpl, now: () => clock }))).toMatch(/ran out of time/);
  });

  it("fails on a search page that does not end", async () => {
    const endless = fakeFetch((request) =>
      methodOf(request) === "auth.test"
        ? ok({ user_id: ME })
        : ok({ messages: { paging: { page: 1, pages: 5 }, matches: [] } }),
    );
    expect(await failureOf(run(base, { fetchImpl: endless.fetchImpl }))).toMatch(/pagination/);
  });

  it("rejects bad settings before any request", async () => {
    const { requests, fetchImpl } = fakeFetch(workspace);
    await expect(run({ ...base, userId: "nobody" }, { fetchImpl })).rejects.toThrow(/userId/);
    await expect(run({ ...base, watchMentions: "false" }, { fetchImpl })).rejects.toThrow(/at least one/);
    await expect(run({ ...base, watchMentions: "yes" }, { fetchImpl })).rejects.toThrow(/true/);
    await expect(run({ ...base, watchChannels: "true" }, { fetchImpl })).rejects.toThrow(/channelIds/);
    await expect(run({ ...base, since: undefined }, { fetchImpl })).rejects.toThrow(/window/);
    await expect(run(base, { fetchImpl, token: "" })).rejects.toThrow(/SLACK_USER_TOKEN/);
    expect(requests).toHaveLength(0);
  });
});

describe("discord-activity", () => {
  const BOT = "900000000000000001";
  const ME = "800000000000000001";
  const ROLE = "600000000000000001";
  const CHANNEL = "700000000000000001";
  const OTHER_CHANNEL = "700000000000000002";
  const base = {
    instanceId: "d1",
    channelIds: CHANNEL,
    userId: ME,
    mentionsOnly: "false",
    mentionRoleIds: "",
    includeDirectMessagesToBot: "false",
    perChannelLimit: "2",
    ...WINDOW,
  };
  let program: Program;
  beforeEach(async () => {
    program = await load(DISCORD_FILE);
  });
  const run = (input: DynamicRecord, deps: Deps) =>
    program.runWatcher(input, {
      token: TOKEN,
      now: () => UNTIL,
      sleep: async () => {},
      cooldownDir: join(temporary, "cooldowns"),
      ...deps,
    });
  /** A message id for a moment: the snowflake for that time plus a sequence. */
  const messageId = (offsetSeconds: number, sequence = 0) =>
    String(BigInt(program.snowflakeFromTime?.(SINCE + offsetSeconds * 1000) ?? "0") + BigInt(sequence + 1));
  const author = (id: string, name: string, bot = false) => ({ id, username: name, bot });

  interface Message extends DynamicRecord {
    id: string;
  }
  /** Mimics Discord: the oldest `limit` messages after `after`, listed newest first. */
  function discord(messages: Message[]) {
    return (request: Recorded) => {
      const path = request.url.pathname;
      if (path === "/api/v10/users/@me") return { body: { id: BOT, username: "bot", bot: true } };
      if (path === `/api/v10/channels/${CHANNEL}`)
        return { body: { id: CHANNEL, type: 0, name: "general", guild_id: "500000000000000001" } };
      if (path === `/api/v10/channels/${CHANNEL}/messages`) {
        const after = BigInt(request.url.searchParams.get("after") ?? "0");
        const limit = Number(request.url.searchParams.get("limit"));
        const page = messages
          .filter((message) => BigInt(message.id) > after)
          .sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1))
          .slice(0, limit)
          .reverse();
        return { body: page };
      }
      return { status: 404, body: { message: SERVER_TEXT } };
    };
  }
  const sample = (): Message[] => [
    { id: messageId(10), type: 0, content: "first", author: author("111111111111111111", "alice"), mentions: [] },
    {
      id: messageId(20),
      type: 0,
      content: "ping",
      author: author("222222222222222222", "bob"),
      mentions: [{ id: ME }],
      edited_timestamp: "2026-10-09T11:56:00.000000+00:00",
    },
    { id: messageId(30), type: 7, content: "", author: author("333333333333333333", "carol") },
    {
      id: messageId(40),
      type: 19,
      content: "re",
      author: author("444444444444444444", "dave"),
      referenced_message: { author: { id: ME } },
    },
    { id: messageId(50), type: 0, content: "x".repeat(500), author: author(BOT, "bot", true), mention_roles: [ROLE] },
  ];

  it("pages through the whole window and reports ids, revisions and authors", async () => {
    const { requests, fetchImpl } = fakeFetch(discord(sample()));
    const result = await run(base, { fetchImpl });
    expect(result).toMatchObject({ hasNextPage: false, cursor: null });
    expect(result.items.map((item) => [item.id.split(":")[1], item.revision, item.actor])).toEqual([
      [messageId(10), "0", "111111111111111111"],
      [messageId(20), "2026-10-09T11:56:00.000000+00:00", "222222222222222222"],
      [messageId(40), "0", "444444444444444444"],
      [messageId(50), "0", BOT],
    ]);
    expect(result.items[0]).toMatchObject({
      id: `${CHANNEL}:${messageId(10)}`,
      kind: "channel",
      channel: CHANNEL,
      channelName: "general",
      author: "alice",
      text: "first",
      url: `https://discord.com/channels/500000000000000001/${CHANNEL}/${messageId(10)}`,
    });
    expect(result.items[3]?.text).toHaveLength(300);
    // Five messages with a page size of two takes three message requests, each after the newest ID seen.
    const pages = requests.filter((request) => request.url.pathname.endsWith("/messages"));
    expect(pages).toHaveLength(3);
    expect(pages[0]?.url.searchParams.get("after")).toBe(program.snowflakeFromTime?.(SINCE));
    expect(pages[1]?.url.searchParams.get("after")).toBe(messageId(20));
    for (const request of requests) {
      expect(request.httpMethod).toBe("GET");
      expect(request.url.origin).toBe("https://discord.com");
      expect(request.url.pathname.startsWith("/api/v10/")).toBe(true);
      expect(request.headers.get("authorization")).toBe(`Bot ${TOKEN}`);
      expect(request.url.toString()).not.toContain(TOKEN);
    }
  });

  it("keeps only mentions of the user, their roles, and replies to them when asked", async () => {
    const { fetchImpl } = fakeFetch(discord(sample()));
    const result = await run(
      { ...base, mentionsOnly: "true", mentionRoleIds: ROLE, perChannelLimit: "100" },
      { fetchImpl },
    );
    expect(result.items.map((item) => item.id.split(":")[1])).toEqual([messageId(20), messageId(40), messageId(50)]);
    const withoutRole = await run({ ...base, mentionsOnly: "true", perChannelLimit: "100" }, { fetchImpl });
    expect(withoutRole.items.map((item) => item.id.split(":")[1])).toEqual([messageId(20), messageId(40)]);
  });

  it("refuses a user token and a wrong identity", async () => {
    const user = fakeFetch((request) =>
      request.url.pathname.endsWith("/users/@me")
        ? { body: { id: ME, username: "human" } }
        : discord(sample())(request),
    );
    expect(await failureOf(run(base, { fetchImpl: user.fetchImpl }))).toMatch(/not belong to a Discord bot/);
    expect(user.requests).toHaveLength(1);
    const rejected = fakeFetch(() => ({ status: 401, body: { message: `${SERVER_TEXT} ${TOKEN}` } }));
    const message = await failureOf(run(base, { fetchImpl: rejected.fetchImpl }));
    expect(message).toMatch(/rejected the bot token/);
    expectSafe(message);
  });

  it("names only the channel ID when a channel cannot be read", async () => {
    for (const status of [403, 404]) {
      const { fetchImpl } = fakeFetch((request) =>
        request.url.pathname === `/api/v10/channels/${OTHER_CHANNEL}`
          ? { status, body: { message: SERVER_TEXT, code: 50001 } }
          : discord(sample())(request),
      );
      const message = await failureOf(run({ ...base, channelIds: `${CHANNEL},${OTHER_CHANNEL}` }, { fetchImpl }));
      expect(message).toContain(OTHER_CHANNEL);
      expect(message).toContain(String(status));
      expectSafe(message);
    }
    const unreadable = fakeFetch((request) =>
      request.url.pathname.endsWith("/messages")
        ? { status: 403, body: { message: SERVER_TEXT } }
        : discord(sample())(request),
    );
    const message = await failureOf(run(base, { fetchImpl: unreadable.fetchImpl }));
    expect(message).toContain(CHANNEL);
    expectSafe(message);
  });

  it("allows a direct message channel only when asked", async () => {
    const handler = (request: Recorded) =>
      request.url.pathname === `/api/v10/channels/${CHANNEL}`
        ? { body: { id: CHANNEL, type: 1 } }
        : discord(sample())(request);
    const { fetchImpl } = fakeFetch(handler);
    expect(await failureOf(run(base, { fetchImpl }))).toMatch(/includeDirectMessagesToBot/);
    const allowed = await run({ ...base, includeDirectMessagesToBot: "true", perChannelLimit: "100" }, { fetchImpl });
    expect(allowed.items[0]).toMatchObject({
      kind: "dm",
      url: `https://discord.com/channels/@me/${CHANNEL}/${messageId(10)}`,
    });
  });

  it("saves a cooldown on HTTP 429 and sends no request until it ends", async () => {
    let clock = UNTIL;
    const limited = fakeFetch(() => ({
      status: 429,
      headers: { "Retry-After": "2" },
      body: { retry_after: 20.5, message: SERVER_TEXT, global: false },
    }));
    expectSafe(await failureOf(run(base, { fetchImpl: limited.fetchImpl, now: () => clock })));
    expect(limited.requests).toHaveLength(1);

    clock = UNTIL + 10_000;
    const during = fakeFetch(discord(sample()));
    expect(await failureOf(run(base, { fetchImpl: during.fetchImpl, now: () => clock }))).toMatch(/cooldown is active/);
    expect(during.requests).toHaveLength(0);

    clock = UNTIL + 21_000;
    const after = fakeFetch(discord(sample()));
    await run(base, { fetchImpl: after.fetchImpl, now: () => clock });
    expect(after.requests.length).toBeGreaterThan(0);
  });

  it("waits out a short bucket pause and saves a cooldown for a long one", async () => {
    const waits: number[] = [];
    const short = fakeFetch((request) => {
      const answer = discord(sample())(request);
      return { ...answer, headers: { "X-RateLimit-Remaining": "0", "X-RateLimit-Reset-After": "1.5" } };
    });
    await run(
      { ...base, perChannelLimit: "100" },
      { fetchImpl: short.fetchImpl, sleep: async (ms) => void waits.push(ms) },
    );
    expect(waits.length).toBeGreaterThan(0);
    expect(waits.every((ms) => ms === 1500)).toBe(true);

    const long = fakeFetch((request) => ({
      ...discord(sample())(request),
      headers: { "X-RateLimit-Remaining": "0", "X-RateLimit-Reset-After": "120" },
    }));
    expect(await failureOf(run(base, { fetchImpl: long.fetchImpl }))).toMatch(/cooldown is active/);
    const during = fakeFetch(discord(sample()));
    await failureOf(run(base, { fetchImpl: during.fetchImpl }));
    expect(during.requests).toHaveLength(0);
  });

  it("never prints the token or server text in a failure", async () => {
    const cases: Array<() => Promise<unknown>> = [
      () =>
        run(base, {
          fetchImpl: fakeFetch(() => ({ status: 500, body: { message: `${SERVER_TEXT} ${TOKEN}` } })).fetchImpl,
        }),
      () =>
        run(base, {
          fetchImpl: async () => {
            throw new Error(`${SERVER_TEXT} ${TOKEN}`);
          },
        }),
      () => run(base, { fetchImpl: async () => new Response(`${SERVER_TEXT} ${TOKEN}`, { status: 200 }) }),
    ];
    for (const attempt of cases) expectSafe(await failureOf(attempt()));
  });

  it("stops with a message instead of reporting a partial window when a cap is reached", async () => {
    const many: Message[] = Array.from({ length: 12 }, (_, index) => ({
      id: messageId(10 + index),
      type: 0,
      content: String(index),
      author: author("111111111111111111", "alice"),
    }));
    const { requests, fetchImpl } = fakeFetch(discord(many));
    expect(await failureOf(run({ ...base, perChannelLimit: "2", maxRequests: "5" }, { fetchImpl }))).toMatch(
      /maxRequests/,
    );
    expect(requests).toHaveLength(5);
    const full = await run(
      { ...base, perChannelLimit: "2", maxRequests: "20" },
      { fetchImpl: fakeFetch(discord(many)).fetchImpl },
    );
    expect(full.items).toHaveLength(12);
  });

  it("does not read messages that are newer than the window end", async () => {
    const late: Message[] = [
      { id: messageId(10), type: 0, content: "in", author: author("111111111111111111", "alice") },
      { id: messageId(900), type: 0, content: "after", author: author("111111111111111111", "alice") },
    ];
    const { fetchImpl } = fakeFetch(discord(late));
    const result = await run({ ...base, perChannelLimit: "100" }, { fetchImpl });
    expect(result.items.map((item) => item.text)).toEqual(["in"]);
  });

  it("rejects bad settings before any request", async () => {
    const { requests, fetchImpl } = fakeFetch(discord(sample()));
    await expect(run({ ...base, channelIds: "general" }, { fetchImpl })).rejects.toThrow(/channelIds/);
    await expect(run({ ...base, channelIds: "" }, { fetchImpl })).rejects.toThrow(/channelIds/);
    await expect(run({ ...base, mentionsOnly: "true", userId: "" }, { fetchImpl })).rejects.toThrow(/mentionsOnly/);
    await expect(run({ ...base, perChannelLimit: "500" }, { fetchImpl })).rejects.toThrow(/perChannelLimit/);
    await expect(run(base, { fetchImpl, token: "  " })).rejects.toThrow(/DISCORD_BOT_TOKEN/);
    expect(requests).toHaveLength(0);
  });
});

describe("program process contract", () => {
  function execute(file: string, stdin: string, env: Record<string, string>) {
    return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
      const child = spawn(process.execPath, [file], { cwd: temporary, env: { PATH: process.env.PATH ?? "", ...env } });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk: Buffer) => {
        stdout += chunk.toString();
      });
      child.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString();
      });
      child.on("error", reject);
      child.on("close", (code) => resolve({ code, stdout, stderr }));
      child.stdin.end(stdin);
    });
  }
  const cases = [
    { name: "slack", file: SLACK_FILE, variable: "SLACK_USER_TOKEN", prefix: "Slack activity watcher: " },
    { name: "discord", file: DISCORD_FILE, variable: "DISCORD_BOT_TOKEN", prefix: "Discord activity watcher: " },
  ];
  for (const { name, file, variable, prefix } of cases) {
    it(`${name} reports bad input with one safe stderr line, exit code 1 and no stdout`, async () => {
      const secret = "SPAWN-SECRET-VALUE-456";
      const badJson = await execute(file, "not json", { [variable]: secret });
      expect(badJson).toMatchObject({ code: 1, stdout: "", stderr: `${prefix}Invalid watcher input JSON.\n` });
      const missingToken = await execute(file, "{}", {});
      expect(missingToken).toMatchObject({ code: 1, stdout: "" });
      expect(missingToken.stderr).toContain(variable);
      const badConfig = await execute(file, JSON.stringify({ instanceId: "x", [variable]: secret }), {
        [variable]: secret,
      });
      expect(badConfig.code).toBe(1);
      expect(badConfig.stdout).toBe("");
      expect(badConfig.stderr.startsWith(prefix)).toBe(true);
      expect(badConfig.stderr.trim().split("\n")).toHaveLength(1);
      for (const run of [badJson, missingToken, badConfig]) expect(run.stderr).not.toContain(secret);
      const oversized = await execute(file, "x".repeat(70_000), { [variable]: secret });
      expect(oversized).toMatchObject({ code: 1, stdout: "" });
    });
  }
});

describe("template catalog", () => {
  it("loads both templates the way the build does", async () => {
    const source = join(temporary, "source");
    await mkdir(join(source, "watchers"), { recursive: true });
    await writeFile(
      join(source, "catalog.json"),
      JSON.stringify({ schemaVersion: 1, catalogVersion: "v1", order: ["slack-activity", "discord-activity"] }),
    );
    for (const slug of ["slack-activity", "discord-activity"])
      await cp(join(WATCHERS, slug), join(source, "watchers", slug), { recursive: true });

    const { templates, files } = await loadWatcherCatalog(source);
    expect(templates.map((template) => template.slug)).toEqual(["slack-activity", "discord-activity"]);
    expect(files.map((file) => file.path).sort()).toEqual([
      "catalog.json",
      "programs/discord-activity.mjs",
      "programs/slack-activity.mjs",
    ]);
    const [slack, discord] = templates;
    expect(slack?.variables.map((variable) => variable.name)).toEqual(["SLACK_USER_TOKEN"]);
    expect(discord?.variables.map((variable) => variable.name)).toEqual(["DISCORD_BOT_TOKEN"]);
    expect(slack?.app).toBe("slack");
    expect(discord?.app).toBeNull();
    for (const template of templates) {
      expect(template.intervalSeconds).toBeGreaterThanOrEqual(30);
      expect(
        template.configuration.some((field) => /token|password|secret|api_key|authorization/i.test(field.name)),
      ).toBe(false);
      expect(template.configuration.filter((field) => field.required).map((field) => field.name)).toContain(
        "instanceId",
      );
      expect(JSON.parse(template.argumentsJson)).toEqual({ since: "$lastSuccessAt", until: "$now" });
    }
    // The shipped program is the reviewed file, byte for byte.
    expect(files.find((file) => file.path === "programs/slack-activity.mjs")?.content.toString()).toBe(
      await readFile(SLACK_FILE, "utf8"),
    );
  });
});
