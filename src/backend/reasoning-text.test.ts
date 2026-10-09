import { describe, expect, it } from "vitest";
import { boundedReasoningText, REASONING_TEXT_LIMIT } from "./reasoning-text";

describe("boundedReasoningText", () => {
  it("masks a secret the model quoted before the text is stored", () => {
    const text = boundedReasoningText(
      "The env file sets API_KEY=hunter2hunter2 and the header is Bearer abcdef123456.",
    );
    expect(text).not.toContain("hunter2hunter2");
    expect(text).not.toContain("abcdef123456");
    expect(text).toContain("The env file sets");
  });

  it("cuts a long thought at the limit and marks the cut", () => {
    const long = "word ".repeat(REASONING_TEXT_LIMIT);
    const bounded = boundedReasoningText(long);
    expect(bounded.length).toBeLessThan(REASONING_TEXT_LIMIT + 20);
    expect(bounded.endsWith("[…]")).toBe(true);
    expect(boundedReasoningText("short thought")).toBe("short thought");
  });
});
