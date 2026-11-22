// Checks that a streaming channel message keeps two events, not one per update (upstream #5392).
// Runs the real ChannelStore on a temporary SQLite database. Before, each delta of a member turn
// wrote a full copy of the message to the event history, which grew with the square of its length.
// `bun scripts/channel-stream-capture-e2e.ts`. Writes .openbot-build/channel-stream-capture-e2e/report.json.
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { ChannelMessage } from "@openbot/contracts/ipc";
import { ChannelStore } from "../src/backend/channel-store";
import { runCauseEffect } from "../src/backend/effect-boundary";
import { OpenBotDatabase } from "../src/backend/openbot-database";

const OUT = resolve(import.meta.dirname, "../.openbot-build/channel-stream-capture-e2e");
const root = await mkdtemp(join(tmpdir(), "openbot-channel-capture-"));
const report: {
  updates: number;
  events: number;
  receipts: number;
  text: string | null;
  passed: boolean;
  error?: string;
} = {
  updates: 0,
  events: 0,
  receipts: 0,
  text: null,
  passed: false,
};

const streamed = (text: string): ChannelMessage => ({
  id: "answer:1",
  channelId: "launch",
  sequence: 0,
  author: { kind: "agent", id: "agent-1", name: "Writer" },
  taskId: null,
  superseded: false,
  message: { id: "answer:1", author: "assistant", text, createdAt: "2026-11-21T10:00:00.000Z", status: "streaming" },
});

const database = new OpenBotDatabase(root);
try {
  await runCauseEffect(database.initialize());
  const store = new ChannelStore(database);
  store.update(store.create("launch", { name: "launch", title: "", instructions: "", members: [], leadAgentId: null }));
  let text = "";
  for (let step = 0; step < 12; step += 1) {
    text += `part ${step} `;
    store.captureMessage(store.get("launch"), streamed(text));
    report.updates += 1;
  }
  const count = (sql: string) => Number(database.connection.prepare(sql).get()?.count ?? -1);
  report.events = count(
    "SELECT COUNT(*) AS count FROM orchestration_events WHERE command_id LIKE 'channels:capture:%'",
  );
  report.receipts = count(
    "SELECT COUNT(*) AS count FROM orchestration_command_receipts WHERE command_id LIKE 'channels:capture:%'",
  );
  report.text = store.messages("launch").find((message) => message.id === "answer:1")?.message.text ?? null;
  assert.equal(report.events, 2, "the first and the newest event of the message stay");
  assert.equal(report.receipts, 2, "the receipts of the removed events go with them");
  assert.equal(report.text, text, "the projection holds the newest text");
  report.passed = true;
} catch (error) {
  report.error = error instanceof Error ? (error.stack ?? error.message) : String(error);
  process.exitCode = 1;
} finally {
  database.close();
  await rm(root, { recursive: true, force: true });
  mkdirSync(OUT, { recursive: true });
  writeFileSync(join(OUT, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`${report.passed ? "PASS" : "FAIL"} ${join(OUT, "report.json")}\n`);
}
