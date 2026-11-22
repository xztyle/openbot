import { goalGap } from "@openbot/ui/features/workspace/TodayView";
import { describe, expect, it } from "vitest";

// Failure mode: in the evening west of UTC, a goal due tomorrow says "0 days left": the deadline day
// was counted from the UTC hour, which is already the next day.
const BOGOTA = "America/Bogota";

describe("goalGap", () => {
  it("counts calendar days from the reader's own day", () => {
    const goal = { target: 10, current: 4, deadline: "2026-11-30" };
    // 20:00 in Bogotá on the 29th is 01:00 UTC on the 30th.
    expect(goalGap(goal, Date.parse("2026-11-30T01:00:00Z"), BOGOTA)).toEqual({ needed: 6, days: 1 });
    expect(goalGap(goal, Date.parse("2026-11-29T14:00:00Z"), BOGOTA)).toEqual({ needed: 6, days: 1 });
    expect(goalGap(goal, Date.parse("2026-11-30T23:00:00Z"), BOGOTA)).toEqual({ needed: 6, days: 0 });
    expect(goalGap(goal, Date.parse("2026-11-20T04:59:00Z"), BOGOTA)).toEqual({ needed: 6, days: 11 });
    expect(goalGap(goal, Date.parse("2026-12-02T12:00:00Z"), BOGOTA)).toEqual({ needed: 6, days: 0 });
  });

  it("has no days without a deadline and no gap once done", () => {
    expect(goalGap({ target: 10, current: 4, deadline: null }, Date.now())).toEqual({ needed: 6, days: null });
    expect(goalGap({ target: 10, current: 10, deadline: "2026-11-30" }, Date.now())).toBeNull();
  });
});
