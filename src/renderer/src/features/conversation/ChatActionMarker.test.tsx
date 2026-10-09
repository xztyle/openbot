import type { AgentProfile, ChatActionMarkerModel } from "@openbot/ui/data";
import { ChatActionMarker } from "@openbot/ui/features/conversation/ChatActionMarker";
import { fireEvent, render, screen } from "@solidjs/testing-library";
import { describe, expect, it, vi } from "vitest";

describe("ChatActionMarker routine history", () => {
  it("shows only the latest state until the user opens earlier states", async () => {
    render(() => (
      <ChatActionMarker marker={completedMarker()} agents={[]} onSelectAgent={vi.fn()} onOpenRoutine={vi.fn()} />
    ));

    expect(screen.getByRole("group", { name: "Completed routine, Morning brief" })).toBeInTheDocument();
    expect(screen.queryByText("Started")).not.toBeInTheDocument();
    const toggle = screen.getByRole("button", { name: "Show history for Morning brief" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");

    await fireEvent.click(toggle);

    expect(screen.getByRole("list", { name: "Earlier routine states" })).toBeInTheDocument();
    expect(screen.getByText("Invoked")).toBeInTheDocument();
    expect(screen.getByText("Started")).toBeInTheDocument();
    expect(toggle).toHaveAttribute("aria-expanded", "true");
  });

  it("labels a running latest state as active", () => {
    render(() => (
      <ChatActionMarker
        marker={{ ...completedMarker(), status: "running", previousTransitions: [] }}
        agents={[]}
        onSelectAgent={vi.fn()}
      />
    ));

    expect(screen.getByRole("group", { name: "Running routine, Morning brief" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /history for Morning brief/ })).not.toBeInTheDocument();
  });
});

describe("ChatActionMarker agent message", () => {
  const marker: Extract<ChatActionMarkerModel, { kind: "agent-message" }> = {
    kind: "agent-message",
    direction: "outgoing",
    sourceAgentId: "chief",
    targetDeliveries: [{ agentId: "builder", status: "completed" }],
    status: "completed",
    timestamp: "2026-09-01T08:02:00.000Z",
    messageId: "message-1",
    replyToMessageId: null,
    expectsReply: true,
  };
  const agents = [agent("chief", "Chief"), agent("builder", "Builder")];

  it("is one button that opens the message, and its agent control keeps its own meaning", async () => {
    const onOpen = vi.fn();
    const onSelectAgent = vi.fn();
    render(() => (
      <ChatActionMarker marker={marker} agents={agents} onSelectAgent={onSelectAgent} onOpenAgentMessage={onOpen} />
    ));

    const row = screen.getByRole("button", { name: "Show the message: Messaged Builder, Completed" });
    await fireEvent.click(row);
    expect(onOpen).toHaveBeenCalledWith("message-1", row);
    expect(onSelectAgent).not.toHaveBeenCalled();

    await fireEvent.click(screen.getByRole("button", { name: "Open chat with Builder" }));
    expect(onSelectAgent).toHaveBeenCalledWith("builder");
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it("stays compact and draws no text of the message", () => {
    render(() => (
      <ChatActionMarker marker={marker} agents={agents} onSelectAgent={vi.fn()} onOpenAgentMessage={vi.fn()} />
    ));
    expect(screen.getByRole("group", { name: /Messaged/ })).toHaveTextContent(/^Messaged\s*Builder/);
    expect(screen.getAllByRole("button")).toHaveLength(2);
  });

  it("is no button when the surface cannot open the message", () => {
    render(() => <ChatActionMarker marker={marker} agents={agents} onSelectAgent={vi.fn()} />);
    expect(screen.queryByRole("button", { name: /Show the message/ })).not.toBeInTheDocument();
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

function completedMarker(): Extract<ChatActionMarkerModel, { kind: "routine-run" }> {
  return {
    kind: "routine-run",
    sourceAgentId: "chief",
    routineId: "routine-1",
    runId: "run-1",
    routineName: "Morning brief",
    status: "succeeded",
    timestamp: "2026-09-01T08:02:00.000Z",
    previousTransitions: [
      { status: "queued", timestamp: "2026-09-01T08:00:00.000Z" },
      { status: "running", timestamp: "2026-09-01T08:01:00.000Z" },
    ],
  };
}
