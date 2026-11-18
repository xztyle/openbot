/**
 * Where a hand-made floating surface portals: into the dialog that holds its anchor, or into the
 * body. A modal dialog sets `pointer-events: none` on the body and hides the body's other children
 * from screen readers, so a surface portaled beside the dialog showed but took no press. Inside the
 * dialog it shares the dialog's layer and focus scope. Kobalte surfaces handle this themselves.
 */
export function overlayMount(anchor: Element | null | undefined): HTMLElement {
  return anchor?.closest<HTMLElement>('[role="dialog"], [role="alertdialog"]') ?? document.body;
}
