// @vitest-environment node
import type { AgentEvent, ClientAgentSummary, TeamRealtimeEvent } from "@openbot/contracts/ipc";
import {
  decodeTeamProtocolV8BaseCurrentEvent,
  encodeTeamProtocolV8BaseCurrentEvent,
} from "@openbot/contracts/team-protocol/v8-base-adapter";
import { translateFor } from "@openbot/i18n";
import { notificationForAgentEvent } from "@openbot/team-client/agent-notifications";
import { describe, expect, it } from "vitest";

// Failure modes: a turn in which an agent answered another agent raises a "Finished" notification,
// though the chat folds it and counts nothing unread; the marker reaches a peer without fork-host-v1,
// or a peer with it loses the marker.
const completed: Extract<AgentEvent, { type: "turn-completed" }> = {
  type: "turn-completed",
  agentId: "agent-scout",
  threadId: "openbot-thread-agent-scout",
  turnId: "turn-1",
  status: "completed",
  origin: "agent",
};

const agent: ClientAgentSummary = {
  id: "agent-scout",
  provider: "claude",
  name: "Scout",
  title: "Catalog",
  description: "",
  notifications: true,
  model: "claude-test",
  reasoningEffort: "medium",
  threadId: "openbot-thread-agent-scout",
  workspacePath: "/tmp/openbot-scout",
  preview: "",
  updatedAt: "2026-11-16T10:00:00.000Z",
  avatarSeed: "scout",
  avatarHue: null,
  avatarUrl: null,
};

function roundTrip(event: AgentEvent, agentTalk: boolean): AgentEvent | TeamRealtimeEvent | null {
  const encoded = encodeTeamProtocolV8BaseCurrentEvent(event, { agentTalk });
  if (!encoded) return null;
  const decoded = decodeTeamProtocolV8BaseCurrentEvent(JSON.parse(encoded));
  return decoded.kind === "known" ? decoded.event : null;
}

describe("agent talk turns", () => {
  it("raise no notification, while a turn that tells the person does", () => {
    const t = translateFor("en");
    expect(notificationForAgentEvent({ ...completed, agentTalk: true }, [agent], t, "all")).toBeNull();
    expect(notificationForAgentEvent(completed, [agent], t, "all")).toMatchObject({ title: "Scout" });
    // A failure is still news.
    expect(
      notificationForAgentEvent({ ...completed, status: "failed", agentTalk: true }, [agent], t, "all"),
    ).not.toBeNull();
  });

  it("carry the marker only to a peer with fork-host-v1", () => {
    expect(roundTrip({ ...completed, agentTalk: true }, true)).toMatchObject({ agentTalk: true });
    expect(roundTrip({ ...completed, agentTalk: true }, false)).not.toHaveProperty("agentTalk");
    expect(roundTrip(completed, true)).not.toHaveProperty("agentTalk");
  });
});
