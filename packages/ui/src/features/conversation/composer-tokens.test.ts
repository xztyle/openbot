import { describe, expect, it } from "vitest";
import { clipToRoom } from "./composer-tokens";

describe("clipToRoom", () => {
  it("keeps text that fits and takes the head of text that does not", () => {
    expect(clipToRoom("abc", 5)).toBe("abc");
    expect(clipToRoom("abcdef", 4)).toBe("abcd");
  });

  it("returns nothing when no room is left", () => {
    expect(clipToRoom("abc", 0)).toBe("");
    expect(clipToRoom("abc", -3)).toBe("");
  });

  it("does not split a surrogate pair", () => {
    // "a" then U+1F600 (two code units): room 2 would cut the pair in half.
    expect(clipToRoom("a\u{1F600}b", 2)).toBe("a");
    expect(clipToRoom("a\u{1F600}b", 3)).toBe("a\u{1F600}");
  });
});
