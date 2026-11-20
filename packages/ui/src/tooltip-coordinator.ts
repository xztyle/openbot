/*
 * What all the tooltips of a document share: only one tooltip is open at a time, and each of them
 * closes when the reader does something else. Kobalte keeps a list of the open tooltips too, but it
 * drops a tooltip from the list when its close delay ends, also when the tooltip did not close, so
 * two tooltips could stay open together.
 *
 * It also knows how the focus moved. A tooltip opens on a focus only when the reader moved the
 * focus with the keyboard, not when a dialog or a panel gives the focus back to its button.
 */

type Close = () => void;
type FocusKind = "keyboard" | "other";

/** The keys that move the focus, also in a list or a toolbar that moves it with the arrows. */
const NAVIGATION_KEYS = new Set(["Tab", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End"]);

/**
 * How long, in milliseconds, after a key that moves the focus a focus still counts as moved by the
 * keyboard. The browser moves the focus in the key's own task, and a list in the next frame.
 */
const KEYBOARD_FOCUS_WINDOW = 100;

/** How far, in pixels, the pointer moves after a press before a tooltip may open again. */
const PRESS_SLOP = 4;

let active: Close | undefined;
/** When a key that moves the focus went down. */
let navigationKeyAt = Number.NEGATIVE_INFINITY;
let lastPointerType = "";
/** Where the pointer pressed, until it moves away: a press keeps the tooltips closed until then. */
let press: { x: number; y: number } | undefined;
let focusKind: FocusKind | undefined;
let focusTimer: ReturnType<typeof setTimeout> | undefined;
let installed = false;

/** Closes the open tooltip. */
export function closeOpenTooltip(): void {
  const close = active;
  active = undefined;
  close?.();
}

/**
 * Makes `close` the open tooltip, and closes the one that was open. Returns its release. The root
 * calls it from an effect, where no other tooltip may close at once: a close renders, and nothing
 * may render in the effect phase. So the other tooltip closes in a microtask.
 */
export function claimTooltip(close: Close): () => void {
  const previous = active;
  if (previous && previous !== close) queueMicrotask(previous);
  active = close;
  return () => {
    if (active === close) active = undefined;
  };
}

/** True while a focus event goes on that the reader caused with the keyboard. */
export function isKeyboardFocus(): boolean {
  return focusKind === "keyboard";
}

/**
 * Whether a tooltip may open now. In a focus event, only a focus that the keyboard moved opens it.
 * Otherwise the pointer opens it, but never a finger: a touch screen has no hover.
 */
export function tooltipMayOpen(): boolean {
  if (focusKind !== undefined) return focusKind === "keyboard";
  // A press stops the tooltips until the pointer moves, also the tooltip of a control that the press
  // put under the pointer, such as the button that took the place of the pressed one.
  return lastPointerType !== "touch" && press === undefined;
}

/** Adds the listeners of the document once. */
export function installTooltipCoordinator(): void {
  if (installed || typeof window === "undefined") return;
  installed = true;
  window.addEventListener(
    "keydown",
    (event) => {
      navigationKeyAt = NAVIGATION_KEYS.has(event.key) ? performance.now() : Number.NEGATIVE_INFINITY;
      press = undefined;
      if (event.key === "Escape") closeOpenTooltip();
    },
    true,
  );
  window.addEventListener(
    "pointerdown",
    (event) => {
      navigationKeyAt = Number.NEGATIVE_INFINITY;
      lastPointerType = event.pointerType;
      press = { x: event.clientX, y: event.clientY };
      closeOpenTooltip();
    },
    true,
  );
  window.addEventListener(
    "pointermove",
    (event) => {
      if (press && Math.hypot(event.clientX - press.x, event.clientY - press.y) > PRESS_SLOP) press = undefined;
    },
    { capture: true, passive: true },
  );
  window.addEventListener(
    "pointerover",
    (event) => {
      lastPointerType = event.pointerType;
    },
    { capture: true, passive: true },
  );
  // The focus event of an element reaches the window first, in the capture phase, so the trigger's
  // own focus handler can ask how the focus moved.
  window.addEventListener(
    "focus",
    (event) => {
      if (event.target === window) return;
      const element = event.target instanceof Element ? event.target : null;
      const byKeyboard = performance.now() - navigationKeyAt <= KEYBOARD_FOCUS_WINDOW;
      focusKind = byKeyboard && element?.matches(":focus-visible") ? "keyboard" : "other";
      clearTimeout(focusTimer);
      focusTimer = setTimeout(() => {
        focusKind = undefined;
      }, 0);
    },
    true,
  );
  // The window's own blur, such as the reader switching to another window or tab.
  window.addEventListener("blur", (event) => {
    if (event.target === window) closeOpenTooltip();
  });
  window.addEventListener("wheel", closeOpenTooltip, { capture: true, passive: true });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") closeOpenTooltip();
  });
  // The pointer left the window: no move outside the trigger will follow to close the tooltip.
  document.addEventListener("mouseout", (event) => {
    if (event.relatedTarget === null) closeOpenTooltip();
  });
}
