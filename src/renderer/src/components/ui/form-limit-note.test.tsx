import { Input, Textarea } from "@openbot/ui";
import { fireEvent, render, screen } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { describe, expect, it } from "vitest";

function note({ length, max, cut }: { length: number; max: number; cut: boolean }): string {
  return cut ? `Cut at ${max}` : `${length} of ${max}`;
}

describe("limit note", () => {
  it("shows only near the limit and links to the field", async () => {
    render(() => {
      const [value, setValue] = createSignal("");
      return <Textarea aria-label="Memory" maxlength={10} value={value()} onValueChange={setValue} limitNote={note} />;
    });
    const field = screen.getByRole("textbox", { name: "Memory" });
    expect(screen.queryByText(/of 10/)).not.toBeInTheDocument();
    await fireEvent.input(field, { target: { value: "123456789" } });
    const shown = await screen.findByText("9 of 10");
    expect(field.getAttribute("aria-describedby")).toBe(shown.id);
  });

  it("says when a paste was cut, and replaces the message at the next keystroke", async () => {
    render(() => {
      const [value, setValue] = createSignal("abc");
      return <Input aria-label="Name" maxlength={5} value={value()} onValueChange={setValue} limitNote={note} />;
    });
    const field = screen.getByRole("textbox", { name: "Name" });
    await fireEvent.paste(field, { clipboardData: { getData: () => "defgh" } });
    await fireEvent.input(field, { target: { value: "abcde" } });
    expect(await screen.findByText("Cut at 5")).toBeInTheDocument();
    await fireEvent.input(field, { target: { value: "abcde" } });
    expect(await screen.findByText("5 of 5")).toBeInTheDocument();
    expect(screen.queryByText("Cut at 5")).not.toBeInTheDocument();
  });

  it("adds nothing to a field with no note", () => {
    render(() => <Input aria-label="Plain" maxlength={5} value="abcde" />);
    expect(screen.getByRole("textbox", { name: "Plain" })).not.toHaveAttribute("aria-describedby");
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });
});
