/*
 * The web client on a mock host whose chat with Research holds the agent's own activity beside the
 * owner's conversation, for `scripts/owner-dm-only-e2e-web.ts`. `?seed=full` loads every turn below;
 * otherwise the chat holds only the owner's first exchange, and `window.harnessOwnerDm` adds the
 * others as a host does: the messages, then the end of the turn (with `agentTalk` for the agent's own
 * activity, as `isBackgroundTurn` sets it on the host).
 */
import type { ConversationMessage } from "@openbot/contracts/ipc";
import { Toaster } from "@openbot/ui";
import { render } from "@solidjs/web";
import { WebWorkspace } from "../src/features/web-client/WebWorkspace";
import type { WebRuntimeFactory } from "../src/features/web-client/web-client-context";
import { WEB_TOAST_OFFSET } from "../src/features/web-client/web-visual-viewport";
import { StaticI18nProvider } from "../src/i18n-context";
import { createMockOpenBot } from "../src/preview/mock-openbot";
import { mockWebRuntimeFor, WEB_PREVIEW_MEMBER_ID } from "../src/preview/mock-web-runtime";
import { seeds } from "./workspace/workspace-app-seeds";
import "../src/styles.css";
import "../src/features/web-client/web-client.css";

const AGENT = "research";
const THREAD = "thread-research";
const DAY = "2026-11-24T";
const at = (time: string) => `${DAY}${time}:00.000Z`;

function person(id: string, turnId: string, time: string, text: string): ConversationMessage {
  return {
    id,
    turnId,
    author: "user",
    source: "user",
    text,
    createdAt: at(time),
    status: "completed",
    senderMember: { id: WEB_PREVIEW_MEMBER_ID, name: "Preview User" },
  };
}
function answer(
  id: string,
  turnId: string,
  time: string,
  text: string,
  itemType = "agentMessage",
): ConversationMessage {
  return { id, turnId, author: "assistant", text, createdAt: at(time), status: "completed", itemType };
}
function motion(id: string, turnId: string, time: string, text: string): ConversationMessage {
  return {
    id,
    turnId,
    author: "system",
    source: "system",
    itemType: "system-notice:motion-event",
    text,
    createdAt: at(time),
    status: "completed",
  };
}

/** The turns, in the order a host adds them, with whether each is the agent's own activity. */
export const OWNER_DM_TURNS: { turnId: string; activity: boolean; messages: ConversationMessage[] }[] = [
  {
    turnId: "turn-motion",
    activity: true,
    messages: [
      motion("motion-1", "turn-motion", "11:18", "Motion · MAS-28 was reopened after review."),
      answer("motion-2", "turn-motion", "11:19", "MAS-28 vuelve a revisión (ronda 3 de 3)."),
    ],
  },
  {
    turnId: "turn-teammate",
    activity: true,
    messages: [
      {
        id: "teammate-1",
        turnId: "turn-teammate",
        author: "agent",
        source: "agent",
        itemType: "agent-exchange",
        senderAgentId: "chief",
        text: "Revisa MAS-30, por favor.",
        createdAt: at("12:20"),
        status: "completed",
        exchange: {
          direction: "incoming",
          messageId: "exchange-1",
          senderAgentId: "chief",
          recipientAgentIds: [AGENT],
          replyToMessageId: null,
          deliveries: [],
        },
      },
      answer("teammate-2", "turn-teammate", "12:22", "No pude dejar la nota en MAS-30."),
    ],
  },
  {
    turnId: "turn-owner",
    activity: false,
    messages: [
      person("owner-1", "turn-owner", "13:00", "¿Cómo va la campaña?"),
      answer("owner-2", "turn-owner", "13:01", "Va bien, mañana te paso los números."),
    ],
  },
  {
    turnId: "turn-told",
    activity: false,
    messages: [
      motion("told-1", "turn-told", "14:00", "Motion · MAS-31 needs the owner's OK."),
      answer("told-2", "turn-told", "14:01", "Necesito tu OK para lanzar Peluquería.", "owner-message"),
      answer("told-3", "turn-told", "14:02", "Listo."),
    ],
  },
];

const BASE: ConversationMessage[] = [
  person("base-1", "turn-base", "10:00", "Hola"),
  answer("base-2", "turn-base", "10:01", "Hola, aquí estoy."),
];

declare global {
  interface Window {
    /** Adds the next turn of `OWNER_DM_TURNS` as a host does, and says which it was. */
    harnessOwnerDm?: { next(): string | null };
  }
}

const full = new URLSearchParams(window.location.search).get("seed") === "full";

const runtime: WebRuntimeFactory = (_accountId, events) => {
  const mock = createMockOpenBot({
    channels: seeds(WEB_PREVIEW_MEMBER_ID),
    channelMemberId: WEB_PREVIEW_MEMBER_ID,
    snapshots: {
      [AGENT]: {
        agentId: AGENT,
        threadId: THREAD,
        activeTurnId: null,
        revision: 1,
        messages: [...BASE, ...(full ? OWNER_DM_TURNS.flatMap((turn) => turn.messages) : [])],
      },
    },
    // The owner read the chat up to the first answer.
    conversationReads: { [AGENT]: { unreadCount: 0, firstUnreadMessageId: null, throughMessageId: "base-2" } },
  });
  window.harnessHost = mock;
  let added = 0;
  window.harnessOwnerDm = {
    next() {
      const turn = OWNER_DM_TURNS[added];
      if (!turn) return null;
      added += 1;
      mock.updateConversationSnapshot(AGENT, (snapshot) => {
        snapshot.messages.push(...turn.messages);
      });
      mock.emitAgentEvent({
        type: "turn-completed",
        agentId: AGENT,
        threadId: THREAD,
        turnId: turn.turnId,
        status: "completed",
        origin: turn.activity ? "agent" : "user",
        ...(turn.activity ? { agentTalk: true as const } : {}),
      });
      return turn.turnId;
    },
  };
  return mockWebRuntimeFor(mock, events);
};

const root = document.getElementById("root");
if (root)
  render(
    () => (
      <StaticI18nProvider locale="en">
        <div class="web-app">
          <Toaster offset={WEB_TOAST_OFFSET} />
          <WebWorkspace
            accountId="preview-account"
            accountEmail="you@example.com"
            accountName="Preview User"
            accountFetch={fetch}
            onSessionCheck={async () => {}}
            onLogout={async () => {}}
            createRuntime={runtime}
            language="system"
            onChangeLanguage={() => {}}
            appearance="dark"
            onChangeAppearance={() => {}}
          />
        </div>
      </StaticI18nProvider>
    ),
    root,
  );
