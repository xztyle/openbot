import { isDynamicRecord } from "@openbot/contracts/runtime-values";
import { createRoot, createSignal, flush } from "solid-js";
import { afterEach, describe, expect, it } from "vitest";
import { createWorkspaceFrecency } from "./workspace-frecency";

// Failure mode: Jump to forgets the conversations the reader visits most: the first visit of a page
// replaced the stored visits, or a switch of server carried the visits of the server before.

const KEY = "openbot.workspace.visits.v1";
const settle = async () => {
  for (let index = 0; index < 5; index += 1) await Promise.resolve();
  flush();
};

/** The conversations that this computer keeps visits of, for one reader and server. */
const storedIds = (key: string) => {
  const value = JSON.parse(window.localStorage.getItem(`${KEY}:${key}`) ?? "{}");
  return isDynamicRecord(value) ? Object.keys(value).sort() : [];
};

afterEach(() => window.localStorage.clear());

describe("workspace frecency", () => {
  it("keeps the stored visits when the page opens on a conversation", async () => {
    const earlier = Date.now() - 3_600_000;
    window.localStorage.setItem(`${KEY}:reader:host`, JSON.stringify({ general: [earlier], launch: [earlier - 1] }));
    const { frecency, dispose } = createRoot((dispose) => ({
      frecency: createWorkspaceFrecency({ storageKey: () => "reader:host", active: () => "agent:lucia" }),
      dispose,
    }));
    await settle();
    expect(frecency.recent()).toEqual(["agent:lucia", "general", "launch"]);
    expect(storedIds("reader:host")).toEqual(["agent:lucia", "general", "launch"]);
    dispose();
  });

  it("does not carry one server's visits to another", async () => {
    window.localStorage.setItem(`${KEY}:reader:one`, JSON.stringify({ general: [Date.now() - 3_600_000] }));
    const [key, setKey] = createSignal("reader:one", { ownedWrite: true });
    const [active, setActive] = createSignal<string | undefined>(undefined, { ownedWrite: true });
    const { frecency, dispose } = createRoot((dispose) => ({
      frecency: createWorkspaceFrecency({ storageKey: key, active }),
      dispose,
    }));
    await settle();
    expect(frecency.recent()).toEqual(["general"]);
    // The reader switches to another server, which opens its own conversation in the same step.
    setKey("reader:two");
    setActive("support");
    await settle();
    expect(frecency.recent()).toEqual(["support"]);
    expect(storedIds("reader:two")).toEqual(["support"]);
    dispose();
  });
});
