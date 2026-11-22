import { describe, expect, it } from "vitest";
import { nextClockTime } from "./owner-away-store";

// Failure mode: "Focus until tomorrow" ends at 08:00 of the browser's zone while the host ends quiet
// hours at 08:00 of their own zone (the server's, often UTC): five hours apart in Bogotá.
describe("nextClockTime", () => {
  it("finds the next clock time in the quiet hours' zone", () => {
    // 22:00 in Bogotá is 03:00 UTC.
    const now = Date.parse("2026-11-23T03:00:00Z");
    expect(new Date(nextClockTime("08:00", now, "UTC")).toISOString()).toBe("2026-11-23T08:00:00.000Z");
    expect(new Date(nextClockTime("08:00", now, "America/Bogota")).toISOString()).toBe("2026-11-23T13:00:00.000Z");
    expect(new Date(nextClockTime("02:00", now, "UTC")).toISOString()).toBe("2026-11-24T02:00:00.000Z");
  });

  it("crosses a daylight saving change", () => {
    // Madrid moves from UTC+2 to UTC+1 on 25 October 2026.
    const now = Date.parse("2026-10-24T20:00:00Z");
    expect(new Date(nextClockTime("08:00", now, "Europe/Madrid")).toISOString()).toBe("2026-10-25T07:00:00.000Z");
  });

  it("uses the browser's zone for an unknown zone", () => {
    const now = Date.parse("2026-11-23T03:00:00Z");
    expect(nextClockTime("08:00", now, "Not/AZone")).toBe(nextClockTime("08:00", now));
  });
});
