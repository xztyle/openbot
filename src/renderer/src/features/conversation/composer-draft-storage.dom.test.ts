import { createRoot, createSignal, flush } from "solid-js";
import { afterEach, describe, expect, it } from "vitest";
import {
  accountComposerDraftsKey,
  readStoredComposerDrafts,
  writeComposerDraftsOnChange,
} from "./composer-draft-storage";

afterEach(() => window.localStorage.clear());

describe("composer draft storage by account", () => {
  it("keeps the text and the failed messages of one account under its own key until it is discarded", () => {
    const key = accountComposerDraftsKey("account-a");
    expect(key).not.toBe(accountComposerDraftsKey("account-b"));
    const [drafts, setDrafts] = createSignal<Record<string, { text: string }>>({});
    const [unsentTexts] = createSignal<Record<string, string[]>>({ "host:chief": ["A failed message"] });
    const storage = createRoot(() =>
      writeComposerDraftsOnChange(
        {
          drafts: () =>
            Object.fromEntries(
              Object.entries(drafts()).map(([id, draft]) => [
                id,
                { ...draft, attachments: [], replyToMessageId: null },
              ]),
            ),
          channelDrafts: () => ({}),
          editingAgentId: () => null,
          editingServerId: () => null,
          editingDraftBackup: () => null,
          unsentTexts,
        },
        key,
      ),
    );
    flush();
    setDrafts({ "host:chief": { text: "Half a thought" } });
    flush();
    // A page that goes away writes the pending change at once.
    window.dispatchEvent(new Event("pagehide"));
    expect(readStoredComposerDrafts(key).agents["host:chief"]?.text).toBe("A failed message\n\nHalf a thought");
    expect(readStoredComposerDrafts(accountComposerDraftsKey("account-b")).agents).toEqual({});

    storage.discard();
    expect(window.localStorage.getItem(key)).toBeNull();
    // Nothing writes after a sign-out.
    setDrafts({ "host:chief": { text: "Later" } });
    flush();
    window.dispatchEvent(new Event("pagehide"));
    expect(window.localStorage.getItem(key)).toBeNull();
  });
});
