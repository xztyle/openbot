// @vitest-environment node

import { tmpdir } from "node:os";
import { join } from "node:path";
import { translateFor } from "@openbot/i18n";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NotificationPreferenceStore } from "../notification-preference-store";
import { notificationIpcHandlers } from "./notification-handlers";

// Same reason as define-ipc-group.test.ts: electron cannot be imported outside an Electron process, so
// registrations are captured.
const { registrations } = vi.hoisted(() => ({
  registrations: new Map<string, (event: unknown, payload?: unknown) => unknown>(),
}));

vi.mock("electron", () => ({
  ipcMain: {
    handle(channel: string, listener: (event: unknown, payload?: unknown) => unknown) {
      registrations.set(channel, listener);
    },
  },
  // The test notification is not used here.
  Notification: { isSupported: () => false },
}));

const MAIN_ID = 1;
const OTHER_ID = 2;

function event(senderId: number, url = "openbot-app://app/index.html") {
  return { senderFrame: { url }, sender: { id: senderId } };
}

function register(mainId: number | null = MAIN_ID) {
  const badges: number[] = [];
  const { notifications } = notificationIpcHandlers({
    // Never read or written here: the badge handler does not use it.
    notificationPreference: new NotificationPreferenceStore(join(tmpdir(), "openbot-badge-test-unused.json")),
    translate: translateFor("en"),
    requestPermission: async () => undefined,
    openExternal: async () => undefined,
    mainRendererId: () => mainId,
    setBadgeCount: (count) => {
      badges.push(count);
    },
  });
  for (const [name, bind] of Object.entries(notifications)) bind(`notifications:${name}`);
  const call = (senderId: number, payload: unknown, url?: string) => {
    const listener = registrations.get("notifications:setBadgeCount");
    if (!listener) throw new Error("No badge handler.");
    return listener(event(senderId, url), payload);
  };
  return { badges, call };
}

beforeEach(() => registrations.clear());

describe("badge count handler", () => {
  it("takes the count only from the main window", async () => {
    const { badges, call } = register();
    expect(() => call(OTHER_ID, 3)).toThrow("outside the main renderer");
    await call(MAIN_ID, 3);
    await call(MAIN_ID, 0);
    expect(badges).toEqual([3, 0]);
  });

  it("refuses every sender while there is no main window", () => {
    const { badges, call } = register(null);
    expect(() => call(MAIN_ID, 1)).toThrow("outside the main renderer");
    expect(badges).toEqual([]);
  });

  it("checks the sender before it decodes the count, and refuses a count that is not one", async () => {
    const { badges, call } = register();
    expect(() => call(OTHER_ID, "many")).toThrow("outside the main renderer");
    expect(() => call(MAIN_ID, -1)).toThrow("Badge count is required.");
    expect(() => call(MAIN_ID, 1.5)).toThrow("Badge count is required.");
    expect(() => call(MAIN_ID, "3")).toThrow("Badge count is required.");
    await call(MAIN_ID, 1_000_000);
    expect(badges).toEqual([9_999]);
  });

  it("rejects a renderer outside the app", () => {
    const { badges, call } = register();
    expect(() => call(MAIN_ID, 1, "https://evil.example/")).toThrow("untrusted renderer");
    expect(badges).toEqual([]);
  });
});
