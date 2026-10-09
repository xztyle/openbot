import { fireEvent, render, screen } from "@solidjs/testing-library";
import { describe, expect, it, vi } from "vitest";
import { MarketplaceSuggestionChatCard } from "./MarketplaceSuggestionChatCard";
import type { MarketplaceAppAccess, MarketplaceAppAccessState } from "./marketplace-app-access";

function renderCard(state: MarketplaceAppAccessState | null) {
  const open = vi.fn();
  const watch = vi.fn();
  const access: MarketplaceAppAccess | undefined = state ? { state: () => state, watch } : undefined;
  render(() => (
    <MarketplaceSuggestionChatCard
      messageId="message-1"
      appId="linear"
      localServer={false}
      access={access}
      onOpenMarketplaceApp={open}
    />
  ));
  return { open, watch };
}

describe("MarketplaceSuggestionChatCard", () => {
  it("offers Connect when no account of the app is on the host", () => {
    const { open, watch } = renderCard("available");
    fireEvent.click(screen.getByRole("button", { name: "Connect Linear" }));

    expect(open).toHaveBeenCalledExactlyOnceWith({ appId: "linear", connect: true });
    expect(watch).toHaveBeenCalled();
  });

  it("offers Connect when the host cannot say", () => {
    renderCard(null);
    expect(screen.getByRole("button", { name: "Connect Linear" })).toBeInTheDocument();
  });

  // An app that is connected but not allowed in this chat is not "available" and not "connected":
  // the agent still sees nothing. The card opens the page where the user chooses; it grants nothing.
  it("says the app is connected but off for this chat, and only opens its page", () => {
    const { open } = renderCard("off");
    expect(screen.getByText("Linear is connected, but this chat cannot use it yet.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Connect Linear" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Allow Linear in this chat" }));

    expect(open).toHaveBeenCalledExactlyOnceWith({ appId: "linear", connect: false });
  });

  it("opens the page of an app that is turned off", () => {
    const { open } = renderCard("disabled");
    fireEvent.click(screen.getByRole("button", { name: "Turn on Linear" }));

    expect(open).toHaveBeenCalledExactlyOnceWith({ appId: "linear", connect: false });
  });

  it("shows Connected only when this chat can use the app", () => {
    renderCard("allowed");
    expect(screen.getByText("Connected")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Connect|Allow/u })).toBeNull();
  });
});
