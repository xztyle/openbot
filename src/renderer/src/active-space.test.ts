import { afterEach, describe, expect, it } from "vitest";
import { firstAgentOfActiveSpace, setActiveSpaces } from "./active-space";

// Failure mode: the open agent is deleted, here or on another device, and the chat that shows instead
// is the first agent of the whole list, from a space the reader does not look at.
afterEach(() => setActiveSpaces(null));

const agents = [{ id: "other-space" }, { id: "this-space" }];

describe("the agent that shows after the open one is gone", () => {
  it("is the first agent of the space that shows", () => {
    setActiveSpaces({
      current: () => "space-b",
      options: () => [],
      agentSpace: (agentId) => (agentId === "this-space" ? "space-b" : "space-a"),
    });
    expect(firstAgentOfActiveSpace(agents)?.id).toBe("this-space");
  });

  it("is the first of all on a host without spaces, or when the space has no agent", () => {
    expect(firstAgentOfActiveSpace(agents)?.id).toBe("other-space");
    setActiveSpaces({ current: () => "empty", options: () => [], agentSpace: () => "space-a" });
    expect(firstAgentOfActiveSpace(agents)?.id).toBe("other-space");
  });
});
