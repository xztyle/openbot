// Checks the workspace message search (`workspace-search-v1`, under `fork-host-v1`) on a real Team API
// host with database read workers (`workspace-e2e-host.ts`), as the web client and a remote desktop
// reach it:
//
// - It finds the messages of the channels, groups and DMs that the person can see, thread replies
//   too, and never a message of a private channel they are not in.
// - Words match the start of words, also without accents; a phrase matches whole; `-word` leaves
//   messages out. Each hit has a snippet with the ranges of its matches.
// - The filters (channels, authors, threads, time, space) and both sorts; pages that cover every
//   match once.
// - An edit, a deletion and a streaming answer keep the index in step.
// - The read runs on a read worker and gives the main connection's answer; a search over 20,000
//   messages stays fast. A client without `fork-host-v1` gets 400.
//
// `bun scripts/workspace-search-e2e.ts`. Writes .openbot-build/workspace-search-e2e/report.json.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { WORKSPACE_SEARCH_CODECS, WORKSPACE_SEARCH_ROUTES } from "@openbot/contracts/team-protocol/workspace-search-v1";
import { WORKSPACE_SPACES_CODECS, WORKSPACE_SPACES_ROUTES } from "@openbot/contracts/team-protocol/workspace-spaces-v1";
import { foldSearchText } from "../src/backend/database/channel-search-queries";
import { type JsonObject, type Person, record, startWorkspaceE2e } from "./workspace-e2e-host";

const e2e = await startWorkspaceE2e(
  "workspace-search-e2e",
  [
    "The WebRTC transport of the web client. It carries the same requests to the same route handler that this check calls over loopback HTTP.",
    "A message of an agent hidden from the peer: no agent runs here. The route passes the hidden agents to the query, which leaves their messages out.",
  ],
  { readWorkers: true },
);
const { owner, member, step, send, createChannel } = e2e;

interface Hit {
  channelId: string;
  messageId: string;
  threadRootId?: string;
  authorId: string;
  snippet: string;
  highlights: { start: number; length: number }[];
  spaceId?: string;
  at: string;
}

interface Page {
  hits: Hit[];
  total: number;
  nextCursor: string | null;
}

async function search(person: Person, body: JsonObject): Promise<Page> {
  const response = await e2e.optional(WORKSPACE_SEARCH_CODECS, WORKSPACE_SEARCH_ROUTES.search, person.token, body);
  assert.equal(response.status, 200, `Search returned ${response.status}: ${JSON.stringify(response.body)}`);
  const page = record(response.body, "search page");
  assert.ok(Array.isArray(page.hits));
  return {
    total: Number(page.total),
    nextCursor: typeof page.nextCursor === "string" ? page.nextCursor : null,
    hits: page.hits.map((entry) => {
      const hit = record(entry, "hit");
      const author = record(hit.author, "author");
      assert.ok(Array.isArray(hit.highlights));
      return {
        channelId: String(hit.channelId),
        messageId: String(hit.messageId),
        ...(typeof hit.threadRootId === "string" ? { threadRootId: hit.threadRootId } : {}),
        authorId: String(author.id),
        snippet: String(hit.snippet),
        highlights: hit.highlights.map((range) => {
          const value = record(range, "highlight");
          return { start: Number(value.start), length: Number(value.length) };
        }),
        ...(typeof hit.spaceId === "string" ? { spaceId: hit.spaceId } : {}),
        at: String(hit.at),
      };
    }),
  };
}

const ids = (page: Page) => page.hits.map((hit) => hit.messageId).sort();
const sorted = (values: string[]) => [...values].sort();

try {
  const setup = await step("setup: channels, a private channel, a DM, a thread and a space", async () => {
    const launch = await createChannel(owner, "launch", "public");
    await e2e.command(member.token, { type: "join", operationId: randomUUID(), channelId: launch });
    const board = await createChannel(owner, "board", "private");
    const market = await createChannel(owner, "market", "public");
    const dm = randomUUID();
    await e2e.command(owner.token, {
      type: "open-dm",
      operationId: randomUUID(),
      channelId: dm,
      memberIds: [member.id],
      agentIds: [],
    });
    const root = await send(owner, launch, "The Café launch plan is ready");
    const reply = await send(member, launch, "Launch plan needs a pricing review", String(root.id));
    const pricing = await send(member, launch, "Pricing draft for the launch");
    const secret = await send(owner, board, "Launch budget is secret");
    const call = await send(member, dm, "Launch call at noon?");
    const quote = await send(owner, market, "Market launch numbers");
    const created = await e2e.optional(WORKSPACE_SPACES_CODECS, WORKSPACE_SPACES_ROUTES.action, owner.token, {
      kind: "create",
      name: "Trading",
    });
    assert.equal(created.status, 200, `Creating a space returned ${created.status}.`);
    const spaceId = String(record(created.body, "spaces").createdSpaceId);
    const moved = await e2e.optional(WORKSPACE_SPACES_CODECS, WORKSPACE_SPACES_ROUTES.action, owner.token, {
      kind: "move",
      spaceId,
      channelIds: [market],
    });
    assert.equal(moved.status, 200, `Moving the channel returned ${moved.status}.`);
    return {
      channels: { launch, board, market, dm },
      messages: {
        root: String(root.id),
        reply: String(reply.id),
        pricing: String(pricing.id),
        secret: String(secret.id),
        call: String(call.id),
        quote: String(quote.id),
      },
      spaceId,
    };
  });
  const { channels, messages } = setup;

  await step("a person finds the messages of what they can see, DMs and thread replies too", async () => {
    const memberPage = await search(member, { query: "launch" });
    assert.deepEqual(
      ids(memberPage),
      sorted([messages.root, messages.reply, messages.pricing, messages.call, messages.quote]),
      "The member's search is not the messages they can see.",
    );
    assert.equal(memberPage.total, 5);
    const ownerPage = await search(owner, { query: "launch" });
    assert.ok(ids(ownerPage).includes(messages.secret), "The owner does not find their private channel.");
    const reply = memberPage.hits.find((hit) => hit.messageId === messages.reply);
    assert.equal(reply?.threadRootId, messages.root, "A thread reply has no root.");
    return { member: memberPage.total, owner: ownerPage.total };
  });

  await step("words match word starts without accents, with highlights in the snippet", async () => {
    const page = await search(member, { query: "cafe" });
    assert.deepEqual(ids(page), [messages.root]);
    const [hit] = page.hits;
    assert.ok(hit);
    assert.ok(hit.highlights.length > 0, "The hit has no highlight.");
    for (const range of hit.highlights)
      assert.equal(foldSearchText(hit.snippet.slice(range.start, range.start + range.length)), "cafe");
    const prefix = await search(member, { query: "pric" });
    assert.deepEqual(ids(prefix), sorted([messages.reply, messages.pricing]));
    const inside = await search(member, { query: "aunch" });
    assert.equal(inside.total, 0, "A match inside a word counted.");
    return { snippet: hit.snippet, highlights: hit.highlights };
  });

  await step("a phrase matches whole; -word leaves messages out; an empty query finds nothing", async () => {
    assert.deepEqual(ids(await search(member, { query: '"plan is"' })), [messages.root]);
    assert.deepEqual(
      ids(await search(member, { query: "launch -plan -pricing" })),
      sorted([messages.call, messages.quote]),
    );
    assert.equal((await search(member, { query: "  " })).total, 0);
    assert.equal((await search(member, { query: "-launch" })).total, 0);
    assert.equal((await search(member, { query: '"' })).total, 0);
    // FTS syntax is plain text: punctuation finds nothing, and AND or NOT are words to find.
    assert.equal((await search(member, { query: "launch ( ) * ^ : +" })).total, 5, "Query syntax leaked in.");
    assert.equal((await search(member, { query: "launch NOT" })).total, 0, "NOT acted as an operator.");
    return { phrase: 1 };
  });

  await step("the filters: channels, authors, threads, time and space", async () => {
    assert.deepEqual(ids(await search(member, { query: "launch", channelIds: [channels.dm] })), [messages.call]);
    // Naming a channel the person cannot see finds nothing in it.
    assert.equal((await search(member, { query: "launch", channelIds: [channels.board] })).total, 0);
    assert.deepEqual(
      ids(await search(member, { query: "launch", authorIds: [member.id] })),
      sorted([messages.reply, messages.pricing, messages.call]),
    );
    assert.deepEqual(
      ids(await search(member, { query: "launch", threadsOnly: true })),
      sorted([messages.root, messages.reply]),
    );
    const future = new Date(Date.now() + 60_000).toISOString();
    assert.equal((await search(member, { query: "launch", after: future })).total, 0);
    assert.equal((await search(member, { query: "launch", before: future })).total, 5);
    const space = await search(member, { query: "launch", spaceId: setup.spaceId });
    assert.deepEqual(ids(space), [messages.quote]);
    assert.equal(space.hits[0]?.spaceId, setup.spaceId);
    return { space: space.total };
  });

  await step("pages cover every match once, in both sorts", async () => {
    for (let index = 0; index < 25; index += 1) await send(member, channels.launch, `Batch item ${index} for zebra`);
    for (const sort of ["recent", "relevance"]) {
      const seen: string[] = [];
      let cursor: string | null = null;
      let pages = 0;
      do {
        const page: Page = await search(member, { query: "zebra", sort, limit: 10, ...(cursor ? { cursor } : {}) });
        assert.equal(page.total, 25);
        seen.push(...page.hits.map((hit) => hit.messageId));
        cursor = page.nextCursor;
        pages += 1;
      } while (cursor);
      assert.equal(pages, 3);
      assert.equal(new Set(seen).size, 25, `The ${sort} pages repeat or miss a match.`);
    }
    const recent = await search(member, { query: "zebra", sort: "recent", limit: 3 });
    const times = recent.hits.map((hit) => hit.at);
    assert.deepEqual(times, [...times].sort().reverse(), "The recent sort is not newest first.");
    const past = await search(member, { query: "zebra", cursor: "100" });
    assert.deepEqual(past, { hits: [], total: 25, nextCursor: null });
    return { total: 25 };
  });

  await step("an edit and a deletion keep the index in step", async () => {
    await e2e.command(member.token, {
      type: "edit",
      operationId: randomUUID(),
      channelId: channels.launch,
      messageId: messages.pricing,
      text: "Tariff draft for the opening",
    });
    assert.equal((await search(member, { query: "pricing draft" })).total, 0);
    assert.deepEqual(ids(await search(member, { query: "tariff" })), [messages.pricing]);
    await e2e.command(member.token, {
      type: "delete",
      operationId: randomUUID(),
      channelId: channels.launch,
      messageId: messages.pricing,
    });
    assert.equal((await search(member, { query: "tariff" })).total, 0);
    return { edited: true, deleted: true };
  });

  await step("the read runs on a read worker and equals the main connection's answer", async () => {
    const database = e2e.host().database;
    const before = database.readsOffMain;
    const page = await search(member, { query: "launch", sort: "recent" });
    assert.ok(database.readsOffMain > before, "No read worker answered the search.");
    const { ChannelSearchQueries, channelSearchPlan } = await import("../src/backend/database/channel-search-queries");
    const plan = channelSearchPlan("launch");
    assert.ok(plan);
    const main = new ChannelSearchQueries({ core: database }).search({
      plan,
      channelIds: [channels.launch, channels.dm, channels.market],
      sort: "recent",
      offset: 0,
      limit: 20,
    });
    assert.deepEqual(
      page.hits.map((hit) => hit.messageId),
      main.rows.map((row) => row.message.id),
    );
    assert.equal(page.total, main.total);
    return { workerReads: database.readsOffMain - before };
  });

  await step("a search over 20,000 messages stays fast and reads the index", async () => {
    const database = e2e.host().database;
    const insert = database.connection.prepare("INSERT INTO projection_channel_messages VALUES (?, ?, ?, ?)");
    database.connection.exec("BEGIN");
    for (let index = 0; index < 20_000; index += 1) {
      const id = `bulk-${index}`;
      const sequence = 10_000 + index;
      insert.run(
        channels.launch,
        id,
        sequence,
        JSON.stringify({
          id,
          channelId: channels.launch,
          sequence,
          author: { kind: "agent", id: "worker", name: "Worker" },
          taskId: null,
          superseded: false,
          message: {
            id,
            author: "assistant",
            text: `Report ${index} about ${index % 10 === 0 ? "harbor" : "river"} levels and weather`,
            createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString(),
            status: "completed",
          },
        }),
      );
    }
    database.connection.exec("COMMIT");
    const timings: number[] = [];
    for (const query of ["river", "harbor", "weather levels", "report"]) {
      const started = performance.now();
      const page = await search(member, { query, limit: 20 });
      timings.push(Math.round(performance.now() - started));
      assert.ok(page.total > 0);
    }
    const plan = database.connection
      .prepare(
        `EXPLAIN QUERY PLAN SELECT message.rowid FROM channel_message_search
           JOIN projection_channel_messages message ON message.rowid = channel_message_search.rowid
          WHERE channel_message_search MATCH ?`,
      )
      .all('"river"*')
      .map((row) => String(row.detail));
    assert.ok(plan.join("\n").includes("VIRTUAL TABLE INDEX"), plan.join("\n"));
    assert.ok(Math.max(...timings) < 1_000, `A search took ${Math.max(...timings)} ms.`);
    return { timingsMs: timings, plan };
  });

  await step("a client without fork-host-v1 gets 400; a malformed body gets 400", async () => {
    const old = await e2e.call("POST", WORKSPACE_SEARCH_ROUTES.search, {
      token: member.token,
      body: { query: "launch" },
      capabilities: ["channel-chats-v1"],
    });
    assert.equal(old.status, 400);
    const malformed = await e2e.call("POST", WORKSPACE_SEARCH_ROUTES.search, {
      token: member.token,
      body: { query: "launch", cursor: "abc" },
    });
    assert.equal(malformed.status, 400);
    return { old: old.status, malformed: malformed.status };
  });

  e2e.report.passed = true;
} finally {
  await e2e.finish();
}
