// @vitest-environment node
// These checks exercise the actual SQLite store, scheduler, mailbox and fake provider boundary.

import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import type { EventCheckInput } from "@openbot/contracts/event-checks";
import { decodeEventCheckInput, EVENT_CHECK_ITEM_TYPE_PREFIX } from "@openbot/contracts/event-checks";
import type { AgentEvent } from "@openbot/contracts/ipc";
import { Effect } from "effect";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ROUTINE_NO_UPDATE_MARKER } from "./agent/routine-quiet-runs";
import type { AgentService } from "./agent-service";
import {
  createTestService,
  FakeAgentClient,
  firstInputText,
  startAgentTestFixture,
  stopAgentTestFixture,
  stores,
  waitFor,
  waitForQueue,
} from "./agent-service-test-harness";
import { runCauseEffect } from "./effect-boundary";
import type { EventCheckData, EventCheckReader } from "./event-check-reader";
import { checkPointer, observeCheck } from "./event-check-result";
import { EventCheckStore, eventCheckBackoffMs } from "./event-check-store";
import { mcpSync } from "./mcp-effects";
import { LOCAL_USER_ACTOR as TEST_USER } from "./security-actor";

let root: string;
let service: AgentService | null = null;
let items: EventCheckData[];
let valid: boolean;
let fail: boolean;
let duringRead: (() => void) | undefined;
const reads = vi.fn();
const reader: EventCheckReader = {
  accounts: () => [{ id: "linear-job-one", name: "Linear — Job one" }],
  read: (_agentId, account, use) =>
    Effect.suspend(() => {
      if (account !== "linear-job-one" || !valid)
        return mcpSync(() => {
          throw new Error("Disconnected.");
        });
      return use({
        tools: [{ name: "list_issues", description: "Read issues", inputSchemaJson: '{"type":"object"}' }],
        valid: () => valid,
        call: (tool, args) =>
          mcpSync(() => {
            reads(tool, args);
            duringRead?.();
            if (fail) throw new Error("Private credential must not leak.");
            return { structuredContent: { items } };
          }),
      });
    }),
};
function input(): EventCheckInput {
  return {
    agentId: "chief",
    name: "Linear tickets",
    instruction: "Review new tickets. Do not post messages.",
    active: true,
    timezone: "UTC",
    schedule: { kind: "interval", amount: 1, unit: "minutes", anchorAt: new Date().toISOString() },
    source: {
      kind: "mcp",
      connectionId: "linear-job-one",
      toolName: "list_issues",
      argumentsJson: "{}",
      cursorArgument: "",
      nextCursorPointer: "",
    },
    selfEvents: { mode: "include", connectionId: "", actorPointer: "", accountActorIds: [] },
    selection: { itemsPointer: "/items", idPointer: "/id", revisionPointer: "/updatedAt" },
  };
}
async function boot(output?: string) {
  const { store, mailbox } = stores(root);
  const client = new FakeAgentClient("codex", output);
  service = createTestService({ store, mailbox, clientFactory: () => client, eventCheckReader: reader });
  await runCauseEffect(service.initialize());
  await runCauseEffect(store.getOrCreate("chief"));
  return { service, store, mailbox, client, checks: new EventCheckStore(store.database) };
}
beforeEach(async () => {
  ({ root } = await startAgentTestFixture());
  items = [{ id: "existing", updatedAt: "1" }];
  valid = true;
  fail = false;
  duringRead = undefined;
  reads.mockClear();
});
afterEach(async () => {
  await stopAgentTestFixture(root, service);
  service = null;
});

it("keeps baseline, empty and unchanged checks silent, then queues one event and one provider turn", async () => {
  const { service, client, store } = await boot();
  const check = await runCauseEffect(service.eventChecks.save(input(), TEST_USER));
  const target = { agentId: "chief", id: check.id };
  expect((await runCauseEffect(service.eventChecks.checkNow(target))).status).toBe("baseline");
  items = [];
  expect((await runCauseEffect(service.eventChecks.checkNow(target))).status).toBe("unchanged");
  items = [{ updatedAt: "1", id: "existing" }];
  await runCauseEffect(service.eventChecks.checkNow(target));
  expect(service.listQueue("chief").deliveries).toHaveLength(0);
  expect(client.requests.filter((request) => request.method === "turn/start")).toHaveLength(0);
  expect((await runCauseEffect(service.readConversation("chief"))).messages).toHaveLength(0);
  items.push({ id: "new", updatedAt: "1" });
  expect((await runCauseEffect(service.eventChecks.checkNow(target))).status).toBe("triggered");
  await waitForQueue(service, "chief", (queue) => queue.deliveries.some((delivery) => delivery.status === "completed"));
  expect(client.requests.filter((request) => request.method === "turn/start")).toHaveLength(1);
  await runCauseEffect(service.eventChecks.checkNow(target));
  const conversation = await runCauseEffect(service.readConversation("chief"));
  const markers = conversation.messages.filter((message) => message.itemType?.startsWith(EVENT_CHECK_ITEM_TYPE_PREFIX));
  expect(markers).toHaveLength(1);
  expect(markers[0]).toMatchObject({ author: "system", text: "Linear tickets" });
  expect(conversation.messages.some((message) => message.text.includes('"accountId"'))).toBe(false);
  const page = store.database.readConversationPage("chief", conversation.threadId, { type: "latest" }, 50, {
    excludeEventCheckEvents: true,
  });
  expect(page.messages.some((message) => message.itemType?.startsWith(EVENT_CHECK_ITEM_TYPE_PREFIX))).toBe(false);
  expect(service.listQueue("chief").deliveries).toHaveLength(1);
  await mkdir(".openbot-build", { recursive: true });
  await writeFile(
    ".openbot-build/event-check-runtime.json",
    JSON.stringify(
      {
        checkedAt: new Date().toISOString(),
        baselineAndEmptyInferenceTurns: 0,
        matchingEventTurns: client.requests.filter((request) => request.method === "turn/start").length,
        eventMarkers: markers.length,
        duplicateDeliveries: service.listQueue("chief").deliveries.length - 1,
        oldClientMarkerCount: page.messages.filter((message) =>
          message.itemType?.startsWith(EVENT_CHECK_ITEM_TYPE_PREFIX),
        ).length,
        rawPayloadInChat: conversation.messages.some((message) => message.text.includes('"accountId"')),
      },
      null,
      2,
    ),
  );
});

it("retains exactly ten execution logs and keeps read errors out of chat and logs free of credentials", async () => {
  const { service, client } = await boot();
  const check = await runCauseEffect(service.eventChecks.save(input(), TEST_USER));
  const target = { agentId: "chief", id: check.id };
  for (let index = 0; index < 12; index++) await runCauseEffect(service.eventChecks.checkNow(target));
  fail = true;
  expect((await runCauseEffect(service.eventChecks.checkNow(target))).status).toBe("error");
  const history = await runCauseEffect(service.eventChecks.history(target));
  expect(history).toHaveLength(10);
  expect(history.filter((execution) => execution.status === "error")).toHaveLength(1);
  expect(JSON.stringify(history)).not.toContain("credential");
  expect(service.listQueue("chief").deliveries).toHaveLength(0);
  expect(client.requests.filter((request) => request.method === "turn/start")).toHaveLength(0);
});

it("lets a disconnected check pause and preserves its baseline across restart and timing changes", async () => {
  const { service: first, checks } = await boot();
  let check = await runCauseEffect(first.eventChecks.save(input(), TEST_USER));
  await runCauseEffect(first.eventChecks.checkNow({ agentId: "chief", id: check.id }));
  valid = false;
  check = await runCauseEffect(first.eventChecks.save({ ...check, active: false }, TEST_USER));
  expect(check.active).toBe(false);
  valid = true;
  check = await runCauseEffect(
    first.eventChecks.save(
      {
        ...check,
        active: true,
        schedule: {
          ...input().schedule,
          kind: "interval",
          amount: 2,
          unit: "minutes",
          anchorAt: new Date().toISOString(),
        },
      },
      TEST_USER,
    ),
  );
  expect(checks.state(check.id).baseline).not.toBeNull();
  await runCauseEffect(first.stop());
  const { service: restarted } = await boot();
  expect((await runCauseEffect(restarted.eventChecks.checkNow({ agentId: "chief", id: check.id }))).status).toBe(
    "unchanged",
  );
  expect(restarted.listQueue("chief").deliveries).toHaveLength(0);
});

it("discards an in-flight observation after permissions are revoked without advancing the baseline", async () => {
  const { service, checks } = await boot();
  const check = await runCauseEffect(service.eventChecks.save(input(), TEST_USER));
  const target = { agentId: "chief", id: check.id };
  await runCauseEffect(service.eventChecks.checkNow(target));
  const before = checks.state(check.id);
  items.push({ id: "secret", updatedAt: "1" });
  duringRead = () => {
    valid = false;
  };
  expect((await runCauseEffect(service.eventChecks.checkNow(target))).status).toBe("cancelled");
  expect(checks.state(check.id)).toEqual(before);
  expect(service.listQueue("chief").deliveries).toHaveLength(0);
});

it("keeps undelivered events during timing edits and clears them only when the query changes", async () => {
  const { service, checks } = await boot();
  const check = await runCauseEffect(service.eventChecks.save(input(), TEST_USER));
  const baseline = observeCheck(items, check.selection, null);
  const changed = observeCheck([...items, { id: "new", updatedAt: "1" }], check.selection, baseline.baseline);
  const now = new Date().toISOString();
  checks.finish(
    check,
    {
      id: randomUUID(),
      checkId: check.id,
      status: "triggered",
      startedAt: now,
      finishedAt: now,
      durationMs: 0,
      itemCount: 2,
      eventCount: 1,
      skippedSelfCount: 0,
      filteredCount: 0,
      error: null,
    },
    changed,
  );
  const edited = checks.save({ ...check, name: "Updated name", active: false }, new Date());
  expect(checks.pending()).toEqual([]);
  const reenabled = checks.save({ ...edited, active: true }, new Date());
  expect(checks.pending()).toMatchObject([{ revision: reenabled.revision, items: [{ id: "new" }] }]);
  checks.save({ ...edited, source: { ...edited.source, argumentsJson: '{"team":"other"}' } }, new Date());
  expect(checks.pending()).toEqual([]);
  expect(checks.state(check.id).baseline).toBeNull();
});

it("compares stable IDs and revisions, rejects malformed paths and never repeats a temporarily absent item", () => {
  const selection = input().selection;
  const baseline = observeCheck(items, selection, null);
  const empty = observeCheck([], selection, baseline.baseline);
  expect(observeCheck(items, selection, empty.baseline).changed).toEqual([]);
  expect(observeCheck([{ id: "existing", updatedAt: "2" }], selection, baseline.baseline).changed).toHaveLength(1);
  expect(() => checkPointer([], "/0")).toThrow();
  expect(() => observeCheck([{ id: "no-revision" }], selection, baseline.baseline)).toThrow();
  expect(() => observeCheck([...items, ...items], selection, baseline.baseline)).toThrow();
});

it("runs a scheduled one-minute check without a chat turn and advances its next run", async () => {
  const { service } = await boot();
  const check = await runCauseEffect(service.eventChecks.save(input(), TEST_USER));
  const due = new Date(Date.parse(check.nextCheckAt) + 1);
  await runCauseEffect(service.eventChecks.processDue(due, () => true));
  await vi.waitFor(() => expect(service.eventChecks.options.store.history("chief", check.id)).toHaveLength(1));
  const saved = await runCauseEffect(service.eventChecks.list({ agentId: "chief" }));
  expect(Date.parse(saved[0]?.nextCheckAt ?? "")).toBeGreaterThan(due.getTime());
  expect(service.listQueue("chief").deliveries).toHaveLength(0);
});

it("retries an interrupted durable event through the same mailbox idempotency key", async () => {
  const { service, checks, client } = await boot();
  const check = await runCauseEffect(service.eventChecks.save(input(), TEST_USER));
  const previous = observeCheck(items, check.selection, null);
  const changed = observeCheck([...items, { id: "after-crash", updatedAt: "1" }], check.selection, previous.baseline);
  const now = new Date().toISOString();
  checks.finish(
    check,
    {
      id: randomUUID(),
      checkId: check.id,
      startedAt: now,
      finishedAt: now,
      status: "triggered",
      itemCount: 2,
      eventCount: 1,
      skippedSelfCount: 0,
      filteredCount: 0,
      durationMs: 0,
      error: null,
    },
    changed,
  );
  const deletion = vi.spyOn(service.eventChecks.options.store, "delivered").mockImplementationOnce(() => {
    throw new Error("Crash after mailbox commit.");
  });
  await runCauseEffect(service.eventChecks.resumePending());
  expect(checks.pending()).toHaveLength(1);
  await runCauseEffect(service.eventChecks.resumePending());
  await waitForQueue(service, "chief", (queue) => queue.deliveries[0]?.status === "completed");
  expect(checks.pending()).toEqual([]);
  expect(service.listQueue("chief").deliveries).toHaveLength(1);
  expect(client.requests.filter((request) => request.method === "turn/start")).toHaveLength(1);
  deletion.mockRestore();
});

it("logs an in-flight check as cancelled when its timing or enabled state changes", async () => {
  const { service, checks } = await boot();
  const check = await runCauseEffect(service.eventChecks.save(input(), TEST_USER));
  duringRead = () => {
    checks.save({ ...check, active: false }, new Date());
  };
  const result = await runCauseEffect(service.eventChecks.checkNow({ agentId: "chief", id: check.id }));
  expect(result.status).toBe("cancelled");
  expect(checks.history("chief", check.id)).toMatchObject([{ status: "cancelled", eventCount: 0 }]);
  expect(checks.state(check.id).baseline).toBeNull();
  expect(service.listQueue("chief").deliveries).toEqual([]);
});

it("skips the connected account's changes, preserves their fingerprints, and wakes only for another author", async () => {
  const { service, checks, client } = await boot();
  items = [{ id: "existing", updatedAt: "1", actor: { id: "me" } }];
  const check = await runCauseEffect(
    service.eventChecks.save(
      {
        ...input(),
        selfEvents: {
          mode: "exclude",
          connectionId: "linear-job-one",
          actorPointer: "/actor/id",
          accountActorIds: ["me"],
        },
      },
      TEST_USER,
    ),
  );
  const target = { agentId: "chief", id: check.id };
  await expect(
    runCauseEffect(
      service.eventChecks.save({ ...check, source: { ...check.source, connectionId: "other-job" } }, TEST_USER),
    ),
  ).rejects.toThrow("change-author");
  expect(checks.get("chief", check.id).source.connectionId).toBe("linear-job-one");
  await runCauseEffect(service.eventChecks.checkNow(target));
  items = [
    { id: "existing", updatedAt: "2", actor: { id: "me" } },
    { id: "own-new", updatedAt: "1", actor: { id: "me" } },
  ];
  expect(await runCauseEffect(service.eventChecks.checkNow(target))).toMatchObject({
    status: "unchanged",
    eventCount: 0,
    skippedSelfCount: 2,
  });
  expect(service.listQueue("chief").deliveries).toHaveLength(0);
  expect(client.requests.filter((request) => request.method === "turn/start")).toHaveLength(0);
  expect((await runCauseEffect(service.eventChecks.checkNow(target))).skippedSelfCount).toBe(0);
  const before = checks.state(check.id);
  items.push({ id: "missing-author", updatedAt: "1" });
  expect((await runCauseEffect(service.eventChecks.checkNow(target))).status).toBe("error");
  expect(checks.state(check.id)).toEqual(before);
  expect(service.listQueue("chief").deliveries).toHaveLength(0);
  items.pop();
  items[0] = { id: "existing", updatedAt: "3", actor: { id: "other" } };
  expect(await runCauseEffect(service.eventChecks.checkNow(target))).toMatchObject({
    status: "triggered",
    eventCount: 1,
    skippedSelfCount: 0,
  });
  await waitForQueue(service, "chief", (queue) => queue.deliveries[0]?.status === "completed");
  expect(client.requests.filter((request) => request.method === "turn/start")).toHaveLength(1);
});

it("defaults to 30 seconds, refuses unconfigured self-event exclusion, and explicitly permits self-events for a test", async () => {
  const { service, client } = await boot();
  const definition = { ...input(), schedule: undefined, selfEvents: undefined };
  const decoded = decodeEventCheckInput(definition);
  expect(decoded.schedule).toMatchObject({ kind: "interval", amount: 30, unit: "seconds" });
  expect(decoded.selfEvents.mode).toBe("exclude");
  await expect(runCauseEffect(service.eventChecks.save(decoded, TEST_USER))).rejects.toThrow("change-author");
  let check = await runCauseEffect(service.eventChecks.save({ ...decoded, selfEvents: input().selfEvents }, TEST_USER));
  const target = { agentId: "chief", id: check.id };
  await runCauseEffect(service.eventChecks.checkNow(target));
  items.push({ id: "self-test", updatedAt: "1", actor: "me" });
  expect((await runCauseEffect(service.eventChecks.checkNow(target))).status).toBe("triggered");
  await waitForQueue(service, "chief", (queue) => queue.deliveries[0]?.status === "completed");
  expect(client.requests.filter((request) => request.method === "turn/start")).toHaveLength(1);
  const due = new Date(Date.parse(check.nextCheckAt) + 1);
  await runCauseEffect(service.eventChecks.processDue(due, () => true));
  await vi.waitFor(() => expect(service.eventChecks.options.store.history("chief", check.id)).toHaveLength(3));
  const saved = (await runCauseEffect(service.eventChecks.list({ agentId: "chief" })))[0];
  if (!saved) throw new Error("Expected the saved check.");
  check = saved;
  expect(Date.parse(check.nextCheckAt) - due.getTime()).toBe(29999);
});

function completedTurns(service: AgentService): Extract<AgentEvent, { type: "turn-completed" }>[] {
  const turns: Extract<AgentEvent, { type: "turn-completed" }>[] = [];
  service.on("event", (event: AgentEvent) => {
    if (event.type === "turn-completed") turns.push(event);
  });
  return turns;
}

it("lets an event check turn answer the no-update marker, and leaves it quiet", async () => {
  const { service, client } = await boot(ROUTINE_NO_UPDATE_MARKER);
  const turns = completedTurns(service);
  const check = await runCauseEffect(service.eventChecks.save(input(), TEST_USER));
  const target = { agentId: "chief", id: check.id };
  await runCauseEffect(service.eventChecks.checkNow(target));
  items.push({ id: "new", updatedAt: "1" });
  expect((await runCauseEffect(service.eventChecks.checkNow(target))).status).toBe("triggered");
  await waitFor(() => turns.length > 0);
  expect(turns[0]).toMatchObject({ status: "completed", quiet: true });
  const prompt = client.requests
    .filter((request) => request.method === "turn/start")
    .map((request) => firstInputText(request.params));
  expect(prompt[0]).toContain(`answer exactly ${ROUTINE_NO_UPDATE_MARKER}`);
  const conversation = await runCauseEffect(service.readConversation("chief"));
  expect(conversation.messages.some((message) => message.author === "assistant")).toBe(false);
  // The marker row of the event stays, so the user can see that the check woke the agent.
  expect(
    conversation.messages.filter((message) => message.itemType?.startsWith(EVENT_CHECK_ITEM_TYPE_PREFIX)),
  ).toHaveLength(1);
});

it("keeps an event check turn visible when the agent has something to say", async () => {
  const { service } = await boot("Two tickets need a decision.");
  const turns = completedTurns(service);
  const check = await runCauseEffect(service.eventChecks.save(input(), TEST_USER));
  const target = { agentId: "chief", id: check.id };
  await runCauseEffect(service.eventChecks.checkNow(target));
  items.push({ id: "new", updatedAt: "1" });
  await runCauseEffect(service.eventChecks.checkNow(target));
  await waitFor(() => turns.length > 0);
  expect(turns[0]?.quiet).toBeUndefined();
  const conversation = await runCauseEffect(service.readConversation("chief"));
  expect(
    conversation.messages.filter((message) => message.author === "assistant").map((message) => message.text),
  ).toEqual(["Two tickets need a decision."]);
});

it("doubles the wait for each error in a row up to a ceiling, and resets after a success", async () => {
  expect(eventCheckBackoffMs(30_000, 0)).toBe(30_000);
  expect(eventCheckBackoffMs(30_000, 1)).toBe(60_000);
  expect(eventCheckBackoffMs(30_000, 3)).toBe(240_000);
  // 16 intervals is 8 minutes, which is below the 15 minute ceiling.
  expect(eventCheckBackoffMs(30_000, 9)).toBe(480_000);
  expect(eventCheckBackoffMs(60_000, 9)).toBe(900_000);
  // A long interval is never stretched.
  expect(eventCheckBackoffMs(3_600_000, 5)).toBe(3_600_000);
  const { service, checks } = await boot();
  const check = await runCauseEffect(service.eventChecks.save(input(), TEST_USER));
  const target = { agentId: "chief", id: check.id };
  const now = new Date();
  checks.advance(check, now);
  const normal = Date.parse(checks.get("chief", check.id).nextCheckAt) - now.getTime();
  fail = true;
  for (let index = 0; index < 3; index++) await runCauseEffect(service.eventChecks.checkNow(target));
  expect(checks.consecutiveErrors(check.id)).toBe(3);
  checks.advance(check, now);
  expect(Date.parse(checks.get("chief", check.id).nextCheckAt) - now.getTime()).toBe(Math.min(normal * 8, 900_000));
  fail = false;
  await runCauseEffect(service.eventChecks.checkNow(target));
  expect(checks.consecutiveErrors(check.id)).toBe(0);
  checks.advance(check, now);
  expect(Date.parse(checks.get("chief", check.id).nextCheckAt) - now.getTime()).toBe(normal);
});

it("tells the user once at the fifth error in a row, with the check's health in the list", async () => {
  const { service } = await boot();
  const notices: Extract<AgentEvent, { type: "error" }>[] = [];
  service.on("event", (event: AgentEvent) => {
    if (event.type === "error" && event.code.startsWith("event_check_")) notices.push(event);
  });
  const check = await runCauseEffect(service.eventChecks.save(input(), TEST_USER));
  const target = { agentId: "chief", id: check.id };
  fail = true;
  for (let index = 0; index < 7; index++) await runCauseEffect(service.eventChecks.checkNow(target));
  expect(notices).toHaveLength(1);
  expect(notices[0]).toMatchObject({ agentId: "chief", code: "event_check_failing" });
  expect(notices[0]?.message).toContain("Linear tickets");
  expect(notices[0]?.message).not.toContain("credential");
  const [listed] = await runCauseEffect(service.eventChecks.list({ agentId: "chief" }));
  expect(listed?.health?.consecutiveErrors).toBe(7);
  expect(listed?.health?.lastError).not.toContain("credential");
  // A success ends the streak, and the next streak tells again.
  fail = false;
  await runCauseEffect(service.eventChecks.checkNow(target));
  fail = true;
  for (let index = 0; index < 5; index++) await runCauseEffect(service.eventChecks.checkNow(target));
  expect(notices).toHaveLength(2);
});

it("keeps changed items that the item filters skip out of later events, because they stay in the baseline", async () => {
  const { service, client } = await boot();
  const check = await runCauseEffect(
    service.eventChecks.save(
      {
        ...input(),
        delivery: { digestSeconds: 0, itemFilters: [{ pointer: "/kind", value: "bug" }] },
      },
      TEST_USER,
    ),
  );
  const target = { agentId: "chief", id: check.id };
  items = [{ id: "existing", updatedAt: "1", kind: "bug" }];
  await runCauseEffect(service.eventChecks.checkNow(target));
  items = [...items, { id: "feature", updatedAt: "1", kind: "feature" }];
  expect(await runCauseEffect(service.eventChecks.checkNow(target))).toMatchObject({
    status: "unchanged",
    eventCount: 0,
    filteredCount: 1,
  });
  // The skipped item is known now. Seeing it again does not make it look new.
  expect(await runCauseEffect(service.eventChecks.checkNow(target))).toMatchObject({
    status: "unchanged",
    filteredCount: 0,
  });
  items = [...items, { id: "bug-2", updatedAt: "1", kind: "bug" }];
  expect((await runCauseEffect(service.eventChecks.checkNow(target))).status).toBe("triggered");
  await waitForQueue(service, "chief", (queue) => queue.deliveries[0]?.status === "completed");
  expect(client.requests.filter((request) => request.method === "turn/start")).toHaveLength(1);
});

it("keeps a saved delivery setting when a client that does not know it saves the check again", async () => {
  const { service, checks } = await boot();
  const delivery = { digestSeconds: 600, itemFilters: [] };
  const check = await runCauseEffect(service.eventChecks.save({ ...input(), delivery }, TEST_USER));
  const { delivery: _unknown, ...withoutDelivery } = decodeEventCheckInput({ ...input(), id: check.id });
  const saved = await runCauseEffect(service.eventChecks.save(withoutDelivery, TEST_USER));
  expect(saved.delivery).toEqual(delivery);
  expect(checks.get("chief", check.id).delivery).toEqual(delivery);
  const cleared = await runCauseEffect(
    service.eventChecks.save({ ...withoutDelivery, delivery: { digestSeconds: 0, itemFilters: [] } }, TEST_USER),
  );
  expect(cleared.delivery).toEqual({ digestSeconds: 0, itemFilters: [] });
});

it("holds events for the digest window, then hands them over as one prompt with each item once", async () => {
  const { service, checks, client } = await boot();
  const check = await runCauseEffect(
    service.eventChecks.save({ ...input(), delivery: { digestSeconds: 3600, itemFilters: [] } }, TEST_USER),
  );
  const target = { agentId: "chief", id: check.id };
  await runCauseEffect(service.eventChecks.checkNow(target));
  items = [...items, { id: "a", updatedAt: "1" }];
  await runCauseEffect(service.eventChecks.checkNow(target));
  items = [
    { id: "existing", updatedAt: "1" },
    { id: "a", updatedAt: "2" },
    { id: "b", updatedAt: "1" },
  ];
  await runCauseEffect(service.eventChecks.checkNow(target));
  expect(checks.pending()).toHaveLength(2);
  expect(service.listQueue("chief").deliveries).toHaveLength(0);
  // The window passes.
  checks.database.connection
    .prepare("UPDATE projection_event_check_outbox SET created_at = ?")
    .run("2020-01-01T00:00:00.000Z");
  await runCauseEffect(service.eventChecks.resumePending());
  await waitForQueue(service, "chief", (queue) => queue.deliveries[0]?.status === "completed");
  expect(checks.pending()).toEqual([]);
  const prompts = client.requests
    .filter((request) => request.method === "turn/start")
    .map((request) => firstInputText(request.params));
  expect(prompts).toHaveLength(1);
  expect(prompts[0]?.match(/"id":"a"/g)).toHaveLength(1);
  expect(prompts[0]).toContain('"updatedAt":"2"');
  expect(prompts[0]).toContain('"id":"b"');
});

it("holds events over the hourly cap and delivers them later as one digest, never dropping them", async () => {
  const { service, checks, client } = await boot();
  service.eventChecks.options.deliveryCap = 1;
  const check = await runCauseEffect(service.eventChecks.save(input(), TEST_USER));
  const target = { agentId: "chief", id: check.id };
  await runCauseEffect(service.eventChecks.checkNow(target));
  items = [...items, { id: "one", updatedAt: "1" }];
  await runCauseEffect(service.eventChecks.checkNow(target));
  await waitForQueue(service, "chief", (queue) => queue.deliveries[0]?.status === "completed");
  items = [...items, { id: "two", updatedAt: "1" }];
  await runCauseEffect(service.eventChecks.checkNow(target));
  items = [...items, { id: "three", updatedAt: "1" }];
  await runCauseEffect(service.eventChecks.checkNow(target));
  expect(checks.pending()).toHaveLength(2);
  expect(client.requests.filter((request) => request.method === "turn/start")).toHaveLength(1);
  // An hour slot frees up.
  service.eventChecks.options.deliveryCap = 2;
  await runCauseEffect(service.eventChecks.resumePending());
  await waitForQueue(
    service,
    "chief",
    (queue) => queue.deliveries.filter((delivery) => delivery.status === "completed").length === 2,
  );
  expect(checks.pending()).toEqual([]);
  const prompts = client.requests
    .filter((request) => request.method === "turn/start")
    .map((request) => firstInputText(request.params));
  expect(prompts).toHaveLength(2);
  expect(prompts[1]).toContain('"id":"two"');
  expect(prompts[1]).toContain('"id":"three"');
});
