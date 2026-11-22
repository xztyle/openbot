// @vitest-environment node
import { describe, expect, it } from "vitest";
import { toolStepView } from "./thread-items";

describe("toolStepView", () => {
  it("names the file of a Claude file tool from the path the Claude client puts on the item", () => {
    expect(
      toolStepView({ id: "t", type: "toolCall", name: "Write", arguments: { file_path: "/ws/qa-hooks.md" } }),
    ).toEqual({ category: "file", label: "/ws/qa-hooks.md" });
    expect(toolStepView({ id: "t", type: "toolCall", name: "Write" })).toEqual({ category: "file", label: "Write" });
  });
});
