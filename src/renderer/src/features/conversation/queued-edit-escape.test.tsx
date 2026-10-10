import { fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { afterEach, assert, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../../App";
import { installOpenbotStub, queuedDelivery } from "../../app-test-harness";

describe("Escape while a queued message is in edit", () => {
  beforeEach(() => {
    installOpenbotStub();
  });

  // The app loads panels on demand. Wait for them, so none loads after the test environment ends.
  afterEach(async () => {
    await vi.dynamicImportSettled();
  });

  async function startEdit() {
    const delivery = queuedDelivery("escape-edit", "Original queue message", 1);
    vi.mocked(window.openbot.agent.listQueue).mockResolvedValue({
      agentId: "chief",
      deliveries: [queuedDelivery("running", "Running", null, { status: "running", turnId: "turn-running" }), delivery],
    });
    vi.mocked(window.openbot.agent.editQueuedMessage).mockResolvedValue({ agentId: "chief", deliveries: [delivery] });
    render(() => <App />);
    const composer = await screen.findByRole("textbox", { name: "Message Chief" });
    await fireEvent.click(await screen.findByRole("button", { name: "Edit queued message 1" }));
    await screen.findByRole("button", { name: "Save queued message" });
    const begin = vi.mocked(window.openbot.agent.editQueuedMessage).mock.calls[0]?.[0];
    assert(begin);
    const cancelled = () =>
      vi
        .mocked(window.openbot.agent.editQueuedMessage)
        .mock.calls.some(([input]) => input.action === "cancel" && input.editId === begin.editId);
    return { composer, cancelled };
  }

  it("keeps the edit while an input method ends its candidate list with Escape", async () => {
    const { composer, cancelled } = await startEdit();
    composer.focus();
    await fireEvent.keyDown(composer, { key: "Escape", isComposing: true });
    await fireEvent.keyDown(composer, { key: "Escape", keyCode: 229 });
    expect(cancelled()).toBe(false);
    expect(screen.getByRole("button", { name: "Save queued message" })).toBeInTheDocument();
  });

  it("keeps the edit when Escape is pressed in a field outside the composer", async () => {
    const { cancelled } = await startEdit();
    const field = document.createElement("input");
    document.body.append(field);
    try {
      field.focus();
      await fireEvent.keyDown(field, { key: "Escape" });
      expect(cancelled()).toBe(false);
      expect(screen.getByRole("button", { name: "Save queued message" })).toBeInTheDocument();
    } finally {
      field.remove();
    }
  });

  it("cancels the edit when Escape is pressed in the composer", async () => {
    const { composer, cancelled } = await startEdit();
    composer.focus();
    await fireEvent.keyDown(composer, { key: "Escape" });
    await waitFor(() => expect(cancelled()).toBe(true));
  });
});
