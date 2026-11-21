/*
 * The web client on a mock host whose agent waits for the reader in its browser, for
 * `scripts/web-live-view-e2e.ts`. Chief has one tab and a takeover request on it. The live view of
 * the tab goes to the page that serves this harness: the script exposes `liveViewHost` (start, stop,
 * input) and sends the frames of a real page back through `window.liveViewBridge`. Without the
 * script, the view says that there is no host to watch, as the preview does.
 */
import type { BrowserLiveViewEvent, BrowserLiveViewInput, BrowserTab } from "@openbot/contracts/ipc";
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

const TAB: BrowserTab = {
  id: "browser-tab-signup",
  title: "Create your account",
  url: "https://accounts.example.test/signup",
  loading: false,
  ownerThreadId: "thread-chief",
  ownerAgentId: "chief",
  environment: {
    viewport: { mode: "fill", width: 800, height: 600, deviceScaleFactor: 1, preset: null },
    colorScheme: "system",
    reducedMotion: false,
  },
  recording: false,
  diagnosticErrorCount: 0,
};
const REQUEST = {
  requestId: "takeover-1",
  agentId: "chief",
  threadId: "thread-chief",
  turnId: "turn-takeover",
  tabId: TAB.id,
};

interface LiveViewHost {
  start(tabId: string, viewport?: { width: number; height: number }): Promise<void>;
  stop(): Promise<void>;
  input(input: BrowserLiveViewInput): Promise<void>;
}
interface HarnessWindow {
  /** The script's side of the live view; it calls `openbotLiveView*`, which the script exposes. */
  liveViewHost?: LiveViewHost;
  liveViewBridge?: {
    frame(tabId: string, sequence: number, width: number, height: number, base64: string): void;
    stopped(tabId: string, reason: string): void;
    /** The host ends the takeover itself, as when the agent stops waiting. */
    resolve(): void;
    /** The host closes the tab. */
    closeTab(): Promise<void>;
    /** The connection to the host drops or comes back, as WebRTC reports it. */
    connection(state: "online" | "offline"): void;
    /** The page of the tab opened a popup: the host lists it, with its own active tab unchanged. */
    addTab(tabId: string, title: string): void;
    /** The popup closed. */
    removeTab(tabId: string): void;
    /** The next close of a tab fails on the host, as a refused close does. */
    failNextClose(): void;
  };
  /** The tabs the client asked the host to close, in order. */
  closedTabs?: string[];
  takeoverResponses?: { requestId: string | number; decision: string }[];
}
declare global {
  interface Window extends HarnessWindow {}
}
const harness: HarnessWindow = window;
harness.takeoverResponses = [];
harness.closedTabs = [];
/** A host answers a close after a round trip; the row must not wait for it. */
const CLOSE_ROUND_TRIP_MS = 600;

const runtime: WebRuntimeFactory = (_accountId, events) => {
  const mock = createMockOpenBot({
    channels: seeds(WEB_PREVIEW_MEMBER_ID),
    channelMemberId: WEB_PREVIEW_MEMBER_ID,
    browserTabs: [TAB],
    browserControlState: { sessions: [] },
  });
  const listeners = new Set<(event: BrowserLiveViewEvent) => void>();
  let tabs: BrowserTab[] = [TAB];
  let failNextClose = false;
  const emit = (event: BrowserLiveViewEvent) => {
    for (const listener of listeners) listener(event);
  };
  harness.liveViewBridge = {
    frame(tabId, sequence, width, height, base64) {
      const image = Uint8Array.from(atob(base64), (character) => character.charCodeAt(0));
      emit({ type: "frame", tabId, sequence, width, height, image });
    },
    stopped: (tabId, reason) => emit({ type: "stopped", tabId, reason }),
    resolve: () =>
      mock.emitAgentEvent({ type: "browser-takeover-resolved", requestId: REQUEST.requestId, agentId: "chief" }),
    closeTab: () => mock.api.browser.close(TAB.id),
    connection: (state) => events.connection({ hostId: "preview-host", state, message: null }),
    addTab: (tabId, title) => {
      tabs = [...tabs, { ...TAB, id: tabId, title, url: "https://auth.example.test/popup" }];
      mock.emitAgentEvent({ type: "browser-changed", tabs, activeTabId: TAB.id });
    },
    removeTab: (tabId) => {
      tabs = tabs.filter((tab) => tab.id !== tabId);
      mock.emitAgentEvent({ type: "browser-changed", tabs, activeTabId: TAB.id });
    },
    failNextClose: () => {
      failNextClose = true;
    },
  };
  const web = mockWebRuntimeFor(mock, events);
  return {
    ...web,
    closeBrowserTab: async (tabId) => {
      harness.closedTabs?.push(tabId);
      await new Promise((resolve) => setTimeout(resolve, CLOSE_ROUND_TRIP_MS));
      if (failNextClose) {
        failNextClose = false;
        throw new Error("The host kept the tab open.");
      }
      if (!tabs.some((tab) => tab.id === tabId)) throw new Error("Browser tab was closed.");
      tabs = tabs.filter((tab) => tab.id !== tabId);
      mock.emitAgentEvent({ type: "browser-changed", tabs, activeTabId: TAB.id });
    },
    browser: {
      ...mock.api.browser,
      // The host holds the page at the size of the view, as a host with `browser-view-viewport` does.
      liveViewHoldsViewport: () => harness.liveViewHost !== undefined,
      startLiveView: async (tabId, options) => {
        if (harness.liveViewHost) await harness.liveViewHost.start(tabId, options?.viewport);
        else emit({ type: "stopped", tabId, reason: "The preview has no host to watch." });
      },
      stopLiveView: async () => harness.liveViewHost?.stop(),
      sendLiveViewInput: async (input) => harness.liveViewHost?.input(input),
      onLiveViewEvent: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
    connect: async (hostId) => {
      const capabilities = await web.connect(hostId);
      // The agent waits for the reader once the client is online, as a host's snapshot says.
      queueMicrotask(() => mock.emitAgentEvent({ type: "browser-takeover-requested", request: REQUEST }));
      return [...capabilities, "browser-control", "browser-view", "browser-view-frame-point", "browser-view-clipboard"];
    },
    respondToTakeover: async (input) => {
      harness.takeoverResponses?.push({ requestId: input.requestId, decision: input.decision });
      mock.emitAgentEvent({ type: "browser-takeover-resolved", requestId: input.requestId, agentId: "chief" });
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
