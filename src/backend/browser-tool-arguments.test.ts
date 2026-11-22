// @vitest-environment node
import { describe, expect, it } from "vitest";
import { parseBrowserToolCall } from "./browser-tools";

// Failure mode: in prod transcripts evaluate failed for timeoutMs above 30000, and click failed for a
// target without kind or revision with an error that did not show the target's form.
describe("browser tool arguments", () => {
  it("waits the longest allowed time for a timeout above the limit", () => {
    expect(parseBrowserToolCall("evaluate", { tabId: "tab", expression: "1", timeoutMs: 60_000 }).args).toMatchObject({
      timeoutMs: 30_000,
    });
  });

  it("shows the target forms when a target is wrong", () => {
    expect(() => parseBrowserToolCall("click", { tabId: "tab", target: { kind: "ref", ref: "e1" } })).toThrow(
      /A target is an object, such as \{"kind":"ref","ref":"e12","revision":3\}/,
    );
    expect(() => parseBrowserToolCall("click", { tabId: "tab", target: "Sign in", timeoutMs: 60_000 })).toThrow(
      /A target is an object/,
    );
  });
});
