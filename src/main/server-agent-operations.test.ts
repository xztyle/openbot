import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { QueuedMessageReceipt, SendMessageInput, SystemNoticeKind } from "@openbot/contracts/ipc";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { createServerAgentOperations, RESTART_INTERRUPTION_REASON, RESUME_NOTE } from "./server-agent-operations";

function database() {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE projection_mailbox_messages (message_id TEXT PRIMARY KEY, message_json TEXT NOT NULL);
    CREATE TABLE projection_deliveries (
      delivery_id TEXT PRIMARY KEY, message_id TEXT NOT NULL, recipient_agent_id TEXT NOT NULL,
      status TEXT NOT NULL, turn_id TEXT, error TEXT, created_at TEXT NOT NULL, last_event_sequence INTEGER NOT NULL
    );
    CREATE TABLE projection_turns (turn_id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, status TEXT NOT NULL, started_at TEXT NOT NULL);
  `);
  let sequence = 0;
  return {
    db,
    delivery(input: {
      id: string;
      agentId: string;
      status?: string;
      error?: string | null;
      createdAt: string;
      turn?: { id: string; thread: string; status: string; startedAt?: string };
      message?: { channelId?: string; taskId?: string };
    }) {
      sequence += 1;
      db.prepare("INSERT INTO projection_mailbox_messages VALUES (?, ?)").run(
        `message-${input.id}`,
        JSON.stringify({ id: `message-${input.id}`, ...input.message }),
      );
      db.prepare("INSERT INTO projection_deliveries VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(
        input.id,
        `message-${input.id}`,
        input.agentId,
        input.status ?? "interrupted",
        input.turn?.id ?? null,
        input.error === undefined ? RESTART_INTERRUPTION_REASON : input.error,
        input.createdAt,
        sequence,
      );
      if (input.turn)
        db.prepare("INSERT INTO projection_turns VALUES (?, ?, ?, ?)").run(
          input.turn.id,
          input.turn.thread,
          input.turn.status,
          input.turn.startedAt ?? input.createdAt,
        );
    },
  };
}

function operations(db: DatabaseSync, restarted: readonly string[] = [], agents = ["agent-a", "agent-b", "agent-c"]) {
  const sent: Array<SendMessageInput & { notice?: SystemNoticeKind }> = [];
  const logs: string[] = [];
  const markerFile = join(mkdtempSync(join(tmpdir(), "openbot-resume-")), "resumes.json");
  const route = createServerAgentOperations({
    restartInterrupted: () => new Set(restarted),
    database: () => db,
    agentIds: () => agents,
    send: (input, notice) =>
      Effect.sync((): QueuedMessageReceipt => {
        sent.push(notice ? { ...input, notice } : input);
        return {
          messageId: `m-${sent.length}`,
          deliveries: [{ id: `d-${sent.length}`, recipientAgentId: input.agentId, status: "running", position: null }],
        };
      }),
    markerFile,
    log: (line) => logs.push(line),
  }).route;
  return { route, sent, logs, markerFile };
}

describe("operator message", () => {
  it("sends the text to the agent's own chat and reports the delivery", async () => {
    const { db } = database();
    const { route, sent } = operations(db);
    const answer = await route("POST", "/v1/agents/agent-a/message", JSON.stringify({ text: " hello " }));
    expect(answer?.status).toBe(200);
    expect(answer?.lines).toMatchObject({ agent: "agent-a", delivery_id: "d-1", delivery_status: "running" });
    expect(sent).toEqual([{ agentId: "agent-a", text: "hello" }]);
  });

  it("sends the text as a note from OpenBot only when the caller asks for it", async () => {
    const { db } = database();
    const { route, sent } = operations(db);
    await route("POST", "/v1/agents/agent-a/message", JSON.stringify({ text: "check", system: true }));
    await route("POST", "/v1/agents/agent-b/message", "text=check&system=1");
    await route("POST", "/v1/agents/agent-c/message", JSON.stringify({ text: "check", system: "yes" }));
    expect(sent).toEqual([
      { agentId: "agent-a", text: "check", notice: "operator-note" },
      { agentId: "agent-b", text: "check", notice: "operator-note" },
      { agentId: "agent-c", text: "check" },
    ]);
  });

  it("takes form fields and refuses an empty text, a long one and an unknown agent", async () => {
    const { db } = database();
    const { route, sent } = operations(db);
    expect((await route("POST", "/v1/agents/agent-b/message", "text=hi&client_message_id=c1"))?.status).toBe(200);
    expect(sent[0]).toEqual({ agentId: "agent-b", text: "hi", clientMessageId: "c1" });
    expect((await route("POST", "/v1/agents/agent-a/message", "{}"))?.lines.error).toBe("text_required");
    expect((await route("POST", "/v1/agents/agent-a/message", `text=${"x".repeat(100_001)}`))?.status).toBe(413);
    expect((await route("POST", "/v1/agents/nobody/message", "text=hi"))?.status).toBe(404);
    expect((await route("GET", "/v1/agents/agent-a/message", ""))?.status).toBe(405);
    expect(sent).toHaveLength(1);
  });

  it("leaves other routes to the control socket", async () => {
    const { db } = database();
    expect(await operations(db).route("GET", "/v1/status", "")).toBeNull();
  });
});

describe("resume after a restart", () => {
  it("sends the note once to each agent whose own chat a restart cut off", async () => {
    const data = database();
    // Cut off by this restart, and still the agent's last work.
    data.delivery({
      id: "a-old",
      agentId: "agent-a",
      createdAt: "2026-11-16T11:00:00.000Z",
      turn: { id: "t-a-old", thread: "thread-a", status: "interrupted" },
    });
    data.delivery({
      id: "a-new",
      agentId: "agent-a",
      createdAt: "2026-11-16T11:50:00.000Z",
      turn: { id: "t-a-new", thread: "thread-a", status: "interrupted" },
    });
    // Worked after the restart: a later message reached it.
    data.delivery({
      id: "b-cut",
      agentId: "agent-b",
      createdAt: "2026-11-16T11:55:00.000Z",
      turn: { id: "t-b", thread: "thread-b", status: "interrupted" },
    });
    data.delivery({
      id: "b-later",
      agentId: "agent-b",
      status: "completed",
      error: null,
      createdAt: "2026-11-16T12:01:00.000Z",
    });
    // Recovery found its turn completed after all.
    data.delivery({
      id: "c-cut",
      agentId: "agent-c",
      createdAt: "2026-11-16T11:58:00.000Z",
      turn: { id: "t-c", thread: "thread-c", status: "completed" },
    });
    const { route, sent, logs, markerFile } = operations(data.db, ["a-old", "a-new", "b-cut", "c-cut"]);

    const first = await route("POST", "/v1/resume-interrupted", "");
    expect(first?.lines).toMatchObject({ found: 3, resumed: 1, newer_work: 1, turn_not_interrupted: 1 });
    expect(sent).toEqual([
      { agentId: "agent-a", text: RESUME_NOTE, clientMessageId: "restart-resume:a-new", notice: "restart-resume" },
    ]);
    expect(JSON.parse(readFileSync(markerFile, "utf8"))).toEqual({ resumed: ["a-new"] });
    expect(logs.some((line) => line.includes("a-new: resumed"))).toBe(true);

    const second = await route("POST", "/v1/resume-interrupted", "");
    expect(second?.lines).toMatchObject({ found: 3, already_resumed: 1 });
    expect(sent).toHaveLength(1);
  });

  it("ignores cut-offs that this restart did not make, other failures and other threads", async () => {
    const data = database();
    data.delivery({
      id: "earlier-run",
      agentId: "agent-a",
      createdAt: "2026-11-15T10:00:00.000Z",
      turn: { id: "t1", thread: "thread-a", status: "interrupted" },
    });
    data.delivery({
      id: "provider-error",
      agentId: "agent-b",
      error: "The provider failed.",
      createdAt: "2026-11-16T11:00:00.000Z",
      turn: { id: "t2", thread: "thread-b", status: "interrupted" },
    });
    data.delivery({
      id: "channel",
      agentId: "agent-c",
      createdAt: "2026-11-16T11:00:00.000Z",
      message: { channelId: "channel-1" },
      turn: { id: "t3", thread: "thread-channel", status: "interrupted" },
    });
    const { route, sent } = operations(data.db, ["provider-error", "channel"]);
    expect((await route("POST", "/v1/resume-interrupted", ""))?.lines).toMatchObject({ found: 0 });
    expect(sent).toHaveLength(0);
  });

  it("takes the deliveries that the deploy recorded, and a dry run sends nothing", async () => {
    const data = database();
    data.delivery({
      id: "recorded",
      agentId: "agent-a",
      createdAt: "2026-11-15T10:00:00.000Z",
      turn: { id: "t1", thread: "thread-a", status: "interrupted" },
    });
    const { route, sent } = operations(data.db);
    const dry = await route(
      "POST",
      "/v1/resume-interrupted",
      JSON.stringify({ deliveryIds: ["recorded"], dryRun: true }),
    );
    expect(dry?.lines).toMatchObject({ dry_run: "yes", found: 1, would_resume: 1 });
    expect(sent).toHaveLength(0);
    const real = await route("POST", "/v1/resume-interrupted", "delivery=recorded&text=Go+on");
    expect(real?.lines).toMatchObject({ resumed: 1 });
    expect(sent).toEqual([
      { agentId: "agent-a", text: "Go on", clientMessageId: "restart-resume:recorded", notice: "restart-resume" },
    ]);
  });
});

// Failure mode: after each deploy the coordinator sent a resume note by hand to every agent whose
// turn the restart cut off, and the deploy cut off turns that were about to end.
describe("restart without an operator", () => {
  it("resumes the cut-off turns of this start once, by itself", async () => {
    const data = database();
    data.delivery({
      id: "a-cut",
      agentId: "agent-a",
      createdAt: "2026-11-16T12:00:00.000Z",
      turn: { id: "t-a", thread: "thread-a", status: "interrupted" },
    });
    const sent: SendMessageInput[] = [];
    const operations = createServerAgentOperations({
      restartInterrupted: () => new Set(["a-cut"]),
      database: () => data.db,
      agentIds: () => ["agent-a"],
      send: (input) =>
        Effect.sync((): QueuedMessageReceipt => {
          sent.push(input);
          return { messageId: "m", deliveries: [] };
        }),
      markerFile: join(mkdtempSync(join(tmpdir(), "openbot-resume-")), "resumes.json"),
      log: () => {},
    });

    await operations.resumeAfterRestart();
    await operations.resumeAfterRestart();

    expect(sent.map((input) => input.clientMessageId)).toEqual(["restart-resume:a-cut"]);
  });

  it("drains for a deploy with a bounded wait, and cancels the hold", async () => {
    const waits: number[] = [];
    let cancelled = 0;
    const { route } = createServerAgentOperations({
      restartInterrupted: () => new Set(),
      database: () => database().db,
      agentIds: () => [],
      send: () => Effect.die("unused"),
      markerFile: join(mkdtempSync(join(tmpdir(), "openbot-resume-")), "resumes.json"),
      log: () => {},
      drain: async (timeoutMs) => {
        waits.push(timeoutMs);
        return timeoutMs > 0 ? [] : [{ turnId: "t-1", agentId: "agent-a" }];
      },
      endDrain: () => {
        cancelled += 1;
      },
    });

    expect((await route("POST", "/v1/drain", "timeout=5000"))?.lines).toMatchObject({ drained: "yes", running: 0 });
    expect((await route("POST", "/v1/drain", '{"timeout":0}'))?.lines).toMatchObject({
      drained: "no",
      turn1: "agent-a t-1",
    });
    expect(waits).toEqual([1_800_000, 0]);
    expect((await route("POST", "/v1/drain/cancel", ""))?.lines).toEqual({ drain: "cancelled" });
    expect(cancelled).toBe(1);
  });
});
