import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ComposerDraft } from "../conversation-types";
import { BUSY_SEND_HOLD_MS, createPendingSendStore } from "./pending-send-store";

const target = { agentId: "chief", serverId: "local" };
const draft: ComposerDraft = { text: "stop and use the other branch", attachments: [], replyToMessageId: null };
const input = { draft, text: draft.text, retrySafe: true };

describe("pending sends held for a working agent", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("keeps the message with the client until the hold ends, then sends it", async () => {
    const store = createPendingSendStore();
    const deliver = vi.fn().mockResolvedValue({ messageId: "m1" });
    store.add(target, input, deliver, BUSY_SEND_HOLD_MS);
    expect(store.list(target)[0]?.state).toBe("held");
    expect(store.unsentTexts()).toEqual({ chief: [draft.text] });
    await vi.advanceTimersByTimeAsync(BUSY_SEND_HOLD_MS - 1);
    expect(deliver).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(deliver).toHaveBeenCalledTimes(1);
  });

  it("never sends a message that was taken back, and returns its draft for Edit", async () => {
    const store = createPendingSendStore();
    const deliver = vi.fn().mockResolvedValue({ messageId: "m1" });
    store.add(target, input, deliver, BUSY_SEND_HOLD_MS);
    const id = store.list(target)[0]?.clientMessageId ?? "";
    expect(store.remove(target, id)?.draft).toEqual(draft);
    await vi.advanceTimersByTimeAsync(BUSY_SEND_HOLD_MS * 2);
    expect(deliver).not.toHaveBeenCalled();
    expect(store.list(target)).toEqual([]);
  });

  it("keeps the order of the chat: a later send waits behind a held one", async () => {
    const store = createPendingSendStore();
    const sent: string[] = [];
    const deliverer = (name: string) => async () => {
      sent.push(name);
      return { messageId: name };
    };
    store.add(target, input, deliverer("first"), BUSY_SEND_HOLD_MS);
    store.add(target, input, deliverer("second"));
    await vi.advanceTimersByTimeAsync(BUSY_SEND_HOLD_MS - 1);
    expect(sent).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(sent).toEqual(["first", "second"]);
  });
});
