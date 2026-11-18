import { prefersReducedMotion } from "@openbot/ui/utils";
import { onSettled } from "solid-js";

/** A touch that starts this close to the left edge can be a swipe back. */
const EDGE_PX = 24;
/** The finger moves this far before the swipe counts as one; a steeper move is a scroll. */
const SLOP_PX = 10;
/** A swipe that ends past this share of the width, or this many pixels, goes back. */
const BACK_SHARE = 0.3;
const BACK_MIN_PX = 64;

/**
 * Whether the page runs as an app from the Home Screen. Safari then has no edge swipe for Back, as it
 * has in a tab, where it already steps through the history entries of the screens.
 */
export function isStandaloneDisplay(): boolean {
  return (
    window.matchMedia?.("(display-mode: standalone)").matches === true ||
    ("standalone" in navigator && navigator.standalone === true)
  );
}

/**
 * The iOS swipe from the left edge that goes back one screen, for the app on the Home Screen. The
 * screen follows the finger; a swipe past a third of the width goes back (`onBack`, which steps the
 * history back), a shorter one springs back. A vertical move stays a scroll.
 */
export function createWebSwipeBack(options: {
  /** Whether a screen to go back to shows, such as a conversation over the list. */
  enabled: () => boolean;
  /** The element that follows the finger. */
  surface: () => HTMLElement | null;
  onBack: () => void;
}): void {
  onSettled(() => {
    if (!isStandaloneDisplay()) return;
    let start: { x: number; y: number; id: number } | null = null;
    let surface: HTMLElement | null = null;
    let distance = 0;

    function release(animate: boolean): void {
      const element = surface;
      surface = null;
      start = null;
      distance = 0;
      if (!element) return;
      element.style.transition =
        animate && !prefersReducedMotion() ? "transform var(--openbot-duration-normal) var(--openbot-ease-out)" : "";
      element.style.transform = "";
      if (animate) element.addEventListener("transitionend", () => (element.style.transition = ""), { once: true });
    }

    const touchStart = (event: TouchEvent) => {
      const touch = event.touches[0];
      if (event.touches.length !== 1 || !touch || touch.clientX > EDGE_PX || !options.enabled()) return;
      start = { x: touch.clientX, y: touch.clientY, id: touch.identifier };
    };
    const touchMove = (event: TouchEvent) => {
      if (!start) return;
      const touch = [...event.touches].find((item) => item.identifier === start?.id);
      if (!touch) return;
      const dx = touch.clientX - start.x;
      const dy = touch.clientY - start.y;
      if (!surface) {
        if (Math.abs(dy) > SLOP_PX && Math.abs(dy) > Math.abs(dx)) {
          start = null;
          return;
        }
        if (dx < SLOP_PX) return;
        surface = options.surface();
        if (!surface) {
          start = null;
          return;
        }
        surface.style.transition = "";
      }
      event.preventDefault();
      distance = Math.max(0, dx);
      if (!prefersReducedMotion()) surface.style.transform = `translateX(${distance}px)`;
    };
    const touchEnd = () => {
      if (!surface) {
        start = null;
        return;
      }
      const width = surface.clientWidth || window.innerWidth;
      if (distance > Math.max(BACK_MIN_PX, width * BACK_SHARE)) {
        release(false);
        options.onBack();
      } else release(true);
    };
    const touchCancel = () => release(true);
    document.addEventListener("touchstart", touchStart, { passive: true });
    // Not passive: a swipe that counts stops the page from scrolling under it.
    document.addEventListener("touchmove", touchMove, { passive: false });
    document.addEventListener("touchend", touchEnd);
    document.addEventListener("touchcancel", touchCancel);
    return () => {
      release(false);
      document.removeEventListener("touchstart", touchStart);
      document.removeEventListener("touchmove", touchMove);
      document.removeEventListener("touchend", touchEnd);
      document.removeEventListener("touchcancel", touchCancel);
    };
  });
}
