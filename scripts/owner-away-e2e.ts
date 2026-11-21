// Checks the owner's quiet hours, focus and "When you're back" list with the real away service, the
// real web push sender and its store, and a push service that the script plays.
//
// - The quiet window: 23:00 to 08:00 runs over midnight, in the zone of the settings, and says when it
//   ends; 09:00 to 17:00 is a day window; a window that starts where it ends is none.
// - In quiet hours a push to the owner waits and counts once for the summary; another member's push
//   and an urgent alert go. At the end of the quiet time one notice sums them up, with the held count.
// - Focus mode is quiet until its end, also outside quiet hours; off ends it.
// - A held question, approval, takeover and FYI: the answer goes to the agent as one message, an FYI
//   that is only read sends none, a second answer is refused, and an agent holds at most 20.
// - The owner coming back after a time away gets the bundle once: the held items count as seen.
// - `heldDeliverAt` pushes the unseen held items once a day, and never while the owner is active.
// - The turn note names the quiet time and its end, and is empty while the owner can be reached.
//
// `bun scripts/owner-away-e2e.ts`.
import assert from "node:assert/strict";
import { createECDH, randomBytes, randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentEvent, AgentSummary } from "@openbot/contracts/ipc";
import { type OwnerAwayNotice, OwnerAwayService, OwnerHoldRefused, quietWindow } from "../src/backend/owner-away";
import { WebPushService } from "../src/main/web-push";
import { WebPushStore } from "../src/main/web-push-store";

const directory = mkdtempSync(join(tmpdir(), "owner-away-e2e-"));
const ZONE = "Europe/Madrid";
// 2026-11-21 23:30 in Madrid (UTC+1).
const NIGHT = Date.parse("2026-11-21T22:30:00Z");
const MORNING = Date.parse("2026-11-22T07:01:00Z");
const NOON = Date.parse("2026-11-22T11:00:00Z");

// The quiet window.
{
  const night = quietWindow(NIGHT, "23:00", "08:00", ZONE);
  assert.equal(night?.quiet, true);
  assert.equal(night?.until, Date.parse("2026-11-22T07:00:00Z"), "Quiet hours end at 08:00 Madrid time.");
  assert.equal(quietWindow(NOON, "23:00", "08:00", ZONE)?.quiet, false);
  assert.equal(quietWindow(NOON, "09:00", "17:00", ZONE)?.quiet, true);
  assert.equal(quietWindow(NOON, "09:00", "09:00", ZONE), null);
}

let now = NIGHT;
const delivered: { agentId: string; text: string; key: string }[] = [];
const summaries: OwnerAwayNotice[] = [];
const away = new OwnerAwayService({
  file: join(directory, "owner-away.json"),
  serverTimezone: () => ZONE,
  deliver: (agentId, text, key) => delivered.push({ agentId, text, key }),
  push: (notice) => summaries.push(notice),
  alert: () => undefined,
  now: () => now,
});

// The push sender, with the away gate, and two browsers: the owner's and a member's.
// Only what the notice reads of an agent: its id, its name and its notification switch.
const fixtureAgents: AgentSummary[] = JSON.parse(
  JSON.stringify(["agent-a", "agent-b"].map((id) => ({ id, name: id.toUpperCase(), notifications: true }))),
);
const agents = Object.assign(new EventEmitter(), {
  listAgents: (): AgentSummary[] => [],
});
const store = new WebPushStore(join(directory, "web-push.json"));
const sent: { endpoint: string; urgency: string }[] = [];
const pushService: typeof fetch = Object.assign(
  async (input: string | URL | Request, init?: RequestInit) => {
    const endpoint = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    sent.push({ endpoint, urgency: new Headers(init?.headers).get("urgency") ?? "" });
    return new Response(null, { status: 201 });
  },
  { preconnect: fetch.preconnect },
);
const push = new WebPushService({
  agents: {
    on: (event, listener) => agents.on(event, listener),
    off: (event, listener) => agents.off(event, listener),
    listAgents: () => agents.listAgents(),
  },
  store,
  hostId: () => "host-e2e",
  memberActive: () => true,
  hiddenAgentIds: () => new Set(),
  away: { appliesTo: (memberId) => memberId === "owner", allowPush: (key, urgent) => away.allowPush(key, urgent) },
  fetch: pushService,
  now: () => now,
});
function browser(memberId: string): string {
  const ecdh = createECDH("prime256v1");
  ecdh.generateKeys();
  const endpoint = `https://fcm.googleapis.com/fcm/send/owner-away-${memberId}-${randomUUID()}`;
  push.register(memberId, 7, {
    endpoint,
    p256dh: ecdh.getPublicKey().toString("base64url"),
    auth: randomBytes(16).toString("base64url"),
    level: "all",
    mutedUntil: null,
    locale: "en",
  });
  return endpoint;
}
const owner = browser("owner");
const member = browser("member");
const settle = () => push.dispose().then(() => undefined);
const finished = (agentId: string): AgentEvent => ({
  type: "turn-completed",
  agentId,
  threadId: `thread-${agentId}`,
  turnId: randomUUID(),
  status: "completed",
});

// Quiet hours hold the owner's pushes and count each notice once.
agents.listAgents = () => fixtureAgents;
agents.emit("event", finished("agent-a"));
agents.emit("event", finished("agent-b"));
await new Promise((resolve) => setTimeout(resolve, 20));
assert.deepEqual(
  sent.map((entry) => entry.endpoint),
  [member, member],
  "In quiet hours only the member's browser got the two notices.",
);
assert.equal(away.state().suppressed.count, 2, "Two notices waited for the summary.");
assert.equal(away.state().quiet?.kind, "quiet-hours");
push.notifyOwner({
  kind: "alert",
  agentId: "agent-a",
  view: "agent",
  urgent: true,
  text: () => ({ title: "A", body: "Outage." }),
});
await new Promise((resolve) => setTimeout(resolve, 20));
assert.equal(sent.at(-1)?.endpoint, owner, "An urgent alert reached the owner in quiet hours.");
assert.equal(sent.at(-1)?.urgency, "high");
assert.equal(away.urgentAlert("money", 50), false, "$50 is under the default $100 limit.");
assert.equal(away.urgentAlert("money", -250), true, "A loss of $250 is urgent.");
assert.equal(away.urgentAlert("outage"), true);

// The turn note while quiet.
{
  const note = away.turnNote();
  assert.ok(note?.includes("quiet hours until 08:00 (Europe/Madrid)"), note ?? "no note");
  assert.ok(note?.includes("openbot.hold_for_owner"));
}

// Held requests, and their answers.
{
  const question = away.hold({
    agentId: "agent-a",
    kind: "question",
    title: "Launch the ad at €20/day?",
    options: ["Yes", "€10/day"],
  });
  const again = away.hold({ agentId: "agent-a", kind: "question", title: "Launch the ad at €20/day?" });
  assert.equal(again.id, question.id, "The same request again is the one held.");
  const approval = away.hold({ agentId: "agent-b", kind: "approval", title: "Delete the old landing" });
  const fyi = away.hold({ agentId: "agent-b", kind: "fyi", title: "Sales are up 12% this week" });
  const takeover = away.hold({
    agentId: "agent-a",
    kind: "takeover",
    title: "Verify the Meta business",
    url: "https://business.facebook.com/",
  });
  assert.equal(away.state().held.length, 4);
  away.answer({ id: question.id, choice: "€10/day" });
  away.answer({ id: approval.id, decision: "decline", text: "Keep it until December." });
  away.answer({ id: fyi.id, decision: "dismiss" });
  away.answer({ id: takeover.id, decision: "done" });
  assert.deepEqual(
    delivered.map((entry) => entry.agentId),
    ["agent-a", "agent-b", "agent-a"],
    "The FYI that was only read sent nothing.",
  );
  assert.match(delivered[0]?.text ?? "", /€10\/day/u);
  assert.match(delivered[1]?.text ?? "", /^Declined: .*Keep it until December\.$/u);
  assert.match(delivered[2]?.text ?? "", /^Done: /u);
  assert.throws(() => away.answer({ id: question.id, choice: "Yes" }), /already answered/u);
  assert.throws(() => away.answer({ id: away.hold({ agentId: "agent-c", kind: "question", title: "Q" }).id }));
  for (let index = 0; index < 19; index += 1) away.hold({ agentId: "agent-c", kind: "fyi", title: `Note ${index}` });
  assert.throws(() => away.hold({ agentId: "agent-c", kind: "fyi", title: "One more" }), OwnerHoldRefused);
  for (const item of away.state().held) away.answer({ id: item.id, decision: "dismiss" });
  delivered.length = 0;
}

// Focus mode.
now = NOON;
assert.equal(away.quietNow(), null);
away.setFocus(NOON + 60 * 60_000);
assert.equal(away.quietNow()?.kind, "focus");
assert.ok(away.turnNote()?.includes("in focus mode until 13:00"));
away.setFocus(null);
assert.equal(away.quietNow(), null);
assert.deepEqual(
  summaries.splice(0),
  [{ kind: "away-digest", count: 2, held: 0, agentId: null }],
  "The end of focus sums up the two notices of the night.",
);
assert.equal(away.turnNote(), null, "No note while the owner can be reached.");
now = NIGHT;

// The end of the quiet time sums up what waited, with the held count.
now = NIGHT + 60_000;
agents.emit("event", finished("agent-b"));
await new Promise((resolve) => setTimeout(resolve, 20));
away.hold({ agentId: "agent-a", kind: "question", title: "Which hero image?" });
away.tick();
now = MORNING;
away.tick();
assert.deepEqual(summaries, [{ kind: "away-digest", count: 1, held: 1, agentId: "agent-a" }]);
assert.equal(away.state().suppressed.count, 0);
away.tick();
assert.equal(summaries.length, 1, "The summary goes once.");

// The owner comes back: the bundle shows once.
{
  const back = away.noteActive();
  assert.deepEqual(back.welcome, { held: 1, suppressed: 0 });
  assert.ok(back.held.every((item) => item.seen));
  assert.equal(away.noteActive().welcome, undefined, "The bundle shows once.");
}

// A chosen time pushes the unseen held items once a day, not while the owner is active.
away.setSettings({ ...away.state().settings, heldDeliverAt: "18:00" });
away.hold({ agentId: "agent-b", kind: "approval", title: "Raise the budget to €40" });
now = Date.parse("2026-11-22T17:05:00Z");
away.tick();
assert.equal(summaries.at(-1)?.kind, "held-bundle");
assert.equal(summaries.at(-1)?.count, 1);
away.tick();
assert.equal(summaries.length, 2, "Once a day.");
away.hold({ agentId: "agent-b", kind: "fyi", title: "Done with the copy" });
now = Date.parse("2026-11-23T17:00:30Z");
away.noteActive();
away.hold({ agentId: "agent-b", kind: "fyi", title: "One more thing" });
away.tick();
assert.equal(summaries.length, 2, "Not while the owner uses the app.");

// The state survives a restart.
{
  await away.stop();
  const saved = JSON.parse(readFileSync(join(directory, "owner-away.json"), "utf8"));
  assert.equal(saved.settings.heldDeliverAt, "18:00");
  const again = new OwnerAwayService({
    file: join(directory, "owner-away.json"),
    serverTimezone: () => ZONE,
    deliver: () => undefined,
    push: () => undefined,
    alert: () => undefined,
    now: () => now,
  });
  assert.equal(again.state().held.length, away.state().held.length);
  assert.equal(again.state().settings.quietHours.start, "23:00");
}

await settle();
rmSync(directory, { recursive: true, force: true });
process.stdout.write("owner-away-e2e: ok\n");
