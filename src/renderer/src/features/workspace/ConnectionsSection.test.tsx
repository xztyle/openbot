import type { ConnectorAccessState } from "@openbot/contracts/team-protocol/connector-access-v1";
import { ConnectionsSection } from "@openbot/ui/features/workspace/ConnectionsSection";
import { fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { describe, expect, it, vi } from "vitest";

const STATE: ConnectorAccessState = {
  gateway: { listening: true, publicUrl: "https://connect.example.com" },
  tokens: [{ id: "t1", label: "Claude", createdAt: 1, lastUsedAt: null }],
  inboxes: [
    {
      routeId: "r1",
      ownerKind: "agent",
      ownerId: "a1",
      ownerName: "Ana",
      routineName: "Hotmart sale",
      spaceId: "s1",
      scheme: "openbot",
      hasSecret: false,
      lastEventAt: null,
      lastStatus: null,
    },
    {
      routeId: "r2",
      ownerKind: "agent",
      ownerId: "a2",
      ownerName: "Bo",
      routineName: "Other space",
      spaceId: "s2",
      scheme: "openbot",
      hasSecret: false,
      lastEventAt: null,
      lastStatus: null,
    },
  ],
};

function setup() {
  const props = {
    onCreateToken: vi.fn(async () => ({ token: "atm_new", url: "https://connect.example.com/mcp/atm_new" })),
    onRevokeToken: vi.fn(async () => undefined),
    onSetSender: vi.fn(async () => undefined),
    onCopy: vi.fn(async () => undefined),
  };
  render(() => <ConnectionsSection state={STATE} spaceId="s1" {...props} />);
  return props;
}

describe("ConnectionsSection", () => {
  it("shows the links and only this space's webhook routines", () => {
    setup();
    expect(screen.getByText("Claude")).toBeTruthy();
    expect(screen.getByText("Hotmart sale")).toBeTruthy();
    expect(screen.queryByText("Other space")).toBeNull();
  });

  it("copies the inbox address of a routine", async () => {
    const props = setup();
    fireEvent.click(screen.getByRole("button", { name: "Copy address" }));
    await waitFor(() => expect(props.onCopy).toHaveBeenCalledWith("https://connect.example.com/hooks/r1"));
  });

  it("makes a link and shows it once", async () => {
    const props = setup();
    fireEvent.click(screen.getByRole("button", { name: "New access link" }));
    const input = await screen.findByPlaceholderText("Claude on my phone");
    fireEvent.input(input, { target: { value: "ChatGPT" } });
    // The submit button sits outside the form (form="…"), which jsdom does not follow.
    const form = input.closest("form");
    if (!form) throw new Error("The dialog has no form.");
    await waitFor(() => expect(screen.getByRole("button", { name: "Create" })).not.toBeDisabled());
    fireEvent.submit(form);
    await waitFor(() => expect(props.onCreateToken).toHaveBeenCalledWith("ChatGPT"));
    expect(await screen.findByDisplayValue("https://connect.example.com/mcp/atm_new")).toBeTruthy();
  });
});
