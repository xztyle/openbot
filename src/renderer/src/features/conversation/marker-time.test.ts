import { createFormat, translateFor } from "@openbot/i18n";
import { formatMarkerTimeRange } from "@openbot/ui/features/conversation/marker-time";
import { describe, expect, it } from "vitest";

// Failure mode: a row of several messages sits where its first message sorts but shows only the time
// of the newest one, so it reads as out of order next to the rows after it.
const t = translateFor("en");
const format = createFormat("en");
const at = (hour: number, minute: number) => {
  const date = new Date();
  date.setHours(hour, minute, 30, 0);
  return date.toISOString();
};
const clock = (hour: number, minute: number) =>
  format.date(new Date(at(hour, minute)), { hour: "2-digit", minute: "2-digit" });

describe("marker time range", () => {
  it("shows the first and the newest time of a row", () => {
    expect(formatMarkerTimeRange(at(5, 11), at(5, 30), t, format)).toBe(`${clock(5, 11)}–${clock(5, 30)}`);
  });

  it("shows one time when both read the same, or when the first is unknown", () => {
    expect(formatMarkerTimeRange(at(5, 30), at(5, 30), t, format)).toBe(clock(5, 30));
    expect(formatMarkerTimeRange(undefined, at(5, 30), t, format)).toBe(clock(5, 30));
  });
});
