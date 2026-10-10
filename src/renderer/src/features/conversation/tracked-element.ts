import { getOwner, onCleanup } from "solid-js";

/**
 * One element of the page that comes and goes, such as the divider of the unread messages. The
 * reference ends with the owner that set it, and a detached element reads as none, so a caller
 * never scrolls to an element that the page has already dropped.
 */
export function createTrackedElement<Element extends HTMLElement>() {
  let current: Element | undefined;
  return {
    get: (): Element | undefined => (current?.isConnected ? current : undefined),
    set(element: Element): void {
      current = element;
      if (getOwner()) {
        onCleanup(() => {
          if (current === element) current = undefined;
        });
      }
    },
  };
}
