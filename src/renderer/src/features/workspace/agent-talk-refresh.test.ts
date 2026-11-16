import type { WorkspaceAgentExchangeMessage } from "@openbot/contracts/ipc";
import { describe, expect, it } from "vitest";
import { mergeLatestExchange } from "./workspace-model";

// Failure mode: the Between agents view keeps a stale list, or a refresh drops the older messages the
// reader loaded, or shows a message twice.
const message = (id: string, createdAt: number): WorkspaceAgentExchangeMessage => ({
  id,
  senderAgentId: "agent-a",
  recipientAgentIds: ["agent-b"],
  text: id,
  createdAt,
});

describe("Between agents refresh", () => {
  it("keeps the older messages the reader loaded and adds the new ones once", () => {
    const loaded = [message("old", 1), message("m2", 2), message("m3", 3)];
    const page = [message("m2", 2), message("m3", 3), message("new", 4)];
    expect(mergeLatestExchange(loaded, page).map(({ id }) => id)).toEqual(["old", "m2", "m3", "new"]);
  });

  it("keeps what shows when the page is empty", () => {
    const loaded = [message("old", 1)];
    expect(mergeLatestExchange(loaded, [])).toEqual(loaded);
  });
});
