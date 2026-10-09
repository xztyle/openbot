import { describe, expect, it } from "vitest";
import { webPushPreferences } from "./web-push";

describe("web push preferences", () => {
  it("gives the host the level of the browser, and a mute as a time or as a level of nothing", () => {
    expect(webPushPreferences({ muted: false, mutedUntil: null, level: "needs-me" }, "de")).toEqual({
      level: "needs-me",
      mutedUntil: null,
      locale: "de",
    });
    // A timed mute ends on the host by itself, so the level stays.
    expect(webPushPreferences({ muted: true, mutedUntil: 5_000, level: "all" }, "en")).toEqual({
      level: "all",
      mutedUntil: 5_000,
      locale: "en",
    });
    expect(webPushPreferences({ muted: true, mutedUntil: null, level: "all" }, "en")).toEqual({
      level: "nothing",
      mutedUntil: null,
      locale: "en",
    });
  });
});
