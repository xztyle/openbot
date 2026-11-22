// @vitest-environment node

import type { AgentEvent } from "@openbot/contracts/ipc";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import type { AgentClient } from "../agent-client";
import type { ProviderClientOperationError } from "../provider-client-effects";
import { AttentionRegistry } from "./attention-registry";

const TOKEN = `ghp_${"Q7w8E9r0T1".repeat(4)}`;

class RecordingClient implements AgentClient {
  readonly provider = "codex";
  readonly running = true;
  readonly answers: unknown[] = [];
  start(): void {}
  stop() {
    return Effect.void;
  }
  request<T>(): Effect.Effect<T, ProviderClientOperationError> {
    return Effect.die(new Error("No provider request in this test."));
  }
  notify(): void {}
  respond(_id: unknown, result: unknown): void {
    this.answers.push(result);
  }
  respondError(): void {}
  on(): this {
    return this;
  }
  once(): this {
    return this;
  }
  off(): this {
    return this;
  }
}

// Failure mode: a command approval card showed the command as the provider sent it, so a token in a
// `curl -H "Authorization: …"` reached every screen that shows the card, the fleet line and the
// briefing.
describe("approval card text", () => {
  it("hides a token in the command and the reason that the card shows", () => {
    const events: AgentEvent[] = [];
    const registry = new AttentionRegistry({
      conversation: {
        agentForThread: () => "agent-1",
        publicThreadId: () => "thread-1",
        emitConversation: () => undefined,
        ensureSnapshot: () => {
          throw new Error("No conversation in this test.");
        },
      },
      browser: {
        prepareSecret: () => Effect.die(new Error("No browser in this test.")),
        listTabs: () => [],
        beginTakeover: () => Effect.void,
        endTakeover: () => undefined,
      },
      hostedSites: { prepareApproval: () => Effect.succeed(null), resolveApproval: () => Effect.void },
      routines: { markNeedsAttention: () => undefined, markRunningForTurn: () => undefined },
      emit: (event) => events.push(event),
      emitError: () => undefined,
      emitRuntimeSnapshot: () => undefined,
    });
    const command = `curl -H "Authorization: token ${TOKEN}" https://api.github.com/user`;
    registry.surfaceApproval(
      new RecordingClient(),
      {
        method: "item/commandExecution/requestApproval",
        id: "approval-1",
        params: { threadId: "provider-thread", turnId: "turn-1", command, reason: `push with ${TOKEN}` },
      },
      "command",
    );

    const approval = events.find((event) => event.type === "approval");
    expect(approval?.type === "approval" && approval.approval.command).toContain("https://api.github.com/user");
    expect(JSON.stringify(events)).not.toContain(TOKEN);
    expect(registry.waitingAgents().get("agent-1")?.what).not.toContain(TOKEN);
  });
});
