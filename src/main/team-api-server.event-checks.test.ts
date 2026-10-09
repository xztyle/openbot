// @vitest-environment node
import type { TeamProtocolV2Json } from "@openbot/contracts/team-protocol/v2";
import { Effect, Scope } from "effect";
import { afterEach, expect, it } from "vitest";
import { runCauseEffect } from "../backend/effect-boundary";
import { EventCheckScheduler } from "../backend/event-check-scheduler";
import { EventCheckStore } from "../backend/event-check-store";
import { OpenBotDatabase } from "../backend/openbot-database";
import { RoutineTimer } from "../backend/routine-timer";
import { createTeamApiFixture, stopTeamApiFixtures } from "./team-api-server-test-harness";

afterEach(stopTeamApiFixtures);
it("requires administrator login and negotiated capability and round-trips settings and private execution history", async () => {
  const fixture = await createTeamApiFixture("event-checks", { configure: true });
  const database = new OpenBotDatabase(fixture.root);
  await runCauseEffect(database.initialize());
  const checks = new EventCheckScheduler({
    store: new EventCheckStore(database),
    scope: () => Scope.makeUnsafe(),
    timer: new RoutineTimer(
      () => [],
      () => false,
      () => {},
    ),
    agentExists: (id) => id === "chief",
    running: () => true,
    reader: {
      accounts: () => [{ id: "linear", name: "Linear" }],
      read: (_agent, _connection, use) =>
        use({
          valid: () => true,
          tools: [{ name: "read", description: "Read", inputSchemaJson: "{}" }],
          call: () => Effect.succeed({ structuredContent: { items: [] } }),
        }),
    },
    deliver: () => Effect.die("Empty checks must not deliver."),
  });
  const { base } = await fixture.start({ eventChecks: checks });
  const owner = await fixture.signIn();
  const invite = await runCauseEffect(fixture.store.createInvite("member"));
  const member = await runCauseEffect(fixture.store.acceptInvite(invite.token, "member", "member password"));
  const headers = {
    Authorization: `Bearer ${owner}`,
    "OpenBot-Protocol-Version": "3",
    "OpenBot-Capabilities": "event-checks-v1",
    "Content-Type": "application/json",
  };
  const send = (path: string, body: TeamProtocolV2Json, overrides: Record<string, string> = {}) =>
    fetch(`${base}/v1/event-checks/${path}`, {
      method: "POST",
      headers: { ...headers, ...overrides },
      body: JSON.stringify(body),
    });
  try {
    for (const path of ["save", "check-now", "history", "accounts", "tools", "remove", "list"]) {
      expect((await send(path, {}, { Authorization: "Bearer invalid" })).status).toBe(401);
      expect((await send(path, {}, { Authorization: `Bearer ${member.sessionToken}` })).status).toBe(403);
      expect((await send(path, {}, { "OpenBot-Capabilities": "" })).status).toBe(400);
    }
    const definition = {
      agentId: "chief",
      name: "Linear tickets",
      instruction: "Read new tickets",
      active: true,
      timezone: "UTC",
      schedule: { kind: "interval", amount: 1, unit: "minutes", anchorAt: new Date().toISOString() },
      source: {
        kind: "mcp",
        connectionId: "linear",
        toolName: "read",
        argumentsJson: "{}",
        cursorArgument: "",
        nextCursorPointer: "",
      },
      selection: { itemsPointer: "/items", idPointer: "/id", revisionPointer: "" },
    };
    expect((await send("save", { ...definition, source: { ...definition.source, argumentsJson: "[]" } })).status).toBe(
      400,
    );
    const saved = await send("save", definition);
    expect(saved.status).toBe(200);
    const check = await saved.json();
    const target = { agentId: "chief", id: check.id };
    expect(await (await send("check-now", target)).json()).toMatchObject({ status: "baseline", eventCount: 0 });
    expect(await (await send("history", target)).json()).toMatchObject([{ status: "baseline" }]);
    expect(await (await send("list", { agentId: "chief" })).json()).toMatchObject([{ name: definition.name }]);
    expect((await send("remove", target)).status).toBe(200);
    expect(await (await send("list", { agentId: "chief" })).json()).toEqual([]);
  } finally {
    database.close();
  }
});
