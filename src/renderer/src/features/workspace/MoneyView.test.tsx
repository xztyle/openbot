import { MoneyView } from "@openbot/ui/features/workspace/MoneyView";
import { fireEvent, render, screen } from "@solidjs/testing-library";
import { describe, expect, it, vi } from "vitest";

function setup(failed: boolean) {
  const onRetry = vi.fn();
  render(() => <MoneyView report={null} failed={failed} onRetry={onRetry} todayUsd={0} spend={[]} agents={[]} />);
  return onRetry;
}

describe("MoneyView", () => {
  it("says the costs did not load, with Retry, instead of no cost", () => {
    const onRetry = setup(true);
    expect(screen.getByText("The costs did not load. The figures here may be missing.")).toBeTruthy();
    expect(screen.queryByText("No cost in this period")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it("says no cost when the report loaded empty", () => {
    setup(false);
    expect(screen.getByText("No cost in this period")).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
