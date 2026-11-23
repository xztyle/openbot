import { describe, expect, it } from "vitest";
import { needsYouItems } from "./needs-you";

const approval = (requestId: string) => ({
  requestId,
  agentId: "agent-a",
  threadId: "thread-a",
  turnId: "turn-a",
  kind: "command" as const,
  command: null,
  cwd: null,
  reason: null,
  grantRoot: null,
  permissions: null,
});

describe("needsYouItems", () => {
  it("keeps a request that the client holds while the host's list may still catch up", () => {
    const now = Date.now();
    const items = needsYouItems({ items: [], prompts: [], approvals: [approval("held-1")], takeovers: [] }, now);
    expect(items.map((item) => item.requestId)).toEqual(["held-1"]);
  });

  it("drops a held request that the host's list still does not name a minute later", () => {
    const now = Date.now();
    needsYouItems({ items: [], prompts: [], approvals: [approval("held-2")], takeovers: [] }, now);
    const later = needsYouItems(
      { items: [], prompts: [], approvals: [approval("held-2")], takeovers: [] },
      now + 61_000,
    );
    expect(later).toEqual([]);
  });

  it("keeps every held request where the host sends no list", () => {
    const now = Date.now();
    needsYouItems({ items: null, prompts: [], approvals: [approval("held-3")], takeovers: [] }, now);
    const later = needsYouItems(
      { items: null, prompts: [], approvals: [approval("held-3")], takeovers: [] },
      now + 61_000,
    );
    expect(later.map((item) => item.requestId)).toEqual(["held-3"]);
  });
});
