// @vitest-environment node
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runCauseEffect } from "./effect-boundary";
import { OpenBotDatabase } from "./openbot-database";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

// Failure mode: the cost of a wake that rewrote the whole prompt cache, and of a quiet routine run,
// could only be found by parsing the provider transcripts by hand.
describe("usage turn notes", () => {
  it("groups the cost of the noted turns by what started them and why they wrote the cache", async () => {
    const root = await mkdtemp(join(tmpdir(), "openbot-turn-notes-"));
    roots.push(root);
    const database = new OpenBotDatabase(root);
    await runCauseEffect(database.initialize());
    const at = "2026-11-21T10:00:00.000Z";
    database.usage.noteTurn({
      agentId: "a",
      turnId: "t-1",
      turnKind: "agent",
      cacheWriteReason: "cache-expired",
      contextTokens: 228_000,
      occurredAt: at,
    });
    database.usage.noteTurn({
      agentId: "a",
      turnId: "t-2",
      turnKind: "owner",
      cacheWriteReason: "warm",
      contextTokens: 230_000,
      occurredAt: at,
    });
    const insert = database.connection.prepare(
      "INSERT INTO agent_usage_records VALUES (?, ?, 's', ?, 'claude', 'claude-sonnet-5-5', ?, ?, ?, 'test', ?)",
    );
    insert.run(
      "a",
      "r-1",
      "t-1",
      at,
      JSON.stringify({ uncachedInput: 0, cachedInput: 0, cacheCreation: 228_000, output: 100 }),
      0.9,
      at,
    );
    insert.run(
      "a",
      "r-2",
      "t-2",
      at,
      JSON.stringify({ uncachedInput: 0, cachedInput: 230_000, cacheCreation: 2_000, output: 100 }),
      0.03,
      at,
    );

    expect(database.usage.turnNoteCosts("2026-11-20T00:00:00.000Z")).toEqual([
      { turnKind: "agent", cacheWriteReason: "cache-expired", turns: 1, costUsd: 0.9, cacheWriteTokens: 228_000 },
      { turnKind: "owner", cacheWriteReason: "warm", turns: 1, costUsd: 0.03, cacheWriteTokens: 2_000 },
    ]);
    database.close();
  });
});
