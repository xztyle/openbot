// Checks the kept message digests and the shared event copies of a chat (`delivery-content.ts`):
//
// - a kept digest follows each change of a message's own fields, and a message whose nested parts
//   change in place (a question prompt, a block, subagents, a plan, an image) is never kept;
// - an event copy equals a deep copy of the message, is frozen, and does not change when the live
//   message changes after the event;
// - under load, every kept digest and every shared copy equals a fresh one: the load harness runs
//   real agent turns (stand-in Claude CLI, mailbox, queue, crash and recovery) on a seeded profile
//   with `--verify-copies`, which throws on the first difference.
//
// Run: `node --import tsx scripts/conversation-event-copies-e2e.ts`.
// Writes .openbot-build/conversation-event-copies-e2e/report.json.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { AgentSummary, ConversationMessage } from "@openbot/contracts/ipc";
import { messageDigest, publishedMessage } from "../src/backend/agent/delivery-content";
import { ConversationReadStore } from "../src/backend/conversation-read-store";
import { runCauseEffect } from "../src/backend/effect-boundary";
import { OpenBotDatabase } from "../src/backend/openbot-database";

const ROOT = resolve(import.meta.dirname, "..");
const OUT = join(ROOT, ".openbot-build/conversation-event-copies-e2e");
const steps: { name: string; detail?: unknown }[] = [];
const at = (minute: number) => new Date(Date.UTC(2026, 10, 16, 10, minute)).toISOString();

function step(name: string, run: () => unknown): void {
  const detail = run();
  steps.push({ name, ...(detail === undefined ? {} : { detail }) });
  process.stdout.write(`ok  ${name}\n`);
}

const message = (id: string, text = `text of ${id}`): ConversationMessage => ({
  id,
  turnId: "turn-1",
  author: "assistant",
  text,
  createdAt: at(1),
  status: "completed",
});

step("a kept digest follows each change of the message's own fields", () => {
  const live = message("m-1");
  const first = messageDigest(live);
  assert.equal(messageDigest(live), first, "An unchanged message keeps its digest.");
  live.text = "changed text";
  const changed = messageDigest(live);
  assert.notEqual(changed.signature, first.signature);
  live.reactions = [];
  const withReactions = messageDigest(live);
  assert.notEqual(withReactions.signature, changed.signature);
  delete live.reactions;
  assert.equal(messageDigest(live).signature, changed.signature);
  live.delivery = { id: "d-1", status: "queued", position: 1 };
  const queued = messageDigest(live);
  live.delivery = { id: "d-1", status: "completed", position: null };
  assert.notEqual(messageDigest(live).signature, queued.signature, "A replaced nested part is a change.");
});

step("a message whose nested parts change in place is never kept", () => {
  const prompt: ConversationMessage = {
    ...message("m-2"),
    itemType: "question_prompt",
    questionPrompt: {
      requestId: "r-1",
      questions: [{ id: "q-1", header: "Pick", question: "Which?", isSecret: false, options: null }],
      resolution: null,
    },
  };
  const before = messageDigest(prompt);
  if (!prompt.questionPrompt) throw new Error("The test message has no prompt.");
  prompt.questionPrompt.resolution = { status: "expired" };
  assert.notEqual(messageDigest(prompt).signature, before.signature);
  const streaming: ConversationMessage = { ...message("m-3"), status: "streaming" };
  const streamed = messageDigest(streaming);
  streaming.text += " more";
  assert.notEqual(messageDigest(streaming).signature, streamed.signature);
});

step("an event copy equals a deep copy, is frozen, and keeps its content after a change", () => {
  const live: ConversationMessage = {
    ...message("m-4"),
    attachments: [
      {
        id: "a-1",
        name: "notes.md",
        size: 12,
        kind: "file",
        mimeType: "text/markdown",
        previewKind: "text",
        previewUrl: null,
      },
    ],
  };
  messageDigest(live);
  const copy = publishedMessage(live);
  assert.deepStrictEqual(copy, structuredClone(live));
  assert.notEqual(copy, live);
  assert.equal(Object.isFrozen(copy), true);
  assert.equal(Object.isFrozen(copy.attachments), true);
  assert.equal(publishedMessage(live), copy, "Events share the copy of an unchanged message.");
  live.text = "after the event";
  assert.equal(copy.text, "text of m-4");
  const next = publishedMessage(live);
  assert.notEqual(next, copy);
  assert.equal(next.text, "after the event");
  const streaming: ConversationMessage = { ...message("m-5"), status: "streaming" };
  const own = publishedMessage(streaming);
  assert.equal(Object.isFrozen(own), false, "A message that changes in place gets a copy of its own.");
  assert.deepStrictEqual(own, structuredClone(streaming));
});

const root = await mkdtemp(join(tmpdir(), "openbot-event-copies-"));
try {
  const userData = join(root, "profile");
  mkdirSync(userData, { recursive: true });
  const database = new OpenBotDatabase(userData);
  await runCauseEffect(database.initialize());
  const agents = Array.from({ length: 4 }, (_, index) => agent(`agent-${index}`));
  database.replaceAgents("seed", agents, "agents.imported");
  for (const seeded of agents) {
    if (!seeded.threadId) continue;
    database.persistConversation(
      {
        agentId: seeded.id,
        threadId: seeded.threadId,
        activeTurnId: null,
        revision: 0,
        messages: Array.from({ length: 120 }, (_, index) => ({
          id: `${seeded.id}-m-${index}`,
          turnId: `${seeded.id}-t-${index >> 1}`,
          author: index % 2 ? ("assistant" as const) : ("user" as const),
          text: `message ${index} `.repeat(40),
          createdAt: at(index % 60),
          status: "completed" as const,
        })),
      },
      "conversation.seeded",
    );
    new ConversationReadStore(database).markReadForThread("owner", seeded.threadId, `${seeded.id}-m-100`);
  }
  database.close();

  step("under load, every kept digest and shared copy equals a fresh one", () => {
    const label = "conversation-event-copies-e2e";
    const run = spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        "scripts/server-load-perf.ts",
        `--db=${join(userData, "openbot.db")}`,
        `--tmp=${root}`,
        "--agents=4",
        "--seconds=24",
        "--crash-at=12",
        "--transcript-mb=4",
        "--clients=2",
        "--verify-copies",
        `--label=${label}`,
      ],
      { cwd: ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
    );
    assert.equal(run.status, 0, `The load run failed:\n${run.stderr.slice(-4000)}\n${run.stdout.slice(-4000)}`);
    assert.doesNotMatch(run.stdout + run.stderr, /differs from/);
    const result = JSON.parse(readFileSync(join(ROOT, ".openbot-build/server-load-perf", `${label}.json`), "utf8"));
    assert.deepEqual(result.problems, []);
    assert.ok(result.completedTurns > 0, "Turns completed.");
    assert.ok(result.verifiedCopies.digests > 0 && result.verifiedCopies.copies > 0, "The run compared kept copies.");
    return { completedTurns: result.completedTurns, verified: result.verifiedCopies, events: result.events };
  });

  mkdirSync(OUT, { recursive: true });
  writeFileSync(join(OUT, "report.json"), `${JSON.stringify({ ok: true, steps }, null, 2)}\n`);
  process.stdout.write(`All ${steps.length} checks passed. Report: ${join(OUT, "report.json")}\n`);
} finally {
  await rm(root, { recursive: true, force: true });
}

function agent(id: string): AgentSummary {
  return {
    id,
    provider: "claude",
    name: id,
    title: "",
    description: "",
    notifications: true,
    model: "claude-haiku-5-5",
    reasoningEffort: "medium",
    threadId: `openbot-thread-${id}`,
    workspacePath: join(root, "workspaces", id),
    preview: "",
    updatedAt: at(0),
    avatarSeed: id,
    avatarHue: null,
    avatarUrl: null,
  };
}
