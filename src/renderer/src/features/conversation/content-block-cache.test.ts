import { createContentBlockCache } from "@openbot/ui/features/conversation/contentBlockCache";
import { describe, expect, it, vi } from "vitest";

describe("content block cache", () => {
  const parse = vi.fn((body: string, streaming: boolean) => ({ body, streaming }));

  it("parses a body once for the rows that ask for it in turn", () => {
    parse.mockClear();
    const cache = createContentBlockCache(parse);
    const first = cache.get("alpha", false);
    cache.get("beta", false);
    cache.get("gamma", false);
    // The row of `alpha` is not the last one asked: a cache of one entry would parse it again.
    expect(cache.get("alpha", false)).toBe(first);
    expect(parse).toHaveBeenCalledTimes(3);
  });

  it("keeps the same text apart for a streaming and a settled body", () => {
    parse.mockClear();
    const cache = createContentBlockCache(parse);
    const settled = cache.get("text", false);
    const streaming = cache.get("text", true);
    expect(settled).not.toBe(streaming);
    expect(cache.get("text", false)).toBe(settled);
    expect(cache.get("text", true)).toBe(streaming);
    expect(parse).toHaveBeenCalledTimes(2);
  });

  it("drops the entry that was used longest ago, not the one that was added first", () => {
    parse.mockClear();
    const cache = createContentBlockCache(parse, { entries: 2 });
    const a = cache.get("a", false);
    cache.get("b", false);
    cache.get("a", false);
    cache.get("c", false);
    // `b` left, `a` stayed.
    expect(cache.get("a", false)).toBe(a);
    expect(parse).toHaveBeenCalledTimes(3);
    cache.get("b", false);
    expect(parse).toHaveBeenCalledTimes(4);
  });

  it("does not keep a body that is longer than the budget, and holds the text within it", () => {
    parse.mockClear();
    const cache = createContentBlockCache(parse, { characters: 10 });
    cache.get("x".repeat(11), false);
    cache.get("x".repeat(11), false);
    expect(parse).toHaveBeenCalledTimes(2);
    cache.get("aaaaaa", false);
    cache.get("bbbbbb", false);
    // `aaaaaa` left to keep the held text at ten characters or less.
    cache.get("bbbbbb", false);
    expect(parse).toHaveBeenCalledTimes(4);
    cache.get("aaaaaa", false);
    expect(parse).toHaveBeenCalledTimes(5);
  });

  it("gives the same blocks as the parser for every body", () => {
    const cache = createContentBlockCache((body, streaming) => `${streaming ? "s" : "f"}:${body.toUpperCase()}`);
    for (const body of ["one", "two", "one", "three", "two"]) {
      expect(cache.get(body, false)).toBe(`f:${body.toUpperCase()}`);
      expect(cache.get(body, true)).toBe(`s:${body.toUpperCase()}`);
    }
  });
});
