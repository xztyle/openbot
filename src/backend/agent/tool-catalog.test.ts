// @vitest-environment node
import type { AgentSummary } from "@openbot/contracts/ipc";
import type { DynamicRecord } from "@openbot/contracts/runtime-values";
import { describe, expect, it } from "vitest";
import type { DynamicToolCallParams } from "../protocol";
import { discoverTools, resolveDeferredTool, ToolDiscoveryError } from "./tool-catalog";

const agent: AgentSummary = {
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

const call = (tool: string, args: DynamicRecord): DynamicToolCallParams => ({
  threadId: "thread",
  turnId: "turn",
  callId: "call",
  namespace: "openbot",
  tool,
  arguments: args,
});

const described = (args: DynamicRecord) => {
  const result = discoverTools(call("tool_describe", args), agent);
  return "tools" in result ? result.tools.map((tool) => tool.name) : [];
};

// Failure mode: in prod transcripts agents sent tool_describe `name` instead of `names`, a JSON-encoded
// string, or a name that is not in the catalog, and got one generic error that did not say what to fix.
describe("tool_describe", () => {
  it("reads one name, a string, a JSON-encoded array and bare tool names", () => {
    expect(described({ names: ["openbot.create_agent"] })).toEqual(["openbot.create_agent"]);
    expect(described({ name: "openbot.create_agent" })).toEqual(["openbot.create_agent"]);
    expect(described({ names: '["openbot.create_agent","openbot_browser.open"]' })).toEqual([
      "openbot.create_agent",
      "openbot_browser.open",
    ]);
    expect(described({ names: "openbot.create_agent, openbot_browser.open" })).toEqual([
      "openbot.create_agent",
      "openbot_browser.open",
    ]);
    expect(described({ names: ["create_agent", "mcp__openbot_browser__list_tabs"] })).toEqual([
      "openbot.create_agent",
      "openbot_browser.list_tabs",
    ]);
  });

  it("names an unknown tool and suggests similar ones", () => {
    expect(() => described({ names: ["openbot_browser.open_tab"] })).toThrow(ToolDiscoveryError);
    expect(() => described({ names: ["openbot_browser.open_tab"] })).toThrow(
      /"openbot_browser\.open_tab" is not a built-in tool\. Similar tools: .*openbot_browser\.open/,
    );
    expect(() => described({})).toThrow(/tool_describe needs names/);
  });
});

describe("tool_call", () => {
  it("decodes JSON-encoded arguments", () => {
    const resolved = resolveDeferredTool(
      call("tool_call", { name: "openbot_browser.list_tabs", arguments: '{"includeClosed":false}' }),
    );
    expect(resolved).toMatchObject({
      kind: "call",
      params: { namespace: "openbot_browser", tool: "list_tabs", arguments: { includeClosed: false } },
    });
  });

  it("runs the discovery tools", () => {
    expect(
      resolveDeferredTool(call("tool_call", { name: "openbot.tool_search", arguments: { query: "mail" } })),
    ).toMatchObject({ kind: "discovery", params: { tool: "tool_search", arguments: { query: "mail" } } });
  });

  it("says how to correct an unknown name or bad arguments", () => {
    expect(resolveDeferredTool(call("tool_call", { name: "openbot_browser.new_tab", arguments: {} }))).toMatchObject({
      kind: "invalid",
      message: expect.stringMatching(/"openbot_browser\.new_tab" is not a built-in tool/),
    });
    expect(
      resolveDeferredTool(call("tool_call", { name: "openbot.send_message", arguments: "not json" })),
    ).toMatchObject({ kind: "invalid", message: expect.stringMatching(/arguments must be a JSON object/) });
  });
});
