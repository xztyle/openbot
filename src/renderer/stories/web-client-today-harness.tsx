/*
 * The web client on a mock host where things wait for the owner, for `scripts/today-e2e.ts`: two
 * loop decisions in the Trading space (a $40 ad budget and a question), and, from the host's
 * attention list, a $19 payment approval of Chief and a browser sign-in of Sales Outbound in General.
 * Research works in #general. The loop decisions answer as the host would: a decide removes one.
 */
import { Toaster } from "@openbot/ui";
import { render } from "@solidjs/web";
import { WebWorkspace } from "../src/features/web-client/WebWorkspace";
import type { WebRuntimeFactory } from "../src/features/web-client/web-client-context";
import { StaticI18nProvider } from "../src/i18n-context";
import { createMockOpenBot } from "../src/preview/mock-openbot";
import { mockWebRuntimeFor, WEB_PREVIEW_MEMBER_ID } from "../src/preview/mock-web-runtime";
import { seeds } from "./workspace/workspace-app-seeds";
import "../src/styles.css";
import "../src/features/web-client/web-client.css";

const NOW = Date.now();
const runtime: WebRuntimeFactory = (_accountId, events) => {
  const mock = createMockOpenBot({
    channels: seeds(WEB_PREVIEW_MEMBER_ID, { unread: true, working: true }),
    channelMemberId: WEB_PREVIEW_MEMBER_ID,
    loopDecisions: [
      {
        id: "decision-ads",
        spaceId: "trading",
        loopId: "loop-ads",
        itemId: "item-ads",
        kind: "money",
        subject: "experiment",
        title: "Run the spring ad test",
        detail: "Two ad sets for the course, 5 days.",
        amountUsd: 40,
        requestedBy: "research",
        status: "pending",
        createdAt: NOW - 3_600_000,
      },
      {
        id: "decision-question",
        spaceId: "trading",
        loopId: "loop-ads",
        itemId: "item-hook",
        kind: "decision",
        subject: "question",
        title: "Which hook do we open the video with?",
        requestedBy: "research",
        status: "pending",
        createdAt: NOW - 7_200_000,
      },
    ],
    spaces: [
      {
        space: { id: "trading", name: "Trading", slug: "market-trading", icon: null, hue: 215 },
        agentIds: ["research"],
        channelIds: ["cakemaker"],
      },
      { space: { id: "piks", name: "Piks", icon: null, hue: 150 } },
    ],
  });
  const web = mockWebRuntimeFor(mock, events);
  // As the host: the attention list comes after the first connect.
  setTimeout(
    () =>
      mock.emitAgentEvent({
        type: "agent-attention-changed",
        items: [
          {
            kind: "approval",
            requestId: "approval-pay",
            agentId: "chief",
            threadId: "thread-chief",
            turnId: "turn-chief",
            createdAt: new Date(NOW - 600_000).toISOString(),
            summary: "Pay $19 for the domain atelier-course.com",
          },
          {
            kind: "browser-takeover",
            requestId: "takeover-google",
            agentId: "sales",
            threadId: "thread-sales",
            turnId: "turn-sales",
            createdAt: new Date(NOW - 1_800_000).toISOString(),
            summary: "Create a Google Account",
            origin: "accounts.google.com",
          },
        ],
      }),
    1500,
  );
  return web;
};
const root = document.getElementById("root");
if (root)
  render(
    () => (
      <StaticI18nProvider locale="en">
        <div class="web-app">
          <Toaster />
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
            appearance="light"
            onChangeAppearance={() => {}}
          />
        </div>
      </StaticI18nProvider>
    ),
    root,
  );
document.documentElement.dataset.openbotColorScheme = "light";
