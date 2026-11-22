/*
 * The web client on a mock host with nothing in it yet. `?agents=none` serves a host with no agents
 * and no channels; `?space=new` adds an empty space "Fresh" to the usual seeds; `?connect=fail`
 * makes the host unreachable; `?connect=slow` answers after 4 seconds; `?role=member` signs in as a
 * member.
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

const params = new URLSearchParams(window.location.search);
const none = params.get("agents") === "none";
const connect = params.get("connect");
const member = params.get("role") === "member";
let failures = connect === "fail-once" ? 1 : 0;

const runtime: WebRuntimeFactory = (_accountId, events) => {
  const mock = createMockOpenBot({
    ...(none ? { agents: [], channels: [] } : { channels: seeds(WEB_PREVIEW_MEMBER_ID, {}) }),
    channelMemberId: WEB_PREVIEW_MEMBER_ID,
    storyForeignAgent: false,
    spaces: params.get("space") === "new" ? [{ space: { id: "fresh", name: "Fresh", icon: null, hue: 30 } }] : [],
  });
  const base = mockWebRuntimeFor(mock, events);
  return {
    ...base,
    listHosts: async () => {
      const hosts = await base.listHosts();
      return member ? hosts.map((host) => ({ ...host, role: "member" as const })) : hosts;
    },
    connect: async (host) => {
      if (connect === "slow") await new Promise((done) => setTimeout(done, 4_000));
      if (connect === "fail" || failures-- > 0) throw new Error("The host did not answer.");
      return base.connect(host);
    },
  };
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
            appearance={params.get("dark") === null ? "light" : "dark"}
            onChangeAppearance={() => {}}
          />
        </div>
      </StaticI18nProvider>
    ),
    root,
  );
document.documentElement.dataset.openbotColorScheme = params.get("dark") === null ? "light" : "dark";
