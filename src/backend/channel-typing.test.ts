// @vitest-environment node
import type { ChannelTypingEntry } from "@openbot/contracts/ipc";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type ChannelAgentWork, ChannelTyping } from "./channel-typing";

// Failure mode: after a person's message, the channel showed nobody while the lead chose who
// answers, an agent whose turn waited for earlier work showed as working, and a client that
// reconnected kept the list it had, because the host sends a list only when it changes.
function typing(work: () => { agents: readonly ChannelAgentWork[]; recheckInMs?: number }) {
  const sent: { channelId: string; typing: ChannelTypingEntry[] }[] = [];
  const model = new ChannelTyping({ emit: (channelId, list) => sent.push({ channelId, typing: list }), working: work });
  return { model, sent };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("Channel typing list", () => {
  it("shows the lead that routes, and an agent once in a place, at its latest step", () => {
    const { model } = typing(() => ({
      agents: [
        { agentId: "lead", threadRootId: "root", state: "routing" },
        { agentId: "qa", threadRootId: null, state: "waiting" },
        { agentId: "qa", threadRootId: null, state: "working" },
      ],
    }));
    expect(model.list("c1")).toEqual([
      { kind: "agent", id: "qa", state: "working" },
      { kind: "agent", id: "lead", state: "routing", threadRootId: "root" },
    ]);
  });

  it("does not show a working agent as thinking for a gate", () => {
    const { model } = typing(() => ({ agents: [{ agentId: "qa", threadRootId: null, state: "waiting" }] }));
    model.gateStarted("c1", "m1", ["qa", "dev"]);
    expect(model.list("c1")).toEqual([
      { kind: "agent", id: "qa", state: "waiting" },
      { kind: "agent", id: "dev", state: "thinking" },
    ]);
  });

  it("reads the list again when the work asks, and sends it when it changed", () => {
    vi.useFakeTimers();
    let state: ChannelAgentWork["state"] = "working";
    const { model, sent } = typing(() =>
      state === "working"
        ? { agents: [{ agentId: "qa", threadRootId: null, state }], recheckInMs: 2_000 }
        : { agents: [{ agentId: "qa", threadRootId: null, state }] },
    );
    model.changed("c1");
    expect(sent.at(-1)?.typing).toEqual([{ kind: "agent", id: "qa", state: "working" }]);
    state = "waiting";
    vi.advanceTimersByTime(2_000);
    expect(sent.at(-1)?.typing).toEqual([{ kind: "agent", id: "qa", state: "waiting" }]);
    expect(sent).toHaveLength(2);
    model.dispose();
  });

  it("gives the lists that are not empty, for a client that connects", () => {
    let agents: ChannelAgentWork[] = [{ agentId: "qa", threadRootId: null, state: "working" }];
    const { model } = typing(() => ({ agents }));
    model.changed("c1");
    model.changed("c2");
    expect(model.active().map((list) => list.channelId)).toEqual(["c1", "c2"]);
    agents = [];
    model.changed("c1");
    expect(model.active()).toEqual([{ channelId: "c2", typing: [{ kind: "agent", id: "qa", state: "working" }] }]);
  });
});
