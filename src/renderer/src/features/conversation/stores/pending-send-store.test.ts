import { describe, expect, it } from "vitest";
import { EMPTY_DRAFT } from "../composer-draft";
import { createPendingSendStore } from "./pending-send-store";

const target = { agentId: "agent-1", serverId: "local" };
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("pending send store", () => {
  it("marks a send that waits behind a failed send, until the failed one is dismissed", async () => {
    const store = createPendingSendStore();
    store.add(target, { draft: EMPTY_DRAFT, text: "first", retrySafe: true }, () =>
      Promise.reject(new Error("offline")),
    );
    await flush();
    let release: (value: { messageId: string }) => void = () => {};
    store.add(
      target,
      { draft: EMPTY_DRAFT, text: "second", retrySafe: true },
      () => new Promise((resolve) => (release = resolve)),
    );
    const [first, second] = store.list(target);
    expect(first?.state).toBe("failed");
    expect(first?.waitingBehindFailure).toBe(false);
    expect(second?.state).toBe("waiting");
    expect(second?.waitingBehindFailure).toBe(true);

    if (first) store.remove(target, first.clientMessageId);
    const [next] = store.list(target);
    expect(next?.state).toBe("sending");
    expect(next?.waitingBehindFailure).toBe(false);
    release({ messageId: "m-2" });
  });
});
