import { EVENT_CHECK_ITEM_TYPE_PREFIX } from "@openbot/contracts/event-checks";
import type { AgentSummary, AttachmentSummary, ConversationMessage } from "@openbot/contracts/ipc";
import {
  hostedSiteConversationEventItemType,
  hostedSiteConversationEventText,
  routineConversationEventItemType,
  routineRunConversationEventItemType,
  skillConversationEventItemType,
} from "@openbot/contracts/ipc";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  agentProfilesEqual,
  createMessageProjector,
  eventCheckOrigins,
  toAgentMessage,
  toAgentMessages,
  toAgentProfile,
} from "./app-message-projection";

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

describe("agent message marker", () => {
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

  it("keeps the text out of the marker and the full text in the body", () => {
    const message = toAgentMessage(exchange);
    expect(JSON.stringify(message.actionMarker)).not.toContain("Deploy");
    expect(message.body).toContain("Bearer abcdef123456");
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

describe("event check origin", () => {
  const checkName = "Slack mentions and DMs";
  let clock = 0;
  const createdAt = () => new Date(Date.UTC(2026, 8, 13, 21, 3, clock++)).toISOString();
  const marker = (id: string, turnId?: string): ConversationMessage => ({
    id,
    turnId,
    author: "system",
    source: "system",
    text: checkName,
    createdAt: createdAt(),
    status: "completed",
    itemType: `${EVENT_CHECK_ITEM_TYPE_PREFIX}slack-check:${id}`,
  });
  const reply = (id: string, turnId: string | undefined, overrides: Partial<ConversationMessage> = {}) =>
    ({
      id,
      turnId,
      author: "assistant",
      text: `Reply ${id}`,
      createdAt: createdAt(),
      status: "completed",
      ...overrides,
    }) satisfies ConversationMessage;
  const person = (id: string, turnId: string | undefined): ConversationMessage => ({
    id,
    turnId,
    author: "user",
    text: `Question ${id}`,
    createdAt: createdAt(),
    status: "completed",
  });
  /** The chip of each message that carries one, as `id: position`. */
  const chips = (messages: ConversationMessage[], activeTurnId?: string | null) =>
    Object.fromEntries(
      [...eventCheckOrigins(toAgentMessages(messages), { activeTurnId })].map(([id, origin]) => [id, origin.position]),
    );

  beforeEach(() => {
    clock = 0;
  });

  it("keeps the marker in the conversation as a message with no text of its own", () => {
    const projected = toAgentMessages([marker("event"), reply("answer", "t1")]);

    expect(projected.map((message) => message.id)).toEqual(["event", "answer"]);
    expect(projected[0]?.actionMarker).toMatchObject({ kind: "event-check", name: checkName, checkId: "slack-check" });
  });

  it("names the check on the first and the last message of an uninterrupted turn", () => {
    const messages = [marker("event", "t1"), reply("first", "t1"), reply("middle", "t1"), reply("last", "t1")];

    expect(chips(messages)).toEqual({ first: "start", last: "end" });
    expect([...eventCheckOrigins(toAgentMessages(messages)).values()][0]).toMatchObject({
      name: checkName,
      checkId: "slack-check",
    });
  });

  it("puts one chip on a turn with one agent message", () => {
    expect(chips([marker("event", "t1"), reply("answer", "t1")])).toEqual({ answer: "only" });
  });

  it("tags only the first message when the person writes in the middle of the turn", () => {
    const messages = [marker("event", "t1"), reply("first", "t1"), person("steer", "t1"), reply("last", "t1")];

    expect(chips(messages)).toEqual({ first: "only" });
  });

  it("tags only the first message when the person wrote before the first answer", () => {
    expect(chips([marker("event", "t1"), person("steer", "t1"), reply("a", "t1"), reply("b", "t1")])).toEqual({
      a: "only",
    });
  });

  it("keeps the last message tagged when the person writes after it or starts a new turn", () => {
    const messages = [
      marker("event", "t1"),
      reply("first", "t1"),
      reply("last", "t1"),
      person("next", "t2"),
      reply("other", "t2"),
    ];

    expect(chips(messages)).toEqual({ first: "start", last: "end" });
  });

  it("tags only the first message after an event that arrives in a running turn", () => {
    const messages = [
      person("ask", "t1"),
      reply("earlier", "t1"),
      marker("event", "t1"),
      reply("first", "t1"),
      reply("last", "t1"),
    ];

    expect(chips(messages)).toEqual({ first: "only" });
  });

  it("counts reasoning of the turn as a turn that already ran", () => {
    const messages = [
      reply("thought", "t1", { itemType: "commentary" }),
      marker("event", "t1"),
      reply("first", "t1"),
      reply("last", "t1"),
    ];

    expect(chips(messages)).toEqual({ first: "only" });
  });

  it("follows the same rules for each of two separate interactions", () => {
    const messages = [
      marker("event-1", "t1"),
      reply("a1", "t1"),
      reply("a2", "t1"),
      person("ask", "t2"),
      reply("answer", "t2"),
      marker("event-2", "t3"),
      reply("b1", "t3"),
      reply("b2", "t3"),
    ];

    expect(chips(messages)).toEqual({ a1: "start", a2: "end", b1: "start", b2: "end" });
  });

  it("gives a second event of the same turn its own first message and no end chip to the first", () => {
    const messages = [
      marker("event-1", "t1"),
      reply("a1", "t1"),
      marker("event-2", "t1"),
      reply("b1", "t1"),
      reply("b2", "t1"),
    ];

    expect(chips(messages)).toEqual({ a1: "only", b1: "only" });
  });

  it("shows nothing until the first agent message arrives, and counts a streaming one", () => {
    const waiting = [marker("event", "t1")];
    expect(chips(waiting)).toEqual({});
    expect(chips([...waiting, reply("thought", "t1", { itemType: "commentary", status: "streaming" })])).toEqual({});
    expect(chips([...waiting, reply("answer", "t1", { status: "streaming", text: "Looking" })])).toEqual({
      answer: "start",
    });
  });

  it("marks the end only after the turn is over", () => {
    const messages = [marker("event", "t1"), reply("first", "t1"), reply("last", "t1")];

    expect(chips(messages, "t1")).toEqual({ first: "start" });
    expect(chips(messages, "t2")).toEqual({ first: "start", last: "end" });
    expect(chips(messages, null)).toEqual({ first: "start", last: "end" });
  });

  it("never tags reasoning, the person's messages or answers with nothing to draw", () => {
    const messages = [
      marker("event", "t1"),
      reply("thought", "t1", { itemType: "commentary" }),
      reply("silent", "t1", { text: "" }),
      reply("answer", "t1"),
      reply("final-thought", "t1", { itemType: "commentary" }),
    ];

    expect(chips(messages)).toEqual({ answer: "only" });
  });

  it("falls back to message order for a marker whose turn has not started", () => {
    const messages = [
      marker("event"),
      reply("first", "t1"),
      reply("last", "t1"),
      person("ask", "t2"),
      reply("other", "t2"),
    ];

    expect(chips(messages)).toEqual({ first: "start", last: "end" });
    // A delivery that waits behind a running turn has no answer of its own yet.
    expect(chips(messages, "t0")).toEqual({});
  });

  it("does not take the answer of another turn", () => {
    expect(chips([marker("event", "t1"), person("ask", "t2"), reply("answer", "t2")])).toEqual({});
    // A queued event sits before the output of the turn that was running when it arrived.
    expect(chips([marker("event", "t2"), reply("running", "t1"), reply("answer", "t2")])).toEqual({ answer: "only" });
  });
});

describe("message projection that keeps unchanged messages", () => {
  const at = (second: number) => new Date(Date.UTC(2026, 8, 20, 9, 0, second)).toISOString();
  const message = (id: string, overrides: Partial<ConversationMessage> = {}): ConversationMessage => ({
    id,
    turnId: "t1",
    author: "assistant",
    text: `Text of ${id}`,
    createdAt: at(1),
    status: "completed",
    ...overrides,
  });
  /** The loop of `toAgentMessages` before the projector existed. It is the golden output. */
  function legacyToAgentMessages(messages: ConversationMessage[], ownerAgentId?: string) {
    const result: ReturnType<typeof toAgentMessages> = [];
    const thinkingByTurn = new Map<string, (typeof result)[number]>();
    for (const item of messages) {
      const cancelledByPerson =
        item.delivery?.status === "cancelled" && item.author === "user" && !item.exchange && !item.routine;
      if (
        (item.delivery?.status === "queued" || (item.delivery?.status === "cancelled" && !cancelledByPerson)) &&
        !item.routine &&
        !item.itemType?.startsWith(EVENT_CHECK_ITEM_TYPE_PREFIX)
      )
        continue;
      if (item.author !== "assistant" || item.itemType !== "commentary") {
        result.push(toAgentMessage(item, ownerAgentId));
        continue;
      }
      const key = item.turnId ?? item.id;
      const existing = thinkingByTurn.get(key);
      const text = toAgentMessage({ ...item, itemType: undefined }).body;
      if (existing) {
        existing.items = [...(existing.items ?? []), text];
        existing.itemIds = [...(existing.itemIds ?? []), item.id];
        existing.streaming = existing.streaming || item.status === "streaming";
        continue;
      }
      const first = toAgentMessage(item);
      const thinking: (typeof result)[number] = {
        id: `thinking:${key}`,
        turnId: item.turnId,
        author: "agent",
        body: "",
        time: first.time,
        createdAt: item.createdAt,
        streaming: item.status === "streaming",
        itemType: "commentary",
        kind: "thinking",
        items: [text],
        itemIds: [item.id],
      };
      thinkingByTurn.set(key, thinking);
      result.push(thinking);
    }
    return result;
  }
  const conversation = (): ConversationMessage[] => [
    message("ask-1", { author: "user", text: "Plan the launch" }),
    message("think-1", { itemType: "commentary", text: "Looking at the plan" }),
    message("queued", { author: "user", delivery: { id: "d1", status: "queued", position: 1 } }),
    message("think-2", { itemType: "commentary", text: "Checking the dates", status: "streaming" }),
    message("answer-1", { text: "Here is the plan", reactions: [{ emoji: "+1", actor: { kind: "user" } }] }),
    message("cancelled-by-person", { author: "user", delivery: { id: "d2", status: "cancelled", position: null } }),
    message("cancelled-request", {
      author: "user",
      delivery: { id: "d3", status: "cancelled", position: null },
      exchange: {
        messageId: "x1",
        direction: "incoming",
        senderAgentId: "peer",
        recipientAgentIds: ["chief"],
        replyToMessageId: null,
        deliveries: [],
      },
    }),
    message("ask-2", { turnId: "t2", author: "user", text: "Thanks", attachments: [attachment("file-1")] }),
    message("think-3", { turnId: "t2", itemType: "commentary", text: "Replying" }),
    message("answer-2", { turnId: "t2", text: "You are welcome", status: "failed" }),
  ];
  function attachment(id: string): AttachmentSummary {
    return {
      id,
      name: `${id}.png`,
      mimeType: "image/png",
      size: 10,
      kind: "image",
      previewKind: "image",
      previewUrl: null,
    };
  }

  it("gives the output that toAgentMessages gave before, for a list with reasoning, queue and replies", () => {
    const list = conversation();
    const golden = legacyToAgentMessages(list, "chief");
    expect(toAgentMessages(list, "chief")).toEqual(golden);
    expect(createMessageProjector()(list, "chief")).toEqual(golden);
    // The reasoning of a turn is one message, at the place of its first step.
    expect(golden.map((item) => item.id)).toEqual([
      "ask-1",
      "thinking:t1",
      "answer-1",
      "cancelled-by-person",
      "ask-2",
      "thinking:t2",
      "answer-2",
    ]);
  });

  it("keeps the object of every message that did not change when a delta arrives", () => {
    const project = createMessageProjector();
    const list = conversation();
    const first = project(list, "chief");
    const streaming = list.find((item) => item.id === "think-2");
    if (!streaming) throw new Error("missing message");
    streaming.text += " and the owners";
    const second = project(list, "chief");
    expect(second).toEqual(legacyToAgentMessages(list, "chief"));
    for (const [index, item] of first.entries()) {
      if (item.id === "thinking:t1") expect(second[index]).not.toBe(item);
      else expect(second[index]).toBe(item);
    }
    // A delta on the answer rebuilds only the answer.
    const answer = list.find((item) => item.id === "answer-2");
    if (!answer) throw new Error("missing message");
    answer.text += "!";
    answer.status = "streaming";
    const third = project(list, "chief");
    expect(third).toEqual(legacyToAgentMessages(list, "chief"));
    expect(third.filter((item, index) => item !== second[index]).map((item) => item.id)).toEqual(["answer-2"]);
  });

  it("makes a message again when its status, reactions, attachments, delivery or question change", () => {
    const project = createMessageProjector();
    const list = conversation();
    const before = project(list, "chief");
    const edit = (id: string, change: (item: ConversationMessage) => void) => {
      const target = list.find((item) => item.id === id);
      if (!target) throw new Error("missing message");
      change(target);
      const after = project(list, "chief");
      expect(after).toEqual(legacyToAgentMessages(list, "chief"));
      const previous = before.find((item) => item.id === id);
      const next = after.find((item) => item.id === id);
      expect(next).not.toBe(previous);
      return after;
    };
    edit("answer-1", (item) => {
      item.reactions = [];
    });
    edit("answer-2", (item) => {
      item.status = "interrupted";
    });
    edit("ask-2", (item) => {
      item.attachments = [attachment("file-1"), attachment("file-2")];
    });
    edit("answer-1", (item) => {
      item.questionPrompt = { requestId: "r1", questions: [], resolution: null };
    });
    edit("answer-1", (item) => {
      item.delivery = { id: "d9", status: "running", position: null };
    });
    edit("answer-2", (item) => {
      item.exchange = {
        messageId: "x2",
        direction: "outgoing",
        senderAgentId: "chief",
        recipientAgentIds: [],
        replyToMessageId: null,
        deliveries: [],
      };
    });
  });

  it("makes every message again for another owner or a changed turn id", () => {
    const project = createMessageProjector();
    const list = conversation();
    const first = project(list, "chief");
    const other = project(list, "helper");
    expect(other).toEqual(legacyToAgentMessages(list, "helper"));
    expect(other.every((item, index) => item !== first[index])).toBe(true);
    const answer = list.find((item) => item.id === "answer-1");
    if (!answer) throw new Error("missing message");
    answer.turnId = "t9";
    expect(project(list, "helper").find((item) => item.id === "answer-1")?.turnId).toBe("t9");
  });

  it("drops a message that leaves the list and shows a new one", () => {
    const project = createMessageProjector();
    const list = conversation();
    project(list, "chief");
    const next = [...list.filter((item) => item.id !== "answer-1"), message("late", { turnId: "t3" })];
    expect(project(next, "chief")).toEqual(legacyToAgentMessages(next, "chief"));
  });
});
