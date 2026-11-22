import { WorkspaceContextMenu } from "@openbot/ui/features/workspace/WorkspaceContextMenu";
import { render, screen } from "@solidjs/testing-library";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { UiHoldButton } from "../../../../../packages/ui/src/features/conversation/ui-blocks/UiHoldButton";

const originalMatchMedia = window.matchMedia;

/** A touch screen: `usesTouchLayout` reads this query. */
function touchScreen(): void {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: (query: string) => ({
      matches: query.includes("pointer: coarse"),
      media: query,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    }),
  });
}

function touchPointer(type: string): Event {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, clientX: 10, clientY: 10 });
  Object.defineProperties(event, { pointerType: { value: "touch" }, pointerId: { value: 7 } });
  return event;
}

describe("a hold button in a message on a touch screen", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    touchScreen();
  });
  afterEach(() => {
    vi.useRealTimers();
    Object.defineProperty(window, "matchMedia", { configurable: true, value: originalMatchMedia });
  });

  it("completes its hold, and the message's long press stays shut", async () => {
    const onComplete = vi.fn();
    const onSelect = vi.fn();
    const view = render(() => (
      <WorkspaceContextMenu items={() => [{ id: "copy", label: "Copy text", onSelect }]} label="Message actions">
        <UiHoldButton holdMs={800} onComplete={onComplete} onClickWithoutHold={() => undefined}>
          Hold to confirm
        </UiHoldButton>
      </WorkspaceContextMenu>
    ));
    const button = view.getByRole("button", { name: "Hold to confirm" });
    button.dispatchEvent(touchPointer("pointerdown"));
    await vi.advanceTimersByTimeAsync(900);
    expect(screen.queryByRole("dialog", { name: "Message actions" })).toBeNull();
    expect(onComplete).toHaveBeenCalledTimes(1);
  });
});
