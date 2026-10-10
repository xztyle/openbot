import type { AttachmentSummary, ConversationMessage, ConversationPage } from "@openbot/contracts/ipc";
import { createRoot, createSignal, createStore, flush } from "solid-js";
import { describe, expect, it } from "vitest";
import { toAgentMessages } from "../../app-message-projection";
import { createWebConversationView } from "./web-conversation-view";

interface PageState {
  selectedId: string | null;
  status: "online";
  approvals: [];
  prompts: [];
  page: ConversationPage;
}

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
const image = (id: string): AttachmentSummary => ({
  id,
  name: `${id}.png`,
  size: 10,
  kind: "image",
  mimeType: "image/png",
  previewKind: "image",
  previewUrl: null,
});

function setup(initial: ConversationMessage[], previewUrl?: (id: string) => string | null) {
  const [state, setState] = createStore<PageState>({
    selectedId: "chief",
    status: "online",
    approvals: [],
    prompts: [],
    page: {
      agentId: "chief",
      threadId: "thread",
      activeTurnId: null,
      revision: 1,
      messages: initial,
      references: {},
      pageInfo: { hasOlder: false, olderCursor: null },
    },
  });
  let dispose = () => {};
  const view = createRoot((disposeRoot) => {
    dispose = disposeRoot;
    return createWebConversationView({
      workspace: {
        state,
        selected: () => undefined,
        conversation: () => ({ page: state.page }),
        answer: async () => {},
        approve: async () => {},
      },
      remoteAgentAdmin: { settings: () => null, update: async () => {} },
      hidden: () => false,
      ...(previewUrl ? { previewUrl } : {}),
    });
  });
  /** The same writes as the web client: a delta changes the item in place. */
  const write = (change: (messages: ConversationMessage[]) => void) => {
    setState((draft) => {
      change(draft.page.messages);
    });
    flush();
  };
  return { view, write, state, dispose };
}

describe("web conversation view", () => {
  it("keeps the object of the other messages when a delta streams, and gives the same output", () => {
    {
      const { view, write, state, dispose } = setup([
        message("ask", { author: "user", turnId: "t1" }),
        message("think", { itemType: "commentary" }),
        message("old-answer", { turnId: "t1", attachments: [image("pic")] }),
        message("streaming", { turnId: "t2", status: "streaming", text: "Hel" }),
      ]);
      flush();
      const before = view.messages();
      write((messages) => {
        const target = messages.find((item) => item.id === "streaming");
        if (!target) throw new Error("missing message");
        target.text += "lo";
        target.status = "streaming";
      });
      const after = view.messages();
      expect(after.map((item) => item.id)).toEqual(before.map((item) => item.id));
      expect(after.find((item) => item.id === "streaming")?.body).toBe("Hello");
      for (const item of before) {
        if (item.id !== "streaming") expect(after.find((other) => other.id === item.id)).toBe(item);
      }
      expect(after.find((item) => item.id === "streaming")).not.toBe(before.find((item) => item.id === "streaming"));
      // The attachment row is the same object too, with its preview URL layer.
      expect(after.find((item) => item.id === "old-answer")?.attachments).toBeDefined();
      expect(after).toEqual(toAgentMessages(state.page.messages, "chief"));
      dispose();
    }
  });

  it("makes an old message again when its status, reactions or attachments change", () => {
    {
      const { view, write, dispose } = setup([
        message("a", { turnId: "t1" }),
        message("b", { turnId: "t1" }),
        message("c", { turnId: "t2", status: "streaming" }),
      ]);
      flush();
      const initial = view.messages();
      const same = (id: string) => view.messages().find((item) => item.id === id) === initial.find((m) => m.id === id);
      write((messages) => {
        const target = messages.find((item) => item.id === "a");
        if (target) target.status = "failed";
      });
      expect(same("a")).toBe(false);
      expect(view.messages().find((item) => item.id === "a")?.status).toBe("Failed");
      expect(same("b")).toBe(true);
      write((messages) => {
        const target = messages.find((item) => item.id === "b");
        if (target) target.reactions = [{ emoji: "+1", actor: { kind: "user" } }];
      });
      expect(same("b")).toBe(false);
      expect(view.messages().find((item) => item.id === "b")?.reactions).toEqual([
        { emoji: "+1", actor: { kind: "user" } },
      ]);
      write((messages) => {
        const target = messages.find((item) => item.id === "b");
        if (target) target.attachments = [image("late")];
      });
      expect(
        view
          .messages()
          .find((item) => item.id === "b")
          ?.attachments?.map((item) => item.id),
      ).toEqual(["late"]);
      dispose();
    }
  });

  it("makes only the messages with attachments again when a preview URL arrives", () => {
    {
      const [urls, setUrls] = createSignal<Record<string, string>>({});
      const { view, dispose } = setup(
        [message("plain"), message("with-picture", { attachments: [image("pic")] })],
        (id) => urls()[id] ?? null,
      );
      flush();
      const before = view.messages();
      expect(before[1]?.attachments?.[0]?.previewUrl).toBeNull();
      setUrls({ pic: "blob:pic" });
      flush();
      const after = view.messages();
      expect(after[0]).toBe(before[0]);
      expect(after[1]).not.toBe(before[1]);
      expect(after[1]?.attachments?.[0]?.previewUrl).toBe("blob:pic");
      dispose();
    }
  });
});
