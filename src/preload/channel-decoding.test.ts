// @vitest-environment node

import { decodeChannel, decodeChannelSummaries, parseChannelCommand } from "@openbot/contracts/ipc";
import { describe, expect, it } from "vitest";

const CHANNEL = {
  id: "channel-1",
  name: "Prospectacao",
  title: "",
  instructions: "",
  members: [{ agentId: "agent-1" }],
  leadAgentId: "agent-1",
  archived: false,
  revision: 3,
  createdAt: "2026-11-09T00:00:00.000Z",
};

// A database can hold a channel whose lead is not a member. Startup reads every channel, so refusing
// that row stopped every provider from starting (upstream #9141).
describe("stored channel lead that is not a member", () => {
  const members = [{ agentId: "agent-1" }, { agentId: "agent-3" }];

  it("reads the lead as the first member", () => {
    expect(decodeChannel({ ...CHANNEL, members, leadAgentId: "agent-2" }).leadAgentId).toBe("agent-1");
  });

  it("reads no lead when the channel has no members", () => {
    expect(decodeChannel({ ...CHANNEL, members: [], leadAgentId: "agent-2" }).leadAgentId).toBeNull();
  });

  it("keeps a lead that is a member", () => {
    expect(decodeChannel({ ...CHANNEL, members, leadAgentId: "agent-3" }).leadAgentId).toBe("agent-3");
  });

  it("reads the channel list", () => {
    const summary = { ...CHANNEL, leadAgentId: "agent-2", unreadCount: 0, activeTasks: 0, lastMessage: null };
    expect(decodeChannelSummaries([summary])[0]?.leadAgentId).toBe("agent-1");
  });

  it("still refuses a save with that lead", () => {
    const draft = { name: "Renamed", title: "", instructions: "", members, leadAgentId: "agent-2" };
    expect(() =>
      parseChannelCommand({ type: "save", operationId: "operation-1", channelId: "channel-1", draft }),
    ).toThrow();
  });
});
