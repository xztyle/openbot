import type { ChannelTask } from "@openbot/contracts/ipc";
import { describe, expect, it } from "vitest";
import { channelAwaitingReplies } from "./awaiting-replies";

function task(overrides: Partial<ChannelTask>): ChannelTask {
  return {
    id: "task",
    channelId: "channel-1",
    parentTaskId: null,
    rootTaskId: "task",
    ownerAgentId: "chief",
    requestMessageId: "m1",
    instruction: "Do the work",
    attachmentDraftIds: [],
    expectedResult: "",
    sourceMessageIds: [],
    dependencies: [],
    resources: [],
    state: "running",
    revision: 1,
    assignmentCount: 1,
    error: null,
    ...overrides,
  };
}

describe("channelAwaitingReplies", () => {
  const name = (id: string | null) => id ?? "Unassigned";
  const parent = task({ id: "parent", rootTaskId: "parent", state: "waiting" });

  it("shows the first line of a sub-task brief", () => {
    const items = channelAwaitingReplies({
      tasks: [
        parent,
        task({
          id: "child",
          rootTaskId: "parent",
          parentTaskId: "parent",
          ownerAgentId: "ada",
          instruction: "\n  Draft the pricing section\nUse the 2026 figures.\nMention the discount.",
        }),
      ],
      agents: [],
      name,
    });
    expect(items).toMatchObject([{ id: "child", name: "ada", preview: "Draft the pricing section" }]);
  });

  it("cuts a long line at a word and adds an ellipsis", () => {
    const words = Array.from({ length: 60 }, (_, index) => `word${index}`).join(" ");
    const [item] = channelAwaitingReplies({
      tasks: [parent, task({ id: "child", rootTaskId: "parent", parentTaskId: "parent", instruction: words })],
      agents: [],
      name,
    });
    const preview = item?.preview ?? "";
    expect(preview.endsWith("…")).toBe(true);
    expect(preview.length).toBeLessThanOrEqual(161);
    // The cut is at a word: the text before the ellipsis is a prefix that ends on a whole word.
    expect(words.startsWith(preview.slice(0, -1))).toBe(true);
    expect(words.charAt(preview.length - 1)).toBe(" ");
  });
});
