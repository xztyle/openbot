import { isDynamicRecord, isNumber } from "@openbot/contracts/runtime-values";
import type { WebMobilePane } from "./WebMobileNavigation";

/**
 * The screens of a phone, from the bottom of the stack: the list (a tab of the workspace, or the
 * agents), the conversation, and the thread or details panel over the conversation.
 */
export type WebPhoneLevel = WebMobilePane | "panel";

/** The key of the history state that holds the screen an entry shows. */
const PANE_KEY = "openbotPane";
/** The key of the history state that holds the place of the entry in the stack of screens. */
const DEPTH_KEY = "openbotPaneDepth";
/** Marks the entry that an open dialog, settings page or report added on top of its pane. */
const OVERLAY_KEY = "openbotOverlay";

const LEVEL_DEPTH: Record<WebPhoneLevel, number> = { workspace: 0, conversation: 1, panel: 2 };

function paneOf(state: unknown): WebPhoneLevel | null {
  const value = isDynamicRecord(state) ? state[PANE_KEY] : undefined;
  return value === "workspace" || value === "conversation" || value === "panel" ? value : null;
}

/** The place of an entry in the stack. An entry of an older client has none: the list is the bottom. */
function depthOf(state: unknown, pane: WebPhoneLevel): number {
  const value = isDynamicRecord(state) ? state[DEPTH_KEY] : undefined;
  return isNumber(value) && Number.isInteger(value) && value >= 0 ? value : pane === "workspace" ? 0 : 1;
}

function isOverlayEntry(state: unknown): boolean {
  return isDynamicRecord(state) && state[OVERLAY_KEY] === true;
}

/** The state of a pane entry: the state of the page without an overlay mark, with the pane. */
function withPane(pane: WebPhoneLevel, depth: number) {
  const state = window.history.state;
  const rest = isDynamicRecord(state) ? Object.entries(state).filter(([key]) => key !== OVERLAY_KEY) : [];
  return { ...Object.fromEntries(rest), [PANE_KEY]: pane, [DEPTH_KEY]: depth };
}

/**
 * Makes the Android back button and the iOS back swipe move between the screens of a phone, as they
 * do in a native app. The list (a tab) is the bottom entry; a conversation opened from it is the entry
 * above, and a thread opened in the conversation the entry above that. Back goes down one screen,
 * and from the list out of the app. A screen change that the user makes, such as a chosen
 * conversation or the back button of a screen, moves along the history too.
 *
 * A screen that opens straight from the list, such as a thread from Activity, gets one entry: Back
 * goes to the list it came from, as in Slack.
 *
 * Something that covers the pane, such as a dialog or the settings, adds one entry on top while it is
 * open. The back button then closes it (`closeOverlay`) and stays on the pane. An entry of an overlay
 * that is closed already, which a pane change can leave under the pane, is stepped over.
 *
 * Without `start` (a wide screen shows both panes) nothing touches the history.
 */
export function createWebPaneHistory(options: {
  pane: () => WebPhoneLevel;
  setPane: (pane: WebPhoneLevel) => void;
  /** The user stepped back from an overlay. Closes everything that covers the pane. */
  closeOverlay?: () => void;
}): {
  start(): void;
  sync(pane: WebPhoneLevel): void;
  /** Tells that something covers the pane, or that nothing does. */
  syncOverlay(open: boolean): void;
  stop(): void;
} {
  let listening = false;
  /** The screens of the entries of this page, from the bottom; the last is the entry on screen. */
  let stack: WebPhoneLevel[] = [];
  /** The history has an entry for the open overlay on top. */
  let overlayShown = false;
  /** The overlay's entry waits for the screen that it opened with. */
  let overlayPending = false;

  const shown = (): WebPhoneLevel | null => stack.at(-1) ?? null;

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
    const depth = depthOf(event.state, pane);
    // A step forward can reach an entry that this page did not see; the screens under it are lists.
    while (stack.length < depth) stack.push(stack.length === 0 ? "workspace" : "conversation");
    stack.length = depth;
    stack.push(pane);
    if (options.pane() !== pane) options.setPane(pane);
  }

  return {
    start() {
      if (listening) return;
      listening = true;
      const state = window.history.state;
      const current = paneOf(state);
      if (current) {
        // A reload keeps the entry, and with it the screen that the user had.
        const depth = depthOf(state, current);
        stack = [
          ...Array.from({ length: depth }, (_, index): WebPhoneLevel => (index === 0 ? "workspace" : "conversation")),
          current,
        ];
        if (options.pane() !== current) options.setPane(current);
      } else {
        // The first entry of the page becomes the list, with the screen of the page on top of it.
        window.history.replaceState(withPane("workspace", 0), "");
        stack = ["workspace"];
        const pane = options.pane();
        if (pane !== "workspace") {
          window.history.pushState(withPane(pane, 1), "");
          stack.push(pane);
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
        // A page opens with the screen it shows on, such as the settings over the conversation. The
        // screen's entry goes first, so the overlay's entry waits until the changes of this task are in.
        overlayPending = true;
        queueMicrotask(() => {
          if (!overlayPending) return;
          overlayPending = false;
          if (!listening || !overlayShown) return;
          const pane = shown() ?? options.pane();
          window.history.pushState({ ...withPane(pane, Math.max(0, stack.length - 1)), [OVERLAY_KEY]: true }, "");
        });
        return;
      }
      if (overlayPending) {
        overlayPending = false;
        return;
      }
      // The entry is gone when a pane change pushed another one over it. That entry is stepped over later.
      if (isOverlayEntry(window.history.state)) window.history.back();
    },
    sync(pane) {
      const top = shown();
      if (!listening || !top || top === pane) return;
      if (LEVEL_DEPTH[pane] > LEVEL_DEPTH[top]) {
        window.history.pushState(withPane(pane, stack.length), "");
        stack.push(pane);
        return;
      }
      // A screen below: the history's own steps go back to it, when it has an entry.
      const below = stack.findLastIndex((level) => LEVEL_DEPTH[level] <= LEVEL_DEPTH[pane]);
      if (below >= 0 && stack[below] === pane && paneOf(window.history.state) === top) {
        const steps = stack.length - 1 - below;
        stack.length = below + 1;
        window.history.go(-steps);
        return;
      }
      // No entry has it, such as the conversation under a thread that opened from the list.
      stack[stack.length - 1] = pane;
      window.history.replaceState(withPane(pane, stack.length - 1), "");
    },
    stop() {
      if (!listening) return;
      listening = false;
      stack = [];
      overlayShown = false;
      overlayPending = false;
      window.removeEventListener("popstate", onPopState);
    },
  };
}
