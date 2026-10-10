import type { AgentMessage, AgentMessageMarkerModel } from "@openbot/ui/data";
import { describe, expect, it } from "vitest";
import { collapseThinkingRuns, groupAgentMessageMarkers } from "./agent-message-timeline";

function marker(id: string, direction: "incoming" | "outgoing" = "outgoing"): AgentMessageMarkerModel {
  return {
    kind: "agent-message",
    direction,
    sourceAgentId: "ana",
    targetDeliveries: [{ agentId: "bo", status: "completed" }],
    status: "completed",
    timestamp: "2026-01-01T10:00:00Z",
    messageId: id,
    replyToMessageId: null,
    expectsReply: true,
  };
}

function exchange(id: string, options: { incoming?: boolean; files?: boolean; createdAt?: string } = {}): AgentMessage {
  const direction = options.incoming ? "incoming" : "outgoing";
  const message: AgentMessage = {
    id,
    author: "agent",
    body: `text of ${id}`,
    time: "10:00",
    createdAt: options.createdAt ?? "2026-01-01T10:00:00Z",
    actionMarker: marker(id, direction),
    exchange: {
      direction,
      messageId: id,
      senderAgentId: "ana",
      recipientAgentIds: ["bo"],
      replyToMessageId: null,
      deliveries: [],
    },
  };
  if (options.files) {
    message.attachments = [
      {
        id: `${id}-file`,
        name: "report.pdf",
        size: 1,
        kind: "file",
        mimeType: "application/pdf",
        previewKind: "pdf",
        previewUrl: null,
      },
    ];
  }
  return message;
}

function text(id: string): AgentMessage {
  return { id, author: "agent", body: id, time: "10:00", createdAt: "2026-01-01T10:00:00Z" };
}

function thinking(id: string, items: string[], createdAt = "2026-01-01T10:00:00Z"): AgentMessage {
  return { id, author: "agent", body: "", time: "10:00", createdAt, kind: "thinking", items };
}

describe("groupAgentMessageMarkers when messages between agents are switched off", () => {
  it("keeps every message in one collapsed row for the run, with files too", () => {
    const rows = groupAgentMessageMarkers(
      [exchange("m1"), exchange("m2", { incoming: true, files: true }), exchange("m3")],
      null,
      { collapsed: true },
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.actionMarker).toMatchObject({ kind: "agent-message-group" });
    const group = rows[0]?.actionMarker;
    expect(group?.kind === "agent-message-group" ? group.messages.map((entry) => entry.id) : []).toEqual([
      "m1",
      "m2",
      "m3",
    ]);
  });

  it("does not leave a message with files as its own row when it is alone", () => {
    const rows = groupAgentMessageMarkers(
      [text("a"), exchange("m1", { incoming: true, files: true }), text("b")],
      null,
      {
        collapsed: true,
      },
    );
    expect(rows.map((row) => row.id)).toEqual(["a", "m1", "b"]);
    const group = rows[1]?.actionMarker;
    expect(group?.kind === "agent-message-group" ? group.messages : []).toHaveLength(1);
  });

  it("keeps a single message as its marker, so one click peeks at it", () => {
    const single = exchange("m1");
    expect(groupAgentMessageMarkers([single], null, { collapsed: true })).toEqual([single]);
  });

  it("still stops a run at the first unread message and at a new day", () => {
    const rows = groupAgentMessageMarkers(
      [
        exchange("m1"),
        exchange("m2"),
        exchange("m3"),
        exchange("m4", { createdAt: "2026-01-02T09:00:00Z" }),
        exchange("m5", { createdAt: "2026-01-02T09:01:00Z" }),
      ],
      "m3",
      { collapsed: true },
    );
    expect(rows.map((row) => row.id)).toEqual(["m1", "m3", "m4"]);
  });

  it("keeps a message with files as its own row when the switch is on", () => {
    const rows = groupAgentMessageMarkers([exchange("m1"), exchange("m2", { incoming: true, files: true })]);
    expect(rows.map((row) => row.id)).toEqual(["m1", "m2"]);
    expect(rows[1]?.actionMarker?.kind).toBe("agent-message");
  });
});

describe("collapseThinkingRuns", () => {
  it("joins consecutive reasoning rows into one that holds every step", () => {
    const rows = collapseThinkingRuns([
      text("a"),
      thinking("t1", ["one"]),
      thinking("t2", ["two", "three"]),
      text("b"),
    ]);
    expect(rows.map((row) => row.id)).toEqual(["a", "t1", "b"]);
    expect(rows[1]?.items).toEqual(["one", "two", "three"]);
  });

  it("keeps reasoning that other rows separate, and leaves the input alone", () => {
    const first = thinking("t1", ["one"]);
    const input = [first, text("a"), thinking("t2", ["two"])];
    expect(collapseThinkingRuns(input).map((row) => row.id)).toEqual(["t1", "a", "t2"]);
    expect(first.items).toEqual(["one"]);
  });

  it("stops at the first unread message and at a new day", () => {
    const rows = collapseThinkingRuns(
      [thinking("t1", ["one"]), thinking("t2", ["two"]), thinking("t3", ["three"], "2026-01-02T09:00:00Z")],
      "t2",
    );
    expect(rows.map((row) => row.id)).toEqual(["t1", "t2", "t3"]);
  });
});
