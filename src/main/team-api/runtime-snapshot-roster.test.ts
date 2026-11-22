import type { AgentRuntimeSnapshot } from "@openbot/contracts/ipc";
import { encodeTeamProtocolV8BaseCurrentEvent } from "@openbot/contracts/team-protocol/v8-base-adapter";
import { describe, expect, it } from "vitest";
import { fitTeamRuntimeSnapshot } from "./runtime-snapshot-roster";

function snapshot(count: number): AgentRuntimeSnapshot {
  const agents = Array.from({ length: count }, (_, index) => ({
    id: `agent-${index}`,
    name: `Agent ${index}`,
    notifications: true,
    preview: "",
    updatedAt: new Date(Date.UTC(2026, 10, 1, 0, index)).toISOString(),
    avatarSeed: `agent-${index}`,
    avatarHue: null,
    avatarUrl: null,
  }));
  return {
    agents,
    activeTurns: [{ agentId: "agent-0", threadId: "thread-0", turnId: "turn-0" }],
    work: [],
    latestMessages: agents.map((agent) => ({
      agentId: agent.id,
      id: `message-${agent.id}`,
      text: "hi",
      createdAt: "2026-11-22T00:00:00.000Z",
    })),
    attentionComplete: true,
    pendingPrompts: [],
    pendingApprovals: [
      {
        requestId: "request-1",
        agentId: "agent-1",
        threadId: "thread-1",
        turnId: "turn-1",
        kind: "permissions",
        command: "Set the Meta Ads daily cap to 7 USD",
        cwd: null,
        reason: "Money needs the owner.",
        grantRoot: null,
        permissions: null,
        truncated: false,
      },
    ],
    pendingBrowserTakeovers: [],
    failedTurns: [],
  };
}

const encode = (value: AgentRuntimeSnapshot) =>
  encodeTeamProtocolV8BaseCurrentEvent({ type: "runtime-snapshot", snapshot: value }, { uiBlocks: true });

describe("fitTeamRuntimeSnapshot", () => {
  it("lets a host with more than 100 agents send its snapshot, approval included", () => {
    const large = snapshot(122);
    expect(encode(large)).toBeNull();
    const fitted = fitTeamRuntimeSnapshot(large);
    expect(fitted.agents).toHaveLength(100);
    expect(fitted.agents.map((agent) => agent.id)).toEqual(expect.arrayContaining(["agent-0", "agent-1"]));
    expect(fitted.pendingApprovals).toHaveLength(1);
    expect(fitted.latestMessages.every((message) => fitted.agents.some((agent) => agent.id === message.agentId))).toBe(
      true,
    );
    expect(encode(fitted)).not.toBeNull();
  });

  it("leaves a snapshot within the limit as it is", () => {
    const small = snapshot(5);
    expect(fitTeamRuntimeSnapshot(small)).toBe(small);
  });
});
