import { decodeChatCardFromMain, decodeChatCardsFromMain } from "@openbot/contracts/portfolio";
import { describe, expect, it } from "vitest";

const CARD = {
  id: "0b8d6f0e-4a0c-4c55-9d1e-2f7a1c3b5d6e",
  agentId: "agent-1",
  channelId: null,
  spec: {
    type: "choice",
    title: "Which headline?",
    options: [
      { id: "a", label: "Bold" },
      { id: "b", label: "Calm" },
    ],
  },
  status: "answered",
  answer: { selected: ["b"] },
  answeredBy: { id: "owner", name: "Owner" },
  answeredAt: "2026-11-22T08:00:00.000Z",
  createdAt: "2026-11-22T07:00:00.000Z",
};

describe("chat cards from main", () => {
  it("keeps a card and its answer", () => {
    expect(decodeChatCardFromMain(CARD)).toEqual(CARD);
    expect(decodeChatCardsFromMain([CARD])).toHaveLength(1);
  });

  it("refuses a card with an unknown status or spec", () => {
    expect(() => decodeChatCardFromMain({ ...CARD, status: "lost" })).toThrow();
    expect(() => decodeChatCardFromMain({ ...CARD, spec: { type: "poll" } })).toThrow();
    expect(() => decodeChatCardsFromMain({ cards: [CARD] })).toThrow();
  });
});
