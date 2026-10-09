// @vitest-environment node

import { describe, expect, it } from "vitest";
import { describeServerHealth, type ServerHealthSources } from "./server-health";

function sources(overrides: Partial<ServerHealthSources> = {}): ServerHealthSources {
  return {
    agentInit: () => ({ state: "ok", failure: null }),
    schemaVersion: () => 31,
    restartReadiness: () => ({ safeToRestart: true, reasons: [] }),
    providers: () => [],
    providerRestarts: () => [],
    memoryLevel: () => null,
    startedAt: 1_000_000,
    runState: () => ({ lastShutdown: "clean", startsLast24Hours: 2 }),
    turns: () => ({ running: 0, longestTurnSeconds: 0, longestIdleSeconds: 0, silent: 0 }),
    analyticsEnabled: () => true,
    now: () => 1_000_000 + 90_000,
    ...overrides,
  };
}

describe("describeServerHealth", () => {
  it("is healthy when the agents started and the database answers", () => {
    const health = describeServerHealth(sources());
    expect(health).toMatchObject({ healthy: true, problems: [] });
    expect(health.lines).toMatchObject({
      health: "ok",
      agent_init: "ok",
      schema_version: 31,
      safe_to_restart: "yes",
      busy: null,
      uptime_s: 90,
      last_shutdown: "clean",
      starts_24h: 2,
      analytics: "on",
    });
  });

  it("is not healthy while the agents start, and says so once the start failed", () => {
    expect(describeServerHealth(sources({ agentInit: () => ({ state: "idle", failure: null }) }))).toMatchObject({
      healthy: false,
      problems: ["agent_init_not_ready"],
      lines: { agent_init: "pending" },
    });
    const failed = describeServerHealth(
      sources({ agentInit: () => ({ state: "failed", failure: new Error("The provider could not start.") }) }),
    );
    expect(failed.healthy).toBe(false);
    expect(failed.problems).toEqual(["agent_init_failed"]);
    expect(failed.lines).toMatchObject({ agent_init: "failed", agent_init_message: "The provider could not start." });
  });

  it("keeps a secret out of the failure sentence and keeps it to one short line", () => {
    const secret = "sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789ABCDEF";
    const health = describeServerHealth(
      sources({
        agentInit: () => ({
          state: "failed",
          failure: new Error(`Request failed\nAuthorization: Bearer ${secret}\n${"x".repeat(400)}`),
        }),
      }),
    );
    const message = String(health.lines.agent_init_message);
    expect(message).not.toContain(secret);
    expect(message).not.toMatch(/[\r\n]/u);
    expect(message.length).toBeLessThanOrEqual(201);
  });

  it("reports an unreadable database as a problem", () => {
    expect(describeServerHealth(sources({ schemaVersion: () => null }))).toMatchObject({
      healthy: false,
      problems: ["database_unreadable"],
    });
  });

  it("lists why a restart is not safe, and the providers that wait for a restart", () => {
    const health = describeServerHealth(
      sources({
        restartReadiness: () => ({ safeToRestart: false, reasons: ["agent-turn", "queued-delivery"] }),
        providers: () => [
          { id: "codex", state: "available" },
          { id: "claude", state: "error" },
          { id: "grok", state: "not-installed" },
        ],
        providerRestarts: () => [{ provider: "claude", attempts: 5, nextAttemptAt: 1_000_000 + 90_000 + 60_000 }],
      }),
    );
    expect(health.lines).toMatchObject({
      safe_to_restart: "no",
      busy: "agent-turn,queued-delivery",
      providers: "codex:available,claude:error",
      provider_retry: "claude attempt=5 next_in_s=60",
    });
  });

  it("cannot add a line or a key through a provider name or a reason", () => {
    const health = describeServerHealth(
      sources({
        restartReadiness: () => ({ safeToRestart: false, reasons: ["a\naccount=signed_in"] }),
        providers: () => [{ id: "x\nserver=online", state: "ok" }],
      }),
    );
    expect(health.lines.busy).toBe("a_account_signed_in");
    expect(health.lines.providers).toBe("x_server_online:ok");
  });
});
