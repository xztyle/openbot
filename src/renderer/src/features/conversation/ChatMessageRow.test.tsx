import type { AgentMessage, MessageEventCheckOrigin } from "@openbot/ui/data";
import { ChatMessageRow } from "@openbot/ui/features/conversation/ChatMessageRow";
import { render, screen } from "@solidjs/testing-library";
import { describe, expect, it, vi } from "vitest";
import { findChatSearchMatches } from "./chat-search";

const message: AgentMessage = {
  id: "answer",
  author: "agent",
  body: "Two new mentions in the release channel.",
  time: "09:03 PM",
  createdAt: "2026-09-13T21:03:00.000Z",
};

const origin: MessageEventCheckOrigin = {
  name: "Slack mentions and DMs",
  checkId: "slack-check",
  timestamp: "2026-09-13T21:03:00.000Z",
  position: "start",
};

function renderRow(eventCheckOrigin?: MessageEventCheckOrigin, eventCheckIconUrl?: string | null) {
  return render(() => (
    <ChatMessageRow
      message={message}
      author={{ kind: "agent", name: "Chief" }}
      agents={[]}
      data-chat-search-message="answer"
      eventCheckOrigin={eventCheckOrigin}
      eventCheckIconUrl={eventCheckIconUrl}
      onSelectAgent={vi.fn()}
      onOpenLink={vi.fn()}
      onPreview={vi.fn()}
      onAttachmentAction={vi.fn()}
    />
  ));
}

describe("ChatMessageRow event check origin", () => {
  it("names the event check that woke the agent", () => {
    renderRow(origin);

    const chip = screen.getByRole("note", { name: /^Event check: Slack mentions and DMs · .+/u });
    expect(chip).toHaveTextContent("Slack mentions and DMs");
  });

  it("keeps the name of the chip when it shows the icon of the app, and the icon is no extra image", () => {
    renderRow(origin, "https://slack.com/favicon.ico");

    const chip = screen.getByRole("note", { name: /^Event check: Slack mentions and DMs · .+/u });
    expect(chip).toHaveTextContent("Slack mentions and DMs");
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
  });

  it("draws no chip for a message that is not the answer to an event", () => {
    renderRow(undefined, "https://slack.com/favicon.ico");

    expect(screen.queryByRole("note")).not.toBeInTheDocument();
  });

  it("keeps the name of the check out of the search in the chat", () => {
    const { container } = renderRow(origin);

    expect(findChatSearchMatches(container, "Slack")).toHaveLength(0);
    expect(findChatSearchMatches(container, "release channel")).toHaveLength(1);
  });
});
