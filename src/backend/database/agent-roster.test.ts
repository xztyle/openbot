// @vitest-environment node
// Failure modes: a roster write that leaves a half-written roster, a pruned event that was the only
// record of who changed a model, and a receipt that is removed while another event still uses it.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentSummary } from "@openbot/contracts/ipc";
import { afterEach, describe, expect, it } from "vitest";
import { runCauseEffect } from "../effect-boundary";
import { OpenBotDatabase } from "../openbot-database";

const roots: string[] = [];
const databases: OpenBotDatabase[] = [];

afterEach(async () => {
  for (const database of databases.splice(0)) database.close();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function createDatabase(): Promise<OpenBotDatabase> {
  const root = await mkdtemp(join(tmpdir(), "openbot-roster-"));
  roots.push(root);
  const database = new OpenBotDatabase(root);
  databases.push(database);
  await runCauseEffect(database.initialize());
  return database;
}

function agent(id: string, preview = "0"): AgentSummary {
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
    preview,
    updatedAt: "2026-08-18T10:00:01.000Z",
    avatarSeed: id,
    avatarHue: null,
    avatarUrl: null,
  };
}

function rosterEvents(database: OpenBotDatabase): { sequence: number; commandId: string; eventType: string }[] {
  return database.connection
    .prepare(
      `SELECT sequence, command_id, event_type FROM orchestration_events
       WHERE aggregate_type = 'agents' AND aggregate_id = 'agents' ORDER BY sequence`,
    )
    .all()
    .map((row) => ({
      sequence: Number(row.sequence),
      commandId: String(row.command_id),
      eventType: String(row.event_type),
    }));
}

function hasReceipt(database: OpenBotDatabase, commandId: string): boolean {
  return (
    database.connection.prepare("SELECT 1 FROM orchestration_command_receipts WHERE command_id = ?").get(commandId) !==
    undefined
  );
}

describe("AgentRoster.replaceAgents", () => {
  it("keeps only the newest roster event and drops the receipts of the ones it replaced", async () => {
    const database = await createDatabase();
    for (let index = 0; index < 5; index++)
      database.replaceAgents(`write-${index}`, [agent("chief", String(index)), agent("scout")], "agent.updated");

    expect(rosterEvents(database).map((event) => event.commandId)).toEqual(["write-4"]);
    for (let index = 0; index < 4; index++) expect(hasReceipt(database, `write-${index}`)).toBe(false);
    expect(hasReceipt(database, "write-4")).toBe(true);
    expect(database.listAgents().map((entry) => [entry.id, entry.preview])).toEqual([
      ["chief", "4"],
      ["scout", "0"],
    ]);
    expect(database.latestRosterAgents()).toEqual([
      expect.objectContaining({ id: "chief", preview: "4" }),
      expect.objectContaining({ id: "scout" }),
    ]);
  });

  it("keeps the audit entry of a model change and the events of other aggregates", async () => {
    const database = await createDatabase();
    const previous = { provider: "codex", model: "gpt-5.6-luna", reasoningEffort: "medium" } as const;
    const next = { provider: "codex", model: "gpt-5.6-terra", reasoningEffort: "medium" } as const;
    database.replaceAgents("first", [agent("chief"), agent("scout")], "agent.updated");
    database.replaceAgents(
      "change",
      [agent("chief"), { ...agent("scout"), model: next.model }],
      "agent.model-changed",
      {
        initiatingAgentId: "chief",
        targetAgentId: "scout",
        previous,
        next,
      },
    );
    database.dispatch(
      "other",
      [{ aggregateType: "agent-usage", aggregateId: "scout", eventType: "usage.recorded", payload: {} }],
      () => null,
    );
    database.replaceAgents("third", [agent("chief"), agent("scout")], "agent.updated");
    database.replaceAgents("fourth", [agent("chief", "4"), agent("scout")], "agent.updated");

    expect(rosterEvents(database).map((event) => event.commandId)).toEqual(["change", "fourth"]);
    expect(hasReceipt(database, "change")).toBe(true);
    expect(hasReceipt(database, "other")).toBe(true);
    const audit = database.connection
      .prepare("SELECT payload_json FROM orchestration_events WHERE event_type = 'agent.model-changed'")
      .all();
    expect(audit.map((row) => JSON.parse(String(row.payload_json)).modelChange)).toEqual([
      { initiatingAgentId: "chief", targetAgentId: "scout", previous, next },
    ]);
    expect(database.latestRosterAgents()).toHaveLength(2);
  });

  it("keeps the receipt of a command that still has an event outside the roster", async () => {
    const database = await createDatabase();
    // One command wrote a roster event and an event of another aggregate: only the first is pruned.
    database.dispatch(
      "shared",
      [
        { aggregateType: "agents", aggregateId: "agents", eventType: "agent.updated", payload: { agents: [] } },
        { aggregateType: "agent-usage", aggregateId: "scout", eventType: "usage.recorded", payload: {} },
      ],
      () => null,
    );
    database.replaceAgents("later", [agent("chief")], "agent.updated");

    expect(rosterEvents(database).map((event) => event.commandId)).toEqual(["later"]);
    expect(hasReceipt(database, "shared")).toBe(true);
    expect(
      database.connection.prepare("SELECT 1 FROM orchestration_events WHERE command_id = 'shared'").get(),
    ).toBeDefined();
  });

  it("shrinks a large backlog over several writes and never removes the newest event", async () => {
    const database = await createDatabase();
    const insert = database.connection.prepare(
      `INSERT INTO orchestration_events
         (event_id, command_id, aggregate_type, aggregate_id, event_type, occurred_at, payload_json)
       VALUES (?, ?, 'agents', 'agents', 'agent.updated', ?, ?)`,
    );
    const receipt = database.connection.prepare(
      `INSERT INTO orchestration_command_receipts (command_id, accepted_at, first_sequence, last_sequence, result_json)
       VALUES (?, ?, 0, 0, 'null')`,
    );
    const at = "2026-08-18T10:00:00.000Z";
    for (let index = 0; index < 200; index++) {
      insert.run(`event-${index}`, `old-${index}`, at, JSON.stringify({ agents: [agent("chief")] }));
      receipt.run(`old-${index}`, at);
    }

    database.replaceAgents("current-0", [agent("chief", "0")], "agent.updated");
    const afterFirst = rosterEvents(database).length;
    // One write must not rewrite the whole backlog, and must add its own event.
    expect(afterFirst).toBeGreaterThan(1);
    expect(afterFirst).toBeLessThan(201);

    let previous = afterFirst;
    for (let index = 1; index < 10 && rosterEvents(database).length > 1; index++) {
      database.replaceAgents(`current-${index}`, [agent("chief", String(index))], "agent.updated");
      const count = rosterEvents(database).length;
      expect(count).toBeLessThan(previous);
      previous = count;
    }
    const remaining = rosterEvents(database);
    expect(remaining).toHaveLength(1);
    expect(database.latestRosterAgents()).toEqual([expect.objectContaining({ id: "chief" })]);
    expect(database.connection.prepare("SELECT COUNT(*) AS count FROM orchestration_command_receipts").get()).toEqual(
      expect.objectContaining({ count: 1 }),
    );
  });

  it("leaves the old roster, its events and its receipts when the write fails", async () => {
    const database = await createDatabase();
    database.replaceAgents("kept-1", [agent("chief", "1"), agent("scout")], "agent.updated");
    database.replaceAgents("kept-2", [agent("chief", "2"), agent("scout")], "agent.updated");
    const eventsBefore = rosterEvents(database);

    // A duplicate id fails the insert after the delete, the new event and the pruning have run.
    expect(() =>
      database.replaceAgents("failing", [agent("chief", "3"), agent("chief", "4")], "agent.updated"),
    ).toThrow();

    expect(rosterEvents(database)).toEqual(eventsBefore);
    expect(hasReceipt(database, "failing")).toBe(false);
    expect(hasReceipt(database, "kept-2")).toBe(true);
    expect(database.connection.isTransaction).toBe(false);
    expect(database.listAgents().map((entry) => [entry.id, entry.preview])).toEqual([
      ["chief", "2"],
      ["scout", "0"],
    ]);
    expect(database.latestRosterAgents()).toEqual([
      expect.objectContaining({ id: "chief", preview: "2" }),
      expect.objectContaining({ id: "scout" }),
    ]);
  });
});

describe("AgentRoster.getAgent", () => {
  it("reads one agent by id, so a streamed flush never parses the rest of the roster", async () => {
    const database = await createDatabase();
    database.replaceAgents("seed", [agent("chief"), agent("scout")], "agent.updated");
    // A row that is not an agent would break a search through the whole roster. The write below must not read it.
    database.connection.prepare("UPDATE projection_agents SET agent_json = ? WHERE agent_id = ?").run("null", "scout");
    expect(database.listAgents()).toContain(null);

    const snapshot = {
      agentId: "chief",
      threadId: "openbot-thread-chief",
      activeTurnId: "turn-1",
      revision: 0,
      messages: [
        {
          id: "streamed",
          author: "agent" as const,
          text: "Partial answer",
          status: "streaming" as const,
          createdAt: "2026-08-18T10:00:02.000Z",
        },
      ],
    };
    expect(() =>
      database.persistStreamingMessage({ snapshot, messageId: "streamed", eventType: "message.streamed" }),
    ).not.toThrow();
    expect(database.connection.prepare("SELECT COUNT(*) AS count FROM projection_thread_messages").get()).toEqual(
      expect.objectContaining({ count: 1 }),
    );
    // An unknown agent is still refused, as it was with the whole-roster read.
    expect(() =>
      database.persistStreamingMessage({
        snapshot: { ...snapshot, agentId: "ghost", threadId: "openbot-thread-ghost" },
        messageId: "streamed",
        eventType: "message.streamed",
      }),
    ).toThrow("Unknown agent for conversation: ghost");
  });
});
