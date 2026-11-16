// @vitest-environment node
import { Effect } from "effect";
import { describe, expect, it, vi } from "vitest";
import { BootRecovery, type BootRecoveryOptions } from "./boot-recovery";

// Failure mode: readiness after a provider restart imports the transcript of a turn that still runs.
// The turn shows its messages live, so the import stored a second copy of them under the
// transcript's IDs.
describe("provider history backfill", () => {
  it("reads no history of a thread whose turn still runs", async () => {
    const agents = [
      { id: "agent-busy", threadId: "thread-busy", provider: "claude" },
      { id: "agent-idle", threadId: "thread-idle", provider: "claude" },
    ];
    const listProviderSessions = vi.fn((_threadId: string) => []);
    const store = {
      list: () => agents,
      database: {
        readActiveTurnId: (agentId: string) => (agentId === "agent-busy" ? "turn-live" : null),
        activeProviderSession: () => null,
        listProviderSessions,
      },
    };
    // biome-ignore lint/nursery/noUnsafeTypeAssertion: a stub of the two members that the backfill reads before any session.
    const options = { store, hooks: {} } as unknown as BootRecoveryOptions;
    const recovery = new BootRecovery(options);

    await Effect.runPromise(recovery.backfillProviderHistory());

    expect(listProviderSessions.mock.calls.map(([threadId]) => threadId)).toEqual(["thread-idle"]);
  });
});
