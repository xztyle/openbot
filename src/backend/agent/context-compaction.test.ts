// @vitest-environment node
import { Effect } from "effect";
import { describe, expect, it, vi } from "vitest";
import {
  ContextCompaction,
  type ContextCompactionOptions,
  IDLE_HANDOFF_AFTER_MS,
  IDLE_HANDOFF_MIN_TOKENS,
} from "./context-compaction";

function compaction(mode: "native" | "events", rotates = true) {
  const agent = { id: "agent-1", threadId: "public-1", provider: "claude" };
  const rotateSession = vi.fn(() => Effect.succeed<string | null>("session-2"));
  const scheduleDrain = vi.fn();
  const options = {
    store: { list: () => [agent], database: { activeProviderSessions: () => new Map() } },
    providers: { clientForAgent: () => ({ contextCompaction: mode }), isReady: () => true },
    emitError: vi.fn(),
    scheduleDrain,
    rotateSession,
    rotatesSession: () => rotates,
  };
  // biome-ignore lint/nursery/noUnsafeTypeAssertion: a stub of the members that the idle handoff reads.
  const subject = new ContextCompaction(options as unknown as ContextCompactionOptions);
  return { subject, rotateSession, scheduleDrain };
}

// Failure mode: an agent idle for hours woke on a 228k-token session, and its first request wrote
// the whole session to the prompt cache again.
describe("idle handoff", () => {
  const later = () => Date.now() + IDLE_HANDOFF_AFTER_MS + 1_000;

  it("hands off a large Claude session whose cache expired, then lets the queue drain", async () => {
    const { subject, rotateSession, scheduleDrain } = compaction("native");
    subject.observeUsage("session-1", IDLE_HANDOFF_MIN_TOKENS + 1, 1_000_000, true, null);

    expect(subject.reserveIdleHandoff("agent-1", "session-1", later())).toBe(true);
    expect(subject.mayDrain("agent-1")).toBe(false);
    await Effect.runPromise(subject.request("agent-1", "session-1"));

    expect(rotateSession).toHaveBeenCalledOnce();
    expect(subject.mayDrain("agent-1")).toBe(true);
    expect(scheduleDrain).toHaveBeenCalledWith("agent-1");
  });

  it("keeps a session whose cache is still warm, a small one, and one that never reported", () => {
    const warm = compaction("native");
    warm.subject.observeUsage("session-1", IDLE_HANDOFF_MIN_TOKENS + 1, 1_000_000, true, null);
    expect(warm.subject.reserveIdleHandoff("agent-1", "session-1", Date.now() + 60_000)).toBe(false);

    const small = compaction("native");
    small.subject.observeUsage("session-1", IDLE_HANDOFF_MIN_TOKENS - 1, 1_000_000, true, null);
    expect(small.subject.reserveIdleHandoff("agent-1", "session-1", later())).toBe(false);

    expect(compaction("native").subject.reserveIdleHandoff("agent-1", "session-1", later())).toBe(false);
  });

  it("leaves providers that compact on request, and threads that cannot rotate, to their own rules", () => {
    const codex = compaction("events");
    codex.subject.observeUsage("session-1", IDLE_HANDOFF_MIN_TOKENS + 1, 1_000_000, false, 0.8);
    expect(codex.subject.reserveIdleHandoff("agent-1", "session-1", later())).toBe(false);

    const fixed = compaction("native", false);
    fixed.subject.observeUsage("session-1", IDLE_HANDOFF_MIN_TOKENS + 1, 1_000_000, true, null);
    expect(fixed.subject.reserveIdleHandoff("agent-1", "session-1", later())).toBe(false);
  });
});
