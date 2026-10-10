import type { ChannelMessage } from "@openbot/contracts/ipc";
import { fireEvent, render, screen, waitFor, within } from "@solidjs/testing-library";
import { assert, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { App } from "./App";
import { attachment, emitAgentEvent, emitAttachmentImport, installOpenbotStub, testServer } from "./app-test-harness";
import { setShowAgentReasoning } from "./chat-visibility-preferences";
import { CHANNEL_SELECTION_STORAGE_KEY } from "./features/channels/channel-selection";
import { AccountDock } from "./lazy-views";

beforeAll(async () => {
  await AccountDock.preload();
});

beforeEach(installOpenbotStub);

async function openSavedChannel(onUnmount?: (unmount: () => void) => void) {
  await window.openbot.agent.channelCommand({
    type: "save",
    operationId: "create",
    channelId: "channel-test",
    draft: {
      name: "Project room",
      title: "",
      instructions: "Research the project",
      members: [{ agentId: "chief" }],
      leadAgentId: "chief",
    },
  });
  const view = render(() => <App />);
  onUnmount?.(view.unmount);
  await screen.findByRole("button", { name: /Open account (actions|menu)/ });
  await fireEvent.click(await screen.findByRole("button", { name: /Project room/ }));
  const chat = await screen.findByRole("main", { name: "Channel conversation" });
  await within(chat).findByRole("heading", { name: "Project room", level: 1 });
  return chat;
}

/** The sidebar row reads like an agent row: the name, then the last message as its preview. */
function channelRow(name: string) {
  return screen.getByRole("button", { name: new RegExp(`^${name}\\.`) });
}

async function openChannelMenuItem(item: string) {
  await fireEvent.contextMenu(channelRow("Project room"));
  await fireEvent.pointerUp(await screen.findByRole("menuitem", { name: item }), { button: 0 });
}

it("restores the selected channel after restart and clears it when returning to an agent", async () => {
  let unmount: (() => void) | undefined;
  await openSavedChannel((dispose) => {
    unmount = dispose;
  });
  expect(JSON.parse(window.localStorage.getItem(CHANNEL_SELECTION_STORAGE_KEY) ?? "{}")).toEqual({
    "user-1": { local: "channel-test" },
  });

  unmount?.();
  const restarted = render(() => <App />);
  await within(await screen.findByRole("main", { name: "Channel conversation" })).findByRole("heading", {
    name: "Project room",
    level: 1,
  });

  await fireEvent.click(screen.getByRole("button", { name: /^Chief, Chief of staff/ }));
  await screen.findByRole("main", { name: "Conversation" });
  expect(window.localStorage.getItem(CHANNEL_SELECTION_STORAGE_KEY)).toBe("{}");

  restarted.unmount();
  const view = render(() => <App />);
  expect(await screen.findByRole("heading", { name: "Chief", level: 1 })).toBeVisible();
  view.unmount();
});

it("keeps unsent agent and channel drafts through a chat switch and a restart", async () => {
  let unmount: (() => void) | undefined;
  const chat = await openSavedChannel((dispose) => {
    unmount = dispose;
  });
  const channelComposer = within(chat).getByRole("textbox", { name: "Message to channel" });
  channelComposer.textContent = "Channel draft";
  await fireEvent.input(channelComposer);
  await fireEvent.click(screen.getByRole("button", { name: /^Chief, Chief of staff/ }));
  const agentComposer = await screen.findByRole("textbox", { name: "Message Chief" });
  agentComposer.textContent = "Agent draft";
  await fireEvent.input(agentComposer);
  await fireEvent.click(channelRow("Project room"));
  const returnedChat = await screen.findByRole("main", { name: "Channel conversation" });
  expect(await within(returnedChat).findByRole("textbox", { name: "Message to channel" })).toHaveTextContent(
    "Channel draft",
  );

  // Unmounting the app writes the drafts at once, the way a quit inside the write delay does.
  unmount?.();
  const restarted = render(() => <App />);
  const restartedChat = await screen.findByRole("main", { name: "Channel conversation" });
  expect(await within(restartedChat).findByRole("textbox", { name: "Message to channel" })).toHaveTextContent(
    "Channel draft",
  );
  await fireEvent.click(screen.getByRole("button", { name: /^Chief, Chief of staff/ }));
  expect(await screen.findByRole("textbox", { name: "Message Chief" })).toHaveTextContent("Agent draft");
  restarted.unmount();
});

it("shows the channel title in the header and sidebar and refreshes it after editing", async () => {
  await window.openbot.agent.channelCommand({
    type: "save",
    operationId: "create-titled",
    channelId: "channel-titled",
    draft: {
      name: "Launch room",
      title: "Ship OpenBot 1.0",
      instructions: "Ship the launch",
      members: [{ agentId: "chief" }],
      leadAgentId: "chief",
    },
  });
  render(() => <App />);
  await screen.findByRole("button", { name: /Open account (actions|menu)/ });

  const row = await screen.findByRole("button", { name: "Launch room, Ship OpenBot 1.0. No messages yet" });
  expect(within(row).getByText("Ship OpenBot 1.0")).toBeVisible();
  await fireEvent.click(row);

  const chat = await screen.findByRole("main", { name: "Channel conversation" });
  const settings = await within(chat).findByRole("button", { name: "Channel settings" });
  expect(within(settings).getByText("Ship OpenBot 1.0")).toBeVisible();

  await fireEvent.click(settings);
  const title = await within(chat).findByRole("textbox", { name: "Channel title" });
  await fireEvent.input(title, { target: { value: "Weekly sync" } });
  await fireEvent.blur(title);

  await waitFor(() => {
    expect(
      within(within(chat).getByRole("button", { name: "Channel settings" })).getByText("Weekly sync"),
    ).toBeVisible();
    expect(
      within(screen.getByRole("button", { name: "Launch room, Weekly sync. No messages yet" })).getByText(
        "Weekly sync",
      ),
    ).toBeVisible();
  });
});

it("shows the lead's routing choice as activity, not as a message from the lead", async () => {
  await window.openbot.agent.channelCommand({
    type: "save",
    operationId: "create-routed",
    channelId: "channel-routed",
    draft: {
      name: "Launch room",
      title: "",
      instructions: "Ship the launch",
      members: [{ agentId: "chief" }, { agentId: "sales-outbound" }],
      leadAgentId: "chief",
    },
  });
  render(() => <App />);
  await screen.findByRole("button", { name: /Open account (actions|menu)/ });
  await fireEvent.click(await screen.findByRole("button", { name: /Launch room/ }));
  const chat = await screen.findByRole("main", { name: "Channel conversation" });
  await within(chat).findByRole("heading", { name: "Launch room", level: 1 });
  const composer = within(chat).getByRole("textbox", { name: "Message to channel" });
  composer.textContent = "Someone please draft the announcement";
  await fireEvent.input(composer);
  await fireEvent.click(within(chat).getByRole("button", { name: "Send message" }));

  const receipt = await within(chat).findByLabelText("Assigned to Chief");
  // Activity carries no bubble, so it offers none of the actions a message row does.
  expect(within(receipt).queryByRole("button", { name: "Copy" })).toBeNull();
  expect(within(receipt).queryByRole("button", { name: "Reply" })).toBeNull();
  expect(within(chat).queryByRole("article", { name: "Message from Chief" })).toBeNull();
  // The member it names stays reachable from the row.
  expect(within(receipt).getByRole("button", { name: "Open chat with Chief" })).toBeInTheDocument();
});

it("opens the agent chat when Edit agent runs while a channel is open", async () => {
  await openSavedChannel();

  await fireEvent.contextMenu(screen.getByRole("button", { name: /^Chief, Chief of staff/ }));
  await fireEvent.pointerUp(await screen.findByRole("menuitem", { name: "Edit agent" }), { button: 0 });

  await screen.findByRole("main", { name: "Conversation" });
  expect(screen.queryByRole("main", { name: "Channel conversation" })).toBeNull();
});

it.each([0, 1])("opens the agent chat from author control %i", async (control) => {
  const read = window.openbot.agent.readChannel;
  vi.spyOn(window.openbot.agent, "readChannel").mockImplementation(async (input) => ({
    ...(await read(input)),
    messages: [
      {
        id: "reply",
        channelId: input.channelId,
        sequence: 1,
        author: { kind: "agent", id: "chief", name: "Chief" },
        taskId: null,
        superseded: false,
        message: {
          id: "reply",
          author: "assistant",
          text: "The report is ready.",
          createdAt: new Date().toISOString(),
          status: "completed",
        },
      },
    ],
  }));
  const chat = await openSavedChannel();
  const controls = await within(chat).findAllByRole("button", { name: "Open Chief's chat" });
  const authorControl = controls[control];
  assert(authorControl);
  await fireEvent.click(authorControl);
  const conversation = await screen.findByRole("main", { name: "Conversation" });
  expect(within(conversation).getByRole("heading", { name: "Chief", level: 1 })).toBeVisible();
});

it("reports a message copy that the clipboard refuses", async () => {
  const writeText = vi.fn().mockRejectedValue(new DOMException("Document is not focused.", "NotAllowedError"));
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
  Object.defineProperty(document, "execCommand", { configurable: true, value: vi.fn(() => false) });
  const read = window.openbot.agent.readChannel;
  vi.spyOn(window.openbot.agent, "readChannel").mockImplementation(async (input) => ({
    ...(await read(input)),
    messages: [
      {
        id: "reply",
        channelId: input.channelId,
        sequence: 1,
        author: { kind: "agent", id: "chief", name: "Chief" },
        taskId: null,
        superseded: false,
        message: {
          id: "reply",
          author: "assistant",
          text: "The report is ready.",
          createdAt: new Date().toISOString(),
          status: "completed",
        },
      },
    ],
  }));
  try {
    const chat = await openSavedChannel();
    await fireEvent.pointerDown(await within(chat).findByRole("button", { name: "More message actions" }), {
      button: 0,
    });
    await fireEvent.pointerUp(screen.getByRole("menuitem", { name: "Copy" }), { button: 0 });

    expect(await within(chat).findByRole("alert")).toHaveTextContent("Could not copy the message.");
    expect(writeText).toHaveBeenCalledWith("The report is ready.");
  } finally {
    Reflect.deleteProperty(document, "execCommand");
  }
});

it.each(["owner", "admin", "member"] as const)("limits remote channel deletion for %s", async (role) => {
  vi.mocked(window.openbot.servers.list).mockResolvedValue([
    {
      ...testServer("remote-1", true),
      role,
      compatibility: {
        localAppVersion: "0.4.0",
        hostAppVersion: "0.4.0",
        localProtocol: { minimum: 3, maximum: 3 },
        hostProtocol: { minimum: 3, maximum: 3 },
        negotiatedProtocol: 3,
        capabilities: ["channel-chats-v1", "channel-delete-v1"],
      },
    },
  ]);
  await openSavedChannel();
  await fireEvent.contextMenu(channelRow("Project room"));
  await screen.findByRole("menuitem", { name: "Edit channel" });
  if (role === "member") {
    expect(screen.queryByRole("menuitem", { name: "Delete channel" })).not.toBeInTheDocument();
  } else {
    expect(screen.getByRole("menuitem", { name: "Delete channel" })).toBeVisible();
  }
});

it("opens the channel creation dialog from both sidebar context menus", async () => {
  await openSavedChannel();
  await fireEvent.contextMenu(channelRow("Project room"));
  await fireEvent.pointerUp(await screen.findByRole("menuitem", { name: "New channel" }), { button: 0 });
  const dialog = await screen.findByRole("dialog", { name: "New channel" });
  await fireEvent.click(within(dialog).getByRole("button", { name: "Close new channel" }));
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "New channel" })).not.toBeInTheDocument());

  await fireEvent.contextMenu(screen.getByLabelText("Sidebar free area"));
  await fireEvent.pointerUp(await screen.findByRole("menuitem", { name: "New channel" }), { button: 0 });
  await screen.findByRole("dialog", { name: "New channel" });
});

it("closes sidebar context menus on a left press on their trigger, outside press, and Escape", async () => {
  const chat = await openSavedChannel();
  const freeArea = screen.getByLabelText("Sidebar free area");
  const sidebarMenuClosed = () =>
    waitFor(() => expect(screen.queryByRole("menu", { name: "Sidebar actions" })).not.toBeInTheDocument());

  await fireEvent.contextMenu(freeArea);
  await screen.findByRole("menu", { name: "Sidebar actions" });
  await fireEvent.pointerDown(freeArea, { button: 0 });
  await sidebarMenuClosed();

  await fireEvent.contextMenu(freeArea);
  const menu = await screen.findByRole("menu", { name: "Sidebar actions" });
  await fireEvent.keyDown(menu, { key: "Escape" });
  await sidebarMenuClosed();

  await fireEvent.contextMenu(channelRow("Project room"));
  await screen.findByRole("menuitem", { name: "Edit channel" });
  await fireEvent.pointerDown(channelRow("Project room"), { button: 0 });
  await waitFor(() => expect(screen.queryByRole("menuitem", { name: "Edit channel" })).not.toBeInTheDocument());

  await fireEvent.contextMenu(freeArea);
  await screen.findByRole("menu", { name: "Sidebar actions" });
  await waitFor(async () => {
    await fireEvent.pointerDown(chat, { button: 0 });
    expect(screen.queryByRole("menu", { name: "Sidebar actions" })).not.toBeInTheDocument();
  });
});

it("keeps the section editor open past menu focus restoration", async () => {
  render(() => <App />);
  await screen.findByRole("button", { name: /Open account (actions|menu)/ });
  // Hold the trigger: the open menu hides the background from role queries.
  const trigger = await screen.findByRole("button", { name: "New agent or channel" });
  await fireEvent.pointerDown(trigger, { button: 0 });
  const item = await screen.findByRole("menuitem", { name: "New section" });
  // Frames are a fake modeling animation-frame timing, not a sleep: each step runs exactly
  // the callbacks the production code scheduled.
  const pendingFrames: FrameRequestCallback[] = [];
  const restore = vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
    pendingFrames.push(callback);
    return pendingFrames.length;
  });
  const runFrame = async () => {
    // Browsers checkpoint microtasks between callbacks in the same frame.
    for (const callback of pendingFrames.splice(0)) {
      callback(performance.now());
      await Promise.resolve();
    }
  };
  try {
    await fireEvent.pointerUp(item, { button: 0 });
    // The menu hands focus back to its trigger two frames after closing (focusRestoreHandler
    // in components/ui/complex.tsx); the editor must open only after that. Keep the counts
    // in step with complex.tsx.
    await runFrame();
    await runFrame();
    // This is exactly what that restoration does: focus the trigger. An editor that opened
    // too early loses its input to this steal and cancels on blur.
    trigger.focus();
    await runFrame();
    await runFrame();
    expect(screen.getByLabelText("New section")).toBeInTheDocument();
    expect(screen.getByLabelText("New section name")).toHaveFocus();
  } finally {
    restore.mockRestore();
  }
});

it("creates a channel from a searchable member dialog and keeps the chat open beside settings", async () => {
  const save = vi.spyOn(window.openbot.agent, "channelCommand");
  render(() => <App />);
  await screen.findByRole("button", { name: /Open account (actions|menu)/ });
  await fireEvent.pointerDown(await screen.findByRole("button", { name: "New agent or channel" }), { button: 0 });
  await fireEvent.pointerUp(await screen.findByRole("menuitem", { name: "New channel" }), { button: 0 });
  const dialog = await screen.findByRole("dialog", { name: "New channel" });
  await fireEvent.input(within(dialog).getByRole("textbox", { name: "Channel name" }), {
    target: { value: "Project room" },
  });
  const search = within(dialog).getByRole("searchbox", { name: "Search agents" });
  await fireEvent.input(search, { target: { value: "Chief" } });
  await fireEvent.click(within(dialog).getByRole("checkbox", { name: /Chief/ }));
  await fireEvent.click(within(dialog).getByRole("checkbox", { name: /Chief/ }));
  expect(within(dialog).getByRole("button", { name: "Create" })).toBeDisabled();
  await fireEvent.click(within(dialog).getByRole("checkbox", { name: /Chief/ }));
  await fireEvent.input(search, { target: { value: "Sales" } });
  expect(within(dialog).queryByRole("checkbox", { name: /Chief/ })).not.toBeInTheDocument();
  await fireEvent.click(within(dialog).getByRole("checkbox", { name: /Sales Outbound/ }));
  await fireEvent.click(within(dialog).getByRole("button", { name: "Create" }));
  await waitFor(() => expect(save).toHaveBeenCalled());
  expect(save.mock.calls[0]?.[0]).toMatchObject({
    type: "save",
    draft: {
      leadAgentId: "chief",
      title: "",
      instructions: "",
      members: [{ agentId: "chief" }, { agentId: "sales-outbound" }],
    },
  });
  const chat = await screen.findByRole("main", { name: "Channel conversation" });
  await within(chat).findByRole("heading", { name: "Project room", level: 1 });
  const composer = within(chat).getByRole("textbox", { name: "Message to channel" });
  composer.textContent = "Keep this draft";
  await fireEvent.input(composer);
  await openChannelMenuItem("Edit channel");
  const instructions = await within(chat).findByRole("textbox", { name: "Channel instructions" });
  expect(instructions).toHaveValue("");
  expect(within(chat).getByRole("button", { name: "Chief is the channel lead" })).toBeVisible();
  expect(within(chat).getByRole("button", { name: "Make Sales Outbound the channel lead" })).toBeVisible();
  expect(composer).toHaveTextContent("Keep this draft");
  // Leaving a field is the only commit: the panel has to survive it, or the next edit has nowhere
  // to happen.
  await fireEvent.input(instructions, { target: { value: "Coordinate the release" } });
  await fireEvent.blur(instructions);
  await waitFor(() =>
    expect(save.mock.calls.at(-1)?.[0]).toMatchObject({
      type: "save",
      draft: { instructions: "Coordinate the release" },
    }),
  );
  expect(instructions).toBeVisible();
  await fireEvent.click(within(chat).getByRole("button", { name: "Remove Chief" }));
  await waitFor(() =>
    expect(save.mock.calls.at(-1)?.[0]).toMatchObject({
      type: "save",
      draft: { instructions: "Coordinate the release", members: [{ agentId: "sales-outbound" }] },
    }),
  );
});

it("keeps the channel the reader opened while the save that creates another one is in flight", async () => {
  await window.openbot.agent.channelCommand({
    type: "save",
    operationId: "create",
    channelId: "channel-test",
    draft: {
      name: "Project room",
      title: "",
      instructions: "",
      members: [{ agentId: "chief" }],
      leadAgentId: "chief",
    },
  });
  render(() => <App />);
  await screen.findByRole("button", { name: /Open account (actions|menu)/ });
  await fireEvent.pointerDown(await screen.findByRole("button", { name: "New agent or channel" }), { button: 0 });
  await fireEvent.pointerUp(await screen.findByRole("menuitem", { name: "New channel" }), { button: 0 });
  const dialog = await screen.findByRole("dialog", { name: "New channel" });
  await fireEvent.input(within(dialog).getByRole("textbox", { name: "Channel name" }), {
    target: { value: "Release room" },
  });
  await fireEvent.click(within(dialog).getByRole("checkbox", { name: /Chief/ }));

  // The save waits on a gate, so the reader leaves the new channel while it is in flight.
  const original = window.openbot.agent.channelCommand;
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  vi.spyOn(window.openbot.agent, "channelCommand").mockImplementation(async (input) => {
    if (input.type === "save") await gate;
    return original(input);
  });
  void fireEvent.click(within(dialog).getByRole("button", { name: "Create" }));
  await fireEvent.click(within(dialog).getByRole("button", { name: "Close new channel" }));
  await fireEvent.click(await screen.findByRole("button", { name: /Project room/ }));
  const chat = await screen.findByRole("main", { name: "Channel conversation" });
  await within(chat).findByRole("heading", { name: "Project room", level: 1 });
  release();

  // The new channel arrives in the sidebar, but the reader stays where they went.
  await screen.findByRole("button", { name: /Release room/ });
  expect(within(chat).getByRole("heading", { level: 1 })).toHaveTextContent("Project room");
  expect(JSON.parse(window.localStorage.getItem(CHANNEL_SELECTION_STORAGE_KEY) ?? "{}")).toEqual({
    "user-1": { local: "channel-test" },
  });
});

it("keeps both removals when the second starts before the first save lands", async () => {
  await window.openbot.agent.channelCommand({
    type: "save",
    operationId: "create",
    channelId: "channel-test",
    draft: {
      name: "Project room",
      title: "",
      instructions: "",
      members: [{ agentId: "chief" }, { agentId: "sales-outbound" }],
      leadAgentId: "chief",
    },
  });
  render(() => <App />);
  await screen.findByRole("button", { name: /Open account (actions|menu)/ });
  await fireEvent.click(await screen.findByRole("button", { name: /Project room/ }));
  const chat = await screen.findByRole("main", { name: "Channel conversation" });
  await within(chat).findByRole("heading", { name: "Project room", level: 1 });
  await openChannelMenuItem("Edit channel");
  await within(chat).findByRole("button", { name: "Remove Chief" });

  // Both saves wait on one gate, so the second removal is started while the first is in flight.
  // A draft carries the whole member list, so a second draft built from the state before the
  // first save would put Chief back.
  const original = window.openbot.agent.channelCommand;
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  vi.spyOn(window.openbot.agent, "channelCommand").mockImplementation(async (input) => {
    if (input.type === "save") await gate;
    return original(input);
  });
  void fireEvent.click(within(chat).getByRole("button", { name: "Remove Chief" }));
  void fireEvent.click(within(chat).getByRole("button", { name: "Remove Sales Outbound" }));
  release();

  await waitFor(() => expect(within(chat).queryByRole("button", { name: "Remove Sales Outbound" })).toBeNull());
  expect(within(chat).queryByRole("button", { name: "Remove Chief" })).toBeNull();
});

it("builds the second removal on a channel read that started after the first save", async () => {
  await window.openbot.agent.channelCommand({
    type: "save",
    operationId: "create",
    channelId: "channel-test",
    draft: {
      name: "Project room",
      title: "",
      instructions: "",
      members: [{ agentId: "chief" }, { agentId: "sales-outbound" }],
      leadAgentId: "chief",
    },
  });
  render(() => <App />);
  await screen.findByRole("button", { name: /Open account (actions|menu)/ });
  await fireEvent.click(await screen.findByRole("button", { name: /Project room/ }));
  const chat = await screen.findByRole("main", { name: "Channel conversation" });
  await within(chat).findByRole("heading", { name: "Project room", level: 1 });
  await openChannelMenuItem("Edit channel");
  await within(chat).findByRole("button", { name: "Remove Chief" });

  // A read of the channel is already in flight when the first removal is saved, and it answers
  // with the members it found before that save. A draft carries the whole member list, so a save
  // that ends on this answer builds the next draft from the list it replaced. Every later read is
  // held as well, so this answer is the only one the second draft can be built on.
  let releaseFirstRead: () => void = () => undefined;
  let releaseLaterReads: () => void = () => undefined;
  const firstRead = new Promise<void>((resolve) => {
    releaseFirstRead = resolve;
  });
  const laterReads = new Promise<void>((resolve) => {
    releaseLaterReads = resolve;
  });
  let reads = 0;
  const originalRead = window.openbot.agent.readChannel;
  vi.spyOn(window.openbot.agent, "readChannel").mockImplementation(async (input) => {
    const first = ++reads === 1;
    // The answer holds the members this read found, not the ones the store keeps when it lands.
    const answer = structuredClone(await originalRead(input));
    await (first ? firstRead : laterReads);
    return answer;
  });
  emitAgentEvent?.({ type: "channels-changed", channelId: "channel-test", revision: 1 });
  await waitFor(() => expect(reads).toBe(1));

  const command = vi.spyOn(window.openbot.agent, "channelCommand");
  const saves = () => command.mock.calls.map(([input]) => input).filter((input) => input.type === "save");
  void fireEvent.click(within(chat).getByRole("button", { name: "Remove Chief" }));
  void fireEvent.click(within(chat).getByRole("button", { name: "Remove Sales Outbound" }));
  await waitFor(() => expect(saves()).toHaveLength(1));
  await command.mock.results[0]?.value;
  releaseFirstRead();
  await waitFor(() => expect(reads).toBe(2));
  releaseLaterReads();

  // The second save builds on the first: it removes the last member instead of restoring Chief.
  await waitFor(() => expect(saves()).toHaveLength(2));
  expect(saves().map((input) => (input.type === "save" ? input.draft.members : null))).toEqual([
    [{ agentId: "sales-outbound" }],
    [],
  ]);
  await waitFor(() => expect(within(chat).queryByRole("button", { name: "Remove Sales Outbound" })).toBeNull());
  expect(within(chat).queryByRole("button", { name: "Remove Chief" })).toBeNull();
});

it("keeps a queued settings save on the channel it was made in", async () => {
  for (const [channelId, name] of [
    ["channel-test", "Project room"],
    ["channel-other", "Release room"],
  ] satisfies [string, string][]) {
    await window.openbot.agent.channelCommand({
      type: "save",
      operationId: `create-${channelId}`,
      channelId,
      draft: {
        name,
        title: "",
        instructions: "",
        members: [{ agentId: "chief" }, { agentId: "sales-outbound" }],
        leadAgentId: "chief",
      },
    });
  }
  render(() => <App />);
  await screen.findByRole("button", { name: /Open account (actions|menu)/ });
  await fireEvent.click(await screen.findByRole("button", { name: /Project room/ }));
  const chat = await screen.findByRole("main", { name: "Channel conversation" });
  await within(chat).findByRole("heading", { name: "Project room", level: 1 });
  await openChannelMenuItem("Edit channel");
  await within(chat).findByRole("button", { name: "Remove Chief" });

  // Both removals wait on one gate, and the reader opens the other channel while they wait.
  const original = window.openbot.agent.channelCommand;
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const save = vi.spyOn(window.openbot.agent, "channelCommand").mockImplementation(async (input) => {
    if (input.type === "save") await gate;
    return original(input);
  });
  void fireEvent.click(within(chat).getByRole("button", { name: "Remove Chief" }));
  void fireEvent.click(within(chat).getByRole("button", { name: "Remove Sales Outbound" }));
  await fireEvent.click(screen.getByRole("button", { name: /Release room/ }));
  release();

  // Both saves belong to the channel they were made in, and the second builds on the first.
  await waitFor(() => expect(save.mock.calls.filter(([input]) => input.type === "save")).toHaveLength(2));
  const saves = save.mock.calls.map(([input]) => input).filter((input) => input.type === "save");
  expect(saves.map((input) => input.channelId)).toEqual(["channel-test", "channel-test"]);
  expect(saves.at(-1)).toMatchObject({ draft: { name: "Project room", members: [] } });
  // A settings save edits the channel that is open. It must never create one, or a save queued
  // behind the deletion of its own channel would bring the channel back.
  expect(saves.map((input) => input.type === "save" && input.update === true)).toEqual([true, true]);
});

/** Stopped task via read; the stub skips the automatic assignment limit. */
const STOPPED_TASK_REASON = "The automatic assignment limit was reached. Continue or reassign this task.";
it("shows a channel read that lands while more changes are still arriving", async () => {
  const chat = await openSavedChannel();
  // Hold every read open so events overtake them the way streaming does (see channels-context).
  const gates: Array<() => void> = [];
  const originalRead = window.openbot.agent.readChannel;
  vi.spyOn(window.openbot.agent, "readChannel").mockImplementation(async (input) => {
    await new Promise<void>((resolve) => gates.push(resolve));
    return originalRead(input);
  });
  await window.openbot.agent.channelCommand({
    type: "send",
    operationId: "request",
    channelId: "channel-test",
    text: "Prepare the report",
    recipientAgentId: "chief",
    replyToMessageId: null,
    attachmentDraftIds: [],
  });
  emitAgentEvent?.({ type: "channels-changed", channelId: "channel-test", revision: 1 });
  await waitFor(() => expect(gates).toHaveLength(1));
  for (const revision of [2, 3, 4]) emitAgentEvent?.({ type: "channels-changed", channelId: "channel-test", revision });

  // The running read answers for the changes behind it (see channels-context).
  gates[0]?.();
  await within(chat).findByRole("article", { name: "Message from You" });
  expect(within(chat).getByRole("article", { name: "Message from You" })).toHaveTextContent("Prepare the report");
  for (const release of gates) release();
});

async function openChannelWithStoppedTask(
  options: { withChild?: boolean; state?: "paused" | "failed"; error?: string | null } = {},
) {
  await window.openbot.agent.channelCommand({
    type: "save",
    operationId: "create",
    channelId: "channel-test",
    draft: {
      name: "Project room",
      title: "",
      instructions: "",
      members: [{ agentId: "chief" }, { agentId: "sales-outbound" }],
      leadAgentId: "chief",
    },
  });
  await window.openbot.agent.channelCommand({
    type: "send",
    operationId: "request",
    channelId: "channel-test",
    text: "Prepare the report",
    recipientAgentId: "chief",
    replyToMessageId: null,
    attachmentDraftIds: [],
  });
  const originalRead = window.openbot.agent.readChannel;
  const state = { taskId: "", stopped: true };
  const read = vi.spyOn(window.openbot.agent, "readChannel").mockImplementation(async (input) => {
    const page = await originalRead(input);
    state.taskId = page.tasks[0]?.id ?? "";
    if (!state.stopped) return page;
    const stopped = page.tasks.map((task) => ({
      ...task,
      state: options.state ?? ("paused" as const),
      error: options.error === undefined ? STOPPED_TASK_REASON : options.error,
    }));
    // The assignment limit stops the root task and everything under it, so the child arrives
    // stopped with the same reason on it.
    const child = stopped[0] ? [{ ...stopped[0], id: `${stopped[0].id}-child`, parentTaskId: stopped[0].id }] : [];
    return { ...page, tasks: options.withChild ? [...stopped, ...child] : stopped };
  });
  const originalCommand = window.openbot.agent.channelCommand;
  const command = vi.spyOn(window.openbot.agent, "channelCommand").mockImplementation(async (input) => {
    const result = await originalCommand(input);
    if (input.type === "resume" || input.type === "reassign") state.stopped = false;
    return result;
  });
  render(() => <App />);
  await screen.findByRole("button", { name: /Open account (actions|menu)/ });
  await fireEvent.click(await screen.findByRole("button", { name: /Project room/ }));
  const chat = await screen.findByRole("main", { name: "Channel conversation" });
  const notice = await within(chat).findByRole("region", { name: "Stopped task for Chief" });
  return { chat, notice, command, read, state };
}

it("continues a task the channel stopped with a reason", async () => {
  const { notice, command, state } = await openChannelWithStoppedTask();
  expect(notice).toHaveTextContent(STOPPED_TASK_REASON);
  await fireEvent.click(within(notice).getByRole("button", { name: "Continue" }));
  await waitFor(() =>
    expect(command).toHaveBeenCalledWith(
      expect.objectContaining({ type: "resume", taskId: state.taskId, recipientAgentId: null }),
    ),
  );
  await waitFor(() => expect(screen.queryByRole("region", { name: "Stopped task for Chief" })).not.toBeInTheDocument());
});

it("shows one notice for a stopped run and continues it at the root", async () => {
  const { command, state } = await openChannelWithStoppedTask({ withChild: true });
  expect(screen.getAllByRole("region", { name: /^Stopped task for / })).toHaveLength(1);
  const notice = screen.getByRole("region", { name: /^Stopped task for / });
  await fireEvent.click(within(notice).getByRole("button", { name: "Continue" }));
  await waitFor(() =>
    expect(command).toHaveBeenCalledWith(expect.objectContaining({ type: "resume", taskId: state.taskId })),
  );
});

it("reassigns a task the channel stopped with a reason", async () => {
  const { notice, command, state } = await openChannelWithStoppedTask();
  await fireEvent.pointerDown(within(notice).getByRole("button", { name: "Reassign the stopped task of Chief" }), {
    button: 0,
  });
  await fireEvent.pointerUp(await screen.findByRole("menuitem", { name: "Sales Outbound" }), { button: 0 });
  await waitFor(() =>
    expect(command).toHaveBeenCalledWith(
      expect.objectContaining({ type: "reassign", taskId: state.taskId, recipientAgentId: "sales-outbound" }),
    ),
  );
  await waitFor(() => expect(screen.queryByRole("region", { name: "Stopped task for Chief" })).not.toBeInTheDocument());
});

it("keeps a stopped-task notice after a failed action and a refresh", async () => {
  const { notice, command, read } = await openChannelWithStoppedTask();
  command.mockRejectedValueOnce(new Error("Connection lost. Try again."));
  await fireEvent.click(within(notice).getByRole("button", { name: "Continue" }));
  await screen.findByText("Connection lost. Try again.");
  expect(screen.getByRole("region", { name: "Stopped task for Chief" })).toHaveTextContent(STOPPED_TASK_REASON);

  read.mockClear();
  await fireEvent.focus(window);
  await waitFor(() => expect(read).toHaveBeenCalled());
  expect(await screen.findByRole("region", { name: "Stopped task for Chief" })).toHaveTextContent(STOPPED_TASK_REASON);
  await fireEvent.click(
    within(screen.getByRole("region", { name: "Stopped task for Chief" })).getByRole("button", { name: "Continue" }),
  );
  await waitFor(() => expect(screen.queryByRole("region", { name: "Stopped task for Chief" })).not.toBeInTheDocument());
});

it("retries a lost response once and keeps a focused draft through incoming messages", async () => {
  const chat = await openSavedChannel();
  const originalCommand = window.openbot.agent.channelCommand;
  let loseResponse = true;
  vi.spyOn(window.openbot.agent, "channelCommand").mockImplementation(async (input) => {
    const result = await originalCommand(input);
    if (input.type === "send" && loseResponse) {
      loseResponse = false;
      throw new Error("Connection lost after sending.");
    }
    return result;
  });
  const composer = within(chat).getByRole("textbox", { name: "Message to channel" });
  composer.textContent = "@[Chief](agent:chief) Prepare the report";
  await fireEvent.input(composer);
  await fireEvent.click(within(chat).getByRole("button", { name: "Send message" }));
  await fireEvent.click(await within(chat).findByRole("button", { name: "Retry" }));
  expect(window.openbot.agent.channelCommand).toHaveBeenCalledWith(
    expect.objectContaining({ type: "send", recipientAgentId: "chief" }),
  );
  await waitFor(() => expect(composer).toHaveTextContent(""));
  expect(within(chat).getAllByRole("article", { name: "Message from You" })).toHaveLength(1);
  expect(within(chat).getByRole("article", { name: "Message from You" })).toHaveTextContent("Prepare the report");
  await waitFor(() =>
    expect(channelRow("Project room")).toHaveAccessibleName("Project room. @Chief Prepare the report"),
  );
  composer.textContent = "Keep this draft";
  await fireEvent.input(composer);
  composer.focus();
  await window.openbot.agent.channelCommand({
    type: "send",
    operationId: "incoming",
    channelId: "channel-test",
    text: "Another request",
    recipientAgentId: "chief",
    replyToMessageId: null,
    attachmentDraftIds: [],
  });
  await within(chat).findByText("Another request");
  expect(composer).toHaveFocus();
  expect(composer).toHaveTextContent("Keep this draft");
});

it("keeps deleted channel history for preview below active chats", async () => {
  const chat = await openSavedChannel();
  const composer = within(chat).getByRole("textbox", { name: "Message to channel" });
  composer.textContent = "Keep this history";
  await fireEvent.input(composer);
  await fireEvent.click(within(chat).getByRole("button", { name: "Send message" }));
  await within(chat).findByText("Keep this history");
  await waitFor(() => expect(composer).toHaveTextContent(""));
  await waitFor(() => expect(channelRow("Project room")).toHaveAccessibleName("Project room. Keep this history"));
  await openChannelMenuItem("Delete channel");
  const dialog = await screen.findByRole("alertdialog", { name: "Delete Project room?" });
  await fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }));
  await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());
  expect(screen.queryByRole("button", { name: /^Project room\./ })).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: /^Chief, Chief of staff/ })).toBeInTheDocument();
  expect((await window.openbot.agent.listChannels()).find((channel) => channel.id === "channel-test")?.archived).toBe(
    true,
  );
  await within(chat).findByText("Deleted channel. Preview only.");
  expect(within(chat).queryByRole("textbox")).not.toBeInTheDocument();
  expect(within(chat).queryByRole("button", { name: /Reply to/ })).not.toBeInTheDocument();
  expect(within(chat).getByRole("button", { name: "Channel settings" })).toBeDisabled();
  expect(within(chat).getByText("Keep this history")).toBeInTheDocument();
  await fireEvent.contextMenu(screen.getByLabelText("Sidebar free area"));
  await fireEvent.pointerUp(await screen.findByRole("menuitem", { name: "Deleted channels" }), { button: 0 });
  const deleted = await screen.findByRole("region", { name: "Deleted channels" });
  expect(within(deleted).getByRole("button", { name: /^Project room\./ })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: /^Chief, Chief of staff/ })).toBeInTheDocument();
});

it("closes a channel deleted from another connection", async () => {
  await openSavedChannel();
  await window.openbot.agent.deleteChannel("channel-test");
  await waitFor(() => expect(screen.queryByRole("main", { name: "Channel conversation" })).not.toBeInTheDocument());
  expect(screen.queryByRole("button", { name: /^Project room\./ })).not.toBeInTheDocument();
});

it("shows the message a channel reply answers and puts the caret in the message box", async () => {
  const chat = await openSavedChannel();
  const composer = within(chat).getByRole("textbox", { name: "Message to channel" });
  composer.textContent = "Prepare the report";
  await fireEvent.input(composer);
  await fireEvent.click(within(chat).getByRole("button", { name: "Send message" }));
  await within(chat).findByRole("article", { name: "Message from You" });

  const shown = within(chat).getAllByText("Prepare the report").length;
  await fireEvent.click(within(chat).getByRole("button", { name: /Reply to/ }));
  await within(chat).findByText("Replying to You");
  // The quote above the message box repeats the text of the message that is answered.
  expect(within(chat).getAllByText("Prepare the report")).toHaveLength(shown + 1);
  await waitFor(() => expect(composer).toHaveFocus());

  await fireEvent.click(within(chat).getByRole("button", { name: "Cancel reply" }));
  await waitFor(() => expect(within(chat).queryByText("Replying to You")).not.toBeInTheDocument());
});

it("keeps the channel message box open while a send runs and says why a second send waits", async () => {
  const chat = await openSavedChannel();
  const originalCommand = window.openbot.agent.channelCommand;
  const release = Promise.withResolvers<void>();
  vi.spyOn(window.openbot.agent, "channelCommand").mockImplementation(async (input) => {
    if (input.type === "send") await release.promise;
    return originalCommand(input);
  });
  const composer = within(chat).getByRole("textbox", { name: "Message to channel" });
  composer.textContent = "First request";
  await fireEvent.input(composer);
  await fireEvent.click(within(chat).getByRole("button", { name: "Send message" }));
  await within(chat).findByText("Sending…");

  // The person keeps writing, and an Enter during the send is answered, not dropped.
  expect(composer).toHaveAttribute("aria-disabled", "false");
  composer.textContent = "First request and a second thought";
  await fireEvent.input(composer);
  await fireEvent.keyDown(composer, { key: "Enter" });
  await within(chat).findByText("Wait for the message to send, then send again.");

  release.resolve();
  await waitFor(() => expect(within(chat).queryByText("Sending…")).not.toBeInTheDocument());
  // The text changed after the send, so it stays in the box for the person to send or edit.
  expect(composer).toHaveTextContent("First request and a second thought");
});

it("attaches a file that the desktop imports from a paste or drop, and shows an import failure", async () => {
  const chat = await openSavedChannel();
  emitAttachmentImport?.({ type: "started", requestId: "channel-paste", serverId: "local" });
  emitAttachmentImport?.({
    type: "completed",
    requestId: "channel-paste",
    serverId: "local",
    attachments: [attachment("paste-1", "report.pdf", "pdf")],
  });
  await within(chat).findByRole("button", { name: "Remove report.pdf" });

  emitAttachmentImport?.({ type: "started", requestId: "channel-bad", serverId: "local" });
  emitAttachmentImport?.({
    type: "error",
    requestId: "channel-bad",
    serverId: "local",
    message: "notes.xyz is not supported.",
  });
  expect(await within(chat).findByText("notes.xyz is not supported.")).toBeInTheDocument();
});

it("addresses a channel member only while the request names one", async () => {
  const chat = await openSavedChannel();
  const command = vi.spyOn(window.openbot.agent, "channelCommand");
  const composer = within(chat).getByRole("textbox", { name: "Message to channel" });
  composer.textContent = "@[Chief](agent:chief) Prepare the report";
  await fireEvent.input(composer);
  await fireEvent.click(within(chat).getByRole("button", { name: "Send message" }));
  await waitFor(() =>
    expect(command).toHaveBeenCalledWith(expect.objectContaining({ type: "send", recipientAgentId: "chief" })),
  );

  // The composer keeps no recipient of its own; a stale one would address every later request.
  await waitFor(() => expect(composer).toHaveTextContent(""));
  composer.textContent = "Add the rollback step";
  await fireEvent.input(composer);
  await fireEvent.click(within(chat).getByRole("button", { name: "Send message" }));
  await waitFor(() =>
    expect(command).toHaveBeenCalledWith(
      expect.objectContaining({ type: "send", text: "Add the rollback step", recipientAgentId: null }),
    ),
  );
});

/** Routing window: a root task no member owns yet. */
async function openChannelWhileRouting(state: "queued" | "paused") {
  await window.openbot.agent.channelCommand({
    type: "save",
    operationId: "create",
    channelId: "channel-test",
    draft: {
      name: "Project room",
      title: "",
      instructions: "",
      members: [{ agentId: "chief" }, { agentId: "sales-outbound" }],
      leadAgentId: "chief",
    },
  });
  await window.openbot.agent.channelCommand({
    type: "send",
    operationId: "request",
    channelId: "channel-test",
    text: "Prepare the report",
    recipientAgentId: null,
    replyToMessageId: null,
    attachmentDraftIds: [],
  });
  const originalRead = window.openbot.agent.readChannel;
  vi.spyOn(window.openbot.agent, "readChannel").mockImplementation(async (input) => {
    const page = await originalRead(input);
    return {
      ...page,
      tasks: page.tasks.map((task) => ({
        ...task,
        ownerAgentId: null,
        state,
        error: state === "paused" ? STOPPED_TASK_REASON : null,
      })),
    };
  });
  render(() => <App />);
  await screen.findByRole("button", { name: /Open account (actions|menu)/ });
  await fireEvent.click(await screen.findByRole("button", { name: /Project room/ }));
  return screen.findByRole("main", { name: "Channel conversation" });
}

it("keeps the working indicator while the coordinator chooses an owner", async () => {
  const chat = await openChannelWhileRouting("queued");
  // The lead is the coordinator. Its routing turn holds the task and posts nothing until it
  // decides, so the indicator is the only sign that the request is alive.
  expect(await within(chat).findByRole("status", { name: /^Chief is working: / })).toBeInTheDocument();
});

/** A channel whose task for Chief runs, so a request of Chief can be answered in the channel. */
async function openChannelWithRunningTask() {
  await window.openbot.agent.channelCommand({
    type: "save",
    operationId: "create",
    channelId: "channel-test",
    draft: {
      name: "Project room",
      title: "",
      instructions: "",
      members: [{ agentId: "chief" }, { agentId: "sales-outbound" }],
      leadAgentId: "chief",
    },
  });
  await window.openbot.agent.channelCommand({
    type: "send",
    operationId: "request",
    channelId: "channel-test",
    text: "Prepare the report",
    recipientAgentId: "chief",
    replyToMessageId: null,
    attachmentDraftIds: [],
  });
  const originalRead = window.openbot.agent.readChannel;
  vi.spyOn(window.openbot.agent, "readChannel").mockImplementation(async (input) => {
    const page = await originalRead(input);
    return {
      ...page,
      tasks: page.tasks.map((task) => ({ ...task, ownerAgentId: "chief", state: "running" as const, error: null })),
    };
  });
  render(() => <App />);
  await screen.findByRole("button", { name: /Open account (actions|menu)/ });
  await fireEvent.click(await screen.findByRole("button", { name: /Project room/ }));
  return screen.findByRole("main", { name: "Channel conversation" });
}

function approvalOf(requestId: number, threadId: string) {
  return {
    requestId,
    agentId: "chief",
    threadId,
    turnId: `turn-${requestId}`,
    kind: "command" as const,
    command: "bun run report",
    cwd: null,
    reason: null,
    grantRoot: null,
    permissions: null,
  };
}

it("names the agent that asks for an approval in the channel", async () => {
  const chat = await openChannelWithRunningTask();
  emitAgentEvent?.({ type: "approval", approval: approvalOf(31, "thread-channel-chief") });

  const card = await within(chat).findByRole("region", { name: "Approval for Chief" });
  expect(within(card).getByText("Chief")).toBeInTheDocument();
  expect(within(card).getByRole("button", { name: "Allow" })).toBeInTheDocument();
});

it("leaves the approval of a member's own chat to that chat", async () => {
  const chat = await openChannelWithRunningTask();
  // `thread-chief` is the thread of the agent chat of Chief, not a thread of this channel.
  emitAgentEvent?.({ type: "approval", approval: approvalOf(32, "thread-chief") });

  await within(chat).findByRole("status", { name: /^Chief is working: / });
  expect(within(chat).queryByRole("region", { name: /^Approval/ })).not.toBeInTheDocument();
  expect(within(chat).queryByRole("button", { name: "Allow" })).not.toBeInTheDocument();
});

/** A channel message, as the host stores it. A test adds it to the page the stub returns. */
function storedMessage(
  id: string,
  sequence: number,
  author: ChannelMessage["author"],
  text: string,
  overrides: Partial<ChannelMessage["message"]> & { superseded?: boolean } = {},
): ChannelMessage {
  const { superseded, ...message } = overrides;
  return {
    id,
    channelId: "channel-test",
    sequence,
    author,
    taskId: null,
    superseded: superseded ?? false,
    message: {
      id,
      author: author.kind === "member" ? "user" : "assistant",
      text,
      createdAt: new Date(2026, 8, 9, 12, sequence).toISOString(),
      status: "completed",
      ...message,
    },
  };
}

/**
 * Opens a saved channel whose page also holds the given messages, with `unread` of them unread.
 * The unread count of the list is `unread.count`, so a test can move it the way reading does.
 */
async function openChannelWithMessages(messages: ChannelMessage[], unreadCount = 0) {
  const unread = { count: unreadCount };
  await window.openbot.agent.channelCommand({
    type: "save",
    operationId: "create",
    channelId: "channel-test",
    draft: {
      name: "Project room",
      title: "",
      instructions: "",
      members: [{ agentId: "chief" }, { agentId: "sales-outbound" }],
      leadAgentId: "chief",
    },
  });
  const originalRead = window.openbot.agent.readChannel;
  vi.spyOn(window.openbot.agent, "readChannel").mockImplementation(async (input) => {
    const page = await originalRead(input);
    return { ...page, messages, throughSequence: messages.at(-1)?.sequence ?? 0 };
  });
  const originalList = window.openbot.agent.listChannels;
  vi.spyOn(window.openbot.agent, "listChannels").mockImplementation(async () =>
    (await originalList()).map((channel) => ({ ...channel, unreadCount: unread.count })),
  );
  render(() => <App />);
  await screen.findByRole("button", { name: /Open account (actions|menu)/ });
  await fireEvent.click(await screen.findByRole("button", { name: /Project room/ }));
  const chat = await screen.findByRole("main", { name: "Channel conversation" });
  return Object.assign(chat, { unread });
}

const chiefAuthor = { kind: "agent" as const, id: "chief", name: "Chief" };

it("draws the reasoning of an agent as one closed Thinking row in the channel", async () => {
  const chat = await openChannelWithMessages([
    storedMessage("t1", 1, chiefAuthor, "Reading the report.", { itemType: "commentary" }),
    storedMessage("t2", 2, chiefAuthor, "Checking the totals.", { itemType: "commentary" }),
    storedMessage("a3", 3, chiefAuthor, "The totals match."),
  ]);

  const thinking = await within(chat).findByRole("button", { name: /^Thinking/ });
  expect(within(chat).getAllByRole("button", { name: /^Thinking/ })).toHaveLength(1);
  expect(thinking).toHaveAttribute("aria-expanded", "false");
  expect(within(chat).getByText("The totals match.")).toBeInTheDocument();
  expect(within(chat).queryByText("Reading the report.")).not.toBeInTheDocument();

  await fireEvent.click(thinking);
  expect(await within(chat).findByText("Reading the report.")).toBeInTheDocument();
  expect(within(chat).getByText("Checking the totals.")).toBeInTheDocument();
});

it("shows a closed Thinking row with no preview line when reasoning is switched off", async () => {
  setShowAgentReasoning(false);
  try {
    const chat = await openChannelWithMessages([
      storedMessage("t1", 1, chiefAuthor, "Reading the report.", { itemType: "commentary" }),
      storedMessage("a2", 2, chiefAuthor, "The totals match."),
    ]);
    const thinking = await within(chat).findByRole("button", { name: "Thinking" });
    expect(thinking).toHaveAttribute("aria-expanded", "false");
    await fireEvent.click(thinking);
    expect(await within(chat).findByText("Reading the report.")).toBeInTheDocument();
  } finally {
    setShowAgentReasoning(true);
  }
});

it("draws a teammate as a member and an earlier answer muted with a note", async () => {
  const chat = await openChannelWithMessages([
    storedMessage("m1", 1, { kind: "member", id: "member-2", name: "Ada" }, "Please add the totals."),
    storedMessage("a2", 2, chiefAuthor, "First draft.", { superseded: true }),
    storedMessage("a3", 3, chiefAuthor, "Second draft.", { status: "interrupted" }),
  ]);

  const teammate = await within(chat).findByRole("article", { name: "Message from Ada" });
  expect(teammate).toHaveTextContent("Please add the totals.");
  expect(within(chat).queryByRole("button", { name: /Open Ada's chat/ })).not.toBeInTheDocument();
  const earlier = within(chat).getByText("First draft.").closest<HTMLElement>('[role="article"]');
  assert(earlier);
  expect(within(earlier).getByText("Earlier answer. The task changed after it.")).toBeInTheDocument();
  const cut = within(chat).getByText("Second draft.").closest<HTMLElement>('[role="article"]');
  assert(cut);
  expect(within(cut).getByText("This answer stopped before it was done.")).toBeInTheDocument();
});

it("keeps the unread divider while the channel is read, and drops it when the reader leaves", async () => {
  const command = vi.spyOn(window.openbot.agent, "channelCommand");
  const chat = await openChannelWithMessages(
    [
      storedMessage("a1", 1, chiefAuthor, "Already read."),
      storedMessage("a2", 2, chiefAuthor, "First new answer."),
      storedMessage("a3", 3, chiefAuthor, "Second new answer."),
    ],
    2,
  );
  const divider = await within(chat).findByRole("separator", { name: "New messages" });
  expect(within(chat).getByText("NEW")).toBeInTheDocument();

  // The channel is in front, so it is marked read. The count of the list falls to zero.
  await waitFor(() => expect(command).toHaveBeenCalledWith(expect.objectContaining({ type: "read" })));
  chat.unread.count = 0;
  const read = vi.spyOn(window.openbot.agent, "readChannel");
  read.mockClear();
  await fireEvent.focus(window);
  await waitFor(() => expect(read).toHaveBeenCalled());

  // The divider stays where the unread part began.
  expect(within(chat).getByRole("separator", { name: "New messages" })).toBeInTheDocument();
  const row = within(chat).getByText("First new answer.");
  expect(row.compareDocumentPosition(divider) & Node.DOCUMENT_POSITION_PRECEDING).toBeTruthy();

  // Another chat and back is a new opening, and nothing is unread now.
  await fireEvent.click(screen.getByRole("button", { name: /^Chief, Chief of staff/ }));
  await screen.findByRole("main", { name: "Conversation" });
  await fireEvent.click(await screen.findByRole("button", { name: /Project room/ }));
  const again = await screen.findByRole("main", { name: "Channel conversation" });
  await within(again).findByText("Second new answer.");
  expect(within(again).queryByRole("separator", { name: "New messages" })).not.toBeInTheDocument();
});

it("keeps a task the reader stopped, says so, and names its owner and request", async () => {
  const { notice, command, state } = await openChannelWithStoppedTask({ error: null });
  expect(notice).toHaveTextContent("Stopped by you.");
  expect(within(notice).getByText("Chief")).toBeInTheDocument();
  expect(within(notice).getByText("Prepare the report")).toBeInTheDocument();
  expect(within(notice).getByRole("button", { name: "Open the chat of Chief" })).toBeInTheDocument();

  await fireEvent.click(within(notice).getByRole("button", { name: "Continue" }));
  await waitFor(() =>
    expect(command).toHaveBeenCalledWith(
      expect.objectContaining({ type: "resume", taskId: state.taskId, recipientAgentId: null }),
    ),
  );
  await waitFor(() => expect(screen.queryByRole("region", { name: "Stopped task for Chief" })).not.toBeInTheDocument());
});

it("opens the chat of the owner of a stopped task", async () => {
  const { notice } = await openChannelWithStoppedTask();
  await fireEvent.click(within(notice).getByRole("button", { name: "Open the chat of Chief" }));
  await screen.findByRole("main", { name: "Conversation" });
});

it("names the member who works and the member who waits for a free place", async () => {
  await window.openbot.agent.channelCommand({
    type: "save",
    operationId: "create",
    channelId: "channel-test",
    draft: {
      name: "Project room",
      title: "",
      instructions: "",
      members: [{ agentId: "chief" }, { agentId: "sales-outbound" }],
      leadAgentId: "chief",
    },
  });
  await window.openbot.agent.channelCommand({
    type: "send",
    operationId: "request",
    channelId: "channel-test",
    text: "Prepare the report",
    recipientAgentId: "chief",
    replyToMessageId: null,
    attachmentDraftIds: [],
  });
  const originalRead = window.openbot.agent.readChannel;
  vi.spyOn(window.openbot.agent, "readChannel").mockImplementation(async (input) => {
    const page = await originalRead(input);
    const [first] = page.tasks;
    if (!first) return page;
    return {
      ...page,
      tasks: [
        { ...first, ownerAgentId: "chief", state: "running" as const, error: null },
        { ...first, id: "task-queued", ownerAgentId: "sales-outbound", state: "queued" as const, error: null },
      ],
    };
  });
  render(() => <App />);
  await screen.findByRole("button", { name: /Open account (actions|menu)/ });
  await fireEvent.click(await screen.findByRole("button", { name: /Project room/ }));
  const chat = await screen.findByRole("main", { name: "Channel conversation" });

  expect(
    await within(chat).findByRole("status", { name: /^Chief is working · Sales Outbound queued: / }),
  ).toBeInTheDocument();
  expect(within(chat).getByText("Chief is working · Sales Outbound queued")).toBeVisible();
});

it("does not make the whole channel transcript a live region", async () => {
  const chat = await openChannelWithMessages([storedMessage("a1", 1, chiefAuthor, "The totals match.")]);
  const transcript = await within(chat).findByRole("region", { name: "Shared messages" });
  expect(transcript).not.toHaveAttribute("aria-live");
});
