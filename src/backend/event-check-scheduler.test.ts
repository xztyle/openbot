// @vitest-environment node
// These checks exercise the actual SQLite store, scheduler, mailbox and fake provider boundary.

import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import type { EventCheckInput } from "@openbot/contracts/event-checks";
import { EVENT_CHECK_ITEM_TYPE_PREFIX } from "@openbot/contracts/event-checks";
import { Effect } from "effect";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { AgentService } from "./agent-service";
import {
  createTestService,
  FakeAgentClient,
  startAgentTestFixture,
  stopAgentTestFixture,
  stores,
  waitForQueue,
} from "./agent-service-test-harness";
import { runCauseEffect } from "./effect-boundary";
import type { EventCheckData, EventCheckReader } from "./event-check-reader";
import { checkPointer, observeCheck } from "./event-check-result";
import { EventCheckStore } from "./event-check-store";
import { mcpSync } from "./mcp-effects";

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
    selection: { itemsPointer: "/items", idPointer: "/id", revisionPointer: "/updatedAt" },
  };
}
async function boot() {
  const { store, mailbox } = stores(root);
  const client = new FakeAgentClient("codex");
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
  const check = await runCauseEffect(service.eventChecks.save(input()));
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
  const check = await runCauseEffect(service.eventChecks.save(input()));
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
  let check = await runCauseEffect(first.eventChecks.save(input()));
  await runCauseEffect(first.eventChecks.checkNow({ agentId: "chief", id: check.id }));
  valid = false;
  check = await runCauseEffect(first.eventChecks.save({ ...check, active: false }));
  expect(check.active).toBe(false);
  valid = true;
  check = await runCauseEffect(
    first.eventChecks.save({
      ...check,
      active: true,
      schedule: {
        ...input().schedule,
        kind: "interval",
        amount: 2,
        unit: "minutes",
        anchorAt: new Date().toISOString(),
      },
    }),
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
  const check = await runCauseEffect(service.eventChecks.save(input()));
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
  const check = await runCauseEffect(service.eventChecks.save(input()));
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
  const check = await runCauseEffect(service.eventChecks.save(input()));
  const due = new Date(Date.parse(check.nextCheckAt) + 1);
  await runCauseEffect(service.eventChecks.processDue(due, () => true));
  await vi.waitFor(() => expect(service.eventChecks.options.store.history("chief", check.id)).toHaveLength(1));
  const saved = await runCauseEffect(service.eventChecks.list({ agentId: "chief" }));
  expect(Date.parse(saved[0]?.nextCheckAt ?? "")).toBeGreaterThan(due.getTime());
  expect(service.listQueue("chief").deliveries).toHaveLength(0);
});

it("retries an interrupted durable event through the same mailbox idempotency key", async () => {
  const { service, checks, client } = await boot();
  const check = await runCauseEffect(service.eventChecks.save(input()));
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
  const check = await runCauseEffect(service.eventChecks.save(input()));
  duringRead = () => {
    checks.save({ ...check, active: false }, new Date());
  };
  const result = await runCauseEffect(service.eventChecks.checkNow({ agentId: "chief", id: check.id }));
  expect(result.status).toBe("cancelled");
  expect(checks.history("chief", check.id)).toMatchObject([{ status: "cancelled", eventCount: 0 }]);
  expect(checks.state(check.id).baseline).toBeNull();
  expect(service.listQueue("chief").deliveries).toEqual([]);
});
