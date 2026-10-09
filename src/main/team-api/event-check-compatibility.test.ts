// @vitest-environment node

import { EVENT_CHECK_ITEM_TYPE_PREFIX } from "@openbot/contracts/event-checks";
import type { ConversationSnapshot } from "@openbot/contracts/ipc";
import { TEAM_CURRENT_CAPABILITIES } from "@openbot/contracts/team-protocol/current";
import { EVENT_CHECKS_CAPABILITY } from "@openbot/contracts/team-protocol/event-checks-v1";
import { expect, it } from "vitest";
import { conversationSnapshotForCapabilities, markerExclusionsForCapabilities } from "./request-helpers";

it("keeps event markers out of older clients even when every older capability is negotiated", () => {
  const snapshot: ConversationSnapshot = {
    agentId: "chief",
    threadId: "thread",
    activeTurnId: null,
    revision: 1,
    messages: [
      {
        id: "marker",
        author: "system",
        source: "system",
        text: "Linear tickets",
        createdAt: new Date().toISOString(),
        status: "completed",
        itemType: `${EVENT_CHECK_ITEM_TYPE_PREFIX}check:execution`,
      },
    ],
  };
  const older = new Set(TEAM_CURRENT_CAPABILITIES.filter((capability) => capability !== EVENT_CHECKS_CAPABILITY));
  expect(conversationSnapshotForCapabilities(snapshot, older).messages).toEqual([]);
  expect(markerExclusionsForCapabilities(older).excludeEventCheckEvents).toBe(true);
  const current = new Set(TEAM_CURRENT_CAPABILITIES);
  expect(conversationSnapshotForCapabilities(snapshot, current).messages).toHaveLength(1);
  expect(markerExclusionsForCapabilities(current).excludeEventCheckEvents).toBe(false);
});
