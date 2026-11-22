// @vitest-environment node
import { describe, expect, it } from "vitest";
import { parseBrowserToolCall } from "./browser-tools";

// Failure mode: with no pause in the browser tools, an agent waited for the text "zzzzqqq" with a
// 30 s timeout as a sleep, 85 times, and each scraped page cost a model step of its own.
describe("browser waits and loops", () => {
  it("accepts a plain pause, in wait_for and as a step", () => {
    expect(parseBrowserToolCall("wait_for", { tabId: "tab-1", delayMs: 30_000 }).args).toMatchObject({
      delayMs: 30_000,
    });
    expect(
      parseBrowserToolCall("run_steps", { tabId: "tab-1", steps: [{ action: "wait_for", delayMs: 2_000 }] }).args,
    ).toMatchObject({ steps: [{ delayMs: 2_000 }] });
    expect(() => parseBrowserToolCall("wait_for", { tabId: "tab-1", delayMs: 600_000 })).toThrow();
  });

  it("accepts a repeated evaluation within its limit", () => {
    expect(
      parseBrowserToolCall("evaluate", { tabId: "tab-1", expression: "1", repeat: 50, intervalMs: 500 }).args,
    ).toMatchObject({ repeat: 50, intervalMs: 500 });
    expect(() => parseBrowserToolCall("evaluate", { tabId: "tab-1", expression: "1", repeat: 51 })).toThrow();
  });
});
