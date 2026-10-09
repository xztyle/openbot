import { flush } from "solid-js";
import { afterEach, describe, expect, it } from "vitest";
import {
  readShowAgentMessages,
  readShowAgentReasoning,
  setShowAgentMessages,
  setShowAgentReasoning,
  useShowAgentMessages,
  useShowAgentReasoning,
  writeShowAgentMessages,
  writeShowAgentReasoning,
} from "./chat-visibility-preferences";

function memoryStorage(initial: Record<string, string> = {}): Pick<Storage, "getItem" | "setItem"> & {
  values: Map<string, string>;
} {
  const values = new Map(Object.entries(initial));
  return {
    values,
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => void values.set(key, value),
  };
}

const blockedStorage: Pick<Storage, "getItem" | "setItem"> = {
  getItem: () => {
    throw new Error("storage blocked");
  },
  setItem: () => {
    throw new Error("storage blocked");
  },
};

afterEach(() => {
  window.localStorage.clear();
  setShowAgentReasoning(true);
  setShowAgentMessages(true);
});

describe("chat visibility preferences", () => {
  it("shows both by default", () => {
    const storage = memoryStorage();
    expect(readShowAgentReasoning(storage)).toBe(true);
    expect(readShowAgentMessages(storage)).toBe(true);
  });

  it("saves each choice on its own and reads it back", () => {
    const storage = memoryStorage();
    writeShowAgentReasoning(false, storage);
    expect(readShowAgentReasoning(storage)).toBe(false);
    expect(readShowAgentMessages(storage)).toBe(true);

    writeShowAgentReasoning(true, storage);
    writeShowAgentMessages(false, storage);
    expect(readShowAgentReasoning(storage)).toBe(true);
    expect(readShowAgentMessages(storage)).toBe(false);
  });

  it("changes the shared signal at once and keeps the choice in the browser", () => {
    const reasoning = useShowAgentReasoning();
    const messages = useShowAgentMessages();
    expect(reasoning()).toBe(true);

    setShowAgentReasoning(false);
    setShowAgentMessages(false);
    flush();

    expect(reasoning()).toBe(false);
    expect(messages()).toBe(false);
    expect(readShowAgentReasoning()).toBe(false);
    expect(readShowAgentMessages()).toBe(false);
  });

  it("does not throw when the browser blocks storage, and keeps the choice for this page", () => {
    expect(readShowAgentReasoning(blockedStorage)).toBe(true);
    expect(() => writeShowAgentMessages(false, blockedStorage)).not.toThrow();
    expect(readShowAgentMessages(blockedStorage)).toBe(false);
    // A later save that works replaces the choice that only this page held.
    const storage = memoryStorage();
    writeShowAgentMessages(true, storage);
    expect(readShowAgentMessages(storage)).toBe(true);
  });
});
