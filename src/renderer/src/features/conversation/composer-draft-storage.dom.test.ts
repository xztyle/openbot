import { createRoot, createSignal, flush } from "solid-js";
import { afterEach, describe, expect, it } from "vitest";
import { readStoredComposerDrafts, writeComposerDraftsOnChange } from "./composer-draft-storage";
import type { ComposerDraft } from "./conversation-types";

// Failure mode: a phone hides the page right after the last keys and closes it in the background
// with no `pagehide`, so the words typed in the last moment before the switch are gone.
const KEY = "composer-drafts-test";

function setVisibility(state: DocumentVisibilityState) {
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => state });
  document.dispatchEvent(new Event("visibilitychange"));
}

afterEach(() => {
  window.localStorage.clear();
  setVisibility("visible");
});

describe("writeComposerDraftsOnChange", () => {
  it("stores the draft at once when the page hides", () => {
    const [drafts, setDrafts] = createSignal<Record<string, ComposerDraft>>({}, { ownedWrite: true });
    const dispose = createRoot((dispose) => {
      writeComposerDraftsOnChange(
        {
          drafts,
          channelDrafts: () => ({}),
          editingAgentId: () => null,
          editingServerId: () => null,
          editingDraftBackup: () => null,
          unsentTexts: () => ({}),
        },
        KEY,
      );
      return dispose;
    });
    flush();
    setDrafts({ chief: { text: "las últimas palabras", attachments: [], replyToMessageId: null } });
    flush();
    expect(window.localStorage.getItem(KEY)).toBeNull();
    setVisibility("hidden");
    expect(readStoredComposerDrafts(KEY).agents.chief?.text).toBe("las últimas palabras");
    dispose();
  });
});
