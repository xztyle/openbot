import { createEffect, createSignal, untrack } from "solid-js";

/**
 * The modal dialogs and sheets that are open, oldest first, each with what closes it. A phone's Back
 * (the iOS edge swipe, the Android button) closes the top one before it leaves the screen under it,
 * as a native sheet does; without this list a dialog stayed open over the screen that Back showed.
 */
const [modals, setModals] = createSignal<readonly (() => void)[]>([]);

/** How many modal dialogs and sheets are open. */
export function openModalCount(): number {
  return modals().length;
}

/** Closes the modal that opened last. False when none is open. */
export function closeTopModal(): boolean {
  const close = untrack(modals).at(-1);
  if (!close) return false;
  close();
  return true;
}

/** Counts a dialog while `open` holds. `close` asks its owner to close it, as Escape does. */
export function trackModal(open: () => boolean, close: () => void): void {
  createEffect(open, (isOpen) => {
    if (!isOpen) return;
    const entry = () => close();
    setModals((list) => [...list, entry]);
    return () => setModals((list) => list.filter((item) => item !== entry));
  });
}
