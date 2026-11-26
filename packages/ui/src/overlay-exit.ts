import { prefersReducedMotion } from "./utils";

const EXIT_FALLBACK_MS = 400;
/** A surface with more nodes than this is not copied: the copy would cost more than the exit is worth. */
const MAX_COPIED_NODES = 4000;
const FIELDS = "input, textarea";

/**
 * Kobalte removes a closed dialog, sheet or overlay at once, so a CSS exit cannot play on it. An inert
 * copy takes its place with the data attribute `mark` set (`"overlayClosing"` is `data-overlay-closing`),
 * plays the exit that the stylesheet gives to that mark, and
 * leaves when the animation ends. The copy keeps the scroll positions and the typed text, so it looks as
 * the surface did. Call it in a cleanup, before the surface leaves the page: the copy mounts only once
 * the surface has left, so a surface that stays, because only a child closed, gets no copy.
 */
export function playExitCopy(surface: HTMLElement, mark: string): void {
  if (typeof surface.animate !== "function" || prefersReducedMotion()) return;
  if (!surface.isConnected || surface.querySelectorAll("*").length > MAX_COPIED_NODES) return;
  // Read now: the cleanup can run before the surface leaves the page, and a copy keeps no scroll or typed text.
  const scrolled = Array.from(surface.querySelectorAll("*"), (element) => element.scrollTop);
  const values = Array.from(surface.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>(FIELDS), (f) => f.value);
  const copy = surface.cloneNode(true);
  if (!(copy instanceof HTMLElement)) return;
  copy.inert = true;
  copy.setAttribute("aria-hidden", "true");
  copy.style.pointerEvents = "none";
  copy.removeAttribute("id");
  for (const element of copy.querySelectorAll("[id]")) element.removeAttribute("id");
  copy.dataset[mark] = "";

  queueMicrotask(() => {
    // The surface stays when only a child closed.
    if (surface.isConnected) return;
    document.body.appendChild(copy);
    for (const [index, element] of Array.from(copy.querySelectorAll("*")).entries()) {
      const top = scrolled[index];
      if (top) element.scrollTop = top;
    }
    for (const [index, field] of Array.from(
      copy.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>(FIELDS),
    ).entries())
      field.value = values[index] ?? "";
    if (copy.getAnimations({ subtree: true }).length === 0) {
      copy.remove();
      return;
    }
    const fallback = setTimeout(() => copy.remove(), EXIT_FALLBACK_MS);
    copy.addEventListener("animationend", (event) => {
      // Elements in the copy can end their own animations first.
      if (event.target !== copy) return;
      clearTimeout(fallback);
      copy.remove();
    });
  });
}
