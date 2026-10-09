import { describe, expect, it } from "vitest";
import { toolFailure, toolProgressText } from "./thread-items";

describe("toolFailure", () => {
  it("names the tool and the provider's own reason, redacted", () => {
    const item = {
      type: "mcpToolCall",
      server: "github",
      tool: "create_issue",
      status: "failed",
      error: { message: "401 Bad credentials for token ghp_abcdefgh1234567890\nsecond line" },
    };
    const failure = toolFailure(item);
    expect(failure?.tool).toBe("github.create_issue");
    expect(failure?.reason).toContain("Bad credentials");
    expect(failure?.reason).not.toContain("ghp_abcdefgh1234567890");
    expect(failure?.reason).not.toContain("second line");
  });

  it("reads a dynamic tool that answered success false, a Claude error result and a failed command", () => {
    expect(
      toolFailure({
        type: "dynamicToolCall",
        namespace: "openbot",
        tool: "send_message",
        status: "completed",
        success: false,
        contentItems: [{ type: "inputText", text: "Unknown agent: ghost" }],
      }),
    ).toEqual({ tool: "openbot.send_message", reason: "Unknown agent: ghost" });
    expect(
      toolFailure({ type: "toolCall", name: "mcp__openbot__list_agents", status: "failed", error: "Transport closed" }),
    ).toEqual({ tool: "openbot.list_agents", reason: "Transport closed" });
    expect(
      toolFailure({ type: "commandExecution", status: "failed", exitCode: 2, aggregatedOutput: "a\nnpm ERR! boom\n" }),
    ).toEqual({ tool: "command", reason: "exit code 2: npm ERR! boom" });
  });

  it("ignores a step that did not fail, including one the user declined", () => {
    expect(toolFailure({ type: "toolCall", name: "Bash", status: "completed" })).toBeNull();
    expect(toolFailure({ type: "commandExecution", status: "declined" })).toBeNull();
    expect(toolFailure({ type: "agentMessage", text: "hello" })).toBeNull();
  });

  it("puts the reason on the activity line only when the step is complete", () => {
    const item = { type: "toolCall", name: "mcp__openbot__x", status: "failed", error: "Transport closed" };
    expect(toolProgressText(item, true)).toBe("A tool step failed: openbot.x. Transport closed");
    expect(toolProgressText({ ...item, error: "" }, true)).toBe(
      "A tool step failed (openbot.x). Deciding what to try next…",
    );
    expect(toolProgressText(item, false)).not.toContain("failed");
  });
});
