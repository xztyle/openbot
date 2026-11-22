import { TodayView } from "@openbot/ui/features/workspace/TodayView";
import { TextProvider } from "@openbot/ui/text";
import { render, screen } from "@solidjs/testing-library";
import { afterEach, describe, expect, it, vi } from "vitest";

// Failure mode: Today stays mounted behind the phone's tabs; the next morning it still greets
// "Good evening" with yesterday's date.
describe("Today's greeting and date", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("follow the clock while Today stays open", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
    vi.setSystemTime(new Date("2026-11-22T21:30:00Z"));
    render(() => (
      <TextProvider locale="en" formatLocale="en-US">
        <TodayView name="Ale" decisions={[]} working={[]} report={null} shipped={[]} />
      </TextProvider>
    ));
    expect(screen.getByText(/Sunday, November 22/u)).toBeTruthy();
    vi.setSystemTime(new Date("2026-11-23T08:30:00Z"));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(screen.getByText(/Monday, November 23/u)).toBeTruthy();
    expect(screen.queryByText(/Sunday, November 22/u)).toBeNull();
  });
});
