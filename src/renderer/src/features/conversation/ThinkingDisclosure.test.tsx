import { AgentActivityIndicator } from "@openbot/ui/features/conversation/AgentActivity";
import { ThinkingDisclosure } from "@openbot/ui/features/conversation/ThinkingDisclosure";
import { ThinkingText } from "@openbot/ui/features/conversation/ThinkingText";
import { fireEvent, render, screen } from "@solidjs/testing-library";
import { describe, expect, it, vi } from "vitest";

const handlers = { agents: [], onSelectAgent: vi.fn(), onOpenLink: vi.fn() };

describe("ThinkingDisclosure", () => {
  it("shows a line of the last step closed and the whole reasoning open", async () => {
    render(() => (
      <ThinkingDisclosure
        items={["First I read the **failing test**.", "Then I fix the **import** order."]}
        {...handlers}
      />
    ));
    const toggle = screen.getByRole("button", { name: /Thinking/ });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(toggle).toHaveTextContent("Then I fix the import order.");
    expect(screen.queryByText(/First I read/)).not.toBeInTheDocument();

    await fireEvent.click(toggle);

    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText(/First I read/)).toBeInTheDocument();
    expect(screen.getByText(/Then I fix/)).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "What the model thought" })).toBeInTheDocument();
  });
});

describe("ThinkingText", () => {
  it("says so when the provider shared nothing", () => {
    render(() => <ThinkingText items={[]} {...handlers} />);
    expect(screen.getByText(/shared no reasoning for this turn/)).toBeInTheDocument();
  });
});

describe("AgentActivityIndicator reasoning", () => {
  it("opens the reasoning from the activity line", async () => {
    render(() => (
      <AgentActivityIndicator
        agent={undefined}
        label="Working on it…"
        detail="Reading the failing test"
        reasoning={() => <ThinkingText items={["The test fails on import order."]} streaming {...handlers} />}
      />
    ));
    const toggle = screen.getByRole("button", { name: /Reading the failing test/ });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText(/import order/)).not.toBeInTheDocument();
    await fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText(/import order/)).toBeInTheDocument();
  });

  it("stays plain text without a reasoning view", () => {
    render(() => <AgentActivityIndicator agent={undefined} label="Working on it…" detail="Reading the failing test" />);
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });
});
