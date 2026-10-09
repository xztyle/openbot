import { createSignal } from "solid-js";

/**
 * Two things the chat can leave out, for each person on each browser or device: the model's
 * reasoning, and the messages that agents send to each other. Both are on unless the person turned
 * them off. The choice is only a view, so it never reaches the host.
 */

const REASONING_STORAGE_KEY = "openbot:show-agent-reasoning";
const AGENT_MESSAGES_STORAGE_KEY = "openbot:show-agent-messages";

type PreferenceStorage = Pick<Storage, "getItem" | "setItem">;

/** The choices for this page after the browser did not save them. They win over an older saved value. */
const unsavedPreferences = new Map<string, boolean>();

/**
 * Reading `window.localStorage` throws when the browser blocks storage, so it is read inside the
 * guard, and a failed read means the default: on.
 */
function readPreference(key: string, storage?: Pick<Storage, "getItem">): boolean {
  const unsaved = unsavedPreferences.get(key);
  if (unsaved !== undefined) return unsaved;
  try {
    return (storage ?? window.localStorage).getItem(key) !== "false";
  } catch {
    return true;
  }
}

function writePreference(key: string, enabled: boolean, storage?: Pick<Storage, "setItem">): void {
  try {
    (storage ?? window.localStorage).setItem(key, String(enabled));
    unsavedPreferences.delete(key);
  } catch {
    // Blocked or full storage keeps the choice for this page only.
    unsavedPreferences.set(key, enabled);
  }
}

export function readShowAgentReasoning(storage?: Pick<Storage, "getItem">): boolean {
  return readPreference(REASONING_STORAGE_KEY, storage);
}

export function readShowAgentMessages(storage?: Pick<Storage, "getItem">): boolean {
  return readPreference(AGENT_MESSAGES_STORAGE_KEY, storage);
}

export function writeShowAgentReasoning(enabled: boolean, storage?: PreferenceStorage): void {
  writePreference(REASONING_STORAGE_KEY, enabled, storage);
}

export function writeShowAgentMessages(enabled: boolean, storage?: PreferenceStorage): void {
  writePreference(AGENT_MESSAGES_STORAGE_KEY, enabled, storage);
}

const [showAgentReasoning, setShowAgentReasoningSignal] = createSignal(readShowAgentReasoning());
const [showAgentMessages, setShowAgentMessagesSignal] = createSignal(readShowAgentMessages());

function readStorageIntoSignals(event: StorageEvent): void {
  if (event.key === null || event.key === REASONING_STORAGE_KEY) {
    setShowAgentReasoningSignal(readShowAgentReasoning());
  }
  if (event.key === null || event.key === AGENT_MESSAGES_STORAGE_KEY) {
    setShowAgentMessagesSignal(readShowAgentMessages());
  }
}

if (typeof window !== "undefined") {
  // One registration per page: addEventListener ignores the same listener twice, and HMR
  // disposal removes it when this module is replaced.
  window.addEventListener("storage", readStorageIntoSignals);
  import.meta.hot?.dispose(() => {
    window.removeEventListener("storage", readStorageIntoSignals);
  });
}

/**
 * The shared reactive choices. Every chat on this page follows the same signals, so a switch in
 * Settings changes the timeline at once, without a reload.
 */
export function useShowAgentReasoning(): () => boolean {
  return showAgentReasoning;
}

export function useShowAgentMessages(): () => boolean {
  return showAgentMessages;
}

export function setShowAgentReasoning(enabled: boolean): void {
  writeShowAgentReasoning(enabled);
  setShowAgentReasoningSignal(enabled);
}

export function setShowAgentMessages(enabled: boolean): void {
  writeShowAgentMessages(enabled);
  setShowAgentMessagesSignal(enabled);
}
