import type { AgentMessage } from "@openbot/ui/data";
import { describe, expect, it } from "vitest";
import { agentMessageThread } from "./agent-message-thread";

const agents = [
  { id: "orchestrator", name: "Orchestrator" },
  { id: "frontend", name: "Frontend" },
];

function exchange(
  id: string,
  mailboxId: string,
  sender: string,
  recipients: string[],
  createdAt: string,
  replyTo: string | null = null,
): AgentMessage {
  return {
    id,
    author: "agent",
    body: `text of ${mailboxId}`,
    time: "10:00",
    createdAt,
    exchange: {
      direction: "outgoing",
      messageId: mailboxId,
      senderAgentId: sender,
      recipientAgentIds: recipients,
      replyToMessageId: replyTo,
      deliveries: [],
    },
  };
}

describe("agentMessageThread", () => {
  const request = exchange("outbox-m1", "m1", "orchestrator", ["frontend"], "2026-01-01T10:00:00Z");
  const reply = exchange("d2", "m2", "frontend", ["orchestrator"], "2026-01-01T10:05:00Z", "m1");
  const other = exchange("outbox-m3", "m3", "orchestrator", ["frontend"], "2026-01-01T10:06:00Z");
  const chat = [request, other, reply];

  it("shows the request together with its reply, oldest first", () => {
    const entries = agentMessageThread(chat, "m1", agents);
    expect(entries.map((entry) => entry.message.body)).toEqual(["text of m1", "text of m2"]);
    expect(entries[1]).toMatchObject({ senderName: "Frontend", recipientNames: ["Orchestrator"] });
  });

  it("shows a reply together with the request it answers", () => {
    expect(agentMessageThread(chat, "m2", agents).map((entry) => entry.message.body)).toEqual([
      "text of m1",
      "text of m2",
    ]);
  });

  it("shows a message alone when nothing answers it, and names a deleted agent as unknown", () => {
    const entries = agentMessageThread(chat, "m3", agents);
    expect(entries).toHaveLength(1);
    expect(
      agentMessageThread([exchange("x", "m9", "gone", ["frontend"], "2026-01-01T11:00:00Z")], "m9", agents)[0],
    ).toMatchObject({
      senderName: null,
    });
    expect(agentMessageThread(chat, "missing", agents)).toEqual([]);
  });
});
