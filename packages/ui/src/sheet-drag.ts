import { prefersReducedMotion } from "./utils";

/** The finger moves this far before the drag counts; a steeper sideways move stays a tap or a scroll. */
const SLOP_PX = 8;
/** A drag that ends past this share of the sheet's height, or this many pixels, closes it. */
const CLOSE_SHARE = 0.25;
const CLOSE_MIN_PX = 80;
/** A flick down this fast, in pixels per millisecond, closes it after a shorter drag. */
const FLICK_SPEED = 0.5;
/** The last move counts for a flick only this close to the release. */
const FLICK_WINDOW_MS = 100;

/**
 * Lets a finger drag a bottom sheet (`.ui-sheet`) down by its handle or its body, as on iOS: the sheet
 * follows the finger, and a release far or fast enough closes it (`close`); a shorter drag springs back.
 * A sheet or a list in it that is scrolled down scrolls first: the drag starts only from the top of
 * its content, so the list scrolls as before. Pass it as the `ref` of the sheet's content.
 */
/** Whether the finger is on something scrolled down inside the sheet, such as a long emoji list. */
function scrolledUnder(target: EventTarget | null, sheet: HTMLElement): boolean {
  for (let node = target instanceof Element ? target : null; node; node = node.parentElement) {
    if (node.scrollTop > 0) return true;
    if (node === sheet) return false;
  }
  return false;
}

export function sheetDragToDismiss(close: () => void): (element: HTMLElement) => void {
  return (element) => {
    let start: { x: number; y: number; id: number; target: EventTarget | null } | null = null;
    let dragging = false;
    let distance = 0;
    let last = { y: 0, time: 0, speed: 0 };

    const reset = (animate: boolean) => {
      const spring = animate && !prefersReducedMotion();
      element.style.transition = spring ? "transform var(--openbot-duration-normal) var(--openbot-ease-out)" : "";
      element.style.transform = "";
      start = null;
      dragging = false;
      distance = 0;
    };

    element.addEventListener(
      "touchstart",
      (event) => {
        const touch = event.touches[0];
        if (event.touches.length !== 1 || !touch) {
          if (dragging) reset(true);
          start = null;
          return;
        }
        start = { x: touch.clientX, y: touch.clientY, id: touch.identifier, target: event.target };
        last = { y: touch.clientY, time: event.timeStamp, speed: 0 };
        dragging = false;
        distance = 0;
      },
      { passive: true },
    );
    element.addEventListener(
      "touchmove",
      (event) => {
        if (!start) return;
        const touch = [...event.touches].find((item) => item.identifier === start?.id);
        if (!touch) return;
        const dx = touch.clientX - start.x;
        const dy = touch.clientY - start.y;
        if (!dragging) {
          if (Math.abs(dx) < SLOP_PX && Math.abs(dy) < SLOP_PX) return;
          // Up, sideways, or a sheet that has scrolled: the sheet's own scroll takes the finger.
          if (dy <= 0 || Math.abs(dx) > dy || scrolledUnder(start.target, element)) {
            start = null;
            return;
          }
          dragging = true;
          element.style.transition = "none";
        }
        if (event.cancelable) event.preventDefault();
        distance = Math.max(0, dy);
        const elapsed = event.timeStamp - last.time;
        if (elapsed > 0) last = { y: touch.clientY, time: event.timeStamp, speed: (touch.clientY - last.y) / elapsed };
        element.style.transform = distance ? `translateY(${distance}px)` : "";
      },
      { passive: false },
    );
    const end = (event: TouchEvent) => {
      if (!dragging) {
        start = null;
        return;
      }
      const far = distance > Math.max(CLOSE_MIN_PX, element.offsetHeight * CLOSE_SHARE);
      // A finger that stopped before it lifted is no flick.
      const flick = last.speed > FLICK_SPEED && event.timeStamp - last.time < FLICK_WINDOW_MS && distance > SLOP_PX * 2;
      if (far || flick) {
        // The sheet stays where the finger left it while the dialog closes.
        start = null;
        dragging = false;
        close();
        return;
      }
      reset(true);
    };
    element.addEventListener("touchend", end);
    element.addEventListener("touchcancel", () => {
      if (dragging) reset(true);
      start = null;
    });
  };
}
