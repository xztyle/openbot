/*
 * Press handling for a list that belongs to a text field, such as the composer's mention picker or
 * the browser's address suggestions. The field keeps the focus, the caret and the on-screen
 * keyboard while the person presses an option, with a mouse, a finger or a pen.
 *
 * iOS Safari sends a tap as touch events and then, at touchend, as a synthetic mousedown, mouseup
 * and click. A cancelled pointerdown does not stop that mousedown, and the mousedown takes the
 * focus from the field. The field then closed its list on blur, the web client gave the page its
 * full height back as the keyboard went down, and the click landed on whatever moved under the
 * finger. So the list cancels mousedown as well, and a tap selects at touchend: cancelling
 * touchend stops the synthetic mouse events and the click, and nothing moves before the selection.
 * A finger that moves past the slop scrolls the list and selects nothing. A mouse keeps the
 * listbox's own press-up selection, and the keys stay with the field.
 */

/** How far a finger may move, in CSS pixels, and still count as a tap. */
const TAP_SLOP = 10;

interface TrackedTouch {
  pointerId: number;
  x: number;
  y: number;
  moved: boolean;
}

export interface FieldListPress {
  /** Spread on the element that holds the options. */
  rootProps: {
    onMouseDown: (event: MouseEvent) => void;
    onPointerDown: (event: PointerEvent) => void;
  };
  /** Handlers for one option. `select` runs once for a tap; a click selects through the listbox. */
  optionProps: (select: () => void) => {
    onPointerDown: (event: PointerEvent) => void;
    onPointerMove: (event: PointerEvent) => void;
    onPointerCancel: (event: PointerEvent) => void;
    onTouchEnd: (event: TouchEvent) => void;
  };
  /**
   * True from a press in the list until the press ends. The field does not close the list on a
   * blur or a selection change in that time.
   */
  pressing: () => boolean;
}

export function createFieldListPress(): FieldListPress {
  let touch: TrackedTouch | null = null;
  let pressed = false;
  let releaseTimer: ReturnType<typeof setTimeout> | undefined;

  const press = () => {
    pressed = true;
    clearTimeout(releaseTimer);
    // A press that never ends in the list, such as one that scrolled it, releases on the next up.
    const release = () => {
      document.removeEventListener("pointerup", release, true);
      document.removeEventListener("pointercancel", release, true);
      // The synthetic mouse events and the blur that a tap can still cause come after pointerup.
      releaseTimer = setTimeout(() => {
        pressed = false;
      }, 400);
    };
    document.addEventListener("pointerup", release, true);
    document.addEventListener("pointercancel", release, true);
  };

  return {
    rootProps: {
      onMouseDown: (event) => event.preventDefault(),
      onPointerDown: (event) => {
        // A cancelled pointerdown keeps the focus in the field for a mouse; touch scrolling is
        // decided by `touch-action`, so the list still scrolls.
        event.preventDefault();
        // An ancestor such as the composer focuses its editor on pointerdown; the field has it.
        event.stopPropagation();
        press();
      },
    },
    optionProps: (select) => ({
      onPointerDown: (event) => {
        touch =
          event.pointerType === "mouse"
            ? null
            : { pointerId: event.pointerId, x: event.clientX, y: event.clientY, moved: false };
      },
      onPointerMove: (event) => {
        if (!touch || touch.pointerId !== event.pointerId) return;
        if (Math.hypot(event.clientX - touch.x, event.clientY - touch.y) > TAP_SLOP) touch.moved = true;
      },
      onPointerCancel: () => {
        touch = null;
      },
      onTouchEnd: (event) => {
        const tapped = touch !== null && !touch.moved;
        touch = null;
        if (!tapped || !event.cancelable) return;
        event.preventDefault();
        select();
      },
    }),
    pressing: () => pressed,
  };
}
