import { chatCardMarker } from "@openbot/contracts/portfolio";
import { describe, expect, it } from "vitest";
import { chatCardOf } from "./WorkspaceChatCard";

describe("chatCardOf", () => {
  it("takes the marker out of the text and names the card", () => {
    const id = "0b8d6f0e-4a0c-4c55-9d1e-2f7a1c3b5d6e";
    expect(chatCardOf(`Which headline?\n• Bold\n${chatCardMarker(id)}`)).toEqual({
      cardId: id,
      text: "Which headline?\n• Bold",
    });
  });

  it("leaves a message without a card alone", () => {
    expect(chatCardOf("No card here [card:nope]")).toBeNull();
  });
});
