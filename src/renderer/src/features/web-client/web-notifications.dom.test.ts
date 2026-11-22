import type { AgentEvent, ClientAgentSummary } from "@openbot/contracts/ipc";
import { translateFor } from "@openbot/i18n";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { showWebAgentNotification, showWebChannelNotifications } from "./web-notifications";

// Failure mode: two tabs that opened the same host each get its events, and each showed its own
// notification without a tag, so the desktop showed every agent event and channel reply twice.
describe("web notifications across tabs", () => {
  const shown: { title: string; tag: string | undefined }[] = [];
  class FakeNotification extends EventTarget {
    static permission = "granted";
    constructor(title: string, options: NotificationOptions = {}) {
      super();
      shown.push({ title, tag: options.tag });
    }
    close() {}
  }
  beforeEach(() => {
    shown.length = 0;
    vi.stubGlobal("Notification", FakeNotification);
    vi.spyOn(document, "hasFocus").mockReturnValue(false);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const agents: ClientAgentSummary[] = [
    {
      id: "ana",
      provider: "claude",
      name: "Ana",
      title: "",
      description: "",
      notifications: true,
      model: "claude-test",
      reasoningEffort: "medium",
      threadId: "openbot-thread-ana",
      workspacePath: "/tmp/openbot-ana",
      preview: "",
      updatedAt: "2026-11-22T10:00:00.000Z",
      avatarSeed: "ana",
      avatarHue: null,
      avatarUrl: null,
    },
  ];
  const finished: AgentEvent = {
    type: "turn-completed",
    agentId: "ana",
    threadId: "openbot-thread-ana",
    turnId: "turn-1",
    status: "completed",
  };

  it("tags an agent's event the same way in each tab", () => {
    for (let tab = 0; tab < 2; tab += 1)
      showWebAgentNotification({
        hostId: "host-1",
        event: finished,
        agents,
        level: "all",
        translate: translateFor("en"),
        channel: null,
        onOpen: () => undefined,
      });
    expect(shown).toHaveLength(2);
    expect(shown[0]?.tag).toBe("openbot:host-1:agent:ana");
    expect(shown[1]?.tag).toBe(shown[0]?.tag);
  });

  it("tags a channel reply by its channel", () => {
    const reply = { channelId: "general", agentId: "ana", title: "#general", body: "New reply" };
    showWebChannelNotifications({ hostId: "host-1", replies: [reply], onOpen: () => undefined });
    expect(shown[0]?.tag).toBe("openbot:host-1:general");
  });
});
