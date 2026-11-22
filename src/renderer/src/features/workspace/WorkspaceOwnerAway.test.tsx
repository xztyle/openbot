import { DEFAULT_OWNER_AWAY_SETTINGS, type OwnerAwayState } from "@openbot/contracts/team-protocol/owner-away-v1";
import { fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { describe, expect, it, vi } from "vitest";
import type { OwnerAwayStore } from "./owner-away-store";
import { QuietHoursSettingsDialog } from "./WorkspaceOwnerAway";

const STATE: OwnerAwayState = {
  settings: DEFAULT_OWNER_AWAY_SETTINGS,
  systemTimezone: "Europe/Madrid",
  focusUntil: null,
  quiet: null,
  held: [],
  suppressed: { count: 0, since: null },
};

function setup() {
  const saveSettings = vi.fn(async () => undefined);
  const away: OwnerAwayStore = {
    state: () => STATE,
    supported: () => true,
    setFocus: async () => undefined,
    saveSettings,
    answer: async () => undefined,
    refresh: () => undefined,
  };
  render(() => <QuietHoursSettingsDialog away={away} onClose={() => undefined} />);
  return { saveSettings };
}

describe("QuietHoursSettingsDialog", () => {
  it("says why an amount above the host's limit cannot be saved", async () => {
    const { saveSettings } = setup();
    const amount = await screen.findByDisplayValue("100");
    fireEvent.input(amount, { target: { value: "5000000" } });
    expect(await screen.findByText("Enter whole dollars, from 0 to 1,000,000.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
    fireEvent.input(amount, { target: { value: "250" } });
    await waitFor(() => expect(screen.queryByText("Enter whole dollars, from 0 to 1,000,000.")).toBeNull());
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(saveSettings).toHaveBeenCalledWith(expect.objectContaining({ urgentMoneyUsd: 250 })));
  });
});
