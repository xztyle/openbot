// @vitest-environment node
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ContextCompaction,
  type ContextCompactionOptions,
  IDLE_HANDOFF_AFTER_MS,
  IDLE_HANDOFF_MIN_TOKENS,
  IDLE_PRECOMPACT_AFTER_MS,
  IDLE_PRECOMPACT_INSTRUCTIONS,
  IDLE_PRECOMPACT_MIN_TOKENS,
  idlePrecompactEnabled,
} from "./context-compaction";

let directory = "";

function compaction(options: { busy?: () => boolean; path?: string | null } = {}) {
  const agent = { id: "agent-1", threadId: "public-1", provider: "claude" };
  const request = vi.fn((_method: string, _params: unknown) => Effect.succeed({ turn: { id: "compact-turn" } }));
  const client = { contextCompaction: "native", request };
  const scheduleDrain = vi.fn();
  const settings = {
    store: { list: () => [agent], database: { activeProviderSessions: () => new Map() } },
    providers: { clientForAgent: () => client, isReady: () => true },
    emitError: vi.fn(),
    scheduleDrain,
    rotateSession: vi.fn(() => Effect.succeed<string | null>("session-2")),
    rotatesSession: () => true,
    agentBusy: options.busy ?? (() => false),
    idlePrecompactPath: options.path === undefined ? join(directory, "idle-precompact.json") : options.path,
    idlePrecompact: true,
  };
  // biome-ignore lint/nursery/noUnsafeTypeAssertion: a stub of the members that the idle pre-compaction reads.
  const subject = new ContextCompaction(settings as unknown as ContextCompactionOptions);
  return { subject, request, scheduleDrain };
}

/** Lets the forked compaction request run. */
async function settle(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0);
}

function compactCalls(request: ReturnType<typeof compaction>["request"]) {
  return request.mock.calls.filter(([method]) => method === "thread/compact/start");
}

// Failure mode: an idle Claude agent woke after the hour-long prompt cache expired, and its first
// request wrote a 200k-token session to the cache again.
describe("idle pre-compaction", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    directory = mkdtempSync(join(tmpdir(), "idle-precompact-"));
  });
  afterEach(() => {
    vi.useRealTimers();
    rmSync(directory, { recursive: true, force: true });
  });

  it("compacts a large idle session once at 55 minutes, with instructions that keep the latest turns", async () => {
    const { subject, request } = compaction();
    subject.observeUsage("session-1", IDLE_PRECOMPACT_MIN_TOKENS + 5_000, 1_000_000, true, null);
    subject.agentTurnEnded("agent-1", "session-1");

    await vi.advanceTimersByTimeAsync(IDLE_PRECOMPACT_AFTER_MS - 1_000);
    expect(compactCalls(request)).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1_000);
    await settle();

    expect(compactCalls(request)).toEqual([
      [
        "thread/compact/start",
        { threadId: "session-1", instructions: IDLE_PRECOMPACT_INSTRUCTIONS },
        expect.anything(),
        undefined,
      ],
    ]);
    expect(subject.mayDrain("agent-1")).toBe(false);
    expect(subject.claimTurn("agent-1", "session-1", "compact-turn")).toBe(true);
    expect(subject.isCompactionTurn("session-1", "compact-turn")).toBe(true);
    subject.finish("agent-1", "session-1", "completed");
    expect(subject.mayDrain("agent-1")).toBe(true);
    expect(subject.precompactedSinceLastTurn("session-1")).toBe(true);

    // Only a new turn lets it compact again.
    await vi.advanceTimersByTimeAsync(IDLE_PRECOMPACT_AFTER_MS * 2);
    expect(compactCalls(request)).toHaveLength(1);
  });

  it("skips a session under 100k tokens", async () => {
    const { subject, request } = compaction();
    subject.observeUsage("session-1", IDLE_PRECOMPACT_MIN_TOKENS - 1, 1_000_000, true, null);
    subject.agentTurnEnded("agent-1", "session-1");
    await vi.advanceTimersByTimeAsync(IDLE_PRECOMPACT_AFTER_MS);
    await settle();
    expect(compactCalls(request)).toHaveLength(0);
  });

  it("skips a session whose agent started another turn or has work waiting", async () => {
    const started = compaction();
    started.subject.observeUsage("session-1", IDLE_PRECOMPACT_MIN_TOKENS + 1, 1_000_000, true, null);
    started.subject.agentTurnEnded("agent-1", "session-1");
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    started.subject.beginTurn("session-1");
    await vi.advanceTimersByTimeAsync(IDLE_PRECOMPACT_AFTER_MS);
    await settle();
    expect(compactCalls(started.request)).toHaveLength(0);

    const busy = compaction({ busy: () => true, path: null });
    busy.subject.observeUsage("session-1", IDLE_PRECOMPACT_MIN_TOKENS + 1, 1_000_000, true, null);
    busy.subject.agentTurnEnded("agent-1", "session-1");
    await vi.advanceTimersByTimeAsync(IDLE_PRECOMPACT_AFTER_MS);
    await settle();
    expect(compactCalls(busy.request)).toHaveLength(0);
  });

  it("wakes a pre-compacted session without the idle handoff, and a new turn clears the mark", async () => {
    const { subject } = compaction();
    subject.observeUsage("session-1", IDLE_HANDOFF_MIN_TOKENS + 1, 1_000_000, true, null);
    subject.agentTurnEnded("agent-1", "session-1");
    await vi.advanceTimersByTimeAsync(IDLE_PRECOMPACT_AFTER_MS);
    await settle();
    subject.claimTurn("agent-1", "session-1", "compact-turn");
    subject.finish("agent-1", "session-1", "completed");

    expect(subject.reserveIdleHandoff("agent-1", "session-1", Date.now() + IDLE_HANDOFF_AFTER_MS)).toBe(false);
    subject.beginTurn("session-1");
    expect(subject.precompactedSinceLastTurn("session-1")).toBe(false);
  });

  it("keeps the turn end and the mark across a restart", async () => {
    const first = compaction();
    first.subject.observeUsage("session-1", IDLE_PRECOMPACT_MIN_TOKENS + 1, 1_000_000, true, null);
    first.subject.agentTurnEnded("agent-1", "session-1");
    first.subject.dispose();
    const stored = JSON.parse(readFileSync(join(directory, "idle-precompact.json"), "utf8"));
    expect(stored.threads["session-1"]).toMatchObject({ agentId: "agent-1", precompacted: false });

    // A restart 20 minutes later still compacts at the 55-minute point, from the stored size.
    await vi.advanceTimersByTimeAsync(20 * 60_000);
    const second = compaction();
    await vi.advanceTimersByTimeAsync(IDLE_PRECOMPACT_AFTER_MS - 20 * 60_000);
    await settle();
    expect(compactCalls(second.request)).toHaveLength(1);
    second.subject.claimTurn("agent-1", "session-1", "compact-turn");
    second.subject.finish("agent-1", "session-1", "completed");
    second.subject.dispose();

    // The mark survives the next restart: no second compaction, and no handoff at the wake.
    const third = compaction();
    expect(third.subject.precompactedSinceLastTurn("session-1")).toBe(true);
    await vi.advanceTimersByTimeAsync(IDLE_PRECOMPACT_AFTER_MS);
    expect(compactCalls(third.request)).toHaveLength(0);
  });

  it("forgets a thread whose prompt cache expired before the restart", async () => {
    const first = compaction();
    first.subject.observeUsage("session-1", IDLE_PRECOMPACT_MIN_TOKENS + 1, 1_000_000, true, null);
    first.subject.agentTurnEnded("agent-1", "session-1");
    first.subject.dispose();
    await vi.advanceTimersByTimeAsync(IDLE_HANDOFF_AFTER_MS + 1_000);

    const second = compaction();
    await vi.advanceTimersByTimeAsync(IDLE_PRECOMPACT_AFTER_MS);
    expect(compactCalls(second.request)).toHaveLength(0);
    expect(JSON.parse(readFileSync(join(directory, "idle-precompact.json"), "utf8")).threads).toEqual({});
  });

  it("turns off with OPENBOT_IDLE_PRECOMPACT=off", () => {
    expect(idlePrecompactEnabled({ OPENBOT_IDLE_PRECOMPACT: "off" })).toBe(false);
    expect(idlePrecompactEnabled({})).toBe(true);
  });
});
