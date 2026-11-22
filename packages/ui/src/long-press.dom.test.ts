import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createLongPress } from "./long-press";

function pointer(type: string, x: number, y: number): PointerEvent {
  return new PointerEvent(type, {
    bubbles: true,
    cancelable: true,
    clientX: x,
    clientY: y,
    pointerType: "touch",
    pointerId: 3,
  });
}

function click(target: HTMLElement, x: number, y: number): MouseEvent {
  const event = new MouseEvent("click", { bubbles: true, cancelable: true, clientX: x, clientY: y });
  target.dispatchEvent(event);
  return event;
}

describe("createLongPress", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function held() {
    const onLongPress = vi.fn();
    const press = createLongPress({ onLongPress });
    press.onPointerDown(pointer("pointerdown", 40, 300));
    vi.advanceTimersByTime(500);
    press.onPointerUp(pointer("pointerup", 41, 301));
    expect(onLongPress).toHaveBeenCalledTimes(1);
  }

  it("swallows the click that ends the long press", () => {
    held();
    const target = document.body.appendChild(document.createElement("button"));
    expect(click(target, 41, 301).defaultPrevented).toBe(true);
    target.remove();
  });

  it("lets a quick tap elsewhere through when the browser sent no click", () => {
    held();
    const target = document.body.appendChild(document.createElement("button"));
    vi.advanceTimersByTime(200);
    // A tap on the sheet that opened, far from the finger's spot.
    expect(click(target, 200, 640).defaultPrevented).toBe(false);
    target.remove();
  });
});
