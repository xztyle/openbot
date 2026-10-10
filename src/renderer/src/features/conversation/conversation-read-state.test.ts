import { EVENT_CHECK_ITEM_TYPE_PREFIX } from "@openbot/contracts/event-checks";
import type { ConversationMessage } from "@openbot/contracts/ipc";
import {
  hostedSiteConversationEventItemType,
  hostedSiteConversationEventText,
  routineConversationEventItemType,
  routineRunConversationEventItemType,
} from "@openbot/contracts/ipc";
import { describe, expect, it } from "vitest";
import { toAgentMessages } from "../../app-message-projection";
import { decideAgentAutoRead, latestVisibleAgentMessageId, readStateForMessages } from "./conversation-read-state";

describe("readStateForMessages", () => {
  it("does not count response attachments as unread replies", () => {
    const messages: ConversationMessage[] = [
      {
        id: "attachment",
        author: "assistant",
        text: "",
        createdAt: "2026-08-30T11:00:00.000Z",
        status: "completed",
        itemType: "agent_attachment",
      },
      {
        id: "answer",
        author: "assistant",
        text: "Here is the screenshot.",
        createdAt: "2026-08-30T11:01:00.000Z",
        status: "completed",
      },
    ];

    expect(
      readStateForMessages({ unreadCount: 0, firstUnreadMessageId: null, throughMessageId: null }, messages),
    ).toMatchObject({ unreadCount: 1, firstUnreadMessageId: "answer" });
  });

  it("does not count routine event markers as unread replies", () => {
    const messages: ConversationMessage[] = [
      {
        id: "routine-event",
        author: "system",
        source: "system",
        text: "Morning brief",
        createdAt: "2026-08-30T11:00:00.000Z",
        status: "completed",
        itemType: routineConversationEventItemType("created", "routine-1"),
      },
    ];

    expect(
      readStateForMessages({ unreadCount: 0, firstUnreadMessageId: null, throughMessageId: null }, messages),
    ).toMatchObject({ unreadCount: 0, firstUnreadMessageId: null });
  });

  it("does not count routine run markers, including malformed markers, as unread replies", () => {
    const messages: ConversationMessage[] = [
      {
        id: "routine-run-event",
        author: "system",
        source: "system",
        text: "Morning brief",
        createdAt: "2026-08-30T11:00:00.000Z",
        status: "completed",
        itemType: routineRunConversationEventItemType("running", "routine-1", "run-1"),
      },
      {
        id: "malformed-routine-run-event",
        author: "system",
        source: "system",
        text: "Morning brief",
        createdAt: "2026-08-30T11:01:00.000Z",
        status: "completed",
        itemType: "routine-run-event:unknown",
      },
    ];

    expect(
      readStateForMessages({ unreadCount: 0, firstUnreadMessageId: null, throughMessageId: null }, messages),
    ).toMatchObject({ unreadCount: 0, firstUnreadMessageId: null });
  });

  it("does not count hosted site markers, including malformed markers, as unread replies", () => {
    const messages: ConversationMessage[] = [
      hostedSiteMessage("succeeded"),
      { ...hostedSiteMessage("succeeded"), id: "malformed-site-event", text: "{" },
    ];

    expect(
      readStateForMessages({ unreadCount: 0, firstUnreadMessageId: null, throughMessageId: null }, messages),
    ).toMatchObject({ unreadCount: 0, firstUnreadMessageId: null });
  });
});

describe("event check markers", () => {
  const messages: ConversationMessage[] = [
    {
      id: "event",
      turnId: "t1",
      author: "system",
      source: "system",
      text: "Slack mentions and DMs",
      createdAt: "2026-08-30T11:00:00.000Z",
      status: "completed",
      itemType: `${EVENT_CHECK_ITEM_TYPE_PREFIX}slack-check:execution-1`,
    },
    {
      id: "answer",
      turnId: "t1",
      author: "assistant",
      text: "Two new mentions.",
      createdAt: "2026-08-30T11:00:05.000Z",
      status: "completed",
    },
  ];

  it("does not count the marker as an unread reply, and the answer still counts", () => {
    expect(
      readStateForMessages({ unreadCount: 0, firstUnreadMessageId: null, throughMessageId: null }, messages),
    ).toMatchObject({ unreadCount: 1, firstUnreadMessageId: "answer" });
  });

  it("does not move the read boundary to the marker", () => {
    expect(latestVisibleAgentMessageId(toAgentMessages(messages.slice(0, 1)))).toBeNull();
    expect(latestVisibleAgentMessageId(toAgentMessages(messages))).toBe("answer");
  });
});

describe("decideAgentAutoRead", () => {
  const unread = { unreadCount: 2, firstUnreadMessageId: "first", throughMessageId: null };

  // The 161 application tests reach this function only on paths that already
  // satisfy one of the three overrides, so deleting the rule left all of them
  // green. It is the whole point of the badge, so it gets a test here.
  it("leaves unread the user has not acknowledged alone", () => {
    expect(
      decideAgentAutoRead({
        messageId: "latest",
        current: unread,
        tracked: undefined,
        optimisticallyClearUnread: false,
        explicitlyOpened: false,
        retryingRead: false,
      }),
    ).toMatchObject({ kind: "deferred" });
  });

  it("reads that same unread once the user opens the conversation, leaving the badge to main", () => {
    expect(
      decideAgentAutoRead({
        messageId: "latest",
        current: unread,
        tracked: undefined,
        optimisticallyClearUnread: false,
        explicitlyOpened: true,
        retryingRead: false,
      }),
    ).toMatchObject({ kind: "mark", optimisticState: null });
  });

  it("clears the badge ahead of main only when the caller says the unread is already seen", () => {
    expect(
      decideAgentAutoRead({
        messageId: "latest",
        current: unread,
        tracked: undefined,
        optimisticallyClearUnread: true,
        explicitlyOpened: false,
        retryingRead: false,
      }),
    ).toMatchObject({
      kind: "mark",
      optimisticState: { unreadCount: 0, firstUnreadMessageId: null, throughMessageId: "latest" },
      rollbackState: unread,
    });
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
