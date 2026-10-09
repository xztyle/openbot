import { fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  readShowAgentMessages,
  readShowAgentReasoning,
  setShowAgentMessages,
  setShowAgentReasoning,
} from "../../chat-visibility-preferences";
import WebAccountSettings from "./WebAccountSettings";

afterEach(() => {
  window.localStorage.clear();
  setShowAgentReasoning(true);
  setShowAgentMessages(true);
});

describe("web account Preferences", () => {
  it("switches agent reasoning and messages between agents on and off for this browser", async () => {
    render(() => (
      <WebAccountSettings
        open
        onOpenChange={vi.fn()}
        account={{ id: "user-1", email: "norbert@example.com", name: "Norbert", avatarUrl: null }}
        calls={{
          updateName: vi.fn(async () => undefined),
          updateAvatar: vi.fn(async () => undefined),
          listSessions: vi.fn(async () => []),
          revokeSession: vi.fn(async () => undefined),
        }}
        language="en"
        onChangeLanguage={vi.fn()}
      />
    ));
    await fireEvent.click(await screen.findByRole("tab", { name: "Preferences" }));
    const reasoning = await screen.findByRole("switch", { name: "Show agent reasoning" });
    const messages = screen.getByRole("switch", { name: "Show messages between agents" });
    expect(reasoning).toBeChecked();
    expect(messages).toBeChecked();

    await fireEvent.click(reasoning);
    await fireEvent.click(messages);

    await waitFor(() => expect(reasoning).not.toBeChecked());
    expect(messages).not.toBeChecked();
    expect(readShowAgentReasoning()).toBe(false);
    expect(readShowAgentMessages()).toBe(false);

    await fireEvent.click(reasoning);
    await waitFor(() => expect(reasoning).toBeChecked());
    expect(readShowAgentReasoning()).toBe(true);
    expect(readShowAgentMessages()).toBe(false);
  });
});
