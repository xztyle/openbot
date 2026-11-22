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

function streamed(text: string): ChannelMessage {
  return {
    id: "answer:1",
    channelId: "launch",
    sequence: 0,
    author: { kind: "agent", id: "agent-1", name: "Writer" },
    taskId: null,
    superseded: false,
    message: { id: "answer:1", author: "assistant", text, createdAt: "2026-11-21T10:00:00.000Z", status: "streaming" },
  };
}

// Each delta of a member turn wrote an event with the whole message, so the log grew with the square
// of the message length (upstream #5392).
describe("a streaming channel message", () => {
  it("keeps the first and the newest event of the message, and the newest text", async () => {
    const root = await mkdtemp(join(tmpdir(), "openbot-channel-capture-"));
    roots.push(root);
    const database = new OpenBotDatabase(root);
    await runCauseEffect(database.initialize());
    const store = new ChannelStore(database);
    const channel = store.update(
      store.create("launch", { name: "launch", title: "", instructions: "", members: [], leadAgentId: null }),
    );
    let text = "";
    for (let step = 0; step < 6; step += 1) {
      text += `part ${step} `;
      store.captureMessage(store.get("launch"), streamed(text));
    }
    const events = database.connection
      .prepare("SELECT command_id FROM orchestration_events WHERE command_id LIKE 'channels:capture:%'")
      .all();
    expect(events).toHaveLength(2);
    expect(store.messages(channel.id).find((message) => message.id === "answer:1")?.message.text).toBe(text);
  });
});
