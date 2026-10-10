import { CustomProviderDialog } from "@openbot/ui/features/custom-providers/CustomProviderDialog";
import { fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { expect, it, vi } from "vitest";

const API_KEY = "sk-typed-key";

function mount(overrides: { onCancel?: () => void } = {}) {
  const onCancel = overrides.onCancel ?? vi.fn();
  render(() => <CustomProviderDialog open onCancel={onCancel} onSubmit={vi.fn()} />);
  return { onCancel };
}

it("closes a form that nothing was typed in at once", async () => {
  const { onCancel } = mount();
  fireEvent.click(await screen.findByRole("button", { name: "Close" }));
  expect(onCancel).toHaveBeenCalledOnce();
  expect(screen.queryByRole("alertdialog")).toBeNull();
});

it("keeps the typed address and key when Escape asks to discard, and leaves on Discard", async () => {
  const { onCancel } = mount();
  fireEvent.input(await screen.findByLabelText(/^Base URL/u), { target: { value: "http://127.0.0.1:11434/v1" } });
  fireEvent.input(screen.getByLabelText(/^API key/u), { target: { value: API_KEY } });
  fireEvent.keyDown(screen.getByLabelText(/^Base URL/u), { key: "Escape" });
  const question = await screen.findByRole("alertdialog");
  expect(question).toHaveTextContent("Discard changes?");
  expect(onCancel).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Keep editing" }));
  await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  expect(screen.getByLabelText(/^Base URL/u)).toHaveValue("http://127.0.0.1:11434/v1");
  expect(screen.getByLabelText(/^API key/u)).toHaveValue(API_KEY);
  expect(onCancel).not.toHaveBeenCalled();

  fireEvent.click(screen.getByRole("button", { name: "Close" }));
  fireEvent.click(await screen.findByRole("button", { name: "Discard changes" }));
  await waitFor(() => expect(onCancel).toHaveBeenCalledOnce());
});
