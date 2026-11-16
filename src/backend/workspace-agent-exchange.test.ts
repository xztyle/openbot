// @vitest-environment node
import { describe, expect, it } from "vitest";
import { exchangePage } from "./workspace-insights";

// Failure mode: Between agents loads an older page from the oldest time it shows, so a page that ended
// inside a millisecond that more messages share skipped the rest of them.
const row = (id: string, at: number) => ({
  id,
  createdAt: new Date(Date.UTC(2026, 10, 16, 10, 0, 0, at)).toISOString(),
});

describe("Between agents pages", () => {
  it("leaves the messages of a shared millisecond to the next page", () => {
    const rows = [row("d", 4), row("c", 3), row("b2", 2), row("b1", 2)];
    expect(exchangePage(rows, 3).map(({ id }) => id)).toEqual(["d", "c"]);
  });

  it("keeps a full page when no millisecond is cut, or when the whole page shares one", () => {
    expect(exchangePage([row("c", 3), row("b", 2), row("a", 1)], 2).map(({ id }) => id)).toEqual(["c", "b"]);
    expect(exchangePage([row("b", 2), row("a", 1)], 2).map(({ id }) => id)).toEqual(["b", "a"]);
    const same = [row("x3", 1), row("x2", 1), row("x1", 1)];
    expect(exchangePage(same, 2).map(({ id }) => id)).toEqual(["x3", "x2"]);
  });
});
