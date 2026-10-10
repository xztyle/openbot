/**
 * Whether the transcript follows its newest message, and who may change that.
 *
 * The transcript sticks to the bottom while the reader is there. The reader's own input decides
 * when it stops: a wheel or touch move toward older messages, an up key, or a drag of the scrollbar
 * releases the stick at once. Only a scroll that the reader made and that reaches the bottom sticks
 * it again. A scroll that nobody asked for, such as the browser clamping the position after a row
 * shrank, never releases it. Code that follows the bottom reads `stick()` when it writes, so a
 * writer that was queued before the reader scrolled up does not move the transcript back.
 */

/** The distance from the bottom that still counts as "at the bottom" for a scroll of the reader. */
export const BOTTOM_DISTANCE = 80;
/** The distance that counts as the very bottom, where a scroll that nobody asked for sticks again. */
const BOTTOM_EXACT = 2;
/** A scroll that follows a wheel move or a key press within this time is the reader's. */
const INPUT_WINDOW_MS = 250;
/** Momentum scrolling continues after the finger lifts. */
const TOUCH_MOMENTUM_MS = 1500;
/** A smooth jump to the latest message ends at the bottom. This ends the wait if it never arrives. */
const JUMP_TIMEOUT_MS = 1500;

const UP_KEYS = new Set(["PageUp", "ArrowUp", "Home"]);
const DOWN_KEYS = new Set(["PageDown", "ArrowDown", "End", " ", "Spacebar"]);

export interface ScrollFollowOptions {
  /** Called when the stick changes, so a virtualizer follows the same intent. */
  onStickChange?: (stick: boolean) => void;
  /** Called when a jump to the latest message ended, so the caller can measure the scroll again. */
  onJumpEnd?: (element: HTMLElement) => void;
  now?: () => number;
  requestFrame?: (callback: () => void) => number;
  cancelFrame?: (handle: number) => void;
  setTimer?: (callback: () => void, ms: number) => number;
  clearTimer?: (handle: number) => void;
}

export interface ScrollFollow {
  stick: () => boolean;
  /** For a caller that decides, such as a send or a jump to a search result. */
  setStick: (value: boolean) => void;
  wheel: (element: HTMLElement, deltaY: number) => void;
  touchStart: (clientY: number) => void;
  touchMove: (element: HTMLElement, clientY: number) => void;
  touchEnd: () => void;
  key: (element: HTMLElement, key: string, shift?: boolean) => void;
  pointerDown: () => void;
  pointerUp: () => void;
  /** A scroll event of the element. */
  scroll: (element: HTMLElement) => void;
  /** Moves to the bottom when the transcript follows and no jump is running. */
  follow: (element: HTMLElement) => void;
  /** A smooth jump to the latest message starts: the steps of it are not the reader's. */
  beginJump: (element: HTMLElement) => void;
  endJump: (element: HTMLElement) => void;
  jumping: () => boolean;
  /** A conversation opens: follow its newest message, with no jump or release left over. */
  reset: () => void;
  dispose: () => void;
}

function distanceFromBottom(element: HTMLElement): number {
  return element.scrollHeight - element.scrollTop - element.clientHeight;
}

export function createScrollFollow(options: ScrollFollowOptions = {}): ScrollFollow {
  const now = options.now ?? (() => performance.now());
  const requestFrame = options.requestFrame ?? ((callback) => requestAnimationFrame(callback));
  const cancelFrame = options.cancelFrame ?? ((handle) => cancelAnimationFrame(handle));
  const setTimer = options.setTimer ?? ((callback, ms) => window.setTimeout(callback, ms));
  const clearTimer = options.clearTimer ?? ((handle) => window.clearTimeout(handle));

  let stick = true;
  let jumping = false;
  let jumpTimer: number | undefined;
  let lastScrollTop: number | undefined;
  let lastInputAt = Number.NEGATIVE_INFINITY;
  let touching = false;
  let touchEndedAt = Number.NEGATIVE_INFINITY;
  let touchY: number | undefined;
  let pointerHeld = false;
  let releaseFrame: number | undefined;

  const setStick = (value: boolean): void => {
    if (stick === value) return;
    stick = value;
    options.onStickChange?.(value);
  };

  const readerScrolling = (): boolean =>
    pointerHeld || touching || now() - lastInputAt <= INPUT_WINDOW_MS || now() - touchEndedAt <= TOUCH_MOMENTUM_MS;

  const cancelRelease = (): void => {
    if (releaseFrame === undefined) return;
    cancelFrame(releaseFrame);
    releaseFrame = undefined;
  };

  /**
   * The reader moves toward older messages: stop following now, before the scroll event. A wheel
   * move over a code block that scrolls on its own does not move the transcript, so the stick that
   * was released comes back on the next frame when nothing moved and the bottom is still there.
   */
  const release = (element: HTMLElement): void => {
    if (element.scrollTop <= 0) return;
    const previous = stick;
    const top = element.scrollTop;
    setStick(false);
    if (!previous) return;
    cancelRelease();
    releaseFrame = requestFrame(() => {
      releaseFrame = undefined;
      if (stick || element.scrollTop !== top || distanceFromBottom(element) > BOTTOM_EXACT) return;
      setStick(true);
    });
  };

  const clearJumpTimer = (): void => {
    if (jumpTimer === undefined) return;
    clearTimer(jumpTimer);
    jumpTimer = undefined;
  };

  const endJump = (element: HTMLElement): void => {
    if (!jumping) return;
    jumping = false;
    clearJumpTimer();
    // The content may have grown while the page scrolled: the bottom is further down now.
    if (stick) follow(element);
    options.onJumpEnd?.(element);
  };

  function follow(element: HTMLElement): void {
    if (!stick || jumping) return;
    // The same value again writes nothing, so several callers in a frame cost one write.
    if (element.scrollHeight - element.clientHeight - element.scrollTop < 1) return;
    element.scrollTop = element.scrollHeight;
  }

  return {
    stick: () => stick,
    setStick,
    wheel(element, deltaY) {
      lastInputAt = now();
      if (deltaY < 0) release(element);
    },
    touchStart(clientY) {
      touching = true;
      touchY = clientY;
      lastInputAt = now();
    },
    touchMove(element, clientY) {
      lastInputAt = now();
      const previous = touchY;
      touchY = clientY;
      // A finger that moves down drags older messages into view.
      if (previous === undefined || clientY > previous) release(element);
    },
    touchEnd() {
      touching = false;
      touchY = undefined;
      touchEndedAt = now();
    },
    key(element, key, shift = false) {
      const spaceUp = shift && (key === " " || key === "Spacebar");
      if (UP_KEYS.has(key) || spaceUp) {
        lastInputAt = now();
        release(element);
      } else if (DOWN_KEYS.has(key)) lastInputAt = now();
    },
    pointerDown() {
      pointerHeld = true;
      lastInputAt = now();
    },
    pointerUp() {
      pointerHeld = false;
      lastInputAt = now();
    },
    scroll(element) {
      const top = element.scrollTop;
      const moved = lastScrollTop === undefined ? 0 : top - lastScrollTop;
      lastScrollTop = top;
      const remaining = distanceFromBottom(element);
      if (jumping) {
        if (!readerScrolling()) {
          if (remaining <= BOTTOM_EXACT) endJump(element);
          return;
        }
        // The reader took over from the jump.
        jumping = false;
        clearJumpTimer();
        options.onJumpEnd?.(element);
      }
      if (readerScrolling()) {
        if (moved <= -1) setStick(false);
        else if (remaining > BOTTOM_DISTANCE) setStick(false);
        else if (moved >= 1 || remaining <= BOTTOM_EXACT) setStick(true);
        return;
      }
      if (remaining <= BOTTOM_EXACT) setStick(true);
    },
    follow,
    beginJump(element) {
      cancelRelease();
      lastInputAt = Number.NEGATIVE_INFINITY;
      touchEndedAt = Number.NEGATIVE_INFINITY;
      touching = false;
      pointerHeld = false;
      setStick(true);
      if (distanceFromBottom(element) <= BOTTOM_EXACT) return;
      jumping = true;
      clearJumpTimer();
      jumpTimer = setTimer(() => {
        jumpTimer = undefined;
        endJump(element);
      }, JUMP_TIMEOUT_MS);
    },
    endJump,
    jumping: () => jumping,
    reset() {
      cancelRelease();
      clearJumpTimer();
      jumping = false;
      lastScrollTop = undefined;
      setStick(true);
    },
    dispose() {
      cancelRelease();
      clearJumpTimer();
    },
  };
}

/**
 * The input events that show what the reader does with the transcript. The listeners are passive:
 * they never delay the scroll.
 */
export function listenForScrollIntent(element: HTMLElement, follow: ScrollFollow): () => void {
  const onWheel = (event: WheelEvent) => follow.wheel(element, event.deltaY);
  const onTouchStart = (event: TouchEvent) => follow.touchStart(event.touches[0]?.clientY ?? 0);
  const onTouchMove = (event: TouchEvent) => {
    const touch = event.touches[0];
    if (touch) follow.touchMove(element, touch.clientY);
  };
  const onTouchEnd = () => follow.touchEnd();
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) return;
    const target = event.target;
    // Arrow keys in a field move the caret, not the transcript.
    if (
      target instanceof HTMLElement &&
      (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName))
    ) {
      return;
    }
    follow.key(element, event.key, event.shiftKey);
  };
  const onPointerUp = () => {
    follow.pointerUp();
    window.removeEventListener("pointerup", onPointerUp);
    window.removeEventListener("pointercancel", onPointerUp);
  };
  const onPointerDown = () => {
    follow.pointerDown();
    window.addEventListener("pointerup", onPointerUp);
    window.addEventListener("pointercancel", onPointerUp);
  };
  const onScrollEnd = () => follow.endJump(element);
  const passive = { passive: true } as const;
  element.addEventListener("wheel", onWheel, passive);
  element.addEventListener("touchstart", onTouchStart, passive);
  element.addEventListener("touchmove", onTouchMove, passive);
  element.addEventListener("touchend", onTouchEnd, passive);
  element.addEventListener("touchcancel", onTouchEnd, passive);
  element.addEventListener("keydown", onKeyDown);
  element.addEventListener("pointerdown", onPointerDown, passive);
  element.addEventListener("scrollend", onScrollEnd);
  return () => {
    element.removeEventListener("wheel", onWheel);
    element.removeEventListener("touchstart", onTouchStart);
    element.removeEventListener("touchmove", onTouchMove);
    element.removeEventListener("touchend", onTouchEnd);
    element.removeEventListener("touchcancel", onTouchEnd);
    element.removeEventListener("keydown", onKeyDown);
    element.removeEventListener("pointerdown", onPointerDown);
    element.removeEventListener("scrollend", onScrollEnd);
    window.removeEventListener("pointerup", onPointerUp);
    window.removeEventListener("pointercancel", onPointerUp);
  };
}
