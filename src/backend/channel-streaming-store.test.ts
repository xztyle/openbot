// @vitest-environment node
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChannelMessage } from "@openbot/contracts/ipc";
import { afterEach, describe, expect, it } from "vitest";
import { ChannelStore } from "./channel-store";
import { runCauseEffect } from "./effect-boundary";
import { OpenBotDatabase } from "./openbot-database";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function channelStore() {
  const root = await mkdtemp(join(tmpdir(), "openbot-channel-stream-"));
  roots.push(root);
  const database = new OpenBotDatabase(root);
  await runCauseEffect(database.initialize());
  const store = new ChannelStore(database);
  const channel = store.create("channel-1", {
    name: "ops",
    title: "Ops",
    instructions: "",
    members: [{ agentId: "agent-a" }],
    leadAgentId: "agent-a",
  });
  store.commit("create", { channel, messages: [], tasks: [], assignments: [] });
  return { store, database };
}

function reply(text: string, status: "streaming" | "completed"): ChannelMessage {
  return {
    id: "reply-1",
    channelId: "channel-1",
    sequence: 0,
    author: { kind: "agent", id: "agent-a", name: "A" },
    taskId: null,
    superseded: false,
    message: { id: "reply-1", author: "assistant", text, createdAt: "2026-11-21T10:00:00.000Z", status },
  };
}

const channelEvents = (database: OpenBotDatabase) =>
  Number(
    database.connection.prepare("SELECT COUNT(*) AS n FROM orchestration_events WHERE aggregate_type = 'channel'").get()
      ?.n,
  );

// Failure mode: each 100 ms part of a streaming reply appended the whole message to the channel event
// log and published the channel, so every client read the channel list again ten times a second.
describe("channel streaming", () => {
  it("writes a new part of a streaming message without an event or a revision", async () => {
    const { store, database } = await channelStore();
    store.update(store.get("channel-1"), { messages: [reply("He", "streaming")] });
    const revision = store.get("channel-1").revision;
    const events = channelEvents(database);

    expect(store.updateStreaming("channel-1", [reply("Hello", "streaming")])).toBe(true);
    expect(store.message("channel-1", "reply-1")?.message.text).toBe("Hello");
    expect(store.get("channel-1").revision).toBe(revision);
    expect(channelEvents(database)).toBe(events);
    expect(store.takeMessageChanges("channel-1").at(-1)?.message.message.text).toBe("Hello");

    // A message that ends, or one that is new, takes the commit.
    expect(store.updateStreaming("channel-1", [reply("Hello.", "completed")])).toBe(false);
    expect(store.updateStreaming("channel-1", [{ ...reply("New", "streaming"), id: "reply-2" }])).toBe(false);
  });

  it("removes the streamed frames of ended messages from the log, and keeps the first one", async () => {
    const { store, database } = await channelStore();
    for (const text of ["H", "He", "Hel", "Hell"])
      store.update(store.get("channel-1"), { messages: [reply(text, "streaming")] });
    store.update(store.get("channel-1"), { messages: [reply("Hello.", "completed")] });
    const before = channelEvents(database);

    let cursor: number | null = 0;
    let deleted = 0;
    const seen = new Set<string>();
    while (cursor !== null) {
      const result = store.compactStreamedEvents(cursor, 2, seen);
      cursor = result.cursor;
      deleted += result.deleted;
    }

    expect(deleted).toBe(3);
    expect(channelEvents(database)).toBe(before - 3);
    expect(store.message("channel-1", "reply-1")?.message.text).toBe("Hello.");
    store.rebuild("channel-1");
    expect(store.message("channel-1", "reply-1")?.message.text).toBe("Hello.");
  });
});
