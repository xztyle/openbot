const OPEN_POPUP = '[role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"]';
/** The settings side panel and the overlays that open inside it: what happens there is the user's choice. */
const SETTINGS_SURFACE = ".settings-panel, .agent-routines-overlay";
const TEXT_ENTRY = 'input, textarea, select, [contenteditable=""], [contenteditable="true"]';

/**
 * Whether the composer should take focus back when the window becomes active again.
 *
 * Chromium gives focus back to the element that had it, so this only acts when that was nothing
 * (`body`, after a click in the transcript) or a control the pointer focused, such as a sidebar row.
 * A popup, a text selection, another text field, a keyboard-focused control or a control in the
 * settings panel is the user's choice.
 */
export function shouldRestoreComposerFocus(editor: HTMLElement): boolean {
  if (!editor.isConnected || editor.getAttribute("contenteditable") !== "true") return false;
  if (editor.closest("[inert], [hidden]")) return false;
  const document = editor.ownerDocument;
  const active = document.activeElement;
  if (active && editor.contains(active)) return false;
  if (document.querySelector(OPEN_POPUP)) return false;
  const selection = document.getSelection();
  if (selection && !selection.isCollapsed && !editor.contains(selection.anchorNode)) return false;
  if (!active || active === document.body || active === document.documentElement) return true;
  // A switch or a button that a click in the settings panel focused is still where the person works.
  if (active.closest(SETTINGS_SURFACE)) return false;
  return !active.matches(TEXT_ENTRY) && !active.matches(":focus-visible");
}
