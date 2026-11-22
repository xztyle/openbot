// @vitest-environment node
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AGENT_WAKE_COALESCE_MS } from "./collaboration-limits";
import { MailboxStore } from "./mailbox-store";

const roots: string[] = [];
afterEach(() => {
  vi.useRealTimers();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function mailbox() {
  const root = mkdtempSync(join(tmpdir(), "openbot-coalesce-"));
  roots.push(root);
  const store = new MailboxStore(join(root, "data"), join(root, "shared"));
  await Effect.runPromise(store.initialize());
  return store;
}

const fromAgent = (agentId: string, text: string) => ({
  sender: { kind: "agent" as const, agentId },
  recipientAgentIds: ["agent-b"],
  text,
});

// Failure mode: each teammate message woke a large idle agent on its own, so three status lines in a
// minute cost three cold turns.
describe("teammate wake coalescing", () => {
  it("holds a burst of teammate messages, then starts them in one turn", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-21T10:00:00.000Z"));
    const store = await mailbox();
    await Effect.runPromise(store.enqueue(fromAgent("agent-a", "Build passed.")));
    vi.setSystemTime(new Date("2026-11-21T10:00:30.000Z"));
    await Effect.runPromise(store.enqueue(fromAgent("agent-c", "Tests are green too.")));

    expect(store.nextQueued("agent-b")).toBeNull();
    expect(store.heldReplyReleaseTimes().get("agent-b")).toBe(
      Date.parse("2026-11-21T10:00:00.000Z") + AGENT_WAKE_COALESCE_MS,
    );

    vi.setSystemTime(new Date(Date.parse("2026-11-21T10:00:00.000Z") + AGENT_WAKE_COALESCE_MS));
    const next = store.nextQueued("agent-b");
    expect(next?.delivery.text).toBe("Build passed.");
    expect(store.notesToStartWith(next?.delivery.id ?? "").map((item) => item.delivery.text)).toEqual([
      "Tests are green too.",
    ]);
  });

  it("starts a message from a person at once, with the teammate messages that wait", async () => {
    const store = await mailbox();
    await Effect.runPromise(store.enqueue(fromAgent("agent-a", "Build passed.")));
    await Effect.runPromise(
      store.enqueue({ sender: { kind: "user" }, recipientAgentIds: ["agent-b"], text: "Ship it?" }),
    );

    const next = store.nextQueued("agent-b");
    expect(next?.delivery.text).toBe("Ship it?");
    expect(store.notesToStartWith(next?.delivery.id ?? "").map((item) => item.delivery.text)).toEqual([
      "Build passed.",
    ]);
  });
});
