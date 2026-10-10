import type { ConversationPage } from "@openbot/contracts/ipc";
import { render, screen, waitFor } from "@solidjs/testing-library";
import { flush } from "solid-js";
import { beforeEach, expect, it, vi } from "vitest";
import { AppProviders } from "../../app-providers";
import { agentReply, emitServers, installOpenbotStub, testConversationPage, testServer } from "../../app-test-harness";
import { useServerScope } from "../servers/server-scope";
import { useConversation } from "./conversation-context";

const at = (minute: number) => `2026-09-20T10:${String(minute).padStart(2, "0")}:00.000Z`;

beforeEach(() => {
  installOpenbotStub();
});

/** A remote host that the app reads after each change of its connection sequence. */
async function mountWithHistory(latest: () => ConversationPage) {
  const remote = { ...testServer("remote-1", true), connectionSequence: 1 };
  vi.mocked(window.openbot.servers.list).mockResolvedValueOnce([remote]);
  const older = testConversationPage("chief", [agentReply("m1", "First", at(1)), agentReply("m2", "Second", at(2))], {
    // The host answers an older page with the revision of the thread.
    revision: 2,
    pageInfo: { hasOlder: false, olderCursor: null },
  });
  vi.mocked(window.openbot.agent.readConversationPage).mockImplementation(async (input) =>
    input.anchor?.type === "before" ? older : latest(),
  );
  let conversation: ReturnType<typeof useConversation> | undefined;
  function Probe() {
    conversation = useConversation();
    const scope = useServerScope();
    return <output aria-label="Conversation loaded">{scope.loaded() ? "Ready" : "Loading"}</output>;
  }
  render(() => (
    <AppProviders>
      <Probe />
    </AppProviders>
  ));
  await waitFor(() => expect(screen.getByRole("status", { name: "Conversation loaded" })).toHaveTextContent("Ready"));
  await waitFor(() => expect(conversation?.conversations.chief?.loaded).toBe(true));
  return { remote, conversation: () => conversation };
}

const messageIds = (conversation: ReturnType<typeof useConversation> | undefined) =>
  conversation?.conversations.chief?.messages.map((message) => message.id);

it("keeps the older pages that were loaded when the host connects again", async () => {
  let tail = testConversationPage("chief", [agentReply("m3", "Third", at(3)), agentReply("m4", "Fourth", at(4))], {
    revision: 2,
    pageInfo: { hasOlder: true, olderCursor: "before-m3" },
  });
  const { remote, conversation } = await mountWithHistory(() => tail);
  await conversation()?.loadOlderAgentMessages("chief");
  flush();
  await waitFor(() => expect(messageIds(conversation())).toEqual(["m1", "m2", "m3", "m4"]));
  const olderInfo = conversation()?.conversations.chief?.page;

  tail = testConversationPage(
    "chief",
    [agentReply("m3", "Third", at(3)), agentReply("m4", "Fourth", at(4)), agentReply("m5", "Fifth", at(5))],
    { revision: 3, pageInfo: { hasOlder: true, olderCursor: "before-m3" } },
  );
  const reads = vi.mocked(window.openbot.agent.readConversationPage).mock.calls.length;
  emitServers?.([{ ...remote, connectionSequence: 2 }]);
  await waitFor(() =>
    expect(vi.mocked(window.openbot.agent.readConversationPage).mock.calls.length).toBeGreaterThan(reads),
  );
  await waitFor(() => expect(messageIds(conversation())).toEqual(["m1", "m2", "m3", "m4", "m5"]));
  // The history that was loaded is whole above the page, so its own end stays.
  expect(conversation()?.conversations.chief?.page).toEqual(olderInfo);
  expect(conversation()?.conversations.chief?.windowMode).toBe("latest");
});

it("shows the page alone when it shares no message with what is loaded", async () => {
  let tail = testConversationPage("chief", [agentReply("m3", "Third", at(3))], {
    revision: 2,
    pageInfo: { hasOlder: true, olderCursor: "before-m3" },
  });
  const { remote, conversation } = await mountWithHistory(() => tail);
  await conversation()?.loadOlderAgentMessages("chief");
  flush();
  await waitFor(() => expect(messageIds(conversation())).toEqual(["m1", "m2", "m3"]));

  tail = testConversationPage("chief", [agentReply("m9", "Ninth", at(9))], {
    revision: 3,
    pageInfo: { hasOlder: true, olderCursor: "before-m9" },
  });
  const reads = vi.mocked(window.openbot.agent.readConversationPage).mock.calls.length;
  emitServers?.([{ ...remote, connectionSequence: 2 }]);
  await waitFor(() =>
    expect(vi.mocked(window.openbot.agent.readConversationPage).mock.calls.length).toBeGreaterThan(reads),
  );
  await waitFor(() => expect(messageIds(conversation())).toEqual(["m9"]));
  expect(conversation()?.conversations.chief?.page).toEqual({ hasOlder: true, olderCursor: "before-m9" });
});
