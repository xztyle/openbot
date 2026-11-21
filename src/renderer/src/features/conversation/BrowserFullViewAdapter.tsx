import type { BrowserTab } from "@openbot/contracts/ipc";
import { BROWSER_PROFILES_CAPABILITY } from "@openbot/contracts/team-protocol/browser-profiles-v1";
import { BROWSER_USER_CONTROL_CAPABILITY } from "@openbot/contracts/team-protocol/browser-user-control-v1";
import BrowserFullView from "@openbot/ui/features/browser/BrowserFullView";
import BrowserLocalSignInDialog from "@openbot/ui/features/browser/BrowserLocalSignInDialog";
import { BROWSER_NEW_TAB_URL } from "@openbot/ui/features/browser/browser-suggestions";
import { createEffect, createMemo, createSignal, onCleanup, Show, untrack } from "solid-js";
import { desktopBrowserProfileCalls } from "../browser/browser-profiles-port";
import {
  browserSessionHistory,
  canReopenBrowserTab,
  moveBrowserTab,
  orderedBrowserTabs,
  placeNextBrowserTab,
  recordBrowserPages,
  rememberClosedBrowserTab,
  syncBrowserTabOrder,
  takeClosedBrowserTab,
} from "../browser/browser-tab-session";
import { createBrowserTabProfiles } from "../browser/stores/browser-tab-profiles";
import { serverSupportsCapability } from "../servers/server-capabilities";
import { BrowserDockAdapter } from "./BrowserDockAdapter";
import { conversationPort } from "./conversation-port";
import { useConversationViewScope } from "./conversation-scope";

/**
 * The full browser view of the conversation. The order of the tabs, the closed tabs and the pages of the
 * session stay in this window (`browser-tab-session.ts`); the tabs themselves are main's.
 */
export default function BrowserFullViewAdapter() {
  const {
    props,
    activateBrowserTab,
    activeBrowserTab,
    allBrowserTabs,
    browserControlForTab,
    browserControllerForTab,
    browserExpandedOpen,
    browserTabOwner,
    browserTabs,
    closeBrowserTab,
    navigateBrowserTab,
    openBrowserAddress,
    reloadBrowserTab,
    stopBrowserTab,
    setActiveRightPanel,
    setBrowserSurfaceElement,
    showBrowserPip,
    showBrowserTabOf,
    localSignIn,
    takeBrowserControl,
  } = useConversationViewScope();
  const serverId = () => props.server?.id ?? "";
  const tabs = createMemo(() => orderedBrowserTabs(serverId(), allBrowserTabs()));
  /** The row shows the tabs of this agent unless the user asks for the tabs of all agents. */
  const [showAllTabs, setShowAllTabs] = createSignal(false);
  const shownTabs = createMemo(() => {
    if (showAllTabs()) return tabs();
    const own = new Set(browserTabs().map((tab) => tab.id));
    return tabs().filter((tab) => own.has(tab.id));
  });
  /**
   * The tabs of this agent that nobody uses now: not the tab on the screen, not a tab that a person
   * controls, and not the tab the agent asked the user to use.
   */
  /** An agent acts on the tab on the screen, and nobody has taken it: the live view holds the input. */
  const liveViewLocked = () => {
    const tab = activeBrowserTab();
    return Boolean(
      tab &&
        !tab.userControl &&
        props.browserTakeover?.tabId !== tab.id &&
        browserControlForTab(tab)?.phase === "acting",
    );
  };
  const takeOverLiveView = () => {
    const tab = activeBrowserTab();
    if (tab) void takeBrowserControl(tab.id);
  };
  const inactiveTabIds = createMemo(() => {
    const activeId = activeBrowserTab()?.id;
    const takeoverId = props.browserTakeover?.tabId;
    return browserTabs()
      .filter((tab) => tab.id !== activeId && tab.id !== takeoverId && !tab.userControl)
      .map((tab) => tab.id);
  });
  // Any member who sees a tab reads its profile label, from a host that serves `browser-profiles-v1`.
  const readTabProfiles = createMemo(() => {
    if (props.runtime) return props.runtime.browserProfiles?.tabProfiles;
    const server = props.server;
    return server && serverSupportsCapability(server, BROWSER_PROFILES_CAPABILITY)
      ? desktopBrowserProfileCalls(server.id).tabProfiles
      : undefined;
  });
  const profileForTab = createBrowserTabProfiles(readTabProfiles, allBrowserTabs);

  createEffect(
    () => ({ id: serverId(), listed: allBrowserTabs() }),
    // The order is read to change it, not to run again when it changes.
    ({ id, listed }) => untrack(() => syncBrowserTabOrder(id, listed)),
  );

  createEffect(
    () => ({
      id: serverId(),
      pages: allBrowserTabs().map((tab) => ({ tabId: tab.id, url: tab.url, title: tab.title })),
    }),
    ({ id, pages }) => recordBrowserPages(id, pages),
  );

  async function openTab(url: string, placement: { afterId?: string; index?: number }) {
    placeNextBrowserTab(serverId(), placement);
    const tab = await openBrowserAddress(url, true);
    if (!tab) placeNextBrowserTab(serverId(), {});
    return tab;
  }

  /**
   * The dock is the composer of the conversation, so a tab of another agent brings its chat: the page stays
   * open, and the dock sends, stops and edits the queue of the agent that owns the tab.
   */
  function activateTab(tabId: string) {
    if (browserTabs().some((tab) => tab.id === tabId)) {
      activateBrowserTab(tabId);
      return;
    }
    const tab = tabs().find((entry) => entry.id === tabId);
    const owner = tab && browserTabOwner(tab);
    if (!owner || !showBrowserTabOf(owner, tabId)) return;
    setActiveRightPanel("browser-expanded", owner.id);
    props.onSelectAgent(owner.id);
  }

  function closeTabs(tabIds: readonly string[]) {
    const order = tabs();
    // The tab with the lowest index is the first to open again, so each one goes back to its place.
    const closing = tabIds
      .map((tabId) => ({
        tab: order.find((tab) => tab.id === tabId),
        index: order.findIndex((tab) => tab.id === tabId),
      }))
      .filter((entry): entry is { tab: BrowserTab; index: number } => entry.tab !== undefined)
      .sort((left, right) => right.index - left.index);
    for (const { tab, index } of closing) {
      rememberClosedBrowserTab(serverId(), tab, index);
      void closeBrowserTab(tab.id);
    }
  }

  // The session of the sign-in stays in main only while this dialog can finish it.
  onCleanup(localSignIn.cancel);

  return (
    <BrowserFullView
      open={browserExpandedOpen()}
      macWindowControls={props.platform === "darwin"}
      shortcuts={props.runtime ? undefined : props.platform === "darwin" ? "mac" : "pc"}
      tabs={shownTabs()}
      activeTab={activeBrowserTab()}
      showAllTabs={showAllTabs()}
      // A view with tabs of one agent only has nothing more to show.
      onShowAllTabs={tabs().length > browserTabs().length || showAllTabs() ? setShowAllTabs : undefined}
      onCloseInactiveTabs={inactiveTabIds().length > 0 ? () => closeTabs(inactiveTabIds()) : undefined}
      history={browserSessionHistory(serverId())}
      canReopen={canReopenBrowserTab(serverId())}
      controlForTab={browserControlForTab}
      controllerForTab={browserControllerForTab}
      ownerForTab={browserTabOwner}
      profileForTab={profileForTab}
      onActivateTab={activateTab}
      onCloseTabs={closeTabs}
      onNewTab={(afterId) => openTab(BROWSER_NEW_TAB_URL, afterId === undefined ? {} : { afterId })}
      onDuplicateTab={(tabId) => {
        const tab = tabs().find((entry) => entry.id === tabId);
        if (tab) void openTab(tab.url, { afterId: tab.id });
      }}
      onMoveTab={(tabId, index) => {
        // The index is a place in the row as it shows now. The order covers all tabs, so it moves the tab
        // to the place of the tab it lands on.
        const target = shownTabs()[index];
        const to = target ? tabs().findIndex((tab) => tab.id === target.id) : index;
        moveBrowserTab(serverId(), tabs(), tabId, to < 0 ? index : to);
      }}
      onReopenTab={() => {
        const closed = takeClosedBrowserTab(serverId());
        if (closed) void openTab(closed.url, { index: closed.index });
      }}
      onReload={(tabId) => void reloadBrowserTab(tabId)}
      onStop={(tabId) => void stopBrowserTab(tabId)}
      onNavigate={(tabId, direction) => void navigateBrowserTab(tabId, direction)}
      onOpenAddress={(url, tabId) => void openBrowserAddress(url, tabId === undefined)}
      canEnterPip={!props.runtime}
      onSurface={setBrowserSurfaceElement}
      liveViewTabId={
        props.server?.kind === "remote" && serverSupportsCapability(props.server, "browser-view")
          ? (activeBrowserTab()?.id ?? null)
          : null
      }
      liveViewRuntime={props.browserRuntime ?? conversationPort().browser}
      liveViewClipboard={serverSupportsCapability(props.server, "browser-view-clipboard")}
      liveViewOnline={props.server?.state === "online"}
      liveViewLocked={liveViewLocked()}
      onLiveViewTakeOver={
        serverSupportsCapability(props.server, BROWSER_USER_CONTROL_CAPABILITY) ? takeOverLiveView : undefined
      }
      onBack={() => setActiveRightPanel("browser")}
      onEnterPip={props.runtime ? () => undefined : showBrowserPip}
      onSignInLocally={localSignIn.canStart(activeBrowserTab()) ? localSignIn.start : undefined}
      // A local tab is a native view above this window, so its dock goes in the overlay above the page.
      dock={<BrowserDockAdapter tab={activeBrowserTab()} overlay={!props.runtime && props.server?.kind === "local"} />}
      dialogs={
        <Show when={localSignIn.state()}>
          {(current) => (
            <BrowserLocalSignInDialog
              open
              site={current().site}
              server={props.server?.name ?? ""}
              windowOpen={current().windowOpen}
              pending={current().pending}
              error={current().error}
              onReopen={() => localSignIn.reopen(current().tabId, current().url)}
              onCancel={localSignIn.cancel}
              onDone={localSignIn.finish}
            />
          )}
        </Show>
      }
    />
  );
}
