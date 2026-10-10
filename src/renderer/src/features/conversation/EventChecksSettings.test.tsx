import type { EventCheckApi, EventCheckInput } from "@openbot/contracts/event-checks";
import { decodeEventCheckInput } from "@openbot/contracts/event-checks";
import { EventChecksSettings } from "@openbot/ui/features/conversation/EventChecksSettings";
import { fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { assert, expect, it, vi } from "vitest";
import { createMockEventCheckTemplates, PREVIEW_EVENT_CHECK_TEMPLATE } from "../../preview/mock-event-check-templates";
import { createMockEventChecks } from "../../preview/mock-event-checks";

const input: EventCheckInput = {
  agentId: "chief",
  name: "Linear tickets",
  instruction: "Review new tickets",
  active: true,
  timezone: "UTC",
  schedule: { kind: "interval", amount: 1, unit: "minutes", anchorAt: new Date().toISOString() },
  source: {
    kind: "mcp",
    connectionId: "preview-linear",
    toolName: "list_issues",
    argumentsJson: "{}",
    cursorArgument: "",
    nextCursorPointer: "",
  },
  selfEvents: { mode: "include", connectionId: "", actorPointer: "", accountActorIds: [] },
  selection: { itemsPointer: "/items", idPointer: "/id", revisionPointer: "" },
};
it("edits timing and shows its own ten-check history without a desktop preload or proxy-clone failure", async () => {
  const api = createMockEventChecks();
  const check = await api.save(input);
  for (let index = 0; index < 12; index++) await api.checkNow({ agentId: "chief", id: check.id });
  const save = vi.spyOn(api, "save");
  const checkNow = vi.spyOn(api, "checkNow");
  vi.stubGlobal("openbot", undefined);
  try {
    render(() => (
      <EventChecksSettings api={api} agentId="chief" onBack={vi.fn()} onClose={vi.fn()} onCountChange={vi.fn()} />
    ));
    await fireEvent.click(await screen.findByRole("button", { name: "Linear tickets" }));
    const timing = await screen.findByRole("spinbutton", { name: "Every (seconds)" });
    await fireEvent.input(timing, { target: { value: "30" } });
    expect(screen.getByRole("button", { name: "Check now" })).toBeDisabled();
    await fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(save).toHaveBeenCalled());
    expect(save.mock.calls[0]?.[0].schedule).toMatchObject({ kind: "interval", amount: 30, unit: "seconds" });
    expect(checkNow).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.getByRole("button", { name: "Last 10 checks" })).not.toBeDisabled());
    await fireEvent.click(screen.getByRole("button", { name: "Last 10 checks" }));
    await screen.findByRole("region", { name: "Last 10 checks" });
    expect(screen.getAllByText("No changes")).toHaveLength(10);
    expect(screen.queryByRole("alert")).toBeNull();
  } finally {
    vi.unstubAllGlobals();
  }
});

it("preserves a two-day interval when editing other check settings", async () => {
  const api = createMockEventChecks();
  await api.save({
    ...input,
    schedule: { kind: "interval", amount: 2, unit: "days", anchorAt: new Date().toISOString() },
  });
  render(() => (
    <EventChecksSettings api={api} agentId="chief" onBack={vi.fn()} onClose={vi.fn()} onCountChange={vi.fn()} />
  ));
  await fireEvent.click(await screen.findByRole("button", { name: "Linear tickets" }));
  expect(screen.getByRole("spinbutton", { name: "Every (seconds)" })).toHaveValue(172800);
  await fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(async () => {
    const saved = (await api.list({ agentId: "chief" }))[0];
    expect(decodeEventCheckInput(saved).schedule).toMatchObject({ amount: 172800, unit: "seconds" });
  });
});

it("shows agent-defined configuration and masked private values without discarding unsaved edits", async () => {
  const api = createMockEventChecks();
  const check = await api.save({
    ...input,
    active: false,
    source: {
      kind: "api",
      connectionId: "Linear job one",
      toolName: "linear.mjs",
      variables: ["LINEAR_API_TOKEN"],
      configuration: [{ name: "workspace", label: "Workspace", description: "Only this workspace", value: "one" }],
      argumentsJson: "{}",
      cursorArgument: "cursor",
      nextCursorPointer: "/cursor",
    },
  });
  const save = vi.spyOn(api, "save"),
    write = vi.spyOn(api, "setEnvironment"),
    test = vi.spyOn(api, "test");
  render(() => (
    <EventChecksSettings api={api} agentId="chief" onBack={vi.fn()} onClose={vi.fn()} onCountChange={vi.fn()} />
  ));
  await fireEvent.click(await screen.findByRole("button", { name: "Linear tickets" }));
  const token = await screen.findByLabelText(/LINEAR_API_TOKEN — Missing/);
  expect(token).toHaveAttribute("type", "password");
  expect(token).toHaveValue("");
  await fireEvent.input(screen.getByRole("textbox", { name: "Workspace" }), { target: { value: "two" } });
  await waitFor(() => {
    expect(screen.getByRole("textbox", { name: "Workspace" })).toHaveValue("two");
    expect(screen.getByLabelText(/LINEAR_API_TOKEN — Missing/)).toBeDisabled();
  });
  await fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(save).toHaveBeenCalled());
  expect(save.mock.calls[0]?.[0].source).toMatchObject({ configuration: [{ name: "workspace", value: "two" }] });
  await waitFor(() => expect(screen.getByLabelText(/LINEAR_API_TOKEN — Missing/)).not.toBeDisabled());
  await fireEvent.input(screen.getByLabelText(/LINEAR_API_TOKEN — Missing/), {
    target: { value: "test-private-token" },
  });
  await fireEvent.click(screen.getByRole("button", { name: "Save value" }));
  await waitFor(() =>
    expect(write).toHaveBeenCalledWith({
      agentId: "chief",
      id: check.id,
      name: "LINEAR_API_TOKEN",
      value: "test-private-token",
    }),
  );
  const masked = await screen.findByLabelText(/LINEAR_API_TOKEN — Set/);
  expect(masked).toHaveValue("");
  expect(screen.queryByText("test-private-token")).toBeNull();
  expect(screen.getByRole("textbox", { name: "Workspace" })).toHaveValue("two");
  await waitFor(() => expect(screen.getByRole("button", { name: "Test without AI" })).not.toBeDisabled());
  await fireEvent.click(screen.getByRole("button", { name: "Test without AI" }));
  await waitFor(() => expect(test).toHaveBeenCalled());
  expect((await api.list({ agentId: "chief" }))[0]?.active).toBe(false);
  await fireEvent.click(screen.getByRole("button", { name: "Remove value" }));
  await screen.findByLabelText(/LINEAR_API_TOKEN — Missing/);
});

it("asks to approve a program that changed, and sends the approval only from that button", async () => {
  const api = createMockEventChecks();
  const check = await api.save({
    ...input,
    active: false,
    source: {
      kind: "api",
      connectionId: "Linear job one",
      toolName: "linear.mjs",
      variables: ["LINEAR_API_TOKEN"],
      configuration: [],
      argumentsJson: "{}",
      cursorArgument: "cursor",
      nextCursorPointer: "/cursor",
    },
  });
  vi.spyOn(api, "environment").mockResolvedValue([{ name: "LINEAR_API_TOKEN", configured: false, reapprove: true }]);
  const save = vi.spyOn(api, "save");
  render(() => (
    <EventChecksSettings api={api} agentId="chief" onBack={vi.fn()} onClose={vi.fn()} onCountChange={vi.fn()} />
  ));
  await fireEvent.click(await screen.findByRole("button", { name: "Linear tickets" }));
  await screen.findByText(/changed after you added these values/);
  expect(save).not.toHaveBeenCalled();
  await fireEvent.click(screen.getByRole("button", { name: "Approve this program" }));
  await waitFor(() => expect(save).toHaveBeenCalledOnce());
  expect(save.mock.calls[0]?.[0]).toMatchObject({ id: check.id, approveProgram: true });
});

it("marks a check that keeps failing in the list, and saves its item filters only when they are valid", async () => {
  const api = createMockEventChecks();
  const check = await api.save(input);
  vi.spyOn(api, "list").mockResolvedValue([
    {
      ...check,
      health: { consecutiveErrors: 3, lastError: "The app limited the requests. The check waits and tries again." },
    },
  ]);
  const save = vi.spyOn(api, "save");
  render(() => (
    <EventChecksSettings api={api} agentId="chief" onBack={vi.fn()} onClose={vi.fn()} onCountChange={vi.fn()} />
  ));
  expect(await screen.findByText("Failing")).toBeInTheDocument();
  await fireEvent.click(await screen.findByRole("button", { name: /Linear tickets/ }));
  // The reason is a visible line in the editor, and the heading points to it.
  expect(await screen.findByText(/The last 3 checks failed: The app limited the requests/)).toBeVisible();
  expect(screen.getByRole("heading", { name: "Event check" })).toHaveAccessibleDescription(/The last 3 checks failed/);
  const filters = await screen.findByRole("textbox", { name: "Only deliver items that match (one per line)" });
  await fireEvent.input(filters, { target: { value: "state=open" } });
  await fireEvent.click(screen.getByRole("button", { name: "Save" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Each filter line needs a path");
  expect(save).not.toHaveBeenCalled();
  await fireEvent.input(filters, { target: { value: "/state=open" } });
  await fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(save).toHaveBeenCalled());
  expect(save.mock.calls[0]?.[0].delivery).toEqual({
    digestSeconds: 0,
    itemFilters: [{ pointer: "/state", value: "open" }],
  });
});

/** A template check on `chief` with a picker setting, an optional switch and one private variable. */
async function installSample(configuration: Record<string, string>, token?: string) {
  const api = createMockEventChecks();
  const templates = createMockEventCheckTemplates(api);
  const check = await templates.install({
    slug: PREVIEW_EVENT_CHECK_TEMPLATE.slug,
    agentId: "chief",
    name: "Sample",
    accountLabel: "Work",
    instruction: "Look.",
    timezone: "UTC",
    intervalSeconds: 60,
    accountActorIds: [],
    configuration: { teamKey: "ENG", ...configuration },
  });
  if (token) await api.setEnvironment({ agentId: "chief", id: check.id, name: "SAMPLE_API_TOKEN", value: token });
  return { api, templates, check };
}

it("fills a picker setting of a template check from its saved private value, and degrades to text without it", async () => {
  const { api, templates, check } = await installSample({ watchedConversations: "OLD123:all" });
  const discoverCheck = vi.spyOn(templates, "discoverCheck");
  render(() => (
    <EventChecksSettings
      api={api}
      pickers={templates}
      agentId="chief"
      onBack={vi.fn()}
      onClose={vi.fn()}
      onCountChange={vi.fn()}
    />
  ));
  await fireEvent.click(await screen.findByRole("button", { name: /Sample/ }));
  // The private value is missing, so the list says what it needs and does not call the host.
  const load = await screen.findByRole("button", { name: "Load my conversations" });
  await waitFor(() => expect(load).toBeDisabled());
  expect(screen.getByText(/Save Sample API token in the private variables first/)).toBeInTheDocument();
  // Before the list is loaded, a saved ID is a chosen entry, not one that "is not in the list".
  expect(screen.getByRole("region", { name: "Chosen" })).toHaveTextContent("OLD123");
  expect(screen.queryByRole("region", { name: "Chosen, not in the list" })).toBeNull();
  await fireEvent.input(await screen.findByLabelText(/Sample API token — Missing/), { target: { value: "tok-1" } });
  await fireEvent.click(screen.getByRole("button", { name: "Save value" }));
  await waitFor(() => expect(screen.getByRole("button", { name: "Load my conversations" })).toBeEnabled());
  await fireEvent.click(screen.getByRole("button", { name: "Load my conversations" }));
  expect(await screen.findByRole("checkbox", { name: "Watch #design" })).toBeInTheDocument();
  expect(discoverCheck).toHaveBeenCalledWith({ agentId: "chief", id: check.id, field: "watchedConversations" });
  // A saved ID that the loaded list does not hold is shown apart, so it can be kept or removed.
  expect(screen.getByRole("region", { name: "Chosen, not in the list" })).toHaveTextContent("OLD123");
  expect(screen.queryByRole("region", { name: "Chosen" })).toBeNull();
  // Two choices and one save: the list stays, and the host is not asked for it again.
  await fireEvent.click(screen.getByRole("checkbox", { name: "Watch #design" }));
  await fireEvent.click(screen.getByRole("checkbox", { name: "Watch #engineering" }));
  const save = vi.spyOn(api, "save");
  await fireEvent.click(await screen.findByRole("button", { name: "Save" }));
  await waitFor(() => expect(save).toHaveBeenCalled());
  const saved = save.mock.calls[0]?.[0].source;
  expect(
    saved?.kind === "api" && saved.configuration.find((field) => field.name === "watchedConversations"),
  ).toMatchObject({
    value: "OLD123:all,DES:all,ENG:all",
  });
  await waitFor(() => expect(screen.getByRole("button", { name: "Save" })).toBeEnabled());
  expect(screen.getByRole("checkbox", { name: "Watch #design" })).toBeChecked();
  expect(screen.getByRole("checkbox", { name: "Watch #engineering" })).toBeChecked();
  expect(screen.getByRole("button", { name: "Reload the list" })).toBeInTheDocument();
  expect(discoverCheck).toHaveBeenCalledTimes(1);
});

it("keeps the loaded list when a private value is saved and when the same check is opened again", async () => {
  const { api, templates, check } = await installSample({ watchedConversations: "ENG:all" }, "tok-1");
  await api.save({ ...check, active: true });
  const discoverCheck = vi.spyOn(templates, "discoverCheck");
  render(() => (
    <EventChecksSettings
      api={api}
      pickers={templates}
      agentId="chief"
      onBack={vi.fn()}
      onClose={vi.fn()}
      onCountChange={vi.fn()}
    />
  ));
  await fireEvent.click(await screen.findByRole("button", { name: /Sample/ }));
  await waitFor(() => expect(screen.getByRole("button", { name: "Load my conversations" })).toBeEnabled());
  await fireEvent.click(screen.getByRole("button", { name: "Load my conversations" }));
  // A chosen entry that the list holds is its row, with its name, and not a raw ID.
  expect(await screen.findByRole("checkbox", { name: "Watch #engineering" })).toBeChecked();
  expect(screen.queryByRole("region", { name: "Chosen, not in the list" })).toBeNull();
  await fireEvent.input(await screen.findByLabelText(/Sample API token — Set/), { target: { value: "tok-2" } });
  await fireEvent.click(screen.getByRole("button", { name: "Save value" }));
  // The host pauses a check when a private value changes. The editor shows that, and keeps its list.
  await waitFor(() => expect(screen.getByRole("switch", { name: "Enabled" })).not.toBeChecked());
  expect(screen.getByLabelText(/Sample API token — Set/)).toHaveValue("");
  expect(screen.getByRole("checkbox", { name: "Watch #design" })).toBeInTheDocument();
  await fireEvent.click(screen.getByRole("button", { name: "All event checks" }));
  await fireEvent.click(await screen.findByRole("button", { name: /Sample/ }));
  expect(await screen.findByRole("checkbox", { name: "Watch #engineering" })).toBeChecked();
  expect(discoverCheck).toHaveBeenCalledTimes(1);
});

it("shows a true-or-false setting of a template check as a switch, even for an older template version", async () => {
  const { api, templates } = await installSample({ watchedConversations: "", includeComments: "true" });
  vi.spyOn(templates, "list").mockResolvedValue([{ ...PREVIEW_EVENT_CHECK_TEMPLATE, version: "9" }]);
  const save = vi.spyOn(api, "save");
  render(() => (
    <EventChecksSettings
      api={api}
      pickers={templates}
      agentId="chief"
      onBack={vi.fn()}
      onClose={vi.fn()}
      onCountChange={vi.fn()}
    />
  ));
  await fireEvent.click(await screen.findByRole("button", { name: /Sample/ }));
  const comments = await screen.findByRole("switch", { name: /Include comments/ });
  expect(comments).toBeChecked();
  // Only the shipped version of a program can list choices, so the picker stays a text box.
  expect(screen.getByRole("textbox", { name: /Conversations to watch/ })).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Load my conversations" })).toBeNull();
  await fireEvent.click(comments);
  await fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(save).toHaveBeenCalled());
  const saved = save.mock.calls[0]?.[0].source;
  expect(saved?.kind === "api" && saved.configuration.find((field) => field.name === "includeComments")).toMatchObject({
    value: "false",
  });
});

it("shows a picker setting as plain text when the host offers no picker", async () => {
  const api = createMockEventChecks();
  const templates = createMockEventCheckTemplates(api);
  await templates.install({
    slug: PREVIEW_EVENT_CHECK_TEMPLATE.slug,
    agentId: "chief",
    name: "Sample",
    accountLabel: "Work",
    instruction: "Look.",
    timezone: "UTC",
    intervalSeconds: 60,
    accountActorIds: [],
    configuration: { teamKey: "ENG" },
  });
  render(() => (
    <EventChecksSettings api={api} agentId="chief" onBack={vi.fn()} onClose={vi.fn()} onCountChange={vi.fn()} />
  ));
  await fireEvent.click(await screen.findByRole("button", { name: /Sample/ }));
  expect(await screen.findByRole("textbox", { name: "Conversations to watch" })).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Load my conversations" })).toBeNull();
});

it("keeps what was typed in the other private fields and the open history when one value is saved", async () => {
  const api = createMockEventChecks();
  const check = await api.save({
    ...input,
    active: false,
    source: {
      kind: "api",
      connectionId: "Linear job one",
      toolName: "linear.mjs",
      variables: ["TOKEN_A", "TOKEN_B"],
      configuration: [],
      argumentsJson: "{}",
      cursorArgument: "cursor",
      nextCursorPointer: "/cursor",
    },
  });
  await api.setEnvironment({ agentId: "chief", id: check.id, name: "TOKEN_A", value: "a-1" });
  await api.setEnvironment({ agentId: "chief", id: check.id, name: "TOKEN_B", value: "b-1" });
  await api.save({ ...check, active: true });
  render(() => (
    <EventChecksSettings api={api} agentId="chief" onBack={vi.fn()} onClose={vi.fn()} onCountChange={vi.fn()} />
  ));
  await fireEvent.click(await screen.findByRole("button", { name: /Linear tickets/ }));
  await fireEvent.click(await screen.findByRole("button", { name: "Last 10 checks" }));
  await screen.findByRole("region", { name: "Last 10 checks" });
  await fireEvent.input(await screen.findByLabelText(/TOKEN_B — Set/), { target: { value: "b-2" } });
  await fireEvent.input(screen.getByLabelText(/TOKEN_A — Set/), { target: { value: "a-2" } });
  const [saveFirst] = screen.getAllByRole("button", { name: "Save value" });
  assert(saveFirst);
  await fireEvent.click(saveFirst);
  // The host pauses the check when a value is set. Once the editor shows that, the save is over.
  await waitFor(() => expect(screen.getByRole("switch", { name: "Enabled" })).not.toBeChecked());
  expect(screen.getByLabelText(/TOKEN_A — Set/)).toHaveValue("");
  expect(screen.getByLabelText(/TOKEN_B — Set/)).toHaveValue("b-2");
  expect(screen.getByRole("region", { name: "Last 10 checks" })).toBeInTheDocument();
});

it("keeps the open check and its unsaved edits when only the api object changes", async () => {
  const api = createMockEventChecks();
  await api.save(input);
  const list = vi.spyOn(api, "list");
  const [current, setCurrent] = createSignal<EventCheckApi>(api);
  render(() => (
    <EventChecksSettings api={current()} agentId="chief" onBack={vi.fn()} onClose={vi.fn()} onCountChange={vi.fn()} />
  ));
  await fireEvent.click(await screen.findByRole("button", { name: "Linear tickets" }));
  await fireEvent.input(await screen.findByRole("textbox", { name: "Name" }), { target: { value: "Renamed" } });
  const reads = list.mock.calls.length;
  setCurrent({ ...api });
  await waitFor(() => expect(list.mock.calls.length).toBeGreaterThan(reads));
  expect(screen.getByRole("textbox", { name: "Name" })).toHaveValue("Renamed");
});

it("says that the list is loading, and offers Retry when it could not be loaded", async () => {
  const api = createMockEventChecks();
  await api.save(input);
  vi.spyOn(api, "list").mockRejectedValueOnce(undefined);
  render(() => (
    <EventChecksSettings api={api} agentId="chief" onBack={vi.fn()} onClose={vi.fn()} onCountChange={vi.fn()} />
  ));
  expect(await screen.findByRole("alert")).toHaveTextContent("Could not load the event checks.");
  expect(screen.queryByText("No event checks yet.")).toBeNull();
  await fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  expect(await screen.findByRole("button", { name: "Linear tickets" })).toBeInTheDocument();
});

it("says why Check now and Save are off, and gives each failed action its own text", async () => {
  const api = createMockEventChecks();
  await api.save(input);
  vi.spyOn(api, "checkNow").mockRejectedValueOnce(undefined);
  render(() => (
    <EventChecksSettings api={api} agentId="chief" onBack={vi.fn()} onClose={vi.fn()} onCountChange={vi.fn()} />
  ));
  await fireEvent.click(await screen.findByRole("button", { name: "Linear tickets" }));
  const name = await screen.findByRole("textbox", { name: "Name" });
  await fireEvent.input(name, { target: { value: "" } });
  expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "Save" })).toHaveAccessibleDescription("To save, fill in: Name.");
  expect(screen.getByRole("button", { name: "Check now" })).toHaveAccessibleDescription(
    "Save your changes first to run a check.",
  );
  await fireEvent.input(name, { target: { value: "Linear tickets" } });
  await waitFor(() => expect(screen.getByRole("button", { name: "Check now" })).toBeEnabled());
  await fireEvent.click(screen.getByRole("button", { name: "Check now" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Could not run the check now.");
});

it("keeps Save off while the interval is empty or below 30 seconds, and says why", async () => {
  const api = createMockEventChecks();
  await api.save(input);
  render(() => (
    <EventChecksSettings api={api} agentId="chief" onBack={vi.fn()} onClose={vi.fn()} onCountChange={vi.fn()} />
  ));
  await fireEvent.click(await screen.findByRole("button", { name: "Linear tickets" }));
  const seconds = await screen.findByRole("spinbutton", { name: "Every (seconds)" });
  await fireEvent.input(seconds, { target: { value: "" } });
  expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
  expect(seconds).toHaveAccessibleDescription(/30 or more/);
  await fireEvent.input(seconds, { target: { value: "29" } });
  expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
  await fireEvent.input(seconds, { target: { value: "30" } });
  expect(screen.getByRole("button", { name: "Save" })).toBeEnabled();
});

it("moves focus to Cancel when Delete asks to confirm, and back to Delete when it is cancelled", async () => {
  const api = createMockEventChecks();
  await api.save(input);
  render(() => (
    <EventChecksSettings api={api} agentId="chief" onBack={vi.fn()} onClose={vi.fn()} onCountChange={vi.fn()} />
  ));
  await fireEvent.click(await screen.findByRole("button", { name: "Linear tickets" }));
  await fireEvent.click(await screen.findByRole("button", { name: "Delete" }));
  await waitFor(() => expect(screen.getByRole("button", { name: "Cancel" })).toHaveFocus());
  await fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  await waitFor(() => expect(screen.getByRole("button", { name: "Delete" })).toHaveFocus());
});
