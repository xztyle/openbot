// @vitest-environment node
// Failure modes: missing login/capability, member secret access, raw secret responses, v1 widening.
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { decodeEventCheck, type EventCheckInput } from "@openbot/contracts/event-checks";
import { Effect, Scope } from "effect";
import { afterEach, expect, it } from "vitest";
import { runCauseEffect } from "../backend/effect-boundary";
import { EventCheckApiReader } from "../backend/event-check-api-reader";
import { EventCheckEnvironment } from "../backend/event-check-environment";
import { EventCheckScheduler } from "../backend/event-check-scheduler";
import { EventCheckStore } from "../backend/event-check-store";
import { OpenBotDatabase } from "../backend/openbot-database";
import { RoutineTimer } from "../backend/routine-timer";
import { createTeamApiFixture, stopTeamApiFixtures } from "./team-api-server-test-harness";

afterEach(stopTeamApiFixtures);
it("protects private variable writes and preserves MCP-only v1 through the real host routes", async () => {
  const fixture = await createTeamApiFixture("api-checks", { configure: true });
  const database = new OpenBotDatabase(fixture.root);
  await runCauseEffect(database.initialize());
  const store = new EventCheckStore(database),
    programs = join(fixture.root, "programs");
  await mkdir(programs);
  await writeFile(join(programs, "read.mjs"), `process.stdout.write('{"items":[],"hasNextPage":false}');`);
  const environment = new EventCheckEnvironment(join(fixture.root, "env"), {
    encrypt: (value) => Buffer.from(value).toString("base64"),
    decrypt: (value) => Buffer.from(value, "base64").toString("utf8"),
  });
  const checks = new EventCheckScheduler({
    store,
    scope: () => Scope.makeUnsafe(),
    timer: new RoutineTimer(
      () => [],
      () => false,
      () => {},
    ),
    agentExists: (id) => id === "chief",
    running: () => true,
    apiReader: new EventCheckApiReader(
      environment,
      programs,
      (check) => store.current(check.id, check.revision) !== null,
      process.execPath,
    ),
    reader: {
      accounts: () => [],
      read: (_agent, _account, use) =>
        use({
          valid: () => true,
          tools: [{ name: "read", description: "Read", inputSchemaJson: "{}" }],
          call: () => Effect.succeed({ structuredContent: { items: [] } }),
        }),
    },
    deliver: () => Effect.die("Quiet tests must not deliver."),
  });
  const { base } = await fixture.start({ eventChecks: checks }),
    owner = await fixture.signIn();
  const invite = await runCauseEffect(fixture.store.createInvite("member"));
  const member = await runCauseEffect(fixture.store.acceptInvite(invite.token, "member", "member password"));
  const send = (path: string, body: unknown, token = owner, capability = "event-check-api-v1") =>
    fetch(`${base}/v1/${path}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "OpenBot-Protocol-Version": "3",
        "OpenBot-Capabilities": capability,
      },
      body: JSON.stringify(body),
    });
  try {
    for (const path of ["list", "save", "environment", "set-environment", "test", "remove", "history"]) {
      expect((await send(`event-check-api/${path}`, {}, "invalid")).status).toBe(401);
      expect((await send(`event-check-api/${path}`, {}, member.sessionToken)).status).toBe(403);
      expect((await send(`event-check-api/${path}`, {}, owner, "")).status).toBe(400);
    }
    const definition: EventCheckInput = {
      agentId: "chief",
      name: "API check",
      instruction: "Only meaningful changes",
      active: false,
      timezone: "UTC",
      schedule: { kind: "interval", amount: 30, unit: "seconds", anchorAt: new Date().toISOString() },
      selfEvents: { mode: "include", connectionId: "", actorPointer: "", accountActorIds: [] },
      source: {
        kind: "api",
        connectionId: "job-one",
        toolName: "read.mjs",
        variables: ["LINEAR_API_TOKEN"],
        configuration: [],
        argumentsJson: "{}",
        cursorArgument: "cursor",
        nextCursorPointer: "/cursor",
      },
      selection: { itemsPointer: "/items", idPointer: "/id", revisionPointer: "/revision" },
    };
    const check = decodeEventCheck(await (await send("event-check-api/save", definition)).json()),
      target = { agentId: "chief", id: check.id };
    const token = "fixture-private-token";
    const reply = await send("event-check-api/set-environment", { ...target, name: "LINEAR_API_TOKEN", value: token });
    expect(reply.status).toBe(200);
    expect(await reply.json()).toEqual([{ name: "LINEAR_API_TOKEN", configured: true }]);
    for (const path of ["list", "environment", "history"])
      expect(
        await (await send(`event-check-api/${path}`, path === "list" ? { agentId: "chief" } : target)).text(),
      ).not.toContain(token);
    expect(await (await send("event-checks/list", { agentId: "chief" }, owner, "event-checks-v1")).json()).toEqual([]);
    expect((await send("event-checks/save", definition, owner, "event-checks-v1")).status).toBe(400);
    expect(await (await send("event-check-api/test", target)).json()).toMatchObject({
      status: "baseline",
      eventCount: 0,
    });
    expect(store.state(check.id).baseline).toBeNull();
    expect((await send("event-check-api/remove", target)).status).toBe(200);
  } finally {
    database.close();
  }
});
