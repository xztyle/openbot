import { prefersReducedMotion } from "@openbot/ui/utils";
import { onSettled } from "solid-js";

/** A touch that starts this close to the left edge can be a swipe back. */
const EDGE_PX = 24;
/** The finger moves this far before the swipe counts as one; a steeper move is a scroll. */
const SLOP_PX = 10;
/** A swipe that ends past this share of the width, or this many pixels, goes back. */
const BACK_SHARE = 0.3;
const BACK_MIN_PX = 64;
/** Set on the surface's parent while the finger moves it, with the distance in `SWIPE_X_PROPERTY`. */
const SWIPE_ATTRIBUTE = "data-web-swipe";
const SWIPE_X_PROPERTY = "--web-swipe-x";

/**
 * The iOS swipe from the left edge that goes back one screen. The screen follows the finger; a swipe
 * past a third of the width goes back (`onBack`, which steps the history back), a shorter one springs
 * back. A vertical move stays a scroll. While the finger moves, the surface's parent has
 * `data-web-swipe`, so `web-client.css` shows the list under the surface, as iOS shows the screen
 * before. After a swipe that goes back, the surface stays out until the history has changed the
 * screen, so the conversation does not show again for a frame.
 *
 * The app on the Home Screen has no Safari edge swipe. In a Safari tab, Safari's own swipe does not
 * always reach the app's screens, so the app has its swipe there too. When Safari takes the swipe,
 * the page gets `touchcancel`, and the screen springs back while Safari goes back.
 */
export function createWebSwipeBack(options: {
  /** Whether a screen to go back to shows, such as a conversation over the list. */
  enabled: () => boolean;
  /** The element that follows the finger. */
  surface: () => HTMLElement | null;
  onBack: () => void;
}): void {
  onSettled(() => {
    let start: { x: number; y: number; id: number } | null = null;
    let surface: HTMLElement | null = null;
    let distance = 0;

    function clearParent(element: HTMLElement): void {
      const parent = element.parentElement;
      parent?.removeAttribute(SWIPE_ATTRIBUTE);
      parent?.style.removeProperty(SWIPE_X_PROPERTY);
    }

    function release(animate: boolean): void {
      const element = surface;
      surface = null;
      start = null;
      distance = 0;
      if (!element) return;
      const spring = animate && !prefersReducedMotion();
      element.style.transition = spring ? "transform var(--openbot-duration-normal) var(--openbot-ease-out)" : "";
      element.style.transform = "";
      element.style.boxShadow = "";
      element.parentElement?.setAttribute(SWIPE_ATTRIBUTE, "release");
      element.parentElement?.style.setProperty(SWIPE_X_PROPERTY, "0px");
      if (!spring) {
        clearParent(element);
        return;
      }
      element.addEventListener(
        "transitionend",
        () => {
          element.style.transition = "";
          clearParent(element);
        },
        { once: true },
      );
    }

    /** Goes back, and puts the surface back once the history has changed the screen. */
    function goBack(): void {
      const element = surface;
      surface = null;
      start = null;
      distance = 0;
      let done = false;
      const finish = () => {
        if (done || !element) return;
        done = true;
        requestAnimationFrame(() =>
          requestAnimationFrame(() => {
            element.style.transform = "";
            element.style.boxShadow = "";
            clearParent(element);
          }),
        );
      };
      window.addEventListener("popstate", finish, { once: true });
      // A history step that changes nothing sends no `popstate`.
      setTimeout(finish, 400);
      options.onBack();
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
        // A move that is more sideways than down keeps the pane from starting a scroll first.
        if (dx > 0 && dx >= Math.abs(dy) && event.cancelable) event.preventDefault();
        if (dx < SLOP_PX) return;
        surface = options.surface();
        if (!surface) {
          start = null;
          return;
        }
        surface.style.transition = "";
        surface.style.boxShadow = "-8px 0 24px var(--openbot-shadow-dialog)";
        surface.parentElement?.setAttribute(SWIPE_ATTRIBUTE, "");
      }
      if (event.cancelable) event.preventDefault();
      distance = Math.max(0, dx);
      if (!prefersReducedMotion()) {
        surface.style.transform = `translateX(${distance}px)`;
        surface.parentElement?.style.setProperty(SWIPE_X_PROPERTY, `${distance}px`);
      }
    };
    const touchEnd = () => {
      if (!surface) {
        start = null;
        return;
      }
      const width = surface.clientWidth || window.innerWidth;
      if (distance > Math.max(BACK_MIN_PX, width * BACK_SHARE)) goBack();
      else release(true);
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
