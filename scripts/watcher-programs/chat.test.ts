// @vitest-environment node
// Failure modes: a token or server text reaching stderr, a write request being sent, a partial window
// being reported as complete, an edit that does not change the revision, a token of another account
// being read, a rate limit being ignored (requests during a cooldown), and a template the host would
// refuse to install. Every request here goes to a fake `fetch`: nothing was run against live Slack or Discord.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
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
interface Discovery {
  options: Array<{ id: string; label: string; group: string; description?: string }>;
  truncated?: boolean;
}
interface Program {
  runWatcher(input: DynamicRecord, deps: Deps): Promise<Result>;
  runDiscovery?(input: DynamicRecord, deps: Deps): Promise<Discovery>;
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
// An app user token. It contains TOKEN, so every "never printed" check covers it too.
const SLACK_TOKEN = `xoxp-${TOKEN}`;
// A browser session token and its d cookie, as they come out of the browser's console and cookie list.
const BROWSER_TOKEN = "xoxc-1234567890-1234567890-1234567890-abcdef0123456789";
const BROWSER_COOKIE = "xoxd-AbCdEf%2BGhIjKl%2FMnOp%3D";

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
    contextMessages: "0",
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
    "users.info",
  ]);
  let program: Program;
  beforeEach(async () => {
    program = await load(SLACK_FILE);
  });
  const run = (input: DynamicRecord, deps: Deps) =>
    program.runWatcher(input, {
      token: SLACK_TOKEN,
      now: () => UNTIL,
      cooldownDir: join(temporary, "cooldowns"),
      ...deps,
    });
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
      expect(request.headers.get("authorization")).toBe(`Bearer ${SLACK_TOKEN}`);
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

  it("reads with a browser token and its d cookie, from the workspace address, and sends no cookie with an app token", async () => {
    const browser = fakeFetch(workspace);
    await run(
      { ...base, workspaceDomain: "Fjordfront.slack.com" },
      { fetchImpl: browser.fetchImpl, token: `${BROWSER_TOKEN}; d=${BROWSER_COOKIE}` },
    );
    expect(browser.requests.length).toBeGreaterThan(0);
    for (const request of browser.requests) {
      expect(request.httpMethod).toBe("GET");
      expect(request.url.host).toBe("fjordfront.slack.com");
      expect(request.headers.get("authorization")).toBe(`Bearer ${BROWSER_TOKEN}`);
      expect(request.headers.get("cookie")).toBe(`d=${BROWSER_COOKIE}`);
    }
    const app = fakeFetch(workspace);
    await run(base, { fetchImpl: app.fetchImpl });
    for (const request of app.requests) {
      expect(request.url.host).toBe("slack.com");
      expect(request.headers.get("cookie")).toBeNull();
    }
  });

  it("accepts the cookie without its d= label, and encodes a cookie that was pasted decoded", async () => {
    const plain = fakeFetch(workspace);
    await run(base, { fetchImpl: plain.fetchImpl, token: `${BROWSER_TOKEN};${BROWSER_COOKIE}` });
    expect(plain.requests[0]?.headers.get("cookie")).toBe(`d=${BROWSER_COOKIE}`);
    const decoded = fakeFetch(workspace);
    await run(base, { fetchImpl: decoded.fetchImpl, token: `${BROWSER_TOKEN}; d=xoxd-AbCdEf+GhIjKl/MnOp=` });
    expect(decoded.requests[0]?.headers.get("cookie")).toBe(`d=${encodeURIComponent("xoxd-AbCdEf+GhIjKl/MnOp=")}`);
  });

  it("refuses a browser token without its cookie, a malformed value, and an address outside slack.com, before any request", async () => {
    const { requests, fetchImpl } = fakeFetch(workspace);
    const bad = [
      BROWSER_TOKEN,
      `${BROWSER_TOKEN}; d=not-a-cookie`,
      `${SLACK_TOKEN}; d=${BROWSER_COOKIE}`,
      "xoxb-123456789-bot-token",
      `${BROWSER_TOKEN}; d=${BROWSER_COOKIE}; extra`,
      "has a space xoxp-12345678",
    ];
    for (const token of bad) {
      const message = await failureOf(run(base, { fetchImpl, token }));
      expect(message).not.toContain(BROWSER_TOKEN);
      expect(message).not.toContain(BROWSER_COOKIE);
      expect(message).toMatch(/SLACK_USER_TOKEN|xoxp-|xoxc-/);
    }
    for (const workspaceDomain of [
      "evil.example.com",
      "slack.com.evil.com",
      "https://fjordfront.slack.com",
      "a.slack.com/x",
    ]) {
      await expect(
        run({ ...base, workspaceDomain }, { fetchImpl, token: `${BROWSER_TOKEN}; d=${BROWSER_COOKIE}` }),
      ).rejects.toThrow(/workspaceDomain/);
    }
    expect(requests).toHaveLength(0);
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

  it("reads direct conversations in batches, the longest unread first, and starts over after the last", async () => {
    const conversations = Array.from({ length: 7 }, (_, index) => ({ id: `D${index + 1}`, is_im: true }));
    const fake = fakeFetch((request) => {
      const method = methodOf(request);
      if (method === "conversations.list") return ok({ channels: conversations });
      if (method === "conversations.history") return ok({ messages: [] });
      return workspace(request);
    });
    const input = {
      ...base,
      instanceId: "rotation",
      watchMentions: "false",
      watchDirectMessages: "true",
      maxConversations: "3",
    };
    const readOnRun = async (index: number, windowSeconds = 600) => {
      const until = UNTIL + index * 120_000;
      const before = fake.requests.length;
      await run(
        { ...input, since: new Date(until - windowSeconds * 1000).toISOString(), until: new Date(until).toISOString() },
        { fetchImpl: fake.fetchImpl, now: () => until },
      );
      return fake.requests
        .slice(before)
        .filter((request) => methodOf(request) === "conversations.history")
        .map((request) => ({
          id: request.url.searchParams.get("channel"),
          oldest: Number(request.url.searchParams.get("oldest")),
        }));
    };
    expect((await readOnRun(0)).map((read) => read.id)).toEqual(["D1", "D2", "D3"]);
    expect((await readOnRun(1)).map((read) => read.id)).toEqual(["D4", "D5", "D6"]);
    expect((await readOnRun(2)).map((read) => read.id)).toEqual(["D7", "D1", "D2"]);
    // D3 was last read three checks ago, before this narrow window starts: it is read from then, not from the window.
    const fourth = await readOnRun(3, 60);
    expect(fourth.map((read) => read.id)).toEqual(["D3", "D4", "D5"]);
    const [skipped, recent] = fourth;
    if (!skipped || !recent) throw new Error("Expected reads.");
    expect(skipped.oldest).toBeLessThan(recent.oldest);
  });

  describe("conversation context", () => {
    const withContext = { ...base, watchMentions: "false", watchDirectMessages: "true", contextMessages: "3" };
    const workspaceWith = (handler: (request: Recorded) => { body?: unknown } | null) =>
      fakeFetch((request) => {
        const answer = handler(request);
        return answer ?? workspace(request);
      });

    it("attaches the earlier messages of the conversation, oldest first, and marks the person's own", async () => {
      const fake = workspaceWith((request) => {
        const method = methodOf(request);
        if (method === "conversations.list") return ok({ channels: [{ id: "D9", is_im: true }] });
        if (method === "conversations.history") {
          return ok({
            messages: [
              { ts: ts(300), text: "any news about the deploy?", user: "U222BBBB" },
              { ts: ts(250), text: "it went out at noon", user: ME },
              { ts: ts(200), text: "ping me when it is live", user: "U222BBBB" },
              { ts: ts(150), text: "older than the limit", user: ME },
              { ts: ts(100), subtype: "channel_join", text: "joined", user: "U222BBBB" },
            ],
          });
        }
        if (method === "users.info")
          return ok({ user: { id: request.url.searchParams.get("user"), profile: { display_name: "Pat" } } });
        return null;
      });
      const result = await run(withContext, { fetchImpl: fake.fetchImpl });
      const item = result.items.find((entry) => entry.id === `D9:${ts(300)}`);
      expect(item?.context).toEqual([
        { ts: ts(150), user: ME, fromMe: true, text: "older than the limit" },
        { ts: ts(200), user: "U222BBBB", fromMe: false, text: "ping me when it is live", name: "Pat" },
        { ts: ts(250), user: ME, fromMe: true, text: "it went out at noon" },
      ]);
      expect(item?.actorName).toBe("Pat");
      expect(fake.requests.every((request) => READ_METHODS.has(methodOf(request)))).toBe(true);
    });

    it("sends no context request when it is turned off", async () => {
      const fake = workspaceWith((request) =>
        methodOf(request) === "conversations.list" ? ok({ channels: [{ id: "D9", is_im: true }] }) : null,
      );
      await run({ ...withContext, contextMessages: "0" }, { fetchImpl: fake.fetchImpl });
      const calls = fake.requests.filter((request) => methodOf(request) === "conversations.history");
      expect(calls).toHaveLength(1);
      expect(fake.requests.some((request) => methodOf(request) === "users.info")).toBe(false);
    });

    it("never fails the check when the context cannot be read", async () => {
      let history = 0;
      const fake = workspaceWith((request) => {
        const method = methodOf(request);
        if (method === "conversations.list") return ok({ channels: [{ id: "D9", is_im: true }] });
        if (method === "conversations.history") {
          history += 1;
          return history === 1
            ? ok({ messages: [{ ts: ts(300), text: "new", user: "U222BBBB" }] })
            : { body: { ok: false, error: "channel_not_found" } };
        }
        return null;
      });
      const result = await run(withContext, { fetchImpl: fake.fetchImpl });
      expect(result.items).toHaveLength(1);
      expect(result.items[0]).not.toHaveProperty("context");
    });
  });

  it("keeps no rotation state while every conversation fits in one check", async () => {
    const fake = fakeFetch((request) => {
      const method = methodOf(request);
      if (method === "conversations.list") return ok({ channels: [{ id: "D1", is_im: true }] });
      if (method === "conversations.history") return ok({ messages: [] });
      return workspace(request);
    });
    await run(
      {
        ...base,
        instanceId: "no-rotation",
        watchMentions: "false",
        watchDirectMessages: "true",
        maxConversations: "3",
      },
      { fetchImpl: fake.fetchImpl },
    );
    const files = await readdir(join(temporary, "cooldowns")).catch((): string[] => []);
    expect(files).not.toContain(`${createHash("sha256").update("rotation:no-rotation").digest("hex")}.json`);
  });

  it("stops with a message instead of reporting a partial window when a cap is reached", async () => {
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

  describe("conversation rules", () => {
    const ruled = { ...base, watchMentions: "false", watchDirectMessages: "false" };
    const mention = `<@${ME}>`;
    /** A workspace where C200 is a channel, G300 a group conversation and D400 a direct conversation. */
    function rulesWorkspace(request: Recorded) {
      const method = methodOf(request);
      const channel = request.url.searchParams.get("channel");
      if (method === "users.conversations") {
        return ok({
          channels: [
            { id: "C200", name: "ops", is_channel: true },
            { id: "C201", name: "random", is_channel: true },
            { id: "G300", name: "mpdm-ann--bob-1", is_mpim: true, is_group: true, is_private: true },
            { id: "G301", name: "secret", is_group: true, is_private: true },
            { id: "D400", is_im: true, user: "U222BBBB" },
          ],
        });
      }
      if (method === "conversations.history") {
        const messages: Record<string, DynamicRecord[]> = {
          C200: [
            { ts: ts(300), text: `please look ${mention}`, user: "U222BBBB" },
            { ts: ts(200), text: "unrelated chatter", user: "U333CCCC" },
            { ts: ts(100), text: `<@${ME}|me> legacy mention form`, user: "U333CCCC" },
          ],
          C201: [{ ts: ts(250), text: "everything is shown", user: "U333CCCC" }],
          G300: [
            { ts: ts(280), text: "group without mention", user: "U222BBBB" },
            { ts: ts(270), text: `group ${mention}`, user: "U222BBBB" },
          ],
          D400: [
            { ts: ts(260), text: "dm without mention", user: "U222BBBB" },
            { ts: ts(255), text: `dm ${mention}`, user: "U222BBBB" },
          ],
        };
        return ok({ messages: messages[channel ?? ""] ?? [] });
      }
      return workspace(request);
    }
    const historyOf = (requests: Recorded[]) =>
      requests.filter((request) => methodOf(request) === "conversations.history");

    it("keeps only messages that mention the person in a mentions rule, and every message in an all rule", async () => {
      const { requests, fetchImpl } = fakeFetch(rulesWorkspace);
      const result = await run(
        { ...ruled, conversationRules: "C200:mentions, C201:all,G300:mentions,D400:all" },
        {
          fetchImpl,
        },
      );
      const byId = new Map(result.items.map((item) => [item.id, item]));
      expect([...byId.keys()].sort()).toEqual(
        [
          `C200:${ts(300)}`,
          `C200:${ts(100)}`,
          `C201:${ts(250)}`,
          `G300:${ts(270)}`,
          `D400:${ts(260)}`,
          `D400:${ts(255)}`,
        ].sort(),
      );
      expect(byId.get(`C200:${ts(300)}`)).toMatchObject({ kind: "mention", channel: "C200", channelName: "ops" });
      expect(byId.get(`C201:${ts(250)}`)).toMatchObject({ kind: "channel", channelName: "random" });
      expect(byId.get(`G300:${ts(270)}`)).toMatchObject({ kind: "group_dm" });
      expect(byId.get(`D400:${ts(255)}`)).toMatchObject({ kind: "dm" });
      // One walk over the person's conversations names them all: no request for each one.
      expect(requests.map(methodOf).filter((method) => method === "conversations.info")).toHaveLength(0);
      expect(requests.map(methodOf).filter((method) => method === "users.conversations")).toHaveLength(1);
      expect(historyOf(requests).map((request) => request.url.searchParams.get("channel"))).toEqual([
        "C200",
        "C201",
        "G300",
        "D400",
      ]);
      for (const request of requests) expect(request.httpMethod).toBe("GET");
    });

    it("runs on a rule alone, without any other switch", async () => {
      const { fetchImpl } = fakeFetch(rulesWorkspace);
      const result = await run({ ...ruled, conversationRules: "C201:all" }, { fetchImpl });
      expect(result.items.map((item) => item.id)).toEqual([`C201:${ts(250)}`]);
    });

    it("lets a rule replace the generic direct message watch for its own conversation only", async () => {
      const fake = fakeFetch((request) => {
        if (methodOf(request) === "conversations.list")
          return ok({
            channels: [
              { id: "D400", is_im: true },
              { id: "D500", is_im: true },
            ],
          });
        if (methodOf(request) === "conversations.history" && request.url.searchParams.get("channel") === "D500")
          return ok({ messages: [{ ts: ts(120), text: "plain dm", user: "U333CCCC" }] });
        return rulesWorkspace(request);
      });
      const result = await run(
        { ...ruled, watchDirectMessages: "true", conversationRules: "D400:mentions" },
        { fetchImpl: fake.fetchImpl },
      );
      expect(result.items.map((item) => item.id).sort()).toEqual([`D400:${ts(255)}`, `D500:${ts(120)}`].sort());
      // D400 is read once, by its rule.
      const reads = historyOf(fake.requests).map((request) => request.url.searchParams.get("channel"));
      expect(reads.filter((id) => id === "D400")).toHaveLength(1);
      expect(reads).toContain("D500");
      // A direct conversation with a rule needs no name lookup request.
      expect(fake.requests.some((request) => methodOf(request) === "conversations.info")).toBe(false);
    });

    it("keeps watchChannels and channelIds working, and lets a rule override the same ID", async () => {
      const legacy = fakeFetch(rulesWorkspace);
      const old = await run(
        { ...ruled, watchChannels: "true", channelIds: "C200,C201" },
        { fetchImpl: legacy.fetchImpl },
      );
      // Each listed ID behaves as "all", read the way the earlier version did: one info request each.
      expect(old.items.filter((item) => item.channel === "C200")).toHaveLength(3);
      expect(legacy.requests.filter((request) => methodOf(request) === "conversations.info")).toHaveLength(2);
      expect(legacy.requests.some((request) => methodOf(request) === "users.conversations")).toBe(false);

      const mixed = fakeFetch(rulesWorkspace);
      const merged = await run(
        { ...ruled, watchChannels: "true", channelIds: "C200,C201", conversationRules: "C200:mentions" },
        { fetchImpl: mixed.fetchImpl },
      );
      expect(merged.items.filter((item) => item.channel === "C200")).toHaveLength(2);
      expect(merged.items.filter((item) => item.channel === "C201")).toHaveLength(1);
      expect(
        historyOf(mixed.requests).filter((request) => request.url.searchParams.get("channel") === "C200"),
      ).toHaveLength(1);
    });

    it("filters thread replies by mention too, and still opens a thread whose first message has none", async () => {
      const parent = {
        ts: ts(100),
        thread_ts: ts(100),
        reply_count: 2,
        latest_reply: ts(300),
        text: "parent",
        user: "U444DDDD",
      };
      const fake = fakeFetch((request) => {
        const method = methodOf(request);
        if (method === "conversations.history") return ok({ messages: [parent] });
        if (method === "conversations.replies")
          return ok({
            messages: [
              parent,
              { ts: ts(200), thread_ts: ts(100), text: "reply without mention", user: "U777GGGG" },
              { ts: ts(300), thread_ts: ts(100), text: `reply ${mention}`, user: "U777GGGG" },
            ],
          });
        return rulesWorkspace(request);
      });
      const result = await run(
        { ...ruled, conversationRules: "C200:mentions", includeThreadReplies: "true" },
        { fetchImpl: fake.fetchImpl },
      );
      expect(result.items.map((item) => [item.kind, item.id])).toEqual([["thread", `C200:${ts(300)}`]]);
    });

    it("asks for a conversation that the person has not joined, and treats a missing list as no answer", async () => {
      const fake = fakeFetch((request) => {
        const method = methodOf(request);
        if (method === "users.conversations") return ok({ channels: [{ id: "C201", name: "random" }] });
        if (method === "conversations.info")
          return ok({ channel: { id: request.url.searchParams.get("channel"), name: "public-elsewhere" } });
        return rulesWorkspace(request);
      });
      const result = await run({ ...ruled, conversationRules: "C201:all,C900:all" }, { fetchImpl: fake.fetchImpl });
      expect(fake.requests.filter((request) => methodOf(request) === "conversations.info")).toHaveLength(1);
      expect(result.items.find((item) => item.channel === "C900")).toBeUndefined();
      // The list ended without C900, so it was asked for by its ID.
      expect(
        fake.requests
          .filter((request) => methodOf(request) === "conversations.info")
          .map((request) => request.url.searchParams.get("channel")),
      ).toEqual(["C900"]);
    });

    it("stops with a rate limit when the walk over conversations is limited, and keeps its cooldown", async () => {
      const limited = fakeFetch((request) =>
        methodOf(request) === "users.conversations"
          ? { status: 429, headers: { "Retry-After": "30" }, body: { ok: false } }
          : rulesWorkspace(request),
      );
      expect(
        await failureOf(run({ ...ruled, conversationRules: "C200:all" }, { fetchImpl: limited.fetchImpl })),
      ).toMatch(/rate limit/);
      expect(limited.requests.filter((request) => methodOf(request) === "conversations.history")).toHaveLength(0);
      const after = fakeFetch(rulesWorkspace);
      expect(await failureOf(run({ ...ruled, conversationRules: "C200:all" }, { fetchImpl: after.fetchImpl }))).toMatch(
        /cooldown is active/,
      );
      expect(after.requests).toHaveLength(0);
    });

    it("rejects a malformed rule list before any request", async () => {
      const { requests, fetchImpl } = fakeFetch(rulesWorkspace);
      const tooMany = Array.from({ length: 51 }, (_, index) => `C${String(1000 + index)}:all`).join(",");
      const bad: Array<[string, RegExp]> = [
        ["C200", /conversationRules/],
        ["C200:everything", /conversationRules/],
        ["C200:all:mentions", /conversationRules/],
        ["general:all", /conversationRules/],
        ["C200:all,C200:mentions", /twice/],
        [tooMany, /at most 50/],
      ];
      for (const [rules, pattern] of bad)
        await expect(run({ ...ruled, conversationRules: rules }, { fetchImpl })).rejects.toThrow(pattern);
      expect(requests).toHaveLength(0);
      // An empty value changes nothing: the earlier settings decide.
      await expect(run({ ...ruled, conversationRules: "" }, { fetchImpl })).rejects.toThrow(/at least one/);
    });
  });

  describe("conversation discovery", () => {
    const discoverInput = { instanceId: "disc", userId: ME, discover: true };
    const discover = (input: DynamicRecord, deps: Deps) => {
      if (!program.runDiscovery) throw new Error("Expected a discovery function.");
      return program.runDiscovery(input, {
        token: SLACK_TOKEN,
        now: () => UNTIL,
        cooldownDir: join(temporary, "cooldowns"),
        ...deps,
      });
    };
    const codeOf = async (attempt: Promise<unknown>): Promise<string | undefined> => {
      const error = await attempt.then(
        () => null,
        (reason: unknown) => reason,
      );
      return error instanceof Error && "code" in error && typeof error.code === "string" ? error.code : undefined;
    };
    const names: Record<string, string> = { U222BBBB: "Pat Doe", U333CCCC: "" };
    function directory(request: Recorded) {
      const method = methodOf(request);
      if (method === "auth.test") return ok({ user_id: ME });
      if (method === "users.info") {
        const id = request.url.searchParams.get("user") ?? "";
        return ok({
          user: { id, profile: { display_name: names[id] ?? "" }, real_name: id === "U333CCCC" ? "Qu\u202einn" : "" },
        });
      }
      if (method === "users.conversations") {
        const cursor = request.url.searchParams.get("cursor");
        expect(request.url.searchParams.get("types")).toBe("public_channel,private_channel,im,mpim");
        expect(request.url.searchParams.get("exclude_archived")).toBe("true");
        if (!cursor)
          return ok({
            channels: [
              { id: "C200", name: "general", is_channel: true, purpose: { value: "Company\u0007 news\n and more" } },
              { id: "G301", name: "secret-club", is_group: true, is_private: true },
              { id: "D400", is_im: true, user: "U222BBBB" },
              { id: "Cold", name: "not-an-id" },
              { id: "C999", name: "archived", is_archived: true },
            ],
            response_metadata: { next_cursor: "page-2" },
          });
        return ok({
          channels: [
            { id: "G300", name: "mpdm-ann--bob--cy-1", is_mpim: true, is_group: true, is_private: true },
            { id: "D500", is_im: true, user: "U333CCCC" },
            { id: "D600", is_im: true, user: "U999ZZZZ", is_user_deleted: true },
            { id: "C201", name: `ev‮il\u0000${"x".repeat(200)}`, is_channel: true },
          ],
        });
      }
      return { status: 500, body: { ok: false } };
    }

    it("lists the conversations of the token's user in groups, across pages, with clean labels", async () => {
      const { requests, fetchImpl } = fakeFetch(directory);
      const result = await discover(discoverInput, { fetchImpl });
      expect(result.truncated).toBeUndefined();
      expect(result.options.map((option) => [option.id, option.group, option.label])).toEqual([
        ["C201", "channel", `#evil${"x".repeat(74)}…`],
        ["C200", "channel", "#general"],
        ["G301", "private_channel", "#secret-club"],
        ["D400", "dm", "@Pat Doe"],
        ["D500", "dm", "@Quinn"],
        ["G300", "group_dm", "ann, bob, cy"],
      ]);
      expect(result.options.find((option) => option.id === "C200")?.description).toBe("Company news and more");
      for (const option of result.options) {
        expect(option.label).not.toMatch(/\p{Cc}|\p{Cf}/u);
        expect(option.label.length).toBeLessThanOrEqual(80);
      }
      // The partner of each direct conversation is asked for once. The deleted user is not.
      expect(
        requests
          .filter((request) => methodOf(request) === "users.info")
          .map((request) => request.url.searchParams.get("user"))
          .sort(),
      ).toEqual(["U222BBBB", "U333CCCC"]);
      // Only read methods, one GET each, with the token in a header and never in a URL.
      for (const request of requests) {
        expect(request.httpMethod).toBe("GET");
        expect(READ_METHODS.has(methodOf(request)) || methodOf(request) === "users.conversations").toBe(true);
        expect(request.url.toString()).not.toContain(TOKEN);
      }
      expect(JSON.stringify(result)).not.toContain(TOKEN);
    });

    it("is what runWatcher does for an input with discover true, and it reads no messages", async () => {
      const { requests, fetchImpl } = fakeFetch(directory);
      const result = await run(discoverInput, { fetchImpl });
      expect(result).toMatchObject({ options: expect.arrayContaining([expect.objectContaining({ id: "C200" })]) });
      expect(result).not.toHaveProperty("items");
      expect(requests.map(methodOf).filter((method) => method.startsWith("conversations."))).toEqual([]);
    });

    it("needs no window, no instance name and no user ID", async () => {
      const { fetchImpl } = fakeFetch(directory);
      const result = await discover({ discover: true }, { fetchImpl });
      expect(result.options.length).toBeGreaterThan(0);
    });

    it("falls back to the user ID when names cannot be read, and never fails for it", async () => {
      const { requests, fetchImpl } = fakeFetch((request) =>
        methodOf(request) === "users.info" ? { body: { ok: false, error: "missing_scope" } } : directory(request),
      );
      const result = await discover(discoverInput, { fetchImpl });
      expect(result.options.filter((option) => option.group === "dm").map((option) => option.label)).toEqual([
        "@U222BBBB",
        "@U333CCCC",
      ]);
      // A failed lookup ends the lookups: the second person is not asked for.
      expect(requests.filter((request) => methodOf(request) === "users.info")).toHaveLength(1);
    });

    it("caps the number of name lookups and the number of options", async () => {
      const people = Array.from({ length: 70 }, (_, index) => ({
        id: `D${String(1000 + index)}`,
        is_im: true,
        user: `U${String(1000 + index)}`,
      }));
      const many = fakeFetch((request) => {
        if (methodOf(request) === "users.conversations") return ok({ channels: people });
        return directory(request);
      });
      const result = await discover({ ...discoverInput, maxRequests: "200" }, { fetchImpl: many.fetchImpl });
      expect(result.options).toHaveLength(70);
      expect(many.requests.filter((request) => methodOf(request) === "users.info")).toHaveLength(60);

      const channels = Array.from({ length: 1005 }, (_, index) => ({
        id: `C${String(10000 + index)}`,
        name: `chan-${String(index).padStart(4, "0")}`,
        is_channel: true,
      }));
      const huge = fakeFetch((request) => {
        if (methodOf(request) !== "users.conversations") return directory(request);
        const start = Number(request.url.searchParams.get("cursor") ?? "0");
        const page = channels.slice(start, start + 200);
        return ok({
          channels: page,
          response_metadata: { next_cursor: start + 200 < channels.length ? String(start + 200) : "" },
        });
      });
      const capped = await discover({ ...discoverInput, maxRequests: "200" }, { fetchImpl: huge.fetchImpl });
      expect(capped.options).toHaveLength(1000);
      expect(capped.truncated).toBe(true);
    });

    it("reports the same error codes as the check", async () => {
      const auth = fakeFetch(() => ({ body: { ok: false, error: "invalid_auth" } }));
      expect(await codeOf(discover(discoverInput, { fetchImpl: auth.fetchImpl }))).toBe("auth");
      const scope = fakeFetch((request) =>
        methodOf(request) === "users.conversations"
          ? { body: { ok: false, error: "missing_scope" } }
          : directory(request),
      );
      expect(await codeOf(discover(discoverInput, { fetchImpl: scope.fetchImpl }))).toBe("auth");
      const upstream = fakeFetch(() => ({ status: 503, body: { ok: false } }));
      expect(await codeOf(discover(discoverInput, { fetchImpl: upstream.fetchImpl }))).toBe("upstream");
      const limited = fakeFetch(() => ({ status: 429, headers: { "Retry-After": "7" }, body: { ok: false } }));
      expect(
        await codeOf(discover({ ...discoverInput, instanceId: "limited" }, { fetchImpl: limited.fetchImpl })),
      ).toBe("rate_limited");
      expect(await codeOf(discover({ ...discoverInput, userId: "nobody" }, { fetchImpl: auth.fetchImpl }))).toBe(
        "config",
      );
      expect(
        await codeOf(
          discover({ ...discoverInput, workspaceDomain: "evil.example.com" }, { fetchImpl: auth.fetchImpl }),
        ),
      ).toBe("config");
      expect(await codeOf(discover(discoverInput, { fetchImpl: auth.fetchImpl, token: "" }))).toBe("auth");
      expect(await codeOf(discover(discoverInput, { fetchImpl: auth.fetchImpl, token: "xoxb-not-a-user-token" }))).toBe(
        "auth",
      );
      const other = fakeFetch((request) =>
        methodOf(request) === "auth.test" ? ok({ user_id: "U999OTHER" }) : directory(request),
      );
      expect(await failureOf(discover(discoverInput, { fetchImpl: other.fetchImpl }))).toMatch(/does not belong/);
      // The request cap and the time budget are the check's own.
      const capped = fakeFetch(directory);
      expect(
        await codeOf(
          discover({ ...discoverInput, maxRequests: "4", workspaceDomain: "" }, { fetchImpl: capped.fetchImpl }),
        ),
      ).toBeUndefined();
      let clock = UNTIL;
      const slow = fakeFetch((request) => {
        clock += 31_000;
        return directory(request);
      });
      expect(await codeOf(discover(discoverInput, { fetchImpl: slow.fetchImpl, now: () => clock }))).toBe("config");
    });

    it("saves the cooldown that Slack asks for and sends nothing while it lasts", async () => {
      const limited = fakeFetch(() => ({ status: 429, headers: { "Retry-After": "30" }, body: { ok: false } }));
      expect(await codeOf(discover(discoverInput, { fetchImpl: limited.fetchImpl }))).toBe("rate_limited");
      const after = fakeFetch(directory);
      expect(await codeOf(discover(discoverInput, { fetchImpl: after.fetchImpl }))).toBe("rate_limited");
      expect(after.requests).toHaveLength(0);
      // The check of the same instance shares the cooldown.
      expect(await failureOf(run({ ...base, instanceId: "disc" }, { fetchImpl: after.fetchImpl }))).toMatch(/cooldown/);
    });

    it("never prints the token or server text in a failure", async () => {
      const attempts = [
        fakeFetch(() => ({ body: { ok: false, error: `${SERVER_TEXT} ${TOKEN}` } })),
        fakeFetch(() => ({ status: 500, body: { message: `${SERVER_TEXT} ${TOKEN}` } })),
      ];
      for (const attempt of attempts)
        expectSafe(await failureOf(discover(discoverInput, { fetchImpl: attempt.fetchImpl })));
    });
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
    {
      name: "slack",
      file: SLACK_FILE,
      variable: "SLACK_USER_TOKEN",
      prefix: "Slack activity watcher: ",
      secret: "xoxp-SPAWN-SECRET-VALUE-456",
    },
    {
      name: "discord",
      file: DISCORD_FILE,
      variable: "DISCORD_BOT_TOKEN",
      prefix: "Discord activity watcher: ",
      secret: "SPAWN-SECRET-VALUE-456",
    },
  ];
  for (const { name, file, variable, prefix, secret } of cases) {
    it(`${name} reports bad input with a safe message and one error code, exit code 1 and no stdout`, async () => {
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
      // The message line, then the one code that OpenBot maps to its own text.
      expect(badConfig.stderr.trim().split("\n")).toEqual([expect.stringContaining(prefix), "openbot-error: config"]);
      for (const run of [badJson, missingToken, badConfig]) expect(run.stderr).not.toContain(secret);
      const oversized = await execute(file, "x".repeat(70_000), { [variable]: secret });
      expect(oversized).toMatchObject({ code: 1, stdout: "" });
    });
  }
  it("slack discovery fails with one code and no stdout, and never echoes a malformed token", async () => {
    const secret = "not-a-token-SPAWN-SECRET-789";
    const run = await execute(SLACK_FILE, JSON.stringify({ discover: true }), { SLACK_USER_TOKEN: secret });
    expect(run).toMatchObject({ code: 1, stdout: "" });
    expect(run.stderr).not.toContain(secret);
    expect(run.stderr.trim().split("\n")).toEqual([
      expect.stringContaining("Slack activity watcher: "),
      "openbot-error: auth",
    ]);
  });
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
    expect(files.map((file) => file.path).sort()).toEqual(
      expect.arrayContaining(["catalog.json", "programs/discord-activity.mjs", "programs/slack-activity.mjs"]),
    );
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

  it("ships the picker setting, keeps the released program, and refuses a picker whose program has no discovery", async () => {
    const source = join(temporary, "source");
    await mkdir(join(source, "watchers"), { recursive: true });
    await writeFile(
      join(source, "catalog.json"),
      JSON.stringify({ schemaVersion: 1, catalogVersion: "v1", order: ["slack-activity"] }),
    );
    await cp(join(WATCHERS, "slack-activity"), join(source, "watchers", "slack-activity"), { recursive: true });
    const { templates, files } = await loadWatcherCatalog(source);
    const [slack] = templates;
    // A client from before pickers decodes this field as text, so the type stays text.
    const rules = slack?.configuration.find((field) => field.name === "conversationRules");
    expect(rules).toMatchObject({
      type: "text",
      required: false,
      value: "",
      picker: {
        optionsFrom: "program",
        modes: [
          { value: "all", label: expect.any(String) },
          { value: "mentions", label: expect.any(String) },
        ],
      },
    });
    expect(slack?.version).toBe("1.3.0");
    expect(slack?.earlierPrograms?.map((program) => program.version)).toEqual([
      "1.0.0",
      "1.0.1",
      "1.1.0",
      "1.1.1",
      "1.2.0",
    ]);
    // Every released program stays byte for byte, so a check that runs one can still be linked.
    const earlier = files.find((file) => file.path === "programs/slack-activity-1.2.0.mjs");
    expect(
      createHash("sha256")
        .update(earlier?.content ?? "")
        .digest("hex"),
    ).toBe("d245334c1ae670396e6f66d422fee3524a979d1e17dac648e900b6097c9131c0");

    const blind = join(source, "watchers", "slack-activity", "program.mjs");
    await writeFile(blind, "process.stdout.write('{}');\n");
    await expect(loadWatcherCatalog(source)).rejects.toThrow(/picker/);
  });
});
