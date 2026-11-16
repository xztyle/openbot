import {
  anchorNewMessages,
  type TimelineRow,
  tallyNewMessages,
} from "@openbot/ui/features/conversation/new-message-tally";
import { describe, expect, it } from "vitest";

// Failure mode: the pill above the composer misses a reply. A turn's answer sorts with its turn, above
// a marker that came while the turn ran, and the count only looked below the last row it had.
const row = (id: string, countable = true): TimelineRow => ({ id, countable });

describe("new message tally", () => {
  it("counts a reply that arrives above the last row", () => {
    const before = anchorNewMessages([row("question", false), row("thought"), row("marker", false)]);
    const after = tallyNewMessages(
      before,
      [row("question", false), row("thought"), row("answer"), row("marker", false)],
      false,
    );
    expect(after.count).toBe(1);
  });

  it("does not count an older page or a row that only changed", () => {
    const before = anchorNewMessages([row("b"), row("c")]);
    const older = tallyNewMessages(before, [row("old-1"), row("old-2"), row("b"), row("c")], false);
    expect(older.count).toBe(0);
    expect(tallyNewMessages(older, [row("old-1"), row("old-2"), row("b"), row("c")], false).count).toBe(0);
  });

  it("keeps the count when no row the reader had is left", () => {
    const before = { ...anchorNewMessages([row("a")]), count: 2 };
    expect(tallyNewMessages(before, [row("x"), row("y")], false).count).toBe(2);
  });
});
