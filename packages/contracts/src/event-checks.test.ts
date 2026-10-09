import { describe, expect, it } from "vitest";
import {
  decodeEventCheck,
  decodeEventCheckExecution,
  decodeEventCheckInput,
  EVENT_CHECK_ITEM_FILTER_LIMIT,
} from "./event-checks";

const stored = {
  id: "check-1",
  agentId: "chief",
  name: "Linear tickets",
  instruction: "Review new tickets.",
  active: true,
  timezone: "UTC",
  schedule: { kind: "interval", amount: 60, unit: "seconds", anchorAt: "2026-10-09T00:00:00.000Z" },
  selfEvents: { mode: "include", connectionId: "", actorPointer: "", accountActorIds: [] },
  source: {
    kind: "mcp",
    connectionId: "linear",
    toolName: "list_issues",
    argumentsJson: "{}",
    cursorArgument: "",
    nextCursorPointer: "",
  },
  selection: { itemsPointer: "/items", idPointer: "/id", revisionPointer: "/updatedAt" },
  revision: "revision-1",
  nextCheckAt: "2026-10-09T00:01:00.000Z",
  createdAt: "2026-10-09T00:00:00.000Z",
  updatedAt: "2026-10-09T00:00:00.000Z",
};

describe("event check wire compatibility", () => {
  it("reads a check saved before delivery settings and health existed, and adds neither", () => {
    const check = decodeEventCheck(stored);
    expect(check).not.toHaveProperty("delivery");
    expect(check).not.toHaveProperty("health");
    expect(decodeEventCheckInput(stored)).not.toHaveProperty("delivery");
  });

  it("reads an execution saved before filtered items were counted as zero", () => {
    const execution = decodeEventCheckExecution({
      id: "execution-1",
      checkId: "check-1",
      startedAt: "2026-10-09T00:00:00.000Z",
      finishedAt: "2026-10-09T00:00:01.000Z",
      status: "unchanged",
      itemCount: 3,
      eventCount: 0,
      durationMs: 12,
      error: null,
    });
    expect(execution).toMatchObject({ skippedSelfCount: 0, filteredCount: 0 });
  });

  it("keeps delivery settings and health, and refuses values that are out of range", () => {
    const delivery = { digestSeconds: 600, itemFilters: [{ pointer: "/state", value: "open" }] };
    const health = { consecutiveErrors: 2, lastError: "The app limited the requests.", lastStatus: "error" };
    expect(decodeEventCheck({ ...stored, delivery, health })).toMatchObject({ delivery, health });
    expect(() => decodeEventCheckInput({ ...stored, delivery: { ...delivery, digestSeconds: -1 } })).toThrow();
    expect(() => decodeEventCheckInput({ ...stored, delivery: { ...delivery, digestSeconds: 86_401 } })).toThrow();
    expect(() =>
      decodeEventCheckInput({
        ...stored,
        delivery: {
          digestSeconds: 0,
          itemFilters: Array.from({ length: EVENT_CHECK_ITEM_FILTER_LIMIT + 1 }, () => ({ pointer: "", value: 1 })),
        },
      }),
    ).toThrow();
    expect(() =>
      decodeEventCheckInput({ ...stored, delivery: { digestSeconds: 0, itemFilters: [{ pointer: "x" }] } }),
    ).toThrow();
    expect(() =>
      decodeEventCheck({ ...stored, health: { consecutiveErrors: 1, lastError: null, lastStatus: "odd" } }),
    ).toThrow();
  });
});
