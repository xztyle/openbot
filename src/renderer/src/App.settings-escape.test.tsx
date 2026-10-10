import { fireEvent, render, screen, within } from "@solidjs/testing-library";
import { beforeEach, describe, expect, it } from "vitest";
import { App } from "./App";
import { installOpenbotStub } from "./app-test-harness";

describe("agent settings side panel", () => {
  beforeEach(() => {
    installOpenbotStub();
  });

  it("stays open when Escape is pressed in one of its fields, so a draft is not dropped", async () => {
    render(() => <App />);
    await screen.findByRole("heading", { name: "Chief" });
    await fireEvent.click(screen.getByRole("button", { name: "View agent settings" }));
    const settings = await screen.findByRole("complementary", { name: "Agent settings" });
    const name = await within(settings).findByRole("textbox", { name: "Agent name" });
    name.focus();
    await fireEvent.keyDown(name, { key: "Escape" });
    expect(screen.getByRole("complementary", { name: "Agent settings" })).toBeInTheDocument();
    expect(name).toHaveFocus();
  });
});
