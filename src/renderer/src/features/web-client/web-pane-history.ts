import { isDynamicRecord } from "@openbot/contracts/runtime-values";
import type { WebMobilePane } from "./WebMobileNavigation";

/** The key of the history state that holds the pane an entry shows. */
const PANE_KEY = "openbotPane";

function paneOf(state: unknown): WebMobilePane | null {
  const value = isDynamicRecord(state) ? state[PANE_KEY] : undefined;
  return value === "workspace" || value === "conversation" ? value : null;
}

function withPane(pane: WebMobilePane) {
  const state = window.history.state;
  return { ...(isDynamicRecord(state) ? state : {}), [PANE_KEY]: pane };
}

/**
 * Makes the Android back button and the iOS back swipe move between the two panes of a phone, as they
 * do in a native app. The list of agents is the entry under the chat: the back button goes from a chat
 * to the list, and from the list out of the app. The history has two entries at most for this. A
 * pane change that the user makes, such as the tab or a chosen agent, moves along it too.
 *
 * Without `enabled` (a wide screen shows both panes) nothing touches the history.
 */
export function createWebPaneHistory(options: { pane: () => WebMobilePane; setPane: (pane: WebMobilePane) => void }): {
  start(): void;
  sync(pane: WebMobilePane): void;
  stop(): void;
} {
  let listening = false;
  /** The pane that the history last showed. A change that came from the history needs no new entry. */
  let shown: WebMobilePane | null = null;

  function onPopState(event: PopStateEvent): void {
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
      window.removeEventListener("popstate", onPopState);
    },
  };
}
