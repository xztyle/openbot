import type { AgentMessage, AgentProfile } from "@openbot/ui/data";
import { AgentMessageDialog } from "@openbot/ui/features/conversation/AgentMessageDialog";
import { ChatActionMarker } from "@openbot/ui/features/conversation/ChatActionMarker";
import { fireEvent, render, screen, waitFor, within } from "@solidjs/testing-library";
import { createSignal, Show } from "solid-js";
import { describe, expect, it, vi } from "vitest";
import { agentMessageThread } from "./agent-message-thread";

const agents: AgentProfile[] = [agent("chief", "Chief"), agent("builder", "Builder"), agent("tester", "Tester")];

const request: AgentMessage = {
  id: "outbox-1",
  author: "agent",
  body: "Please ship the **fix** today.",
  time: "10:00",
  createdAt: "2026-09-01T10:00:00.000Z",
  exchange: {
    direction: "outgoing",
    messageId: "message-1",
    senderAgentId: "chief",
    recipientAgentIds: ["builder"],
    replyToMessageId: null,
    deliveries: [],
  },
  actionMarker: {
    kind: "agent-message",
    direction: "outgoing",
    sourceAgentId: "chief",
    targetDeliveries: [{ agentId: "builder", status: "completed" }],
    status: "completed",
    timestamp: "2026-09-01T10:00:00.000Z",
    messageId: "message-1",
    replyToMessageId: null,
    expectsReply: true,
  },
};

const reply: AgentMessage = {
  id: "delivery-2",
  author: "agent",
  body: "The fix is shipped.",
  time: "10:05",
  createdAt: "2026-09-01T10:05:00.000Z",
  exchange: {
    direction: "incoming",
    messageId: "message-2",
    senderAgentId: "builder",
    recipientAgentIds: ["chief"],
    replyToMessageId: "message-1",
    deliveries: [],
  },
};

/** The marker and the peek wired as the chat wires them: the row opens the peek and gets focus back. */
function Chat(props: { messages: AgentMessage[]; onSelectAgent?: (agentId: string) => void }) {
  const [opened, setOpened] = createSignal<{ messageId: string; trigger: HTMLElement } | null>(null);
  const select = (agentId: string) => {
    setOpened(null);
    props.onSelectAgent?.(agentId);
  };
  return (
    <>
      <Show when={request.actionMarker}>
        {(marker) => (
          <ChatActionMarker
            marker={marker()}
            agents={agents}
            onSelectAgent={select}
            onOpenAgentMessage={(messageId, trigger) => setOpened({ messageId, trigger })}
          />
        )}
      </Show>
      <Show when={opened()} keyed>
        {(peek) => (
          <AgentMessageDialog
            entries={agentMessageThread(props.messages, peek.messageId, agents)}
            openedMessageId={peek.messageId}
            agents={agents}
            restoreFocusTarget={peek.trigger}
            onClose={() => setOpened(null)}
            onSelectAgent={select}
            onOpenLink={vi.fn()}
            onPreview={vi.fn()}
            onAttachmentAction={vi.fn()}
          />
        )}
      </Show>
    </>
  );
}

const openRow = () => screen.getByRole("button", { name: /^Show the message/ });

describe("the peek at a message between agents", () => {
  it("opens from a click on the row and shows who messaged whom, the text, and the reply", async () => {
    render(() => <Chat messages={[request, reply]} />);
    expect(screen.queryByText(/Please ship/)).not.toBeInTheDocument();

    await fireEvent.click(openRow());

    const peek = await screen.findByRole("dialog", { name: "Message between agents" });
    expect(within(peek).getByText("Please ship the", { exact: false })).toBeInTheDocument();
    expect(within(peek).getByText("fix")).toBeInTheDocument();
    expect(within(peek).getByText("The fix is shipped.")).toBeInTheDocument();
    expect(within(peek).getAllByText("Chief").length).toBeGreaterThan(0);
    expect(within(peek).getAllByText("Builder").length).toBeGreaterThan(0);
    expect(within(peek).getByText("Reply")).toBeInTheDocument();
    // The text is in the peek only. The row in the chat stays compact.
    expect(screen.getByRole("group", { name: /Messaged/, hidden: true })).not.toHaveTextContent("Please ship");
  });

  it("is a native button that takes focus, so Enter and Space open it", async () => {
    render(() => <Chat messages={[request]} />);
    const row = screen.getByRole("button", { name: "Show the message: Messaged Builder, Completed" });
    row.focus();
    expect(row).toHaveFocus();
    // The browser turns Enter and Space on a native button into a click; jsdom does not.
    expect(row.tagName).toBe("BUTTON");
    await fireEvent.click(row);
    expect(await screen.findByRole("dialog", { name: "Message between agents" })).toBeInTheDocument();
  });

  it("closes with Escape and gives focus back to the row", async () => {
    render(() => <Chat messages={[request]} />);
    const row = openRow();
    await fireEvent.click(row);
    const peek = await screen.findByRole("dialog", { name: "Message between agents" });

    await fireEvent.keyDown(peek, { key: "Escape" });

    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    await waitFor(() => expect(openRow()).toHaveFocus());
  });

  it("says that a message is not loaded when the chat holds none of its thread", async () => {
    render(() => <Chat messages={[]} />);
    await fireEvent.click(openRow());

    const peek = await screen.findByRole("dialog", { name: "Message between agents" });

    expect(within(peek).getByText("This message is not loaded in this chat yet.")).toBeInTheDocument();
    expect(within(peek).queryByRole("listitem")).not.toBeInTheDocument();
  });

  it("closes with its button", async () => {
    render(() => <Chat messages={[request]} />);
    await fireEvent.click(openRow());
    const peek = await screen.findByRole("dialog", { name: "Message between agents" });

    await fireEvent.click(within(peek).getByRole("button", { name: "Close" }));

    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  it("opens the real conversation with the other agent", async () => {
    const onSelectAgent = vi.fn();
    render(() => <Chat messages={[request, reply]} onSelectAgent={onSelectAgent} />);
    await fireEvent.click(openRow());
    const peek = await screen.findByRole("dialog", { name: "Message between agents" });

    await fireEvent.click(within(peek).getByRole("button", { name: "Open conversation" }));

    expect(onSelectAgent).toHaveBeenCalledWith("builder");
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });
});

function agent(id: string, name: string): AgentProfile {
  return {
    id,
    name,
    title: "",
    description: "",
    notifications: true,
    provider: "codex",
    model: "gpt-5.6-luna",
    reasoningEffort: "medium",
    threadId: null,
    avatarSeed: id,
    avatarHue: null,
    avatarUrl: null,
    time: "",
    preview: "",
  };
}
