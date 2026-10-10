import { isDynamicRecord } from "@openbot/contracts/runtime-values";
import type { WebMobilePane } from "./WebMobileNavigation";

/** The key of the history state that holds the pane an entry shows. */
const PANE_KEY = "openbotPane";
/** Marks the entry that an open dialog, settings page or report added on top of its pane. */
const OVERLAY_KEY = "openbotOverlay";

function paneOf(state: unknown): WebMobilePane | null {
  const value = isDynamicRecord(state) ? state[PANE_KEY] : undefined;
  return value === "workspace" || value === "conversation" ? value : null;
}

function isOverlayEntry(state: unknown): boolean {
  return isDynamicRecord(state) && state[OVERLAY_KEY] === true;
}

/** The state of a pane entry: the state of the page without an overlay mark, with the pane. */
function withPane(pane: WebMobilePane) {
  const state = window.history.state;
  const rest = isDynamicRecord(state) ? Object.entries(state).filter(([key]) => key !== OVERLAY_KEY) : [];
  return { ...Object.fromEntries(rest), [PANE_KEY]: pane };
}

/**
 * Makes the Android back button and the iOS back swipe move between the two panes of a phone, as they
 * do in a native app. The list of agents is the entry under the chat: the back button goes from a chat
 * to the list, and from the list out of the app. The history has two entries at most for this. A
 * pane change that the user makes, such as the tab or a chosen agent, moves along it too.
 *
 * Something that covers the pane, such as a dialog or the settings, adds one entry on top while it is
 * open. The back button then closes it (`closeOverlay`) and stays on the pane. An entry of an overlay
 * that is closed already, which a pane change can leave under the pane, is stepped over.
 *
 * Without `start` (a wide screen shows both panes) nothing touches the history.
 */
export function createWebPaneHistory(options: {
  pane: () => WebMobilePane;
  setPane: (pane: WebMobilePane) => void;
  /** The user stepped back from an overlay. Closes everything that covers the pane. */
  closeOverlay?: () => void;
}): {
  start(): void;
  sync(pane: WebMobilePane): void;
  /** Tells that something covers the pane, or that nothing does. */
  syncOverlay(open: boolean): void;
  stop(): void;
} {
  let listening = false;
  /** The pane that the history last showed. A change that came from the history needs no new entry. */
  let shown: WebMobilePane | null = null;
  /** The history has an entry for the open overlay on top. */
  let overlayShown = false;

  function onPopState(event: PopStateEvent): void {
    const overlay = isOverlayEntry(event.state);
    if (overlayShown && !overlay) {
      overlayShown = false;
      options.closeOverlay?.();
    } else if (!overlayShown && overlay) {
      // The overlay is closed already, so this entry shows nothing of its own.
      window.history.back();
      return;
    }
    const pane = paneOf(event.state);
    if (!pane) return;
    shown = pane;
    if (options.pane() !== pane) options.setPane(pane);
  }

  return {
    start() {
      if (listening) return;
      listening = true;
      const current = paneOf(window.history.state);
      if (current) {
        // A reload keeps the entry, and with it the pane that the user had.
        shown = current;
        if (options.pane() !== current) options.setPane(current);
      } else {
        // The first entry of the page becomes the list, with the pane of the page on top of it.
        window.history.replaceState(withPane("workspace"), "");
        shown = "workspace";
        if (options.pane() === "conversation") {
          window.history.pushState(withPane("conversation"), "");
          shown = "conversation";
        }
      }
      window.addEventListener("popstate", onPopState);
      // A reload on the entry of an overlay shows no overlay, so the entry is stepped over.
      if (isOverlayEntry(window.history.state)) window.history.back();
    },
    syncOverlay(open) {
      if (!listening || open === overlayShown) return;
      overlayShown = open;
      if (open) {
        window.history.pushState({ ...withPane(shown ?? options.pane()), [OVERLAY_KEY]: true }, "");
        return;
      }
      // The entry is gone when a pane change pushed another one over it. That entry is stepped over later.
      if (isOverlayEntry(window.history.state)) window.history.back();
    },
    sync(pane) {
      if (!listening || shown === pane) return;
      if (pane === "conversation") {
        window.history.pushState(withPane("conversation"), "");
        shown = "conversation";
        return;
      }
      // The list is the entry under the chat, so the way back to it is the history's own step.
      shown = "workspace";
      if (paneOf(window.history.state) === "conversation") window.history.back();
      else window.history.replaceState(withPane("workspace"), "");
    },
    stop() {
      if (!listening) return;
      listening = false;
      shown = null;
      overlayShown = false;
      window.removeEventListener("popstate", onPopState);
    },
  };
}
