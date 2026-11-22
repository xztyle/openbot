/*
 * A long press with a finger or a pen, the touch form of a right-click. The innermost element that
 * listens takes the press: a message inside a channel pane opens the message's actions, not the
 * pane's. A finger that moves past the slop scrolls and does nothing; the tap or the scroll that
 * follows a long press is not seen as a click, and the browser's own text selection and callout
 * give way to the actions.
 */

/** Slack and iOS open the actions after about half a second. */
const LONG_PRESS_MS = 450;
/** How far a finger may move, in CSS pixels, and still hold. */
const LONG_PRESS_SLOP = 10;

/** A press that an inner element took. Shared, so an outer listener sees the claim. */
const claimed = new WeakSet<Event>();

/** Whether an inner long-press listener already took this pointerdown. */
export function longPressClaimed(event: Event): boolean {
  return claimed.has(event);
}

/** Marks a pointerdown as taken, so outer long-press listeners leave it. */
export function claimLongPress(event: Event): void {
  claimed.add(event);
}

export interface LongPressHandlers {
  onPointerDown: (event: PointerEvent) => void;
  onPointerMove: (event: PointerEvent) => void;
  onPointerUp: (event: PointerEvent) => void;
  onPointerCancel: (event: PointerEvent) => void;
  /** Android opens the browser's menu on a long press; the long press replaces it. */
  onContextMenu: (event: MouseEvent) => void;
}

export interface LongPressOptions {
  /** Runs once the finger has held still long enough. `point` is where it held. */
  onLongPress: (point: { x: number; y: number }) => void;
  /** No long press while this is false. */
  enabled?: () => boolean;
}

export function createLongPress(options: LongPressOptions): LongPressHandlers {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let start: { pointerId: number; x: number; y: number } | null = null;
  let fired = false;

  const clear = () => {
    clearTimeout(timer);
    timer = undefined;
    start = null;
  };

  /**
   * The click that ends a long press, and only that one, does nothing. iOS and Android often send no
   * click after a long press, so a click elsewhere, such as a quick tap on the sheet that opened, is
   * the person's next tap and goes through.
   */
  const swallowNextClick = (at: { x: number; y: number }) => {
    const swallow = (event: MouseEvent) => {
      if (Math.hypot(event.clientX - at.x, event.clientY - at.y) > LONG_PRESS_SLOP * 2) return;
      document.removeEventListener("click", swallow, { capture: true });
      event.preventDefault();
      event.stopPropagation();
    };
    document.addEventListener("click", swallow, { capture: true });
    setTimeout(() => document.removeEventListener("click", swallow, { capture: true }), 600);
  };

  return {
    onPointerDown: (event) => {
      if (event.pointerType === "mouse" || longPressClaimed(event) || options.enabled?.() === false) return;
      claimLongPress(event);
      clear();
      fired = false;
      start = { pointerId: event.pointerId, x: event.clientX, y: event.clientY };
      const point = { x: event.clientX, y: event.clientY };
      timer = setTimeout(() => {
        timer = undefined;
        start = null;
        fired = true;
        // The browser may have begun a text selection under the finger.
        globalThis.getSelection?.()?.removeAllRanges();
        options.onLongPress(point);
      }, LONG_PRESS_MS);
    },
    onPointerMove: (event) => {
      if (!start || start.pointerId !== event.pointerId) return;
      if (Math.hypot(event.clientX - start.x, event.clientY - start.y) > LONG_PRESS_SLOP) clear();
    },
    onPointerUp: (event) => {
      clear();
      if (fired) swallowNextClick({ x: event.clientX, y: event.clientY });
      fired = false;
    },
    onPointerCancel: () => {
      clear();
      fired = false;
    },
    onContextMenu: (event) => {
      if (options.enabled?.() === false) return;
      // A touch long press: the timer above opens the actions. A mouse right-click is the caller's.
      if (start || fired) event.preventDefault();
    },
  };
}
