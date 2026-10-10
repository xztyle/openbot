import type {
  AgentEvent,
  AgentMemory,
  CreateAgentMemoryInput,
  DeleteAgentMemoryInput,
  UpdateAgentMemoryInput,
} from "@openbot/contracts/ipc";
import { Toaster, toast } from "@openbot/ui";
import { fireEvent, render, screen, waitFor, within } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import type { Mock } from "vitest";
import { afterEach, assert, beforeEach, describe, expect, it, vi } from "vitest";
import { type AnalyticsEventName, type DesktopAnalyticsEvents, desktopAnalytics } from "../../analytics";
import { createMockOpenBot, type MockOpenBotControls } from "../../preview/mock-openbot";
import { AgentMemoriesModal } from "./AgentMemoriesModal";
import { agentMemoriesPort } from "./memories-port";

const firstMemory: AgentMemory = {
  id: "memory-1",
  agentId: "chief",
  text: "Uses metric units.",
  origin: "automatic",
  sourceTurnId: "turn-1",
  createdAt: "2026-08-24T12:00:00.000Z",
  updatedAt: "2026-08-24T12:00:00.000Z",
};

let memoryState: AgentMemory[];
let emitAgentEvent: ((event: AgentEvent) => void) | undefined;
let listMemories: Mock<(agentId: string) => Promise<AgentMemory[]>>;
let createMemory: Mock<(input: CreateAgentMemoryInput) => Promise<AgentMemory>>;
let updateMemory: Mock<(input: UpdateAgentMemoryInput) => Promise<AgentMemory>>;
let deleteMemory: Mock<(input: DeleteAgentMemoryInput) => Promise<void>>;
let clearMemories: Mock<(agentId: string) => Promise<void>>;
let activeMock: MockOpenBotControls | undefined;
const trackMemoryAnalytics = vi.fn();

function trackScopedMemoryAnalytics<Name extends AnalyticsEventName>(
  name: Name,
  properties: DesktopAnalyticsEvents[Name],
) {
  trackMemoryAnalytics(name, properties);
}

afterEach(() => {
  toast.dismiss();
  activeMock?.dispose();
  activeMock = undefined;
});

beforeEach(() => {
  vi.spyOn(desktopAnalytics, "scope").mockImplementation(() => ({ track: trackScopedMemoryAnalytics }));
  trackMemoryAnalytics.mockClear();
  memoryState = [];
  emitAgentEvent = undefined;
  listMemories = vi.fn(async () => [...memoryState]);
  createMemory = vi.fn(async (input: { agentId: string; text: string }) => {
    const memory: AgentMemory = {
      ...firstMemory,
      id: "memory-new",
      agentId: input.agentId,
      text: input.text,
      origin: "manual",
      sourceTurnId: null,
    };
    memoryState.push(memory);
    return memory;
  });
  updateMemory = vi.fn(async (input: { agentId: string; memoryId: string; text: string }) => {
    const memory = memoryState.find((item) => item.id === input.memoryId && item.agentId === input.agentId);
    if (!memory) throw new Error("Memory not found.");
    memory.text = input.text;
    memory.updatedAt = "2026-08-25T12:00:00.000Z";
    return memory;
  });
  deleteMemory = vi.fn(async (input: { agentId: string; memoryId: string }) => {
    memoryState = memoryState.filter((item) => item.id !== input.memoryId || item.agentId !== input.agentId);
  });
  clearMemories = vi.fn(async (agentId: string) => {
    memoryState = memoryState.filter((item) => item.agentId !== agentId);
  });

  activeMock = createMockOpenBot();
  activeMock.api.agent.listMemories = listMemories;
  activeMock.api.agent.createMemory = createMemory;
  activeMock.api.agent.updateMemory = updateMemory;
  activeMock.api.agent.deleteMemory = deleteMemory;
  activeMock.api.agent.clearMemories = clearMemories;
  activeMock.api.agent.onEvent = vi.fn((listener: (event: AgentEvent) => void) => {
    emitAgentEvent = listener;
    return () => undefined;
  });
  window.openbot = activeMock.api;
});

describe("AgentMemoriesModal", () => {
  it("shows the empty state, adds a memory, and refreshes after a memory event", async () => {
    const onCountChange = vi.fn();
    render(() => (
      <AgentMemoriesModal
        port={agentMemoriesPort("chief", "Chief", 64)}
        open
        onOpenChange={vi.fn()}
        onCountChange={onCountChange}
      />
    ));

    expect(await screen.findByRole("dialog", { name: "Memories" })).toBeInTheDocument();
    expect(await screen.findByText("This agent has no saved memories yet.")).toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: "New memory" })).not.toBeInTheDocument();
    await fireEvent.click(screen.getByRole("button", { name: "Add memory" }));
    let newMemoryInput = screen.getByRole("textbox", { name: "New memory" });
    await fireEvent.keyDown(newMemoryInput, { key: "Escape" });
    expect(screen.queryByRole("textbox", { name: "New memory" })).not.toBeInTheDocument();
    expect(screen.getByRole("dialog", { name: "Memories" })).toBeInTheDocument();

    await fireEvent.click(screen.getByRole("button", { name: "Add memory" }));
    newMemoryInput = screen.getByRole("textbox", { name: "New memory" });
    await fireEvent.input(newMemoryInput, {
      target: { value: "Prefers short status reports." },
    });
    const saveMemoryButton = screen.getByRole("button", { name: "Save memory" });
    await fireEvent.click(saveMemoryButton);

    await waitFor(() =>
      expect(createMemory).toHaveBeenCalledWith({
        agentId: "chief",
        text: "Prefers short status reports.",
      }),
    );
    expect(await screen.findByText("Prefers short status reports.")).toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: "New memory" })).not.toBeInTheDocument();
    expect(screen.getByText(/Added manually/)).toBeInTheDocument();
    expect(onCountChange).toHaveBeenLastCalledWith(1);
    expect(trackMemoryAnalytics).toHaveBeenCalledWith("memory_action", {
      action: "create",
      result: "succeeded",
    });

    memoryState.push({ ...firstMemory, id: "memory-remote", text: "Remote change" });
    emitAgentEvent?.({ type: "memories-changed", agentId: "chief" });
    expect(await screen.findByText("Remote change")).toBeInTheDocument();
    expect(onCountChange).toHaveBeenLastCalledWith(2);
  });

  it("edits a memory and deletes it with one tap", async () => {
    memoryState = [{ ...firstMemory }];
    render(() => (
      <AgentMemoriesModal
        port={agentMemoriesPort("chief", "Chief", 64)}
        open
        onOpenChange={vi.fn()}
        onCountChange={vi.fn()}
      />
    ));

    expect(await screen.findByText("Uses metric units.")).toBeInTheDocument();
    await fireEvent.click(screen.getByRole("button", { name: "Edit memory: Uses metric units." }));
    const editInput = screen.getByRole("textbox", { name: "Edit memory" });
    await fireEvent.input(editInput, {
      target: { value: "Uses SI units." },
    });
    const saveButton = screen.getByRole("button", { name: "Save" });
    await fireEvent.click(saveButton);
    expect(await screen.findByText("Uses SI units.")).toBeInTheDocument();
    expect(updateMemory).toHaveBeenCalledWith({ agentId: "chief", memoryId: "memory-1", text: "Uses SI units." });

    const deleteButton = screen.getByRole("button", { name: "Delete memory" });
    await waitFor(() => expect(deleteButton).toBeEnabled());
    await fireEvent.click(deleteButton);
    await waitFor(() => expect(deleteMemory).toHaveBeenCalledWith({ agentId: "chief", memoryId: "memory-1" }));
    expect(screen.queryByRole("dialog", { name: "Delete this memory?" })).not.toBeInTheDocument();
    expect(await screen.findByText("This agent has no saved memories yet.")).toBeInTheDocument();
  });

  it("brings a deleted memory back from the Undo toast", async () => {
    memoryState = [{ ...firstMemory }, { ...firstMemory, id: "memory-2", text: "Prefers short status reports." }];
    const onCountChange = vi.fn();
    render(() => (
      <>
        <Toaster />
        <AgentMemoriesModal
          port={agentMemoriesPort("chief", "Chief", 64)}
          open
          onOpenChange={vi.fn()}
          onCountChange={onCountChange}
        />
      </>
    ));

    expect(await screen.findByText("Uses metric units.")).toBeInTheDocument();
    const [firstDelete] = screen.getAllByRole("button", { name: "Delete memory" });
    assert(firstDelete);
    await fireEvent.click(firstDelete);
    await waitFor(() => expect(onCountChange).toHaveBeenLastCalledWith(1));
    expect(screen.queryByText("Uses metric units.")).not.toBeInTheDocument();

    await fireEvent.click(await screen.findByRole("button", { name: "Undo" }));
    await waitFor(() => expect(createMemory).toHaveBeenCalledWith({ agentId: "chief", text: "Uses metric units." }));
    expect(await screen.findByText("Uses metric units.")).toBeInTheDocument();
    expect(onCountChange).toHaveBeenLastCalledWith(2);
  });

  it("asks before another memory or the add button replaces a changed draft", async () => {
    memoryState = [{ ...firstMemory }, { ...firstMemory, id: "memory-2", text: "Prefers short status reports." }];
    render(() => (
      <AgentMemoriesModal
        port={agentMemoriesPort("chief", "Chief", 64)}
        open
        onOpenChange={vi.fn()}
        onCountChange={vi.fn()}
      />
    ));

    await fireEvent.click(await screen.findByRole("button", { name: "Edit memory: Uses metric units." }));
    await fireEvent.input(screen.getByRole("textbox", { name: "Edit memory" }), {
      target: { value: "Uses SI units." },
    });

    await fireEvent.click(screen.getByRole("button", { name: "Edit memory: Prefers short status reports." }));
    const question = await screen.findByRole("alertdialog", { name: "Discard changes?" });
    await fireEvent.click(within(question).getByRole("button", { name: "Keep editing" }));
    await waitFor(() =>
      expect(screen.queryByRole("alertdialog", { name: "Discard changes?" })).not.toBeInTheDocument(),
    );
    expect(screen.getByRole("textbox", { name: "Edit memory" })).toHaveValue("Uses SI units.");

    await fireEvent.click(screen.getByRole("button", { name: "Add memory" }));
    await fireEvent.click(
      within(await screen.findByRole("alertdialog", { name: "Discard changes?" })).getByRole("button", {
        name: "Discard changes",
      }),
    );
    expect(await screen.findByRole("textbox", { name: "New memory" })).toHaveValue("");
    expect(screen.queryByRole("textbox", { name: "Edit memory" })).not.toBeInTheDocument();
    expect(updateMemory).not.toHaveBeenCalled();
  });

  it("asks before it closes over a new memory, and keeps the text when the host closes it", async () => {
    const onOpenChange = vi.fn();
    const [open, setOpen] = createSignal(true);
    render(() => (
      <AgentMemoriesModal
        port={agentMemoriesPort("chief", "Chief", 64)}
        open={open()}
        onOpenChange={onOpenChange}
        onCountChange={vi.fn()}
      />
    ));

    await screen.findByText("This agent has no saved memories yet.");
    await fireEvent.click(screen.getByRole("button", { name: "Add memory" }));
    await fireEvent.input(screen.getByRole("textbox", { name: "New memory" }), {
      target: { value: "Works from Berlin." },
    });
    await fireEvent.click(screen.getByRole("button", { name: "Close memories" }));
    const question = await screen.findByRole("alertdialog", { name: "Discard changes?" });
    expect(onOpenChange).not.toHaveBeenCalled();
    await fireEvent.click(within(question).getByRole("button", { name: "Keep editing" }));
    expect(screen.getByRole("textbox", { name: "New memory" })).toHaveValue("Works from Berlin.");

    // The host closes the modal and opens it again for the same agent: the draft stays.
    setOpen(false);
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Memories" })).not.toBeInTheDocument());
    setOpen(true);
    expect(await screen.findByRole("textbox", { name: "New memory" })).toHaveValue("Works from Berlin.");

    await fireEvent.click(screen.getByRole("button", { name: "Close memories" }));
    await fireEvent.click(
      within(await screen.findByRole("alertdialog", { name: "Discard changes?" })).getByRole("button", {
        name: "Discard changes",
      }),
    );
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("requires confirmation before clearing all memories", async () => {
    memoryState = [{ ...firstMemory }, { ...firstMemory, id: "memory-2", text: "Prefers short status reports." }];
    render(() => (
      <AgentMemoriesModal
        port={agentMemoriesPort("chief", "Chief", 64)}
        open
        onOpenChange={vi.fn()}
        onCountChange={vi.fn()}
      />
    ));

    expect(await screen.findByText("Uses metric units.")).toBeInTheDocument();
    const clearButton = screen.getByRole("button", { name: "Clear all memories" });
    await fireEvent.click(clearButton);
    const confirmation = await screen.findByRole("alertdialog", { name: "Clear all memories?" });
    // The confirmation opens on top of the memories modal rather than replacing
    // it, so the list it was opened from is still rendered underneath.
    expect(screen.getByText("Uses metric units.")).toBeInTheDocument();
    expect(within(confirmation).getByText(/all 2 saved memories/)).toBeInTheDocument();
    expect(within(confirmation).getByText(/Original messages will stay/)).toBeInTheDocument();
    expect(clearMemories).not.toHaveBeenCalled();

    // Escape closes only the confirmation; the memories modal stays open behind it.
    await fireEvent.keyDown(within(confirmation).getByRole("button", { name: "Cancel" }), { key: "Escape" });
    await waitFor(() =>
      expect(screen.queryByRole("alertdialog", { name: "Clear all memories?" })).not.toBeInTheDocument(),
    );
    expect(screen.getByRole("dialog", { name: "Memories" })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("button", { name: "Clear all memories" })).toHaveFocus());

    await fireEvent.click(screen.getByRole("button", { name: "Clear all memories" }));
    await fireEvent.click(
      within(await screen.findByRole("alertdialog", { name: "Clear all memories?" })).getByRole("button", {
        name: "Cancel",
      }),
    );
    const restoredModal = await screen.findByRole("dialog", { name: "Memories" });
    const restoredClearButton = within(restoredModal).getByRole("button", { name: "Clear all memories" });

    await fireEvent.click(restoredClearButton);
    await fireEvent.click(
      within(await screen.findByRole("alertdialog", { name: "Clear all memories?" })).getByRole("button", {
        name: "Clear all memories",
      }),
    );
    await waitFor(() => expect(clearMemories).toHaveBeenCalledWith("chief"));
    expect(await screen.findByText("This agent has no saved memories yet.")).toBeInTheDocument();
  });

  it.each([
    ["Memory service is unavailable.", "Memory service is unavailable."],
    [
      "Error invoking remote method 'agent:memories': Error: SQLITE_BUSY: database is locked",
      "Could not load memories.",
    ],
  ])("shows readable loading errors and closes from the close button: %s", async (error, message) => {
    listMemories.mockRejectedValueOnce(new Error(error));
    const onOpenChange = vi.fn();
    render(() => (
      <AgentMemoriesModal
        port={agentMemoriesPort("chief", "Chief", 64)}
        open
        onOpenChange={onOpenChange}
        onCountChange={vi.fn()}
      />
    ));

    expect(await screen.findByRole("alert")).toHaveTextContent(message);
    await fireEvent.click(screen.getByRole("button", { name: "Close memories" }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});
