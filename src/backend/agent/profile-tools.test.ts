// @vitest-environment node
import type { AgentSummary } from "@openbot/contracts/ipc";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { newAgentLimits, profileToolErrorMessage } from "./profile-tools";

const caller: AgentSummary = {
  id: "chief",
  provider: "claude",
  name: "Chief",
  title: "Coordinator",
  description: "",
  notifications: true,
  model: "claude-test",
  reasoningEffort: "medium",
  threadId: "openbot-thread-chief",
  workspacePath: "/tmp/openbot-chief",
  preview: "",
  updatedAt: "2026-11-22T10:00:00.000Z",
  avatarSeed: "chief",
  avatarHue: null,
  avatarUrl: null,
};

// Failure mode: every agent that create_agent made got full access and Computer Use, even when its work
// needed neither.
describe("newAgentLimits", () => {
  it("turns Computer Use off unless asked for, and keeps the caller's access", () => {
    expect(newAgentLimits(caller, {})).toEqual({ computerUse: false });
    expect(newAgentLimits(caller, { computerUse: true })).toEqual({});
    expect(newAgentLimits(caller, { access: "workspace" })).toEqual({ access: "workspace", computerUse: false });
  });

  it("never gives more than the caller has", () => {
    const limited = { ...caller, access: "workspace" as const, computerUse: false };
    expect(newAgentLimits(limited, {})).toEqual({ access: "workspace", computerUse: false });
    expect(newAgentLimits(limited, { computerUse: true })).toMatch(/do not have Computer Use/);
    expect(newAgentLimits(limited, { access: "full" })).toMatch(/cannot get full access/);
  });
});

// Failure mode: a schema failure of a tool such as install_local_skill reached the agent as raw Zod JSON,
// and the owner as a server error.
describe("profileToolErrorMessage", () => {
  it("names the field and the tool to describe", () => {
    const failure = z.strictObject({ revision: z.number() }).safeParse({ extra: 1 });
    expect(failure.success).toBe(false);
    expect(profileToolErrorMessage(failure.error, "openbot.install_local_skill")).toBe(
      'revision: Invalid input: expected number, received undefined Remove the fields that this tool does not have. Correct the arguments and retry. openbot.tool_describe with "openbot.install_local_skill" shows its schema.',
    );
  });
});
