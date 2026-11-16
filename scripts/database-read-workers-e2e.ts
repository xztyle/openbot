// Checks the database read workers: worker threads that answer the heavy reads of `openbot.db` (chat
// pages, unread states, message and file search) so the main thread's event loop runs on. A real
// `OpenBotDatabase` on a temporary profile starts real workers from the sources. The check:
//
// - each read that a worker answers equals the same read on the main connection;
// - a read state that needs a cursor write comes back for the main connection to write;
// - a worker sees each write that the main connection committed before the read, and a read inside
//   a main transaction stays on the main connection;
// - the database closes the workers' connections first, so the write-ahead log is removed.
//
// Run: `node --import tsx scripts/database-read-workers-e2e.ts`, as the app runs on Node. Under
// `bun scripts/database-read-workers-e2e.ts` the close check compares with a close without workers,
// because Bun's `node:sqlite` keeps the write-ahead log at a close.
// Writes .openbot-build/database-read-workers-e2e/report.json.

import assert from "node:assert/strict";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { AgentSummary, ConversationMessage, ConversationPageAnchor } from "@openbot/contracts/ipc";
import { AGENT_EXCHANGE_ITEM_TYPE } from "@openbot/contracts/ipc";
import { Effect } from "effect";
import { ConversationReadStore } from "../src/backend/conversation-read-store";
import type { DatabaseReadResults } from "../src/backend/database/database-read-protocol";
import { spawnSourceDatabaseReadWorker } from "../src/backend/database/database-read-worker-source";
import { runCauseEffect } from "../src/backend/effect-boundary";
import { OpenBotDatabase } from "../src/backend/openbot-database";

const OUT = resolve(import.meta.dirname, "../.openbot-build/database-read-workers-e2e");
const MEMBER = "owner";
const at = (minute: number) => new Date(Date.UTC(2026, 10, 16, 10, minute)).toISOString();
const steps: { name: string; ms: number }[] = [];
const roots: string[] = [];

async function step(name: string, run: () => Promise<void>): Promise<void> {
  const start = performance.now();
  await run();
  steps.push({ name, ms: Math.round(performance.now() - start) });
  process.stdout.write(`ok  ${name}\n`);
}

const read = <T>(effect: Effect.Effect<T>) => Effect.runPromise(effect);

try {
  await step("a worker answers each read as the main connection does", async () => {
    const { database, reads, agents } = await seededDatabase();
    database.useReadWorkers(spawnSourceDatabaseReadWorker);
    const [chief, helper] = agents;
    if (!chief?.threadId || !helper?.threadId) throw new Error("The test agents have no thread.");
    const anchors: ConversationPageAnchor[] = [
      { type: "latest" },
      { type: "around", messageId: "m-10" },
      { type: "before", cursor: olderCursor(database, chief, "m-20") },
    ];
    for (const anchor of anchors) {
      const offMain = await workerPage(database, chief.id, chief.threadId, anchor, 8, MEMBER);
      assert.ok(offMain, "The worker answers the page.");
      assert.deepEqual(offMain.page, database.readConversationPage(chief.id, chief.threadId, anchor, 8, {}));
      assert.deepEqual(offMain.readState, reads.readStateForThread(MEMBER, chief.threadId, {}));
    }
    for (const options of [{}, { excludeRoutineEvents: true, excludeHostedSiteEvents: true }]) {
      const states = await read(
        database.readOffMain((reader) =>
          reader.readStates({ kind: "read-states", memberId: MEMBER, threads: threadsOf(agents), options }),
        ),
      );
      assert.deepEqual(states, reads.listStates(MEMBER, agents, options));
    }
    for (const query of ["answer", "Find IT", "user answer m-1", "not in any message"])
      assert.deepEqual(
        await read(
          database.readOffMain((reader) => reader.searchMessages({ kind: "search-messages", query, limit: 5 })),
        ),
        database.searchConversationMessages(query, undefined, undefined, 5),
      );
    assert.deepEqual(
      await read(
        database.readOffMain((reader) =>
          reader.searchMessages({ kind: "search-messages", query: "answer", agentId: helper.id }),
        ),
      ),
      database.searchConversationMessages("answer", helper.id),
    );
    assert.deepEqual(
      await read(database.readOffMain((reader) => reader.searchFiles({ kind: "search-files", query: "" }))),
      database.searchConversationFiles(""),
    );
    database.close();
  });

  await step("a read state that needs a cursor write comes back for the main connection", async () => {
    const { database, agents } = await seededDatabase();
    database.useReadWorkers(spawnSourceDatabaseReadWorker);
    const states = await read(
      database.readOffMain((reader) =>
        reader.readStates({ kind: "read-states", memberId: "new-member", threads: threadsOf(agents), options: {} }),
      ),
    );
    assert.deepEqual(states, { chief: null, helper: null });
    database.close();
  });

  await step("a worker sees each committed write, and a read in a main transaction stays on main", async () => {
    const { database, agents } = await seededDatabase();
    database.useReadWorkers(spawnSourceDatabaseReadWorker);
    const chief = agents[0];
    if (!chief?.threadId) throw new Error("The test agent has no thread.");
    const threadId = chief.threadId;
    const latest = async () =>
      (await workerPage(database, chief.id, threadId, { type: "latest" }, 5, null))?.page.messages.at(-1)?.id;
    assert.equal(await latest(), "m-29");
    const snapshot = database.readConversation(chief.id, chief.threadId);
    database.persistConversation(
      { ...snapshot, messages: [...snapshot.messages, message("m-30", "assistant", "turn-30", 59)] },
      "conversation.test",
    );
    assert.equal(await latest(), "m-30");
    database.connection.exec("BEGIN");
    try {
      assert.equal(
        await read(database.readOffMain((reader) => reader.searchFiles({ kind: "search-files", query: "" }))),
        null,
      );
    } finally {
      database.connection.exec("ROLLBACK");
    }
    database.close();
  });

  await step("the workers close first, so the write-ahead log is removed", async () => {
    // The same close without workers, as a baseline: Bun's `node:sqlite` keeps the log of this database
    // after a close, Node removes it. The app runs on Node (Electron).
    const plain = (await seededDatabase()).database;
    plain.close();
    const removedWithoutWorkers = !existsSync(`${plain.path}-wal`);
    const { database } = await seededDatabase();
    database.useReadWorkers(spawnSourceDatabaseReadWorker, { workers: 2 });
    // Two reads at once start both workers.
    await Promise.all([
      read(database.readOffMain((reader) => reader.searchMessages({ kind: "search-messages", query: "answer" }))),
      read(database.readOffMain((reader) => reader.searchFiles({ kind: "search-files", query: "" }))),
    ]);
    assert.equal(database.readsOffMain, 2);
    const wal = `${database.path}-wal`;
    assert.equal(existsSync(wal), true);
    database.close();
    assert.equal(!existsSync(wal), removedWithoutWorkers, "The workers leave the log as a close without them does.");
    if (!process.versions.bun) assert.equal(existsSync(wal), false, "The last connection removes the log.");
  });

  mkdirSync(OUT, { recursive: true });
  writeFileSync(join(OUT, "report.json"), `${JSON.stringify({ ok: true, runtime: runtime(), steps }, null, 2)}\n`);
  process.stdout.write(`All ${steps.length} checks passed. Report: ${join(OUT, "report.json")}\n`);
} finally {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
}
process.exit(0);

function runtime(): string {
  const bun = process.versions.bun;
  return bun ? `bun ${bun}` : `node ${process.versions.node}`;
}

function workerPage(
  database: OpenBotDatabase,
  agentId: string,
  threadId: string,
  anchor: ConversationPageAnchor,
  limit: number,
  readStateFor: string | null,
): Promise<DatabaseReadResults["conversation-page"] | null> {
  return read(
    database.readOffMain((reader) =>
      reader.conversationPage({
        kind: "conversation-page",
        agentId,
        threadId,
        anchor,
        limit,
        options: {},
        readStateFor,
      }),
    ),
  );
}

function threadsOf(agents: AgentSummary[]) {
  return agents.flatMap((agent) => (agent.threadId ? [{ agentId: agent.id, threadId: agent.threadId }] : []));
}

function message(
  id: string,
  author: ConversationMessage["author"],
  turnId: string,
  minute: number,
): ConversationMessage {
  return { id, turnId, author, text: `${author} answer ${id}`, createdAt: at(minute), status: "completed" };
}

function testAgent(id: string): AgentSummary {
  return {
    id,
    provider: "codex",
    name: id,
    title: "",
    description: "",
    notifications: true,
    model: "gpt-5.6-luna",
    reasoningEffort: "medium",
    threadId: `openbot-thread-${id}`,
    workspacePath: `/tmp/openbot-${id}`,
    preview: "",
    updatedAt: at(0),
    avatarSeed: id,
    avatarHue: null,
    avatarUrl: null,
  };
}

/** Two agents: one long chat with a read cursor in the middle, and one with talk between agents. */
async function seededDatabase() {
  const root = await mkdtemp(join(tmpdir(), "openbot-read-workers-"));
  roots.push(root);
  const database = new OpenBotDatabase(root);
  await runCauseEffect(database.initialize());
  const agents = [testAgent("chief"), testAgent("helper")];
  database.replaceAgents("agents-import", agents, "agents.imported");
  const [chief, helper] = agents;
  if (!chief?.threadId || !helper?.threadId) throw new Error("The test agents have no thread.");
  database.persistConversation(
    {
      agentId: chief.id,
      threadId: chief.threadId,
      activeTurnId: null,
      revision: 0,
      messages: Array.from({ length: 30 }, (_, index) =>
        message(`m-${index}`, index % 2 === 0 ? "user" : "assistant", `turn-${Math.floor(index / 2)}`, index),
      ),
    },
    "conversation.test",
  );
  database.persistConversation(
    {
      agentId: helper.id,
      threadId: helper.threadId,
      activeTurnId: null,
      revision: 0,
      messages: [
        {
          id: "request",
          turnId: "asked-by-agent",
          author: "agent",
          itemType: AGENT_EXCHANGE_ITEM_TYPE,
          text: "request",
          createdAt: at(1),
          status: "completed",
          exchange: {
            direction: "incoming",
            messageId: "exchange-request",
            senderAgentId: chief.id,
            recipientAgentIds: [helper.id],
            replyToMessageId: null,
            deliveries: [],
          },
        },
        message("helper-answer", "assistant", "asked-by-agent", 2),
        { ...message("person", "user", "person-turn", 3), text: "Find it" },
        message("helper-person-answer", "assistant", "person-turn", 4),
      ],
    },
    "conversation.test",
  );
  const reads = new ConversationReadStore(database);
  // A cursor in the middle of the long chat, and one at the start of the other.
  reads.markReadForThread(MEMBER, chief.threadId, "m-11");
  reads.readStateForThread(MEMBER, helper.threadId);
  return { database, reads, agents };
}

function olderCursor(database: OpenBotDatabase, agent: AgentSummary, messageId: string): string {
  const page = database.readConversationPage(agent.id, agent.threadId, { type: "around", messageId }, 4);
  if (!page.pageInfo.olderCursor) throw new Error("The page has no older cursor.");
  return page.pageInfo.olderCursor;
}
