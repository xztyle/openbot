import { describe, expect, it } from "vitest";
import { normalizeSavedReplies, readSavedReplies, SAVED_REPLIES_STORAGE_KEY, writeSavedReplies } from "./saved-replies";

function memoryStorage(initial?: string) {
  const values = new Map<string, string>(initial === undefined ? [] : [[SAVED_REPLIES_STORAGE_KEY, initial]]);
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
    removeItem: (key: string) => void values.delete(key),
  };
}

describe("saved replies storage", () => {
  it("reads nothing as the defaults, and an empty list as a choice", () => {
    expect(readSavedReplies(memoryStorage())).toBeNull();
    expect(readSavedReplies(memoryStorage("[]"))).toEqual([]);
  });

  it("drops what is not a usable reply and survives unreadable storage", () => {
    expect(normalizeSavedReplies(["  Continue ", "", "Continue", 7, "Ship it"])).toEqual(["Continue", "Ship it"]);
    expect(readSavedReplies(memoryStorage("{not json"))).toBeNull();
    expect(
      readSavedReplies({
        getItem: () => {
          throw new Error("blocked");
        },
      }),
    ).toBeNull();
  });

  it("bounds the list and each reply", () => {
    const many = Array.from({ length: 30 }, (_, index) => `reply ${index}`);
    expect(normalizeSavedReplies(many)).toHaveLength(12);
    expect(normalizeSavedReplies(["x".repeat(900)])[0]).toHaveLength(500);
  });

  it("writes the list, and removes it to go back to the defaults", () => {
    const storage = memoryStorage();
    writeSavedReplies(["Continue", "Stop"], storage);
    expect(readSavedReplies(storage)).toEqual(["Continue", "Stop"]);
    writeSavedReplies(null, storage);
    expect(readSavedReplies(storage)).toBeNull();
    // Blocked storage never throws into the composer.
    expect(() =>
      writeSavedReplies(["a"], {
        setItem: () => {
          throw new Error("full");
        },
        removeItem: () => undefined,
      }),
    ).not.toThrow();
  });
});
