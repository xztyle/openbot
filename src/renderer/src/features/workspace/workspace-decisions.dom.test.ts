import { describe, expect, it } from "vitest";
import { dismissInjection, seenInjections } from "./workspace-decisions";

// Failure mode: a blocked prompt injection that the reader dismissed in one tab comes back on
// Today after a dismissal in another tab, which wrote its own older list over it.

const KEY = "openbot:today-seen-injections:reader:host";

describe("dismissed injections", () => {
  it("keeps the dismissals of another tab", () => {
    // This tab read the list when Today opened.
    expect([...seenInjections("reader:host")]).toEqual([]);
    // Another tab of the reader dismisses one.
    window.localStorage.setItem(KEY, JSON.stringify(["from-other-tab"]));
    dismissInjection("reader:host", "from-this-tab");
    expect(JSON.parse(window.localStorage.getItem(KEY) ?? "[]")).toEqual(["from-other-tab", "from-this-tab"]);
    expect([...seenInjections("reader:host")].sort()).toEqual(["from-other-tab", "from-this-tab"]);
  });

  it("drops the other tab's dismissal from this tab's count when it happens", () => {
    expect(seenInjections("reader:second").has("late")).toBe(false);
    window.localStorage.setItem("openbot:today-seen-injections:reader:second", JSON.stringify(["late"]));
    window.dispatchEvent(new StorageEvent("storage", { key: "openbot:today-seen-injections:reader:second" }));
    expect(seenInjections("reader:second").has("late")).toBe(true);
  });
});
