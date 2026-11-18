/*
 * The web client on a mock host for `scripts/needs-you-ui-e2e.ts`. Chief asked Sales Outbound for
 * work; the reader wrote only to Chief lately, so Sales Outbound has no DM row. The script acts as the
 * host with `needs-you-harness` window events: `detail` "request" makes Sales Outbound ask the reader
 * to sign in on accounts.google.com in a browser tab (the takeover event, the escalation to Chief and
 * the host's attention list), and "resolve" ends it as the host does after an answer anywhere. The
 * page sets `data-needs-you-ready` on the root element once it takes events, and writes the number of
 * takeover answers it sent to `data-needs-you-answered`.
 */
import type { AgentAttentionItem, AgentEvent, BrowserTab, RespondToBrowserTakeoverInput } from "@openbot/contracts/ipc";
import { Toaster } from "@openbot/ui";
import { render } from "@solidjs/web";
import { WebWorkspace } from "../src/features/web-client/WebWorkspace";
import type { WebRuntimeFactory } from "../src/features/web-client/web-client-context";
import { StaticI18nProvider } from "../src/i18n-context";
import { STORY_BROWSER_TABS } from "../src/preview/fixtures";
import { createMockOpenBot } from "../src/preview/mock-openbot";
import { mockWebRuntimeFor, WEB_PREVIEW_MEMBER_ID } from "../src/preview/mock-web-runtime";
import { seeds } from "./workspace/workspace-app-seeds";
import "../src/styles.css";
import "../src/features/web-client/web-client.css";

const SALES_TAB: BrowserTab = {
  id: "browser-tab-google",
  title: "Create a Google Account",
  url: "https://accounts.google.com/lifecycle/steps/signup/birthdaygender",
  loading: false,
  ownerThreadId: "thread-sales",
  ownerAgentId: "sales",
};

const REQUEST = {
  requestId: "takeover-google",
  agentId: "sales",
  threadId: "thread-sales",
  turnId: "turn-sales-google",
  tabId: SALES_TAB.id,
} as const;

const ITEM: AgentAttentionItem = {
  kind: "browser-takeover",
  requestId: REQUEST.requestId,
  agentId: REQUEST.agentId,
  threadId: REQUEST.threadId,
  turnId: REQUEST.turnId,
  createdAt: new Date().toISOString(),
  summary: SALES_TAB.title,
  origin: "accounts.google.com",
};

const runtime: WebRuntimeFactory = (_accountId, events) => {
  const mock = createMockOpenBot({
    channels: seeds(WEB_PREVIEW_MEMBER_ID),
    channelMemberId: WEB_PREVIEW_MEMBER_ID,
    browserTabs: [...STORY_BROWSER_TABS, SALES_TAB],
  });
  const web = mockWebRuntimeFor(mock, events);
  const emit = (event: AgentEvent) => mock.emitAgentEvent(event);
  const answered: RespondToBrowserTakeoverInput[] = [];
  const resolve = () => {
    emit({ type: "agent-input-escalations-changed", escalations: [] });
    emit({ type: "browser-takeover-resolved", requestId: REQUEST.requestId, agentId: REQUEST.agentId });
    emit({ type: "agent-attention-changed", items: [] });
  };
  const request = () => {
    // As the host: the escalation first, so the request finds its delegator, then the request.
    emit({
      type: "agent-input-escalations-changed",
      escalations: [{ kind: "browser-takeover", ...REQUEST, delegatorAgentIds: ["chief"] }],
    });
    emit({ type: "browser-takeover-requested", request: { ...REQUEST } });
    emit({ type: "agent-attention-changed", items: [ITEM] });
  };
  window.addEventListener("needs-you-harness", (event) => {
    const detail = event instanceof CustomEvent ? event.detail : null;
    if (detail === "request") request();
    if (detail === "resolve") resolve();
  });
  document.documentElement.dataset.needsYouReady = "";
  // The reader wrote to Chief only: the other agents have no DM row until one needs them.
  mock.api.agent.workspaceDmAgents = async () => ({
    agentIds: ["chief", "research", "sales"],
    recentAgentIds: ["chief"],
  });
  return {
    ...web,
    respondToTakeover: async (input) => {
      answered.push(input);
      document.documentElement.dataset.needsYouAnswered = String(answered.length);
      resolve();
    },
    connect: async (...args: Parameters<typeof web.connect>) => {
      const capabilities = await web.connect(...args);
      return [...capabilities, "browser-control", "browser-view"];
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
            appearance="dark"
            onChangeAppearance={() => {}}
          />
        </div>
      </StaticI18nProvider>
    ),
    root,
  );
