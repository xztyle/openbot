// @vitest-environment node
import { describe, expect, it } from "vitest";
import { normalizeSendMessageArguments } from "./openbot-tools";

// Failure mode: 94 send_message calls in two weeks failed validation because the agent wrote
// `message` for `text` or `to` for `recipientAgentIds`, and each failure cost a model round trip.
describe("send_message arguments", () => {
  it("reads the names that models guess", () => {
    expect(normalizeSendMessageArguments({ to: "agent-a", message: "Status: done", expectsReply: false })).toEqual({
      recipientAgentIds: ["agent-a"],
      text: "Status: done",
      expectsReply: false,
    });
    expect(normalizeSendMessageArguments({ recipients: ["agent-a", "agent-b"], content: "Hi" })).toEqual({
      recipientAgentIds: ["agent-a", "agent-b"],
      text: "Hi",
    });
  });

  it("keeps the canonical names when both are given, and adds nothing that is missing", () => {
    expect(
      normalizeSendMessageArguments({ recipientAgentIds: ["agent-a"], to: "agent-b", text: "A", message: "B" }),
    ).toEqual({ recipientAgentIds: ["agent-a"], text: "A" });
    expect(normalizeSendMessageArguments({ expectsReply: true })).toEqual({ expectsReply: true });
  });
});

// Failure mode: Claude's MCP layer refused a call that sent one id as recipientAgentIds, or "true" for
// expectsReply, before the tool could read it.
describe("send_message argument types", () => {
  it("reads one id, a JSON-encoded id list and boolean text", () => {
    expect(
      normalizeSendMessageArguments({ recipientAgentIds: "agent-a", text: "Hi", expectsReply: "false", fyi: "true" }),
    ).toEqual({ recipientAgentIds: ["agent-a"], text: "Hi", expectsReply: false, fyi: true });
    expect(normalizeSendMessageArguments({ recipientAgentIds: '["agent-a","agent-b"]', text: "Hi" })).toEqual({
      recipientAgentIds: ["agent-a", "agent-b"],
      text: "Hi",
    });
  });
});
