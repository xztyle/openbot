import { createSignal, onSettled } from "solid-js";

/**
 * How much the visible height must shrink, with a text field focused, to count as an on-screen
 * keyboard. The browser bars of a phone change the height by less than this when they hide.
 */
const KEYBOARD_MIN_HEIGHT = 150;
/** The part of the page that shows: its height, and how far down the page it starts. */
const HEIGHT_PROPERTY = "--web-viewport-height";
const TOP_PROPERTY = "--web-viewport-top";
/** The part of the page under the keyboard. Overlays outside the app keep clear of it. */
const KEYBOARD_INSET_PROPERTY = "--web-keyboard-inset";
/** Set on the root while the keyboard is open, for overlays that render outside the app. */
const KEYBOARD_ATTRIBUTE = "data-web-keyboard";
/** A phone or a tablet, where `web-client.css` fixes the app to the visible part of the screen. */
const TOUCH_QUERY = "(max-width: 720px), (pointer: coarse)";

const TEXT_FIELD = "input:not([type='checkbox'], [type='radio'], [type='range']), textarea, [contenteditable='true']";

/**
 * Keeps the phone app on the part of the screen that shows, and tells when the keyboard is open.
 *
 * On an iPhone the keyboard does not resize the page. Safari shrinks the visual viewport and pans it
 * down the page (`offsetTop`) until the focused field shows over the keyboard. The app is fixed to
 * the layout viewport, so it stayed at the top of the page: the box went to the top of the screen
 * and an empty band showed under it. The app now takes the visual viewport's height and starts at
 * its `offsetTop` (`web-client.css`), and follows each resize and pan. That is the place where
 * Safari wants the field, so Safari does not pan again. Chrome on Android with
 * `interactive-widget=resizes-content` shrinks the page itself, and `offsetTop` stays 0.
 *
 * The page itself never scrolls: Safari can leave it scrolled after the keyboard closes, which put
 * the header under the status bar. While the keyboard is open the page is left alone, as a scroll
 * then makes Safari pan again.
 *
 * A pinch zoom also changes the visual viewport. The app then keeps the layout viewport, so that
 * the zoom works as on any page.
 */
export function createWebVisualViewport() {
  const [keyboardOpen, setKeyboardOpen] = createSignal(false);
  onSettled(() => {
    const viewport = window.visualViewport;
    if (!viewport) return;
    const root = document.documentElement;
    const phone = window.matchMedia?.(TOUCH_QUERY);
    let width = viewport.width;
    let tallest = viewport.height;
    let open = false;
    const measure = () => {
      // A new width is a rotation: the tallest height starts again.
      if (Math.abs(viewport.width - width) > 1) {
        width = viewport.width;
        tallest = viewport.height;
      }
      tallest = Math.max(tallest, viewport.height);
      const typing = document.activeElement?.matches(TEXT_FIELD) ?? false;
      open = typing && tallest - viewport.height > KEYBOARD_MIN_HEIGHT;
      setKeyboardOpen(open);
      if (open) root.setAttribute(KEYBOARD_ATTRIBUTE, "");
      else root.removeAttribute(KEYBOARD_ATTRIBUTE);
      if (viewport.scale > 1.01) {
        root.style.removeProperty(HEIGHT_PROPERTY);
        root.style.removeProperty(TOP_PROPERTY);
        root.style.removeProperty(KEYBOARD_INSET_PROPERTY);
        return;
      }
      const top = Math.max(0, viewport.offsetTop);
      root.style.setProperty(HEIGHT_PROPERTY, `${viewport.height}px`);
      root.style.setProperty(TOP_PROPERTY, `${top}px`);
      root.style.setProperty(
        KEYBOARD_INSET_PROPERTY,
        `${Math.max(0, Math.round(window.innerHeight - viewport.height - top))}px`,
      );
      if (!open && phone?.matches && (window.scrollY !== 0 || window.scrollX !== 0)) window.scrollTo(0, 0);
    };
    /*
     * Focus can leave a field for a moment, such as when a press in its list or menu moves it and
     * the field takes it back. Giving the page its full height back at once moved the composer and
     * its list under the finger before the tap ended, so a focus change is measured a frame later.
     * A keyboard that really closes also resizes the viewport.
     */
    let frame: number | undefined;
    const later = () => {
      if (frame !== undefined) cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        frame = undefined;
        measure();
      });
    };
    /* A drag past the end of a pane, or the keyboard as it closes, can leave the page scrolled. */
    const pageScrolled = () => {
      if (!open && phone?.matches && (window.scrollY !== 0 || window.scrollX !== 0)) window.scrollTo(0, 0);
    };
    measure();
    viewport.addEventListener("resize", measure);
    viewport.addEventListener("scroll", measure);
    window.addEventListener("scroll", pageScrolled, { passive: true });
    document.addEventListener("focusin", later);
    document.addEventListener("focusout", later);
    return () => {
      if (frame !== undefined) cancelAnimationFrame(frame);
      viewport.removeEventListener("resize", measure);
      viewport.removeEventListener("scroll", measure);
      window.removeEventListener("scroll", pageScrolled);
      document.removeEventListener("focusin", later);
      document.removeEventListener("focusout", later);
      root.removeAttribute(KEYBOARD_ATTRIBUTE);
      for (const property of [HEIGHT_PROPERTY, TOP_PROPERTY, KEYBOARD_INSET_PROPERTY])
        root.style.removeProperty(property);
    };
  });
  return keyboardOpen;
}
