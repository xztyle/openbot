import { translateFor } from "@openbot/i18n";
import { createRoot, createSignal, flush } from "solid-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createWebTitleBadge, type WebTitleBadge } from "./web-title-badge";

// Failure mode: the installed app's icon (an iPhone Home Screen app) never shows the count that the
// tab title shows, or keeps an old count after everything was read or after sign-out.
describe("createWebTitleBadge app icon", () => {
  const t = translateFor("en");
  const install = (api: { setAppBadge: () => Promise<void>; clearAppBadge: () => Promise<void> }) => {
    Object.defineProperty(navigator, "setAppBadge", { value: api.setAppBadge, configurable: true, writable: true });
    Object.defineProperty(navigator, "clearAppBadge", { value: api.clearAppBadge, configurable: true, writable: true });
  };
  beforeEach(() => {
    // jsdom has no canvas: the tab icon is not drawn, the count is what this checks.
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
  });
  afterEach(() => {
    Reflect.deleteProperty(navigator, "setAppBadge");
    Reflect.deleteProperty(navigator, "clearAppBadge");
  });

  it("sets the icon count with the title count and clears it", () => {
    const setAppBadge = vi.fn(() => Promise.resolve());
    const clearAppBadge = vi.fn(() => Promise.resolve());
    install({ setAppBadge, clearAppBadge });
    const [badge, setBadge] = createSignal<WebTitleBadge>({ count: 0, unread: false });
    const dispose = createRoot((dispose) => {
      createWebTitleBadge({ badge, t });
      return dispose;
    });
    flush();
    expect(clearAppBadge).toHaveBeenCalledTimes(1);
    setBadge({ count: 3, unread: true });
    flush();
    expect(setAppBadge).toHaveBeenLastCalledWith(3);
    // Unread without a count is no count on the Home Screen.
    setBadge({ count: 0, unread: true });
    flush();
    expect(clearAppBadge).toHaveBeenCalledTimes(2);
    setBadge({ count: 2, unread: false });
    flush();
    expect(setAppBadge).toHaveBeenLastCalledWith(2);
    dispose();
    expect(clearAppBadge).toHaveBeenCalledTimes(3);
  });

  it("does nothing without the Badging API, and a refusal is quiet", () => {
    const [badge, setBadge] = createSignal<WebTitleBadge>({ count: 1, unread: false });
    const dispose = createRoot((dispose) => {
      createWebTitleBadge({ badge, t });
      return dispose;
    });
    flush();
    install({
      setAppBadge: vi.fn(() => Promise.reject(new Error("NotAllowedError"))),
      clearAppBadge: vi.fn(() => Promise.resolve()),
    });
    setBadge({ count: 4, unread: false });
    flush();
    dispose();
  });
});
