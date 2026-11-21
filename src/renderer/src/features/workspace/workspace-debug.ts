/*
 * Debug mode of the workspace, kept on this device only. Off, the workspace shows the people what is
 * for them: the messages between agents fold to one line, long answers fold to "Show more", and a
 * channel or a thread shows no steps of the agents' turns. On, it shows everything: the steps and
 * the tools, the messages between agents and long messages whole, and the notes that the transcript
 * hides, such as a lead's routing receipts, and the agent's own text of a condensed answer.
 */
import { setCondensedOriginalByDefault } from "@openbot/ui/features/conversation/CondensedNote";
import { createRoot, createSignal } from "solid-js";

const STORAGE_KEY = "atelier.workspace.debug";

function stored(): boolean {
  try {
    return globalThis.localStorage?.getItem(STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

const [debugMode, setDebug] = createRoot(() => createSignal(stored()));
setCondensedOriginalByDefault(debugMode);

/** Whether this device shows the workspace in debug mode. */
export { debugMode };

export function setDebugMode(on: boolean): void {
  setDebug(on);
  try {
    if (on) globalThis.localStorage?.setItem(STORAGE_KEY, "1");
    else globalThis.localStorage?.removeItem(STORAGE_KEY);
  } catch {
    // Storage can be blocked, as in a private window: the mode then holds until the page reloads.
  }
}

export function toggleDebugMode(): void {
  setDebugMode(!debugMode());
}
