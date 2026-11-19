import { type AgentReportingFields, agentManagerRefusal, agentManagers } from "@openbot/contracts/agent-org";
import {
  decodeTeamProtocolV8CurrentHttpRequest,
  decodeTeamProtocolV8CurrentHttpResponse,
  encodeTeamProtocolV8CurrentHttpRequest,
} from "@openbot/contracts/team-protocol/v8-adapter";
import { describe, expect, it } from "vitest";

const created = (agentId: string) => ({ agentId, at: "2026-11-01T10:00:00.000Z" });

/** A director who created two leads, and a lead who created a designer. */
const team: AgentReportingFields[] = [
  { id: "director" },
  { id: "lead-a", createdBy: created("director") },
  { id: "lead-b", createdBy: created("director") },
  { id: "designer", createdBy: created("lead-a") },
];

describe("agentManagers", () => {
  it("reports to the creator when no manager is set", () => {
    expect(Object.fromEntries(agentManagers(team))).toEqual({
      director: null,
      "lead-a": "director",
      "lead-b": "director",
      designer: "lead-a",
    });
  });

  it("takes a set manager over the creator, and null as the top level", () => {
    const managers = agentManagers([
      ...team.slice(0, 3),
      { id: "designer", createdBy: created("lead-a"), reportsToAgentId: "lead-b" },
      { id: "auditor", createdBy: created("director"), reportsToAgentId: null },
    ]);
    expect(managers.get("designer")).toBe("lead-b");
    expect(managers.get("auditor")).toBeNull();
  });

  it("puts an agent whose manager is gone or in another space at the top level", () => {
    // The list holds one space's agents, so a manager outside it reads as missing.
    const managers = agentManagers([
      { id: "orphan", createdBy: created("deleted-agent") },
      { id: "moved", reportsToAgentId: "agent-of-other-space" },
      { id: "self", reportsToAgentId: "self" },
    ]);
    expect([...managers.values()]).toEqual([null, null, null]);
  });

  it("cuts a loop at the line from the creator before a line someone set", () => {
    const managers = agentManagers([
      { id: "a", reportsToAgentId: "b" },
      { id: "b", createdBy: created("c") },
      { id: "c", reportsToAgentId: "a" },
    ]);
    expect(Object.fromEntries(managers)).toEqual({ a: "b", b: null, c: "a" });
  });

  it("cuts a loop of set lines at the first agent of the list", () => {
    const managers = agentManagers([
      { id: "x", reportsToAgentId: "y" },
      { id: "y", reportsToAgentId: "x" },
      { id: "z", reportsToAgentId: "y" },
    ]);
    expect(Object.fromEntries(managers)).toEqual({ x: null, y: "x", z: "y" });
  });
});

describe("agentManagerRefusal", () => {
  const oneSpace = () => true;

  it("allows a manager in the same space and the top level", () => {
    expect(agentManagerRefusal(team, "designer", "lead-b", oneSpace)).toBeNull();
    expect(agentManagerRefusal(team, "lead-a", null, oneSpace)).toBeNull();
  });

  it("refuses the agent itself, an unknown agent and an agent of another space", () => {
    expect(agentManagerRefusal(team, "lead-a", "lead-a", oneSpace)).toBe("self");
    expect(agentManagerRefusal(team, "lead-a", "deleted-agent", oneSpace)).toBe("unknown");
    const spaces: Record<string, string> = {
      director: "sales",
      "lead-a": "sales",
      "lead-b": "design",
      designer: "sales",
    };
    const sameSpace = (left: string, right: string) => spaces[left] === spaces[right];
    expect(agentManagerRefusal(team, "lead-a", "lead-b", sameSpace)).toBe("other-space");
  });

  it("refuses a manager that reports to the agent, also through the creator line", () => {
    expect(agentManagerRefusal(team, "director", "designer", oneSpace)).toBe("cycle");
    expect(agentManagerRefusal(team, "lead-a", "designer", oneSpace)).toBe("cycle");
    // Once the designer reports to lead-b, lead-a may report to it.
    const moved = team.map((agent) => (agent.id === "designer" ? { ...agent, reportsToAgentId: "lead-b" } : agent));
    expect(agentManagerRefusal(moved, "lead-a", "designer", oneSpace)).toBeNull();
  });
});

describe("agent-reports-to-v1 on protocol 8", () => {
  it("sends a manager change alone, and the host reads it back", () => {
    const body = JSON.parse(
      encodeTeamProtocolV8CurrentHttpRequest("PATCH", "/v1/agents/lead-a", {
        agentId: "lead-a",
        reportsToAgentId: "lead-b",
      }),
    );
    expect(body).toEqual({ reportsToAgentId: "lead-b" });
    expect(decodeTeamProtocolV8CurrentHttpRequest("PATCH", "/v1/agents/lead-a", { reportsToAgentId: null })).toEqual({
      reportsToAgentId: null,
    });
    expect(() =>
      encodeTeamProtocolV8CurrentHttpRequest("PATCH", "/v1/agents/lead-a", { agentId: "lead-a", reportsToAgentId: 4 }),
    ).toThrow();
  });

  it("keeps the manager and the creator beside the frozen agent list", () => {
    const agent = {
      id: "designer",
      name: "Designer",
      title: "",
      description: "",
      notifications: true,
      provider: "codex",
      model: "gpt-5.5",
      reasoningEffort: "medium",
      threadId: null,
      workspacePath: "/w",
      preview: "",
      updatedAt: null,
      avatarSeed: "designer",
      avatarHue: null,
      avatarUrl: null,
      reportsToAgentId: "lead-b",
      createdBy: created("lead-a"),
    };
    const decoded = decodeTeamProtocolV8CurrentHttpResponse("GET", "/v1/agents", 200, [agent]);
    expect(decoded).toMatchObject([{ id: "designer", reportsToAgentId: "lead-b", createdBy: created("lead-a") }]);
  });
});
