// @vitest-environment node
import { describe, expect, it } from "vitest";
import { claudePushedWindows, claudeRateLimits } from "./claude-client";

const RESET = "2026-11-29T14:00:00Z";

describe("Claude weekly window", () => {
  it("shows the overall weekly window when it is more used than the model family's", () => {
    const reading = claudeRateLimits(
      {
        rate_limits_available: true,
        rate_limits: {
          five_hour: null,
          seven_day: { utilization: 95, resets_at: RESET },
          seven_day_sonnet: { utilization: 30, resets_at: RESET },
        },
      },
      "claude-sonnet-5-5",
    );
    expect(reading.rateLimits?.secondary?.usedPercent).toBe(95);
  });

  it("keeps the family window when it is the more used one", () => {
    const reading = claudeRateLimits(
      {
        rate_limits_available: true,
        rate_limits: {
          seven_day: { utilization: 40, resets_at: RESET },
          seven_day_opus: { utilization: 97, resets_at: RESET },
        },
      },
      "claude-opus-5-5",
    );
    expect(reading.rateLimits?.secondary?.usedPercent).toBe(97);
  });

  it("reads the overall window of a pushed event when the family window is not pushed", () => {
    const windows = claudePushedWindows(
      { unifiedWindows: { seven_day: { utilization: 0.95, resetsAt: 1_795_000_000 } } },
      "seven_day_sonnet",
    );
    expect(windows?.secondary?.usedPercent).toBeCloseTo(95);
  });
});
