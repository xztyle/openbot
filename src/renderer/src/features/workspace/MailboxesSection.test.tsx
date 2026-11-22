import type { AgentMailboxesState } from "@openbot/contracts/team-protocol/agent-mailboxes-v1";
import { MailboxesSection } from "@openbot/ui/features/workspace/MailboxesSection";
import { fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { describe, expect, it, vi } from "vitest";

const STATE: AgentMailboxesState = {
  gateway: { listening: true, publicUrl: "https://connect.example.com" },
  inboxUrl: "https://connect.example.com/hooks/mail_abc",
  workerUrl: null,
  hasSecret: false,
  lastMailAt: null,
  lastStatus: null,
  mailboxes: [
    {
      id: "m1",
      address: "ventas@aprendivo.com",
      displayName: "",
      agentId: "lucia",
      agentName: "Lucía",
      spaceId: "s1",
      mode: "reply",
      createdAt: 1,
      lastMailAt: null,
      received: 3,
      sentToday: 1,
    },
    {
      id: "m2",
      address: "otro@delynith.com",
      displayName: "",
      agentId: "bo",
      agentName: "Bo",
      spaceId: "s2",
      mode: "write-first",
      createdAt: 1,
      lastMailAt: null,
      received: 0,
      sentToday: 0,
    },
  ],
};

function setup() {
  const props = {
    onSave: vi.fn(async () => undefined),
    onRemove: vi.fn(async () => undefined),
    onSetWorker: vi.fn(async () => undefined),
    onNewSecret: vi.fn(async () => "ams_secret"),
    onCopy: vi.fn(async () => undefined),
  };
  render(() => (
    <MailboxesSection
      state={STATE}
      spaceId="s1"
      agents={[
        { id: "lucia", name: "Lucía" },
        { id: "pablo", name: "Pablo" },
      ]}
      {...props}
    />
  ));
  return props;
}

describe("MailboxesSection", () => {
  it("shows only this space's addresses with their agent and mode", () => {
    setup();
    expect(screen.getByText("ventas@aprendivo.com")).toBeTruthy();
    expect(screen.getByText("Lucía · Reply only")).toBeTruthy();
    expect(screen.getByText("Received: 3 · Sent today: 1")).toBeTruthy();
    expect(screen.queryByText("otro@delynith.com")).toBeNull();
  });

  it("copies the inbox address for the Worker", async () => {
    const props = setup();
    fireEvent.click(screen.getByRole("button", { name: "Copy inbox address" }));
    await waitFor(() => expect(props.onCopy).toHaveBeenCalledWith("https://connect.example.com/hooks/mail_abc"));
  });

  it("adds an address for an agent, reply only by default", async () => {
    const props = setup();
    fireEvent.click(screen.getByRole("button", { name: "Add address" }));
    const input = await screen.findByPlaceholderText("ventas@aprendivo.com");
    fireEvent.input(input, { target: { value: "soporte@aprendivo.com" } });
    const form = input.closest("form");
    if (!form) throw new Error("The dialog has no form.");
    await waitFor(() => expect(screen.getByRole("button", { name: "Save" })).not.toBeDisabled());
    fireEvent.submit(form);
    await waitFor(() =>
      expect(props.onSave).toHaveBeenCalledWith({ address: "soporte@aprendivo.com", agentId: "lucia", mode: "reply" }),
    );
  });

  it("shows a new mail secret once", async () => {
    const props = setup();
    fireEvent.click(screen.getByRole("button", { name: "New mail secret" }));
    await waitFor(() => expect(props.onNewSecret).toHaveBeenCalled());
    expect(await screen.findByDisplayValue("ams_secret")).toBeTruthy();
  });
});
