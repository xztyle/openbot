import type { AgentSummary, ConversationMessage } from "@openbot/contracts/ipc";
import {
  hostedSiteConversationEventItemType,
  hostedSiteConversationEventText,
  routineConversationEventItemType,
  routineRunConversationEventItemType,
  skillConversationEventItemType,
} from "@openbot/contracts/ipc";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { agentProfilesEqual, toAgentMessage, toAgentMessages, toAgentProfile } from "./app-message-projection";

describe("toAgentProfile", () => {
  it("preserves marketplace installation metadata for the renderer", () => {
    const agent = {
      id: "release-coordinator",
      name: "Release Coordinator",
      title: "Launch partner",
      description: "Keeps launches clear.",
      notifications: true,
      provider: "codex",
      model: "gpt-5.6-luna",
      reasoningEffort: "medium",
      threadId: null,
      workspacePath: "/tmp/release-coordinator",
      preview: "No messages yet",
      updatedAt: null,
      avatarSeed: "release-coordinator",
      avatarHue: null,
      avatarUrl: null,
      marketplaceSource: {
        listingId: "market-release-coordinator",
        versionId: "market-release-coordinator-v2",
        version: 2,
        skillIds: ["release-notes"],
        routineIds: ["release-check-in"],
      },
    } satisfies AgentSummary;

    expect(toAgentProfile(agent).marketplaceSource).toEqual(agent.marketplaceSource);
  });

  it("detects metadata changes hidden by the formatted preview time", () => {
    const first = toAgentProfile(agentSummary("2026-08-29T10:00:01.000Z"));
    const second = toAgentProfile(agentSummary("2026-08-29T10:00:40.000Z"));

    expect(first.time).toBe(second.time);
    expect(first.preview).toBe(second.preview);
    expect(agentProfilesEqual(first, second)).toBe(false);
  });
});

describe("toAgentMessage", () => {
  it("removes internal citation markers from completed and streaming agent text", () => {
    const message = {
      id: "forecast",
      author: "assistant",
      text: "Storms are likely. \u{e200}cite\u{e202}turn0forecast0\u{e201}",
      createdAt: "2026-08-31T10:00:00.000Z",
      status: "completed",
    } satisfies ConversationMessage;

    expect(toAgentMessage(message).body).toBe("Storms are likely. ");
    expect(
      toAgentMessage({ ...message, text: "Storms are likely. \u{e200}cite\u{e202}turn0fore", status: "streaming" })
        .body,
    ).toBe("Storms are likely. ");
  });

  it("projects routine event metadata for the conversation timeline", () => {
    const message = {
      id: "routine-event",
      author: "system",
      source: "system",
      text: "Morning brief",
      createdAt: "2026-08-31T10:00:00.000Z",
      status: "completed",
      itemType: routineConversationEventItemType("created", "routine-1"),
    } satisfies ConversationMessage;

    expect(toAgentMessage(message, "chief")).toMatchObject({
      kind: "action-marker",
      actionMarker: {
        kind: "routine-lifecycle",
        action: "created",
        sourceAgentId: "chief",
        routineId: "routine-1",
      },
    });
  });

  it("projects routine invocation, transitions, and malformed fallback markers", () => {
    const invocation = {
      id: "routine-delivery",
      author: "user",
      source: "routine",
      text: "Prepare the brief.",
      createdAt: "2026-09-01T08:00:00.000Z",
      status: "completed",
      delivery: { id: "delivery-1", status: "queued", position: 1 },
      routine: {
        routineId: "routine-1",
        runId: "run-1",
        name: "Morning brief",
        scheduledFor: "2026-09-01T08:00:00.000Z",
      },
    } satisfies ConversationMessage;
    const running = {
      id: "routine-running",
      author: "system",
      source: "system",
      text: "Morning brief",
      createdAt: "2026-09-01T08:00:01.000Z",
      status: "completed",
      itemType: routineRunConversationEventItemType("running", "routine-1", "run-1"),
    } satisfies ConversationMessage;

    expect(toAgentMessages([invocation], "chief")[0]).toMatchObject({
      body: "Prepare the brief.",
      actionMarker: { kind: "routine-run", status: "queued", runId: "run-1" },
    });
    expect(toAgentMessage(running, "chief").actionMarker).toMatchObject({
      kind: "routine-run",
      status: "running",
      runId: "run-1",
    });
    expect(toAgentMessage({ ...running, itemType: "routine-run-event:future" }, "chief").actionMarker).toEqual({
      kind: "unavailable",
      label: "Action unavailable",
      timestamp: running.createdAt,
    });
  });

  it("projects hosted site events and falls back for malformed data", () => {
    const published = hostedSiteMessage("succeeded");
    expect(toAgentMessage(published, "chief")).toMatchObject({
      kind: "action-marker",
      actionMarker: {
        kind: "hosted-site",
        sourceAgentId: "chief",
        action: "publish",
        status: "succeeded",
        siteId: "site-1",
        hostname: "launch-page-23456789ab.openbot.site",
      },
    });
    expect(toAgentMessage({ ...published, text: "{" }, "chief").actionMarker).toEqual({
      kind: "unavailable",
      label: "Action unavailable",
      timestamp: published.createdAt,
    });
  });

  it("aggregates outgoing agent delivery states", () => {
    const message = {
      id: "exchange-1",
      author: "agent",
      source: "agent",
      text: "",
      createdAt: "2026-09-01T08:00:00.000Z",
      status: "completed",
      exchange: {
        direction: "outgoing",
        messageId: "message-1",
        senderAgentId: "chief",
        recipientAgentIds: ["research", "sales"],
        replyToMessageId: null,
        deliveries: [
          { id: "delivery-1", recipientAgentId: "research", status: "completed", position: null, error: null },
          { id: "delivery-2", recipientAgentId: "sales", status: "failed", position: null, error: "No" },
        ],
      },
    } satisfies ConversationMessage;

    expect(toAgentMessage(message).actionMarker).toMatchObject({ kind: "agent-message", status: "partial" });
  });
});

describe("agent message preview", () => {
  const exchange = {
    id: "exchange-2",
    author: "agent",
    source: "agent",
    text: "**Deploy** is blocked.\nThe token is Bearer abcdef123456 and the rest is long.",
    createdAt: "2026-09-01T08:00:00.000Z",
    status: "completed",
    exchange: {
      direction: "outgoing",
      messageId: "message-2",
      senderAgentId: "chief",
      recipientAgentIds: ["research"],
      replyToMessageId: null,
      deliveries: [
        { id: "delivery-3", recipientAgentId: "research", status: "completed", position: null, error: null },
      ],
    },
  } satisfies ConversationMessage;

  it("puts one redacted line of the text on the marker and keeps the full text in the body", () => {
    const message = toAgentMessage(exchange);
    const marker = message.actionMarker;
    expect(marker?.kind === "agent-message" ? marker.preview : undefined).toBe(
      "Deploy is blocked. The token is [redacted] and the rest is long.",
    );
    expect(message.body).toContain("Bearer abcdef123456");
  });

  it("leaves the preview out for a message with no text", () => {
    const marker = toAgentMessage({ ...exchange, text: "  " }).actionMarker;
    expect(marker?.kind === "agent-message" && "preview" in marker).toBe(false);
  });
});

describe("messages the person cancelled in the queue", () => {
  const sent = (status: "queued" | "cancelled", extra: Partial<ConversationMessage> = {}): ConversationMessage => ({
    id: `m-${status}`,
    author: "user",
    source: "user",
    text: "use the other branch",
    createdAt: "2026-09-01T08:00:00.000Z",
    status: "completed",
    delivery: { id: `d-${status}`, status, position: status === "queued" ? 1 : null },
    ...extra,
  });

  it("keeps a cancelled message in the transcript, marked, and leaves the queue to the queue panel", () => {
    const result = toAgentMessages([sent("queued"), sent("cancelled")]);
    expect(result.map((message) => message.id)).toEqual(["m-cancelled"]);
    expect(result[0]).toMatchObject({ body: "use the other branch", cancelled: true });
  });

  it("still hides a cancelled teammate request, which has its own marker", () => {
    const request = sent("cancelled", {
      author: "agent",
      source: "agent",
      exchange: {
        direction: "incoming",
        messageId: "message-9",
        senderAgentId: "chief",
        recipientAgentIds: ["research"],
        replyToMessageId: null,
        deliveries: [],
      },
    });
    expect(toAgentMessages([request])).toEqual([]);
  });
});

describe("reasoning of a turn", () => {
  it("joins the commentary of one turn into one thinking message with the full text of each step", () => {
    const step = (id: string, text: string): ConversationMessage => ({
      id,
      turnId: "turn-1",
      author: "assistant",
      text,
      createdAt: "2026-09-01T08:00:00.000Z",
      status: "completed",
      itemType: "commentary",
    });
    const [thinking, ...rest] = toAgentMessages([step("a", "First thought"), step("b", "Second thought")]);
    expect(rest).toEqual([]);
    expect(thinking).toMatchObject({ kind: "thinking", items: ["First thought", "Second thought"] });
  });
});

function hostedSiteMessage(status: "succeeded"): ConversationMessage {
  return {
    id: `hosted-site-${status}`,
    author: "system",
    source: "system",
    text: hostedSiteConversationEventText({
      siteId: "site-1",
      title: "Launch page",
      hostname: "launch-page-23456789ab.openbot.site",
      url: "https://launch-page-23456789ab.openbot.site",
    }),
    createdAt: "2026-09-01T08:00:00.000Z",
    status: "completed",
    itemType: hostedSiteConversationEventItemType("publish", status, "operation-1"),
  };
}

function agentSummary(updatedAt: string): AgentSummary {
  return {
    id: "chief",
    name: "Chief",
    title: "Coordinator",
    description: "Coordinates work.",
    notifications: true,
    provider: "codex",
    model: "gpt-5.6-luna",
    reasoningEffort: "medium",
    threadId: "thread-chief",
    workspacePath: "/tmp/chief",
    preview: "Repeated result",
    updatedAt,
    avatarSeed: "chief",
    avatarHue: null,
    avatarUrl: null,
  };
}

describe.each(["en-US", "pl-PL"])("chat timestamps in %s", (locale) => {
  const DateTimeFormat = Intl.DateTimeFormat;

  beforeEach(() => {
    vi.stubEnv("TZ", "America/Los_Angeles");
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-09T07:05:00Z"));
    vi.spyOn(Intl, "DateTimeFormat").mockImplementation(function dateTimeFormat(locales, options) {
      return new DateTimeFormat(locales ?? locale, options);
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  const examples = [
    ["2026-09-09T07:00:00Z", { hour: "2-digit", minute: "2-digit" }],
    ["2026-09-09T06:59:00Z", { dateStyle: "medium", timeStyle: "short" }],
    ["2026-09-08T07:00:00Z", { dateStyle: "medium", timeStyle: "short" }],
    ["2025-09-09T07:00:00Z", { dateStyle: "medium", timeStyle: "short" }],
    ["2026-08-09T07:00:00Z", { dateStyle: "medium", timeStyle: "short" }],
    ["2026-09-10T07:00:00Z", { dateStyle: "medium", timeStyle: "short" }],
  ] satisfies [string, Intl.DateTimeFormatOptions][];

  it.each(examples)("shows the local timestamp for %s", (createdAt, options) => {
    const message: ConversationMessage = {
      id: "dated-message",
      author: "assistant",
      text: "Daily report",
      createdAt,
      status: "completed",
    };
    expect(toAgentMessage(message).time).toBe(new DateTimeFormat(locale, options).format(new Date(createdAt)));
  });
});

it("projects durable skill actions and rejects forged or malformed events", () => {
  const event = { action: "revised" as const, skillId: "local-skill-1", revision: 2, skillName: "Weekly summary" };
  const message: ConversationMessage = {
    id: "skill-event",
    author: "system",
    source: "system",
    status: "completed",
    createdAt: "2026-09-13T12:00:00Z",
    text: event.skillName,
    itemType: skillConversationEventItemType(event),
  };
  expect(toAgentMessage(message).actionMarker).toEqual({
    ...event,
    kind: "skill-lifecycle",
    timestamp: message.createdAt,
  });
  expect(toAgentMessage({ ...message, author: "assistant" }).actionMarker?.kind).toBe("unavailable");
  expect(toAgentMessage({ ...message, itemType: "skill-event:revised:local-skill-1:-2" }).actionMarker?.kind).toBe(
    "unavailable",
  );
});
