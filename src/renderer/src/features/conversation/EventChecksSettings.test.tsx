import type { EventCheckInput } from "@openbot/contracts/event-checks";
import { decodeEventCheckInput } from "@openbot/contracts/event-checks";
import { EventChecksSettings } from "@openbot/ui/features/conversation/EventChecksSettings";
import { fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { expect, it, vi } from "vitest";
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
