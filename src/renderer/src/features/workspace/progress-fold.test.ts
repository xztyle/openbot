import type { ChannelMessage } from "@openbot/contracts/ipc";
import { describe, expect, it } from "vitest";
import { foldProgressRows, messageRows } from "./workspace-model";

// Failure mode: a run of an agent's short lines folds away a line the reader has to see (a question,
// a chat card, a link, a mention).
const at = (minute: number) => new Date(Date.UTC(2026, 10, 22, 10, minute)).toISOString();
const line = (
  id: string,
  minute: number,
  text = `Checked rival ${id}.`,
  extra: Partial<ChannelMessage["message"]> = {},
  fields: Partial<ChannelMessage> = {},
): ChannelMessage => ({
  id,
  channelId: "c1",
  sequence: minute + 1,
  author: { kind: "agent", id: "research", name: "Research" },
  taskId: null,
  superseded: false,
  message: { id, author: "agent", text, createdAt: at(minute), status: "completed", ...extra },
  ...fields,
});

const fold = (entries: ChannelMessage[]) => foldProgressRows(messageRows(entries, { steps: false }));
const ids = (entries: ChannelMessage[]) => fold(entries).map((row) => row.entry.id);
const run = (middle: ChannelMessage) => [line("a", 0), line("b", 1), middle, line("d", 3), line("e", 4)];

describe("progress fold", () => {
  it("folds a run of short lines under the first and keeps the newest", () => {
    const rows = fold(run(line("c", 2)));
    expect(rows.map((row) => row.entry.id)).toEqual(["a", "e"]);
    expect(rows[0]?.progress?.map((entry) => entry.id)).toEqual(["b", "c", "d"]);
  });

  it.each([
    ["a question", line("c", 2, "Which plan?", { questionPrompt: { requestId: 1, questions: [], resolution: null } })],
    ["a chat card", line("c", 2, "Plan ready [card:0f1e2d3c-1111-2222-3333-444455556666]")],
    ["a link", line("c", 2, "Deployed https://shop.delynith.com")],
    ["a mention", line("c", 2, "Over to @[Designer](agent:designer)")],
    ["a pinned line", line("c", 2, "Budget set.", {}, { pinned: { by: { kind: "member", id: "m" }, at: at(2) } })],
    ["a condensed answer", line("c", 2, "Done.", {}, { condensed: { original: "Done, with details." } })],
    ["a streaming line", line("c", 2, "Writing", { status: "streaming" })],
  ])("never folds %s", (_name, middle) => {
    expect(ids(run(middle))).toContain("c");
  });
});
