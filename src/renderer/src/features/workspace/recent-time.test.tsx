import { useRecentTime } from "@openbot/ui/features/workspace/workspace-format";
import { TextProvider } from "@openbot/ui/text";
import { render } from "@solidjs/testing-library";
import { describe, expect, it } from "vitest";

// Failure mode: a list says "Sat" for yesterday where Slack says "Yesterday", a time next week reads
// as a weekday of this past week, and a date of last year has no year.
function recentTimes(times: number[], now: number): string[] {
  let result: string[] = [];
  function Probe() {
    const recent = useRecentTime();
    result = times.map((at) => recent(at, now));
    return null;
  }
  render(() => (
    <TextProvider locale="en" formatLocale="en-US">
      <Probe />
    </TextProvider>
  ));
  return result.map((text) => text.replace(/\s/gu, " "));
}

describe("useRecentTime", () => {
  it("names today, yesterday, this week and other days", () => {
    const now = new Date(2026, 10, 22, 10, 0).getTime();
    expect(
      recentTimes(
        [
          new Date(2026, 10, 22, 8, 5).getTime(),
          new Date(2026, 10, 21, 23, 0).getTime(),
          new Date(2026, 10, 18, 9, 0).getTime(),
          new Date(2026, 10, 29, 9, 0).getTime(),
          new Date(2025, 10, 2, 9, 0).getTime(),
          0,
        ],
        now,
      ),
    ).toEqual(["8:05 AM", "Yesterday", "Wed", "Nov 29", "Nov 2, 2025", ""]);
  });
});
