import { afterEach, describe, expect, it, vi } from "vitest";
import { keepComposerFocusOnSendPress, shouldRestoreComposerFocus } from "./composer-focus";

function composer() {
  const editor = document.createElement("div");
  editor.setAttribute("contenteditable", "true");
  document.body.append(editor);
  return editor;
}

/** A button that a pointer press focused: a browser does not give such a focus the keyboard focus ring. */
function pointerFocusedButtonIn(container: HTMLElement) {
  const button = document.createElement("button");
  const matches = button.matches.bind(button);
  vi.spyOn(button, "matches").mockImplementation((selector) => selector !== ":focus-visible" && matches(selector));
  container.append(button);
  document.body.append(container);
  button.focus();
  return button;
}

describe("shouldRestoreComposerFocus", () => {
  afterEach(() => {
    document.body.replaceChildren();
  });

  it("takes focus back from a control that the pointer focused outside the settings panel", () => {
    const editor = composer();
    const row = document.createElement("div");
    pointerFocusedButtonIn(row);
    expect(shouldRestoreComposerFocus(editor)).toBe(true);
  });

  it("leaves focus on a control in the settings panel or in an overlay inside it", () => {
    const editor = composer();
    const panel = document.createElement("aside");
    panel.className = "settings-panel";
    pointerFocusedButtonIn(panel);
    expect(shouldRestoreComposerFocus(editor)).toBe(false);

    const overlay = document.createElement("div");
    overlay.className = "agent-routines-overlay";
    pointerFocusedButtonIn(overlay);
    expect(shouldRestoreComposerFocus(editor)).toBe(false);
  });
});

describe("keepComposerFocusOnSendPress", () => {
  const originalMatchMedia = window.matchMedia;

  afterEach(() => {
    window.matchMedia = originalMatchMedia;
    document.body.replaceChildren();
  });

  function touchScreen(matches: boolean) {
    window.matchMedia = vi.fn().mockReturnValue({ matches });
  }

  function focusedMessageBox() {
    const composer = document.createElement("form");
    composer.className = "composer";
    const editor = document.createElement("div");
    editor.setAttribute("role", "textbox");
    editor.setAttribute("tabindex", "0");
    composer.append(editor);
    document.body.append(composer);
    editor.focus();
  }

  it("cancels the press on a touch screen while the message box has the focus", () => {
    touchScreen(true);
    focusedMessageBox();
    const event = { preventDefault: vi.fn() };
    keepComposerFocusOnSendPress(event);
    expect(event.preventDefault).toHaveBeenCalledOnce();
  });

  it("leaves a mouse press alone", () => {
    touchScreen(false);
    focusedMessageBox();
    const event = { preventDefault: vi.fn() };
    keepComposerFocusOnSendPress(event);
    expect(event.preventDefault).not.toHaveBeenCalled();
  });

  it("leaves the press alone when the message box does not have the focus", () => {
    touchScreen(true);
    const event = { preventDefault: vi.fn() };
    keepComposerFocusOnSendPress(event);
    expect(event.preventDefault).not.toHaveBeenCalled();
  });
});
