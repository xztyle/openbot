import { DEFAULT_OWNER_AWAY_SETTINGS, OWNER_AWAY_ROUTES } from "@openbot/contracts/team-protocol/owner-away-v1";
import type { TeamApiRequest } from "@openbot/team-client/team-api-requests";
import { createRoot, flush } from "solid-js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createOwnerAwayStore } from "./owner-away-store";

// Failure mode: the owner comes back to the app while the connection is still down, the "I am here"
// call fails, and the store still counts it as told: for four minutes no other call says the owner is
// back, so the "When you're back" bundle and its welcome wait.
describe("createOwnerAwayStore", () => {
  beforeEach(() => {
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
  });

  it("tells the host again after a call that failed", async () => {
    const paths: string[] = [];
    let fail = true;
    const request: TeamApiRequest = async (_method, path, decode) => {
      paths.push(path);
      if (fail) throw new Error("offline");
      return decode({
        settings: DEFAULT_OWNER_AWAY_SETTINGS,
        systemTimezone: "Europe/Madrid",
        focusUntil: null,
        quiet: null,
        held: [],
        suppressed: { count: 0, since: null },
      });
    };
    const dispose = createRoot((dispose) => {
      createOwnerAwayStore({ request: () => request, enabled: () => true, hostId: () => "host-1" });
      return dispose;
    });
    flush();
    await Promise.resolve();
    await Promise.resolve();
    expect(paths).toEqual([OWNER_AWAY_ROUTES.active]);
    fail = false;
    window.dispatchEvent(new Event("focus"));
    await Promise.resolve();
    expect(paths).toEqual([OWNER_AWAY_ROUTES.active, OWNER_AWAY_ROUTES.active]);
    // Told now: the next focus within the time does not ask again.
    await new Promise((done) => setTimeout(done, 0));
    window.dispatchEvent(new Event("focus"));
    expect(paths).toHaveLength(2);
    dispose();
  });

  it("reads the state when it cannot tell", () => {
    const paths: string[] = [];
    vi.spyOn(document, "hasFocus").mockReturnValue(false);
    const request: TeamApiRequest = async (_method, path) => {
      paths.push(path);
      throw new Error("offline");
    };
    const dispose = createRoot((dispose) => {
      createOwnerAwayStore({ request: () => request, enabled: () => true, hostId: () => "host-1" });
      return dispose;
    });
    flush();
    expect(paths).toEqual([OWNER_AWAY_ROUTES.state]);
    dispose();
  });
});
