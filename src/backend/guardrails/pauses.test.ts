// @vitest-environment node
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_GUARDRAIL_POLICY, type GuardrailPause } from "@openbot/contracts/guardrails";
import { Effect } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import { isOwnerWork, MailboxStore } from "../mailbox-store";
import { GuardrailEventLog } from "./guardrail-event-log";
import { type GuardrailAgent, type GuardrailsRuntime, GuardrailsService } from "./guardrails-service";

const NOW = Date.UTC(2026, 10, 26, 18, 0, 0);
const UNTIL = new Date(NOW + 6 * 3_600_000).toISOString();

const CSO: GuardrailAgent = { id: "agent-cso", name: "CSO", provider: "claude", model: "opus", threadId: "t-cso" };
const LEAD: GuardrailAgent = { id: "agent-lead", name: "Lead", provider: "claude", model: "opus", threadId: "t-lead" };
const OTHER: GuardrailAgent = { id: "agent-other", name: "Other", provider: "codex", model: "x", threadId: "t-o" };

const SPACE_PAUSE: GuardrailPause = {
  scope: "space",
  id: "space-uni",
  reason: "turns",
  since: new Date(NOW - 3_600_000).toISOString(),
  until: UNTIL,
  detail: "2046 of 1000 turns today",
};
const AGENT_PAUSE: GuardrailPause = { ...SPACE_PAUSE, scope: "agent", id: LEAD.id, detail: "416 of 200 turns today" };

describe("the guardrails pauses", () => {
  let directory: string | null = null;
  let service: GuardrailsService | null = null;

  afterEach(() => {
    service?.dispose();
    if (directory) rmSync(directory, { recursive: true, force: true });
    service = null;
    directory = null;
  });

  /** A service with the live host's two pauses, CSO and Lead in the paused space. */
  function start(policy = DEFAULT_GUARDRAIL_POLICY, pauses = [SPACE_PAUSE, AGENT_PAUSE]) {
    directory = mkdtempSync(join(tmpdir(), "guardrails-pauses-"));
    const file = join(directory, "guardrails-v1.json");
    writeFileSync(file, JSON.stringify({ version: 1, policy, pauses, warned: [], resumed: [], failovers: [] }));
    const drained: string[] = [];
    const created = new GuardrailsService({
      file,
      events: new GuardrailEventLog(join(directory, "events")),
      now: () => NOW,
    });
    const runtime: GuardrailsRuntime = {
      agents: () => [CSO, LEAD, OTHER],
      spaceOf: (agentId) => (agentId === OTHER.id ? "space-other" : "space-uni"),
      dailyTotals: () => [],
      turnTotals: () => null,
      costsSince: () => new Map(),
      meterAccounts: () => [],
      agentAccount: () => null,
      turnTask: () => [],
      steer: () => Effect.succeed(false),
      interrupt: () => Effect.void,
      scheduleDrain: (agentId) => {
        drained.push(agentId);
      },
      generateCheap: () => Effect.succeed(""),
      notifyOwner: () => undefined,
      alertOwner: () => undefined,
      noteAgent: () => undefined,
      recordTrust: () => undefined,
      failoverTargets: () => [],
      changed: () => undefined,
    };
    created.connect(runtime);
    drained.length = 0;
    service = created;
    return { service: created, drained };
  }

  it("holds the agents' own work of a paused space while the guardrails are on", () => {
    const { service } = start();
    expect(service.holdsAgentWork(CSO.id)).toBe(true);
    expect(service.holdsAgentWork(LEAD.id)).toBe(true);
    expect(service.holdsAgentWork(OTHER.id)).toBe(false);
    expect(service.view().pauses).toHaveLength(2);
  });

  it("holds nothing while the guardrails are off, even with pauses stored", () => {
    const { service } = start({ ...DEFAULT_GUARDRAIL_POLICY, enabled: false });
    expect(service.pauseFor(CSO.id)).toBeNull();
    expect(service.holdsAgentWork(LEAD.id)).toBe(false);
    expect(service.view().pauses).toEqual([]);
  });

  it("drains every held agent at once when the owner turns the guardrails off", async () => {
    const { service, drained } = start();
    await Effect.runPromise(service.savePolicy({ ...service.policy(), enabled: false }));
    expect(new Set(drained)).toEqual(new Set([CSO.id, LEAD.id]));
    expect(service.holdsAgentWork(CSO.id)).toBe(false);
  });

  it("lets a loop pause go and drains it when the stuck watch is turned off", async () => {
    const loop: GuardrailPause = { ...AGENT_PAUSE, id: OTHER.id, reason: "loop", detail: "loop" };
    const { service, drained } = start(DEFAULT_GUARDRAIL_POLICY, [loop]);
    expect(service.holdsAgentWork(OTHER.id)).toBe(true);
    await Effect.runPromise(
      service.savePolicy({ ...service.policy(), stuck: { ...service.policy().stuck, enabled: false } }),
    );
    expect(drained).toEqual([OTHER.id]);
    expect(service.holdsAgentWork(OTHER.id)).toBe(false);
  });

  it("drains the agents of a pause that the owner resumes", () => {
    const { service, drained } = start();
    service.resume("space", SPACE_PAUSE.id, "Owner");
    expect(new Set(drained)).toEqual(new Set([CSO.id, LEAD.id]));
    expect(service.holdsAgentWork(CSO.id)).toBe(false);
    // The agent pause of the Lead still holds it.
    expect(service.holdsAgentWork(LEAD.id)).toBe(true);
  });
});

describe("the owner's work under a pause", () => {
  it("is the owner's and the operator's messages, never a Motion wake, an email or an agent", () => {
    expect(isOwnerWork({ sender: { kind: "user" } })).toBe(true);
    expect(isOwnerWork({ sender: { kind: "user" }, notice: "operator-note" })).toBe(true);
    expect(isOwnerWork({ sender: { kind: "user" }, notice: "motion-event" })).toBe(false);
    expect(isOwnerWork({ sender: { kind: "user" }, notice: "inbound-email" })).toBe(false);
    expect(isOwnerWork({ sender: { kind: "user" }, notice: "restart-resume" })).toBe(false);
    expect(isOwnerWork({ sender: { kind: "agent" } })).toBe(false);
    expect(isOwnerWork({ sender: { kind: "routine" } })).toBe(false);
  });
});

describe("the queue of a paused agent", () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  async function mailbox() {
    const root = mkdtempSync(join(tmpdir(), "guardrails-queue-"));
    roots.push(root);
    const store = new MailboxStore(join(root, "data"), join(root, "shared"));
    await Effect.runPromise(store.initialize());
    return store;
  }

  // Failure mode (2026-11-26): a routine at the head of the CSO's queue held the owner's message
  // behind it under a turn-cap pause, with no word in the chat.
  it("starts the owner's message ahead of the held work, and holds the agents' own work", async () => {
    const store = await mailbox();
    const routine = {
      kind: "routine" as const,
      routineId: "routine-report",
      runId: "run-1",
      routineName: "Report",
      scheduledFor: "2026-11-26T17:30:00.000Z",
    };
    await Effect.runPromise(store.enqueue({ sender: routine, recipientAgentIds: [CSO.id], text: "Write the report." }));
    await Effect.runPromise(
      store.enqueue({
        sender: { kind: "agent", agentId: LEAD.id },
        recipientAgentIds: [CSO.id],
        text: "Review COC-66.",
      }),
    );
    await Effect.runPromise(
      store.enqueue({
        sender: { kind: "user" },
        recipientAgentIds: [CSO.id],
        text: "Motion · COC-66 asked you to review.",
        notice: "motion-event",
      }),
    );

    // Paused, with only the agents' own work queued: nothing starts.
    expect(store.nextQueued(CSO.id, null, true)).toBeNull();
    // Unpaused, the head starts as before.
    expect(store.nextQueued(CSO.id)?.delivery.text).toBe("Write the report.");

    await Effect.runPromise(
      store.enqueue({
        sender: { kind: "user" },
        recipientAgentIds: [CSO.id],
        text: "I have questions about the caps.",
      }),
    );
    expect(store.nextQueued(CSO.id, null, true)?.delivery.text).toBe("I have questions about the caps.");
  });
});
