// @vitest-environment node
import { randomUUID } from "node:crypto";
import type { AgentEvent, QueueDelivery } from "@openbot/contracts/ipc";
import { afterEach, assert, beforeEach, describe, expect, it } from "vitest";
import type { AgentService } from "./agent-service";
import {
  callOpenBotTool,
  createTestService,
  expectOpenBotToolFailure,
  type FakeAgentClient,
  firstInputText,
  notification,
  openBotToolPayload,
  startAgentTestFixture,
  startService,
  stopAgentTestFixture,
  waitFor,
  waitForQueue,
} from "./agent-service-test-harness";
import type { AgentStore } from "./agent-store";
import { AGENT_CREATION_LIMIT, AGENT_MESSAGE_LIMIT } from "./collaboration-limits";
import { runCauseEffect } from "./effect-boundary";
import type { MailboxStore } from "./mailbox-store";
import { getString } from "./protocol";

let root: string;
let service: AgentService | null = null;

beforeEach(async () => {
  ({ root } = await startAgentTestFixture());
});

afterEach(async () => {
  await stopAgentTestFixture(root, service);
  service = null;
});

interface Team {
  service: AgentService;
  client: FakeAgentClient;
  store: AgentStore;
  mailbox: MailboxStore;
  /** Gives the agent a running turn with a message from the person, and answers its ids. */
  begin(agentId: string, text?: string): Promise<{ threadId: string; turnId: string }>;
  /** The running turn of an agent that a message started. */
  running(agentId: string): Promise<{ threadId: string; turnId: string }>;
  /** Ends the running turn of an agent with an answer, or with a failure. */
  end(agentId: string, outcome: { text: string } | { failed: true } | { interrupted: true }): Promise<void>;
  /** The tool call of an agent, made in its running turn. */
  tool(agentId: string, name: string, args: unknown, callId?: string): ReturnType<typeof callOpenBotTool>;
  /** The deliveries an agent got from another agent. */
  from(agentId: string, senderId: string): QueueDelivery[];
}

async function team(agentIds: string[]): Promise<Team> {
  const started = await startService(root, { provider: "codex", autoComplete: false });
  service = started.service;
  const { client, store, mailbox } = started;
  await Promise.all(agentIds.map((id) => runCauseEffect(store.getOrCreate(id))));
  // A turn ends only after the lifecycle has seen it start; a completion that comes first is lost.
  const turnsStarted = new Set<string>();
  started.service.on("event", (event: AgentEvent) => {
    if (event.type === "turn-started") turnsStarted.add(event.turnId);
  });
  const running = async (agentId: string) => {
    await waitForQueue(started.service, agentId, (queue) =>
      queue.deliveries.some((delivery) => delivery.status === "running"),
    );
    const turnId = started.service
      .listQueue(agentId)
      .deliveries.find((delivery) => delivery.status === "running")?.turnId;
    const threadId = store.activeProviderSession(agentId)?.externalSessionId;
    assert(turnId && threadId);
    await waitFor(() => turnsStarted.has(turnId));
    return { threadId, turnId };
  };
  return {
    service: started.service,
    client,
    store,
    mailbox,
    running,
    async begin(agentId, text = "Start.") {
      await runCauseEffect(started.service.sendMessage({ agentId, text }));
      return running(agentId);
    },
    async end(agentId, outcome) {
      const { threadId, turnId } = await running(agentId);
      if ("text" in outcome) {
        client.emit(
          "notification",
          notification("item/completed", {
            threadId,
            turnId,
            item: { id: `${turnId}:answer`, type: "agentMessage", text: outcome.text },
          }),
        );
      }
      const status = "failed" in outcome ? "failed" : "interrupted" in outcome ? "interrupted" : "completed";
      client.emit("notification", notification("turn/completed", { threadId, turn: { id: turnId, status } }));
      await waitForQueue(started.service, agentId, (queue) =>
        queue.deliveries.every((delivery) => delivery.status !== "running" && delivery.status !== "starting"),
      );
    },
    async tool(agentId, name, args, callId = randomUUID()) {
      const { threadId, turnId } = await running(agentId);
      return callOpenBotTool(client, threadId, name, args, turnId, callId);
    },
    from(agentId, senderId) {
      return started.service
        .listQueue(agentId)
        .deliveries.filter((delivery) => delivery.sender.kind === "agent" && delivery.sender.agentId === senderId);
    },
  };
}

function receiptOf(result: unknown): { messageId: string } {
  const payload = openBotToolPayload(result);
  const messageId = getString(payload, "messageId");
  assert(messageId);
  return { messageId };
}

describe.sequential("AgentService: collaboration between agents", () => {
  describe("list_agents", () => {
    it("reports a failed turn and the number of approvals that wait, never the command", async () => {
      const t = await team(["chief", "worker"]);
      await t.begin("chief");
      await t.begin("worker");
      const { threadId, turnId } = await t.running("worker");
      t.client.emit("request", {
        method: "item/commandExecution/requestApproval",
        id: "approval-1",
        params: { threadId, turnId, command: ["curl", "-H", "Authorization: Bearer secret-token"], cwd: root },
      });
      await waitFor(() => t.service.getRuntimeSnapshot().pendingApprovals.length === 1);

      const waiting = await t.tool("chief", "list_agents", {});
      const text = JSON.stringify(openBotToolPayload(waiting.result));
      expect(text).not.toContain("secret-token");
      expect(openBotToolPayload(waiting.result).agents).toContainEqual(
        expect.objectContaining({ id: "worker", waitingForUser: { questions: 0, approvals: 1, browserTakeovers: 0 } }),
      );

      await t.end("worker", { failed: true });
      const failed = await t.tool("chief", "list_agents", {});
      const agents = openBotToolPayload(failed.result).agents;
      assert(Array.isArray(agents));
      expect(agents).toContainEqual(expect.objectContaining({ id: "worker", lastTurnFailed: true }));
      expect(agents.find((agent) => agent.id === "chief")).not.toHaveProperty("lastTurnFailed");
    });
  });

  describe("list_agents and channel work", () => {
    it("says that channel work holds the queued messages of an agent", async () => {
      const t = await team(["chief", "scout"]);
      // The scout asks, so it needs a session of its own. Its turn ends first: channel work starts
      // only when no direct message runs.
      const { threadId } = await t.begin("scout");
      await t.end("scout", { text: "Ready." });
      const actor = { id: "human", name: "Alex" };
      await runCauseEffect(
        t.service.channels.command(
          {
            type: "save",
            channelId: "channel-1",
            operationId: "create",
            draft: {
              name: "project",
              title: "Project launch",
              instructions: "Shared work",
              members: [{ agentId: "chief" }],
              leadAgentId: "chief",
            },
          },
          actor,
        ),
      );
      await runCauseEffect(
        t.service.channels.command(
          {
            type: "send",
            channelId: "channel-1",
            operationId: "send",
            text: "Work in the channel.",
            recipientAgentId: "chief",
            replyToMessageId: null,
            attachmentDraftIds: [],
          },
          actor,
        ),
      );
      await waitFor(() => t.service.channels.store.assignments("channel-1").some((item) => item.turnId));
      await runCauseEffect(t.service.sendMessage({ agentId: "chief", text: "Read the report" }));
      await waitForQueue(t.service, "chief", (queue) => queue.hold !== undefined);

      const listed = await callOpenBotTool(t.client, threadId, "list_agents", {});
      expect(openBotToolPayload(listed.result).agents).toContainEqual(
        expect.objectContaining({ id: "chief", queuedMessages: 1, heldBy: "channel" }),
      );
    });
  });

  describe("send_message guard", () => {
    it("returns the receipt of an identical message that still waits, and sends a different one", async () => {
      const t = await team(["chief", "worker", "helper"]);
      await t.begin("chief");
      await t.begin("worker");
      const first = await t.tool("chief", "send_message", { recipientAgentIds: ["worker"], text: "Draft it." });
      const again = await t.tool("chief", "send_message", { recipientAgentIds: ["worker"], text: "Draft it." });
      expect(receiptOf(again.result).messageId).toBe(receiptOf(first.result).messageId);
      expect(openBotToolPayload(again.result).duplicate).toBe(true);
      expect(t.from("worker", "chief")).toHaveLength(1);

      // Other words, another recipient, and an answer to the same words are not repeats.
      await t.tool("chief", "send_message", { recipientAgentIds: ["worker"], text: "Draft it now." });
      await t.tool("chief", "send_message", { recipientAgentIds: ["worker", "helper"], text: "Draft it." });
      expect(t.from("worker", "chief")).toHaveLength(3);
      expect(t.from("helper", "chief")).toHaveLength(1);
    });

    it("stops a pair after the limit, keeps other recipients open, and lets a retried call through", async () => {
      const t = await team(["chief", "worker", "helper"]);
      await t.begin("chief");
      const { turnId } = await t.running("chief");
      const lastCallId = `call-${AGENT_MESSAGE_LIMIT - 1}`;
      for (let index = 0; index < AGENT_MESSAGE_LIMIT; index += 1) {
        const sent = await t.tool(
          "chief",
          "send_message",
          { recipientAgentIds: ["worker"], text: `Step ${index}`, expectsReply: false },
          `call-${index}`,
        );
        expect(openBotToolPayload(sent.result).error).toBeUndefined();
      }
      const { threadId } = await t.running("chief");
      await expectOpenBotToolFailure(
        t.client,
        threadId,
        "send_message",
        { recipientAgentIds: ["worker"], text: "One more.", expectsReply: false },
        "Stop sending messages to this agent now, and ask the user how to continue.",
      );
      expect(t.from("worker", "chief")).toHaveLength(AGENT_MESSAGE_LIMIT);

      // A fan-out to a new pair is not a loop, and a retry of a call that worked is not a new message.
      const other = await t.tool("chief", "send_message", { recipientAgentIds: ["helper"], text: "Hello." });
      expect(openBotToolPayload(other.result).error).toBeUndefined();
      const retried = await callOpenBotTool(
        t.client,
        threadId,
        "send_message",
        { recipientAgentIds: ["worker"], text: `Step ${AGENT_MESSAGE_LIMIT - 1}`, expectsReply: false },
        turnId,
        lastCallId,
      );
      expect(openBotToolPayload(retried.result).error).toBeUndefined();
      expect(t.from("worker", "chief")).toHaveLength(AGENT_MESSAGE_LIMIT);
    });
  });

  describe("a delegation that ends with no answer", () => {
    async function delegate(t: Team) {
      await t.begin("chief");
      const sent = await t.tool("chief", "send_message", { recipientAgentIds: ["worker"], text: "Fix the bug." });
      await t.running("worker");
      return receiptOf(sent.result).messageId;
    }

    it("tells the requester once when the turn fails", async () => {
      const t = await team(["chief", "worker"]);
      const requestId = await delegate(t);
      await t.end("worker", { failed: true });

      const notes = t.from("chief", "worker");
      expect(notes).toHaveLength(1);
      expect(notes[0]).toMatchObject({ replyToMessageId: requestId, expectsReply: false });
      expect(notes[0]?.text).toContain("OpenBot note: the turn of Worker failed");
      expect(notes[0]?.text).toContain(requestId);
      // The note is an answer: it asks the requester for nothing, so no loop starts.
      expect(t.from("worker", "chief")).toHaveLength(1);
    });

    it("tells the requester when the turn is stopped, and not when the requester stopped it", async () => {
      const t = await team(["chief", "worker"]);
      const requestId = await delegate(t);
      await t.end("worker", { interrupted: true });
      expect(t.from("chief", "worker")[0]).toMatchObject({ replyToMessageId: requestId });
      expect(t.from("chief", "worker")[0]?.text).toContain("was stopped");
    });

    it("tells the requester when the turn wrote only a placeholder", async () => {
      const t = await team(["chief", "worker"]);
      const requestId = await delegate(t);
      await t.end("worker", { text: "∅" });
      const notes = t.from("chief", "worker");
      expect(notes).toHaveLength(1);
      expect(notes[0]).toMatchObject({ replyToMessageId: requestId });
      expect(notes[0]?.text).toContain("wrote no result");
    });

    it("tells the requester after a restart that ended the work, and not again after the next one", async () => {
      const t = await team(["chief", "worker"]);
      const requestId = await delegate(t);
      await runCauseEffect(t.service.stop());

      service = createTestService({ store: t.store, mailbox: t.mailbox });
      await runCauseEffect(service.initialize());
      await waitForQueue(service, "worker", (queue) => queue.deliveries[0]?.status === "interrupted");
      const notes = service
        .listQueue("chief")
        .deliveries.filter((delivery) => delivery.sender.kind === "agent" && delivery.sender.agentId === "worker");
      expect(notes).toHaveLength(1);
      expect(notes[0]).toMatchObject({ replyToMessageId: requestId, expectsReply: false });
      expect(notes[0]?.text).toContain("restarted while Worker worked on your request");

      await runCauseEffect(service.stop());
      service = createTestService({ store: t.store, mailbox: t.mailbox });
      await runCauseEffect(service.initialize());
      expect(
        service
          .listQueue("chief")
          .deliveries.filter((delivery) => delivery.sender.kind === "agent" && delivery.sender.agentId === "worker"),
      ).toHaveLength(1);
    });

    it("sends nothing for a message that wants no answer", async () => {
      const t = await team(["chief", "worker"]);
      await t.begin("chief");
      await t.tool("chief", "send_message", { recipientAgentIds: ["worker"], text: "FYI.", expectsReply: false });
      await t.running("worker");
      await t.end("worker", { failed: true });
      expect(t.from("chief", "worker")).toEqual([]);
    });

    it("does not tell a requester that stopped the turn through interrupt_agent", async () => {
      const t = await team(["chief", "worker"]);
      await delegate(t);
      const stopped = await t.tool("chief", "interrupt_agent", { agentId: "worker", reason: "Plan changed." });
      expect(openBotToolPayload(stopped.result).interruptedTurnId).toEqual(expect.any(String));
      await t.end("worker", { interrupted: true });
      expect(t.from("chief", "worker")).toEqual([]);
    });
  });

  describe("a result that waits for the teammates of the agent", () => {
    it("relays the result of a single hop at once", async () => {
      const t = await team(["chief", "worker"]);
      await t.begin("chief");
      const sent = await t.tool("chief", "send_message", { recipientAgentIds: ["worker"], text: "Fix the bug." });
      await t.running("worker");
      await t.end("worker", { text: "Fixed in one commit." });
      expect(t.from("chief", "worker")).toMatchObject([
        { text: "Fixed in one commit.", replyToMessageId: receiptOf(sent.result).messageId, expectsReply: false },
      ]);
    });

    it("keeps the interim text back, and relays the final summary when the wave of the agent is done", async () => {
      const t = await team(["chief", "worker", "helper"]);
      await t.begin("chief");
      const request = await t.tool("chief", "send_message", { recipientAgentIds: ["worker"], text: "Ship it." });
      const requestId = receiptOf(request.result).messageId;
      await t.running("worker");
      await t.tool("worker", "send_message", { recipientAgentIds: ["helper"], text: "Run the tests." });
      await t.running("helper");

      // The interim text of the first turn is not the result.
      await t.end("worker", { text: "I asked Helper to run the tests." });
      expect(t.from("chief", "worker")).toEqual([]);

      // The answer of Helper starts a second turn of the worker, which writes the real summary.
      await t.end("helper", { text: "All tests pass." });
      await waitForQueue(t.service, "worker", (queue) =>
        queue.deliveries.some(
          (delivery) =>
            delivery.sender.kind === "agent" && delivery.sender.agentId === "helper" && delivery.status === "running",
        ),
      );
      expect(t.from("chief", "worker")).toEqual([]);
      await t.end("worker", { text: "Shipped: the tests pass." });

      expect(t.from("chief", "worker")).toMatchObject([
        { text: "Shipped: the tests pass.", replyToMessageId: requestId, expectsReply: false },
      ]);
    });

    it("tells the requester when the agent fails while it handles the answers of its teammates", async () => {
      const t = await team(["chief", "worker", "helper"]);
      await t.begin("chief");
      const request = await t.tool("chief", "send_message", { recipientAgentIds: ["worker"], text: "Ship it." });
      await t.running("worker");
      await t.tool("worker", "send_message", { recipientAgentIds: ["helper"], text: "Run the tests." });
      await t.running("helper");
      await t.end("worker", { text: "I asked Helper." });
      await t.end("helper", { text: "All tests pass." });
      await waitForQueue(t.service, "worker", (queue) =>
        queue.deliveries.some(
          (delivery) =>
            delivery.sender.kind === "agent" && delivery.sender.agentId === "helper" && delivery.status === "running",
        ),
      );
      await t.end("worker", { failed: true });

      const notes = t.from("chief", "worker");
      expect(notes).toHaveLength(1);
      expect(notes[0]).toMatchObject({ replyToMessageId: receiptOf(request.result).messageId });
      expect(notes[0]?.text).toContain("failed while it handled the answers of its own teammates");
    });

    it("sends the last text with a note when the request of the agent is cancelled and no turn comes", async () => {
      const t = await team(["chief", "worker", "helper"]);
      await t.begin("chief");
      // Helper is busy, so the request of the worker waits in its queue.
      await t.begin("helper");
      const request = await t.tool("chief", "send_message", { recipientAgentIds: ["worker"], text: "Ship it." });
      await t.running("worker");
      await t.tool("worker", "send_message", { recipientAgentIds: ["helper"], text: "Run the tests." });
      await t.end("worker", { text: "I asked Helper." });
      expect(t.from("chief", "worker")).toEqual([]);

      const queued = t.from("helper", "worker")[0];
      assert(queued);
      await runCauseEffect(t.service.cancelQueuedMessage("helper", queued.id));
      const [note] = t.from("chief", "worker");
      expect(note).toMatchObject({ replyToMessageId: receiptOf(request.result).messageId });
      expect(note?.text).toContain("sent no final result");
      expect(note?.text).toContain("I asked Helper.");
    });
  });

  describe("create_agent", () => {
    it("sends the first task as a request from the creator, and relays the result back", async () => {
      const t = await team(["chief"]);
      await t.begin("chief");
      const created = await t.tool("chief", "create_agent", {
        name: "Researcher",
        description: "Finds primary sources.",
        initialMessage: "Find three sources about trains.",
      });
      const agentId = getString(openBotToolPayload(created.result), "id");
      assert(agentId);
      expect(t.store.creatorOf(agentId)).toBe("chief");

      const [first] = t.service.listQueue(agentId).deliveries;
      expect(first).toMatchObject({
        sender: { kind: "agent", agentId: "chief" },
        text: "Find three sources about trains.",
      });
      expect(first?.expectsReply).toBeUndefined();
      const { threadId } = await t.running(agentId);
      const start = t.client.requests.findLast(
        (request) => request.method === "turn/start" && getString(request.params, "threadId") === threadId,
      );
      expect(firstInputText(start?.params)).toContain("Chief created you, and this is your first task from Chief.");

      await t.end(agentId, { text: "Three sources: A, B, C." });
      expect(t.from("chief", agentId)).toMatchObject([{ text: "Three sources: A, B, C.", expectsReply: false }]);
    });

    it("refuses another agent after the limit, and counts only agents that agents created", async () => {
      const t = await team(["chief"]);
      await t.begin("chief");
      for (let index = 0; index < AGENT_CREATION_LIMIT; index += 1) {
        const id = `made-${index}`;
        await runCauseEffect(t.store.getOrCreate(id));
        t.store.recordCreator(id, "chief");
      }
      const { threadId } = await t.running("chief");
      await expectOpenBotToolFailure(
        t.client,
        threadId,
        "create_agent",
        { name: "One too many", description: "Never made.", initialMessage: "Hello." },
        "Do not create another agent. Ask the user how to continue.",
      );
      expect(t.service.listAgents().some((agent) => agent.name === "One too many")).toBe(false);
    });
  });
});
