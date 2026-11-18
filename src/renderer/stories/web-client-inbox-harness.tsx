/*
 * The web client on a mock host with unread messages, for `scripts/workspace-inbox-e2e.ts`: the
 * harness of `web-client-harness.tsx` with the `unread` seeds, so Unreads, Threads, Activity and the
 * sidebar have something unread, and Later has saved messages. Trading (slug `market-trading`) holds
 * Research and #cakemaker.
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

/** Two messages saved for later and one completed, so Later has rows in both tabs. */
const SAVED = [
  { messageId: "general-root", state: "saved" },
  { messageId: "general-m8", state: "saved" },
  { messageId: "general-m5", state: "done" },
] as const;

const runtime: WebRuntimeFactory = (_accountId, events) => {
  const mock = createMockOpenBot({
    channels: seeds(WEB_PREVIEW_MEMBER_ID, { unread: true }),
    channelMemberId: WEB_PREVIEW_MEMBER_ID,
    spaces: [
      {
        space: { id: "trading", name: "Trading", slug: "market-trading", icon: null, hue: 215 },
        agentIds: ["research"],
        channelIds: ["cakemaker"],
      },
      { space: { id: "piks", name: "Piks", icon: null, hue: 150 } },
    ],
  });
  for (const item of SAVED)
    void mock.api.agent.workspaceSetSaved?.({ operationId: crypto.randomUUID(), channelId: "general", ...item });
  return mockWebRuntimeFor(mock, events);
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
            appearance="dark"
            onChangeAppearance={() => {}}
          />
        </div>
      </StaticI18nProvider>
    ),
    root,
  );
