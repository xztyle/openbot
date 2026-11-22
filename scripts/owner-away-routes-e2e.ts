// Checks the owner-away routes (`owner-away-v1`, under `fork-host-v1`) on a real Team API host
// (`workspace-e2e-host.ts`) with the real away service on the host profile, through the frozen codecs:
//
// - The owner reads the state: the default quiet hours (23:00 to 08:00, the server zone) and an empty
//   held list. A member gets 403, and a client without `fork-host-v1` gets nothing.
// - Settings save and come back; a time zone the host does not know is refused with 400.
// - Focus starts and ends.
// - A held request shows in the state; an answer reaches the agent once, and a second answer is a 409.
// - The first `active` after a time away answers with what waited, once. An admin's `active` reads the
//   state only: it does not mark the owner back.
// - The state survives a restart of the host.
//
// `bun scripts/owner-away-routes-e2e.ts`. Writes .openbot-build/owner-away-routes-e2e/report.json.
import assert from "node:assert/strict";
import { join } from "node:path";
import { OWNER_AWAY_CODECS, OWNER_AWAY_ROUTES } from "@openbot/contracts/team-protocol/owner-away-v1";
import { runCauseEffect } from "../src/backend/effect-boundary";
import { OwnerAwayService } from "../src/backend/owner-away";
import { type JsonObject, type Person, record, startWorkspaceE2e } from "./workspace-e2e-host";

const delivered: { agentId: string; text: string }[] = [];
let away: OwnerAwayService | null = null;
let clock = Date.parse("2026-11-22T11:00:00Z");

const e2e = await startWorkspaceE2e(
  "owner-away-routes-e2e",
  [
    "The WebRTC transport of the web client. It carries the same requests to the same route handler that this check calls over loopback HTTP.",
    "The tool calls of a provider turn: the script holds requests on the service, as hold_for_owner does.",
    "The web push of the summaries: owner-away-e2e.ts checks it with the real push sender.",
  ],
  {
    server: async ({ userData }) => {
      await away?.stop();
      away = new OwnerAwayService({
        file: join(userData, "openbot-owner-away-v1.json"),
        serverTimezone: () => "Europe/Madrid",
        deliver: (agentId, text) => delivered.push({ agentId, text }),
        push: () => undefined,
        alert: () => undefined,
        now: () => clock,
      });
      return { ownerAway: away };
    },
  },
);
const { owner, member, step } = e2e;
const service = () => {
  assert.ok(away, "The away service did not start.");
  return away;
};

async function route(path: string, person: Person, body: JsonObject = {}) {
  return e2e.optional(OWNER_AWAY_CODECS, path, person.token, body);
}

function heldOf(read: JsonObject): JsonObject[] {
  assert.ok(Array.isArray(read.held), "The state has no held list.");
  return read.held.map((item) => record(item, "held"));
}

async function state(person: Person = owner): Promise<JsonObject> {
  const response = await route(OWNER_AWAY_ROUTES.state, person);
  assert.equal(response.status, 200, JSON.stringify(response.body));
  return record(response.body, "state");
}

await step("The owner reads the default state; a member and an older client cannot", async () => {
  const read = await state();
  const settings = record(read.settings, "settings");
  assert.deepEqual(settings.quietHours, { enabled: true, start: "23:00", end: "08:00", timeZone: null });
  assert.equal(read.systemTimezone, "Europe/Madrid");
  assert.deepEqual(read.held, []);
  assert.equal(read.quiet, null, "Noon is not quiet.");
  assert.equal((await route(OWNER_AWAY_ROUTES.state, member)).status, 403);
  const older = await e2e.call("POST", OWNER_AWAY_ROUTES.state, { token: owner.token, body: {}, capabilities: [] });
  assert.ok(older.status >= 400, `A client without fork-host-v1 got ${older.status}.`);
  return read;
});

await step("Settings save; an unknown zone is refused", async () => {
  const settings = {
    quietHours: { enabled: true, start: "22:30", end: "07:30", timeZone: "Europe/Paris" },
    urgentMoneyUsd: 250,
    heldDeliverAt: "18:00",
  };
  const saved = await route(OWNER_AWAY_ROUTES.settings, owner, { settings });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  assert.deepEqual(record(saved.body, "state").settings, settings);
  const refused = await route(OWNER_AWAY_ROUTES.settings, owner, {
    settings: { ...settings, quietHours: { ...settings.quietHours, timeZone: "Mars/Olympus" } },
  });
  assert.equal(refused.status, 400);
  assert.deepEqual((await state()).settings, settings);
});

await step("Focus starts and ends", async () => {
  const on = record((await route(OWNER_AWAY_ROUTES.focus, owner, { until: clock + 3_600_000 })).body, "state");
  assert.deepEqual(on.quiet, { kind: "focus", until: clock + 3_600_000 });
  const off = record((await route(OWNER_AWAY_ROUTES.focus, owner, { until: null })).body, "state");
  assert.equal(off.quiet, null);
  assert.equal(off.focusUntil, null);
});

await step("A held request shows, its answer reaches the agent once", async () => {
  const item = service().hold({
    agentId: "agent-e2e",
    kind: "question",
    title: "Which headline goes first?",
    options: ["A", "B"],
  });
  const held = heldOf(await state());
  assert.equal(held.length, 1);
  assert.equal(held[0]?.title, "Which headline goes first?");
  assert.equal((await route(OWNER_AWAY_ROUTES.answer, member, { id: item.id, choice: "A" })).status, 403);
  const answered = await route(OWNER_AWAY_ROUTES.answer, owner, { id: item.id, choice: "B" });
  assert.equal(answered.status, 200, JSON.stringify(answered.body));
  assert.deepEqual(record(answered.body, "state").held, []);
  assert.equal(delivered.length, 1);
  assert.match(delivered[0]?.text ?? "", /Which headline goes first\?.*B$/u);
  assert.equal((await route(OWNER_AWAY_ROUTES.answer, owner, { id: item.id, choice: "B" })).status, 409);
});

await step("Coming back after a time away shows what waited, once", async () => {
  service().hold({ agentId: "agent-e2e", kind: "fyi", title: "The landing is live" });
  clock += 60 * 60_000;
  // An admin's open app is not the owner coming back: the held request stays unseen for the owner.
  await runCauseEffect(e2e.host().team.updateMember(member.id, { role: "admin" }));
  const admin = record((await route(OWNER_AWAY_ROUTES.active, member)).body, "state");
  assert.equal(admin.welcome, undefined);
  assert.equal(heldOf(admin)[0]?.seen, false, "An admin's app marked the owner's held request seen.");
  assert.equal(service().activeNow(), false, "An admin's app marked the owner active.");
  await runCauseEffect(e2e.host().team.updateMember(member.id, { role: "member" }));
  const back = record((await route(OWNER_AWAY_ROUTES.active, owner)).body, "state");
  assert.deepEqual(back.welcome, { held: 1, suppressed: 0 });
  const again = record((await route(OWNER_AWAY_ROUTES.active, owner)).body, "state");
  assert.equal(again.welcome, undefined);
});

await step("The state survives a restart", async () => {
  await service().stop();
  await e2e.restart();
  const read = await state();
  assert.equal(record(read.settings, "settings").urgentMoneyUsd, 250);
  assert.equal(heldOf(read).length, 1);
});

await e2e.finish();
