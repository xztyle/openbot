// @vitest-environment node
import { DEFAULT_GUARDRAIL_POLICY } from "@openbot/contracts/guardrails";
import { describe, expect, it } from "vitest";
import type { ThreadItem } from "../protocol";
import { toolInputDigest, toolResultFields } from "./tool-fingerprint";
import { TurnWatch } from "./turn-watch";

const policy = DEFAULT_GUARDRAIL_POLICY;

describe("the stuck watch's fingerprint of a Claude call", () => {
  it("ignores the description Claude rewrites on each call of its own tools", () => {
    const first = toolInputDigest("Bash", { command: "cat /etc/hostname", description: "call 1 of 12" });
    expect(toolInputDigest("Bash", { command: "cat /etc/hostname", description: "call 2 of 12" })).toBe(first);
    expect(toolInputDigest("Bash", { command: "cat /etc/hosts", description: "call 1 of 12" })).not.toBe(first);
    // An MCP tool's description field is part of what it does.
    expect(toolInputDigest("mcp__motion__issues_create", { title: "A", description: "x" })).not.toBe(
      toolInputDigest("mcp__motion__issues_create", { title: "A", description: "y" }),
    );
  });

  it("nudges at 5 and stops at 10 identical shell calls whose descriptions differ", () => {
    const watch = new TurnWatch(() => policy);
    watch.start("turn", "agent", false);
    const verdicts: string[] = [];
    for (let call = 1; call <= 10; call += 1) {
      const input = { command: "cat /etc/hostname", description: `Print hostname (call ${call} of 12)` };
      const started: ThreadItem = {
        id: `c${call}`,
        type: "toolCall",
        name: "Bash",
        command: input.command,
        inputDigest: toolInputDigest("Bash", input),
      };
      watch.tool("turn", started, false);
      const completed: ThreadItem = {
        id: `c${call}`,
        type: "toolCall",
        name: "Bash",
        ...toolResultFields("Bash", input.command, "host\n"),
      };
      const verdict = watch.tool("turn", completed, true);
      if (verdict) verdicts.push(`${call}:${verdict.kind}`);
    }
    expect(verdicts).toEqual(["5:nudge", "10:stop"]);
  });
});
