import { afterEach, describe, expect, it } from "vitest";
import { createWorkspaceOutbox, type OutboxMessage, readOutbox } from "./workspace-outbox";

// Failure mode: a message sent while the phone was between cells is lost, goes twice, goes out of
// order, or a reload forgets it.
const input = (key: string, text: string) => ({
  key,
  channelId: key,
  threadRootId: null,
  text,
  attachmentDraftIds: [],
  alsoToChannel: false,
});

function setup(options: { ready: boolean; fail?: (message: OutboxMessage) => boolean }) {
  let ready = options.ready;
  const delivered: OutboxMessage[] = [];
  const outbox = createWorkspaceOutbox({
    storageKey: () => "reader:host",
    ready: () => ready,
    deliver: async (message) => {
      if (options.fail?.(message)) throw new Error("refused");
      delivered.push(message);
    },
    describe: (error) => (error instanceof Error ? error.message : "failed"),
  });
  return {
    outbox,
    delivered,
    setReady(value: boolean) {
      ready = value;
    },
  };
}

afterEach(() => window.localStorage.clear());

describe("workspace outbox", () => {
  it("keeps messages while offline and sends them once, in order, when the connection is back", async () => {
    const { outbox, delivered, setReady } = setup({ ready: false });
    const first = outbox.add(input("general", "one"));
    outbox.add(input("general", "two"));
    await outbox.flush();
    expect(delivered).toEqual([]);
    expect(readOutbox("reader:host").map((message) => message.text)).toEqual(["one", "two"]);

    setReady(true);
    outbox.connected();
    outbox.connected();
    await outbox.flush();
    await new Promise((done) => setTimeout(done, 0));
    expect(delivered.map((message) => message.text)).toEqual(["one", "two"]);
    expect(delivered[0]?.id).toBe(first.id);
    expect(readOutbox("reader:host")).toEqual([]);
  });

  it("survives a reload: a stored message goes with the same operation id", async () => {
    const before = setup({ ready: false });
    const sent = before.outbox.add(input("general", "kept"));
    before.outbox.dispose();
    const after = setup({ ready: true });
    await after.outbox.flush();
    expect(after.delivered.map((message) => message.id)).toEqual([sent.id]);
  });

  it("holds the rest of a conversation behind a refused message until Retry, and others go on", async () => {
    let refuse = true;
    const { outbox, delivered } = setup({ ready: true, fail: (message) => refuse && message.text === "bad" });
    const bad = outbox.add(input("general", "bad"));
    outbox.add(input("general", "after"));
    outbox.add(input("random", "elsewhere"));
    await new Promise((done) => setTimeout(done, 0));
    await outbox.flush();
    expect(delivered.map((message) => message.text)).toEqual(["elsewhere"]);
    expect(outbox.of("general").map((message) => message.state)).toEqual(["failed", "waiting"]);
    expect(outbox.of("general")[0]?.error).toBe("refused");

    refuse = false;
    outbox.retry(bad.id);
    await new Promise((done) => setTimeout(done, 0));
    await outbox.flush();
    expect(delivered.map((message) => message.text)).toEqual(["elsewhere", "bad", "after"]);
  });

  it("waits again when the send failed because the connection went", async () => {
    const harness = setup({ ready: true, fail: () => true });
    harness.outbox.add(input("general", "lost"));
    harness.setReady(false);
    await new Promise((done) => setTimeout(done, 0));
    expect(harness.outbox.of("general").map((message) => message.state)).toEqual(["waiting"]);
  });
});
