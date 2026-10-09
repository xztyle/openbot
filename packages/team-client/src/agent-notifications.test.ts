// @vitest-environment node

import type { AgentEvent, AgentSummary } from "@openbot/contracts/ipc";
import { translateFor } from "@openbot/i18n";
import { describe, expect, it } from "vitest";
import { notificationForAgentEvent } from "./agent-notifications";

const agent = {
  id: "chief",
  provider: "codex",
  name: "Chief",
  notifications: true,
  title: "Lead",
  description: "",
  model: "gpt-5.6-luna",
  reasoningEffort: "medium",
  threadId: "thread-chief",
  workspacePath: "/tmp/chief",
  preview: "",
  updatedAt: null,
  avatarSeed: "chief",
  avatarHue: null,
  avatarUrl: null,
} satisfies AgentSummary;

const prompt: AgentEvent = {
  type: "prompt",
  agentId: "chief",
  threadId: "thread-chief",
  turnId: "turn-1",
  requestId: 1,
  questions: [],
};

describe("notificationForAgentEvent", () => {
  const translate = translateFor("en");
  const target = { agentId: "chief", threadId: "thread-chief" };

  it("surfaces finished and failed work and prompts at the all level", () => {
    expect(notificationForAgentEvent(completed("completed"), [agent], translate, "all")).toEqual({
      title: "Chief",
      body: "Finished working.",
      ...target,
    });
    expect(notificationForAgentEvent(completed("failed"), [agent], translate, "all")).toEqual({
      title: "Chief",
      body: "Stopped with an error.",
      ...target,
    });
    expect(notificationForAgentEvent(prompt, [agent], translate, "all")).toEqual({
      title: "Chief",
      body: "Needs your input.",
      ...target,
    });
  });

  it("keeps only events that wait for the user at the needs-me level", () => {
    expect(notificationForAgentEvent(prompt, [agent], translate, "needs-me")).toEqual({
      title: "Chief",
      body: "Needs your input.",
      ...target,
    });
    expect(notificationForAgentEvent(completed("completed"), [agent], translate, "needs-me")).toBeNull();
    expect(notificationForAgentEvent(completed("failed"), [agent], translate, "needs-me")).toBeNull();
  });

  it("tells the user at the needs-me level when unattended work failed, and only then", () => {
    const failedRoutine: AgentEvent = { ...completed("failed"), origin: "routine" };
    expect(notificationForAgentEvent(failedRoutine, [agent], translate, "needs-me")).toEqual({
      title: "Chief",
      body: "A scheduled run stopped with an error.",
      ...target,
    });
    expect(notificationForAgentEvent(failedRoutine, [agent], translate, "all")?.body).toBe(
      "A scheduled run stopped with an error.",
    );
    expect(
      notificationForAgentEvent({ ...completed("failed"), origin: "user" }, [agent], translate, "needs-me"),
    ).toBeNull();
    for (const [code, body] of [
      ["event_check_failing", "An event check keeps failing."],
      ["event_check_delivery_failed", "An event check could not give an event to the agent."],
      ["event_check_turn_failed", "An event check turn stopped with an error."],
    ] as const) {
      const event: AgentEvent = { type: "error", agentId: "chief", code, message: "A host message." };
      expect(notificationForAgentEvent(event, [agent], translate, "needs-me")).toMatchObject({ title: "Chief", body });
      // The server level and the agent's own switch still apply.
      expect(notificationForAgentEvent(event, [agent], translate, "nothing")).toBeNull();
      expect(notificationForAgentEvent(event, [{ ...agent, notifications: false }], translate, "needs-me")).toBeNull();
    }
    const other: AgentEvent = { type: "error", agentId: "chief", code: "agent_error", message: "Oops" };
    expect(notificationForAgentEvent(other, [agent], translate, "all")).toBeNull();
  });

  it("stays quiet at the nothing level, for disabled agents, stopped turns, and unrelated events", () => {
    expect(notificationForAgentEvent(prompt, [agent], translate, "nothing")).toBeNull();
    expect(
      notificationForAgentEvent(completed("completed"), [{ ...agent, notifications: false }], translate, "all"),
    ).toBeNull();
    expect(notificationForAgentEvent(completed("interrupted"), [agent], translate, "all")).toBeNull();
    // A quiet routine run posted nothing to look at.
    expect(notificationForAgentEvent({ ...completed("completed"), quiet: true }, [agent], translate, "all")).toBeNull();
    expect(notificationForAgentEvent({ type: "agents-changed", agents: [] }, [agent], translate, "all")).toBeNull();
  });
});

describe("notifications for a delegation chain", () => {
  const translate = translateFor("en");

  it("says Finished only after the turn that leaves the agent idle", () => {
    const busy = { ...completed("completed"), moreWork: true as const };
    expect(notificationForAgentEvent(busy, [agent], translate, "all")).toBeNull();
    expect(notificationForAgentEvent(completed("completed"), [agent], translate, "all")?.body).toBe(
      "Finished working.",
    );
    // A failure is news whatever else is queued.
    expect(notificationForAgentEvent({ ...busy, status: "failed" }, [agent], translate, "all")?.body).toBe(
      "Stopped with an error.",
    );
  });
});

describe("notification text", () => {
  const translate = translateFor("en");
  const redact = (text: string) => text.replace("sk-secret-token", "[redacted]");
  const detail = { redact };
  const ask = (overrides: Partial<Extract<AgentEvent, { type: "prompt" }>["questions"][number]> = {}): AgentEvent => ({
    ...prompt,
    questions: [{ id: "q", header: "", question: "Deploy to staging?", isSecret: false, options: null, ...overrides }],
  });

  it("keeps the fixed words unless the user opted in", () => {
    expect(notificationForAgentEvent(ask(), [agent], translate, "all")?.body).toBe("Needs your input.");
    expect(notificationForAgentEvent(ask(), [agent], translate, "all", { detail })?.body).toBe("Deploy to staging?");
  });

  it("redacts and shortens the text, and never shows a secret question", () => {
    const long = `Use sk-secret-token ${"word ".repeat(80)}`;
    const body = notificationForAgentEvent(ask({ question: long }), [agent], translate, "all", { detail })?.body ?? "";
    expect(body).not.toContain("sk-secret-token");
    expect(body.length).toBeLessThanOrEqual(161);
    expect(body.endsWith("…")).toBe(true);
    expect(notificationForAgentEvent(ask({ isSecret: true }), [agent], translate, "all", { detail })?.body).toBe(
      "Needs your input.",
    );
  });

  it("shows the approval reason, never the command", () => {
    const approval = (reason: string | null): AgentEvent => ({
      type: "approval",
      approval: {
        requestId: 1,
        agentId: "chief",
        threadId: "thread-chief",
        turnId: "turn-1",
        kind: "command",
        command: "curl -H 'x: sk-secret-token' example.com",
        cwd: null,
        reason,
        grantRoot: null,
        permissions: null,
      },
    });
    expect(
      notificationForAgentEvent(approval("Install the package"), [agent], translate, "all", { detail })?.body,
    ).toBe("Install the package");
    expect(notificationForAgentEvent(approval(null), [agent], translate, "all", { detail })?.body).toBe(
      "Needs your approval.",
    );
  });
});

function completed(status: string): Extract<AgentEvent, { type: "turn-completed" }> {
  return {
    type: "turn-completed",
    agentId: "chief",
    threadId: "thread-chief",
    turnId: "turn-1",
    status,
  };
}
