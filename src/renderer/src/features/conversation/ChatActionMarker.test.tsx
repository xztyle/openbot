import type { ChatActionMarkerModel } from "@openbot/ui/data";
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
    preview: "Please ship the fix",
  };

  it("opens the full message from the preview button and from the row", async () => {
    const onOpen = vi.fn();
    render(() => <ChatActionMarker marker={marker} agents={[]} onSelectAgent={vi.fn()} onOpenAgentMessage={onOpen} />);

    await fireEvent.click(screen.getByRole("button", { name: "Show the full message: Please ship the fix" }));
    expect(onOpen).toHaveBeenLastCalledWith("message-1", expect.any(HTMLElement));
    onOpen.mockClear();

    await fireEvent.click(screen.getByRole("group", { name: /Messaged/ }));
    expect(onOpen).toHaveBeenCalledWith("message-1", expect.any(HTMLElement));
  });

  it("shows no preview when the surface cannot open the message", () => {
    render(() => <ChatActionMarker marker={marker} agents={[]} onSelectAgent={vi.fn()} />);
    expect(screen.queryByText("Please ship the fix")).not.toBeInTheDocument();
  });
});

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
