/*
 * The web client on a mock host, for `scripts/web-deep-links-e2e.ts`. The script serves it at every
 * address under `/app`, as the site does, so the client owns the address bar and the history.
 * It is the "Spaces workspace" story: Trading (slug `market-trading`) holds Research and #cakemaker.
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

const runtime: WebRuntimeFactory = (_accountId, events) =>
  mockWebRuntimeFor(
    createMockOpenBot({
      channels: seeds(WEB_PREVIEW_MEMBER_ID),
      channelMemberId: WEB_PREVIEW_MEMBER_ID,
      spaces: [
        {
          space: { id: "trading", name: "Trading", slug: "market-trading", icon: null, hue: 215 },
          agentIds: ["research"],
          channelIds: ["cakemaker"],
        },
        { space: { id: "piks", name: "Piks", icon: null, hue: 150 } },
      ],
    }),
    events,
  );

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
