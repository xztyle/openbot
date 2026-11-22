import type { BrowserControlSession, BrowserPreview, BrowserTab } from "@openbot/contracts/ipc";
import { TEAM_BROWSER_NAVIGATION_CAPABILITY } from "@openbot/contracts/team-protocol/current";
import { toast } from "@openbot/ui";
import type { AgentProfile } from "@openbot/ui/data";
import { browserAddressUrl } from "@openbot/ui/features/browser/browser-suggestions";
import { currentText } from "@openbot/ui/text";
import { createEffect, createMemo, createSignal, untrack } from "solid-js";
import { desktopAnalytics } from "../../../analytics";
import { serverSupportsCapability } from "../../servers/server-capabilities";
import { conversationPort } from "../conversation-port";
import { conversationRuntime } from "../conversation-runtime";
import type { ConversationProps, ConversationTarget, RightPanelMode } from "../conversation-types";

export interface BrowserTakeoverPreviewState {
  status: "idle" | "loading" | "ready" | "failed";
  preview: BrowserPreview | null;
}

export interface BrowserTakeoverResolutionState {
  decision: "complete" | "cancel";
  tab: BrowserTab | undefined;
  preview: BrowserPreview | null;
  previewStatus: BrowserTakeoverPreviewState["status"];
  messageMarker: string | null;
  signInBlocked?: { server: string; signingIn: boolean } | undefined;
}

/** A sign-in on this computer for a tab of a remote server's browser. Main keeps the session. */
export interface LocalSignIn {
  tabId: string;
  url: string;
  site: string;
  windowOpen: boolean;
  pending: boolean;
  error?: string | undefined;
}

function webHost(url: string | undefined): string | null {
  if (!url || !/^https?:\/\//iu.test(url)) return null;
  try {
    return new URL(url).hostname || null;
  } catch {
    return null;
  }
}

function canonicalBrowserUrl(url: string): string {
  try {
    return new URL(url).toString();
  } catch {
    return url;
  }
}

interface BrowserPanels {
  activeRightPanel: () => RightPanelMode;
  setActiveRightPanel: (mode: RightPanelMode, agentId?: string) => void;
}

/** How long a closed tab stays out of the row while the host's list still has it. */
const CLOSED_TAB_GRACE_MS = 10_000;

export interface BrowserStoreDeps {
  props: ConversationProps;
  browserOpenRequests: Map<
    string,
    {
      promise: Promise<BrowserTab | undefined>;
      serverId: string;
      agentId: string | null;
      url: string;
      existingTabIds: Set<string>;
    }
  >;
  browserAddress: () => string;
  setBrowserAddress: (address: string) => void;
  /** `cause` is the failure behind `error`. The banner shows its code. */
  setComposerError: (error: string | null, targetOverride?: ConversationTarget, cause?: unknown) => void;
  panels: BrowserPanels;
}

export function createBrowserStore(deps: BrowserStoreDeps) {
  const browserInteractionAvailable = () =>
    deps.props.browserEnabled !== false && !deps.props.browserVisibilitySuspended;
  const browserSidebarOpen = () => browserInteractionAvailable() && deps.panels.activeRightPanel() === "browser";
  const browserExpandedOpen = () =>
    browserInteractionAvailable() && deps.panels.activeRightPanel() === "browser-expanded";
  const browserPipOpen = () => browserInteractionAvailable() && deps.panels.activeRightPanel() === "browser-pip";
  const screenOpen = () => browserSidebarOpen() || browserExpandedOpen() || browserPipOpen();
  /** The tabs the host lists, the ones a close is on its way for included. */
  const listedBrowserTabs = createMemo(() => (deps.props.browserEnabled === false ? [] : deps.props.browserTabs));
  /**
   * Tabs the person closed. They leave the row at once, as in other browsers: a host answers after a
   * round trip, and a tab that stayed until then read as a click that did nothing, so the person
   * clicked again. A close that fails puts the tab back.
   */
  const [closedTabIds, setClosedTabIds] = createSignal<ReadonlySet<string>>(new Set());
  /** All tabs of the server. The full view lists them; the side panel lists only the agent's. */
  const allBrowserTabs = createMemo(() => {
    const closed = closedTabIds();
    const listed = listedBrowserTabs();
    return closed.size === 0 ? listed : listed.filter((tab) => !closed.has(tab.id));
  });
  const reopenClosedTab = (tabId: string) =>
    setClosedTabIds((current) => {
      if (!current.has(tabId)) return current;
      const next = new Set(current);
      next.delete(tabId);
      return next;
    });
  const ownsTab = (agent: Pick<AgentProfile, "id" | "threadId">, tab: BrowserTab) =>
    tab.ownerAgentId ? tab.ownerAgentId === agent.id : Boolean(agent.threadId && tab.ownerThreadId === agent.threadId);
  const tabsOwnedBy = (agent: Pick<AgentProfile, "id" | "threadId">) =>
    allBrowserTabs().filter((tab) => ownsTab(agent, tab));
  /** The agent of a tab. A tab of an old agent run has only the thread. */
  const browserTabOwner = (tab: BrowserTab) => deps.props.agents.find((agent) => ownsTab(agent, tab));
  const browserTabs = createMemo(() => {
    const agent = deps.props.agent;
    return agent ? tabsOwnedBy(agent) : [];
  });
  const closingBrowserTabIds = new Set<string>();
  createEffect(
    () => new Set(listedBrowserTabs().map((tab) => tab.id)),
    (visibleTabIds) => {
      for (const tabId of closingBrowserTabIds) {
        if (!visibleTabIds.has(tabId)) closingBrowserTabIds.delete(tabId);
      }
      // A closed tab the host no longer lists is gone for good.
      const closed = untrack(closedTabIds);
      if ([...closed].some((tabId) => !visibleTabIds.has(tabId)))
        setClosedTabIds(new Set([...closed].filter((tabId) => visibleTabIds.has(tabId))));
    },
  );
  createEffect(
    () => browserTabs().map((tab) => ({ id: tab.id, url: tab.url })),
    (tabs) => {
      const serverId = untrack(() => deps.props.server?.id ?? "local");
      const agentId = untrack(() => deps.props.agent?.id ?? null);
      for (const [requestKey, request] of deps.browserOpenRequests) {
        if (request.serverId !== serverId || request.agentId !== agentId) continue;
        const tabAppeared = tabs.some(
          (tab) => canonicalBrowserUrl(tab.url) === request.url && !request.existingTabIds.has(tab.id),
        );
        if (tabAppeared) deps.browserOpenRequests.delete(requestKey);
      }
    },
  );
  // Main shows one tab for every agent and client. When another one moves it, this conversation
  // takes back the tab it last showed, not its first tab, so the user's choice is kept. When that
  // tab is closed, the tab that slid into its place in this agent's strip takes over.
  const lastShownTabs = new Map<string, { id: string; index: number }>();
  const activeBrowserTab = createMemo(() => {
    const tabs = browserTabs();
    const agentId = deps.props.agent?.id;
    const shownIndex = tabs.findIndex((tab) => tab.id === deps.props.activeBrowserTabId);
    const shown = tabs[shownIndex];
    if (shown) {
      if (agentId) lastShownTabs.set(agentId, { id: shown.id, index: shownIndex });
      return shown;
    }
    const lastShown = agentId ? lastShownTabs.get(agentId) : undefined;
    if (!lastShown) return tabs.find((tab) => tab.id === deps.props.browserTakeover?.tabId) ?? tabs[0];
    // A popup that closed gives the view back to the page that opened it, as a browser does.
    const opener = openerOf(lastShown.id);
    return (
      tabs.find((tab) => tab.id === lastShown.id) ??
      (opener ? tabs.find((tab) => tab.id === opener) : undefined) ??
      tabs[lastShown.index] ??
      tabs[lastShown.index - 1] ??
      tabs[0]
    );
  });

  /**
   * A page that the person or the agent uses opens a new tab: a sign-in popup, or a link with
   * `target=_blank`. The view goes to the new tab, and back to the page that opened it when the new
   * tab closes. Main's active tab is one for every agent and client and can move again at once, so
   * the view does not wait for it. A remote host's tab list does not carry the opener (the frozen
   * Team API tab has no such field), so the tab that the view showed when the new one came is the
   * opener here.
   */
  const localOpeners = new Map<string, string>();
  const openerOf = (tabId: string) =>
    allBrowserTabs().find((tab) => tab.id === tabId)?.openerTabId ?? localOpeners.get(tabId);
  /** The tabs of each agent that this view has seen. A tab that is not in it is new. */
  const seenTabs = new Map<string, Set<string>>();
  /** The tab that each agent's view showed before the last change, which is the opener of a new tab. */
  const viewedTabs = new Map<string, string>();
  createEffect(
    () => ({ agentId: deps.props.agent?.id, tabs: browserTabs() }),
    ({ agentId, tabs }) => {
      if (!agentId) return;
      const ids = tabs.map((tab) => tab.id);
      const seen = seenTabs.get(agentId);
      seenTabs.set(agentId, new Set(ids));
      const all = untrack(allBrowserTabs);
      const viewed = viewedTabs.get(agentId);
      // The page that the view showed closed: a popup gives the view back to its opener.
      if (viewed && !ids.includes(viewed)) {
        const opener = localOpeners.get(viewed) ?? all.find((tab) => tab.id === viewed)?.openerTabId;
        const back = opener ? tabs.find((tab) => tab.id === opener) : undefined;
        if (back) {
          lastShownTabs.set(agentId, { id: back.id, index: ids.indexOf(back.id) });
          viewedTabs.set(agentId, back.id);
          untrack(() => activateBrowserTab(back.id));
        }
      }
      // The first list of an agent, and many tabs at once, are not a tab that a page opened.
      if (!seen || seen.size === 0) return;
      const added = ids.filter((id) => !seen.has(id));
      const newTabId = added.at(-1);
      if (!newTabId || added.length > 2 || !viewed || !ids.includes(viewed)) return;
      const opener = all.find((tab) => tab.id === newTabId)?.openerTabId;
      if (opener && opener !== viewed) return;
      localOpeners.set(newTabId, viewed);
      // Closed tabs keep their entry so the view can go back; only the oldest are forgotten.
      if (localOpeners.size > 200) localOpeners.delete(localOpeners.keys().next().value ?? "");
      lastShownTabs.set(agentId, { id: newTabId, index: ids.indexOf(newTabId) });
      viewedTabs.set(agentId, newTabId);
      if (untrack(() => deps.props.activeBrowserTabId) !== newTabId) untrack(() => activateBrowserTab(newTabId));
    },
  );
  createEffect(
    () => ({ agentId: deps.props.agent?.id, tabId: activeBrowserTab()?.id }),
    ({ agentId, tabId }) => {
      if (agentId && tabId) viewedTabs.set(agentId, tabId);
    },
  );
  const browserTakeoverTab = createMemo(() => {
    const tabId = deps.props.browserTakeover?.tabId;
    // A channel has no agent of its own, so it finds the tab among all tabs. Main already checked that the
    // agent of the request owns it.
    return tabId ? allBrowserTabs().find((tab) => tab.id === tabId) : undefined;
  });
  /**
   * Whether the step the agent asked for is on this tab: the takeover tab, or a popup that it opened,
   * such as the window of a sign-in. The dock over such a popup hands the page back, as over its opener.
   */
  const browserTakeoverCovers = (tabId: string | undefined): boolean => {
    const takeoverId = deps.props.browserTakeover?.tabId;
    if (!takeoverId || !tabId) return false;
    const visited = new Set<string>();
    for (let current: string | undefined = tabId; current && !visited.has(current); current = openerOf(current)) {
      if (current === takeoverId) return true;
      visited.add(current);
    }
    return false;
  };
  /**
   * The tab that the takeover card shows live: the takeover tab, or a popup that it opened, which
   * the view follows as the full view does. The card used to show the takeover tab only, so a click
   * on "Continue with Google" in the card seemed to do nothing while the popup waited on the host.
   */
  const browserTakeoverLiveTab = createMemo(() => {
    const takeover = browserTakeoverTab();
    const active = activeBrowserTab();
    return active && browserTakeoverCovers(active.id) ? active : takeover;
  });
  const [browserTakeoverPreview, setBrowserTakeoverPreview] = createSignal<BrowserTakeoverPreviewState>({
    status: "idle",
    preview: null,
  });
  let browserTakeoverPreviewKey: string | null = null;
  let browserTakeoverPreviewGeneration = 0;
  createEffect(
    () => ({
      request: deps.props.browserTakeover,
      tab: browserTakeoverTab(),
      suspended: deps.props.browserVisibilitySuspended,
    }),
    ({ request, tab, suspended }) => {
      if (!request || request.secret || suspended) {
        browserTakeoverPreviewKey = null;
        browserTakeoverPreviewGeneration += 1;
        setBrowserTakeoverPreview({ status: "idle", preview: null });
        return;
      }

      const requestKey = String(request.requestId);
      if (!tab) {
        if (browserTakeoverPreviewKey !== requestKey) {
          setBrowserTakeoverPreview({ status: "loading", preview: null });
        }
        return;
      }
      if (browserTakeoverPreviewKey === requestKey) return;

      browserTakeoverPreviewKey = requestKey;
      const generation = ++browserTakeoverPreviewGeneration;
      setBrowserTakeoverPreview({ status: "loading", preview: null });
      void conversationRuntime(deps.props)
        .browser.capturePreview(tab.id)
        .then((preview) => {
          if (browserTakeoverPreviewGeneration !== generation) return;
          setBrowserTakeoverPreview({ status: "ready", preview });
        })
        .catch(() => {
          if (browserTakeoverPreviewGeneration !== generation) return;
          setBrowserTakeoverPreview({ status: "failed", preview: null });
        });
    },
  );
  const latestMessageMarker = createMemo(() => {
    const message = deps.props.messages.at(-1);
    return message
      ? `${message.id}:${message.body.length}:${message.streaming === true ? "streaming" : "settled"}`
      : null;
  });
  const [browserTakeoverResolution, setBrowserTakeoverResolution] = createSignal<BrowserTakeoverResolutionState | null>(
    null,
  );
  createEffect(
    () => deps.props.browserTakeover?.requestId,
    (requestId) => {
      if (requestId !== undefined) setBrowserTakeoverResolution(null);
    },
  );
  createEffect(latestMessageMarker, (messageMarker) => {
    const resolution = untrack(browserTakeoverResolution);
    if (resolution && resolution.messageMarker !== messageMarker) setBrowserTakeoverResolution(null);
  });
  /**
   * The answer on its way for a request. The card, the full view's dock and the Done of a channel
   * card can all answer, and the agent's waiting tool call takes one answer: a second press while
   * the first is on its way gets the first one's result.
   */
  let answering: { requestId: string; result: Promise<boolean> } | null = null;
  const respondToBrowserTakeover = (decision: "complete" | "cancel"): Promise<boolean> => {
    const request = deps.props.browserTakeover;
    if (!request) return Promise.resolve(false);
    const requestId = String(request.requestId);
    if (answering?.requestId === requestId) return answering.result;
    const result = answerBrowserTakeover(decision).finally(() => {
      if (answering?.result === result) answering = null;
    });
    answering = { requestId, result };
    return result;
  };
  const answerBrowserTakeover = async (decision: "complete" | "cancel") => {
    const resolution = {
      decision,
      tab: browserTakeoverTab(),
      preview: browserTakeoverPreview().preview,
      previewStatus: browserTakeoverPreview().status,
      messageMarker: latestMessageMarker(),
      signInBlocked: blockedTakeoverSignIn(),
    } satisfies BrowserTakeoverResolutionState;
    const completed = await deps.props.onRespondToBrowserTakeover(decision);
    if (completed && latestMessageMarker() === resolution.messageMarker) setBrowserTakeoverResolution(resolution);
    return completed;
  };
  let previousBrowserTabCount = 0;
  createEffect(
    () => ({ count: browserTabs().length, open: screenOpen(), enabled: deps.props.browserEnabled !== false }),
    ({ count, open, enabled }) => {
      if (!enabled) return;
      const browserWasClosed = open && previousBrowserTabCount > 0 && count === 0;
      previousBrowserTabCount = count;
      if (browserWasClosed) deps.panels.setActiveRightPanel("browser");
    },
  );

  /**
   * A takeover request used to expand the browser over the conversation the moment it arrived,
   * which took the window away from whatever the user was reading for a step they may not want to
   * start yet. The card carries the page preview instead, and pressing that preview is what opens
   * the page -- the same gesture as a preview card in the browser sidebar.
   */
  /** Whether this client can show the tab of the takeover. A web client without the browser view cannot. */
  const canOpenBrowserTakeoverTab = () => Boolean(browserTakeoverTab()) && deps.props.browserEnabled !== false;
  function openBrowserTakeoverTab() {
    const tab = browserTakeoverTab();
    if (!tab) return;
    if (browserTabs().some((entry) => entry.id === tab.id)) {
      if (deps.props.activeBrowserTabId !== tab.id) activateBrowserTab(tab.id);
      deps.panels.setActiveRightPanel("browser-expanded");
      return;
    }
    // In a channel, the page opens in the chat of the agent that owns the tab. That chat mounts a new store,
    // so main shows the tab first.
    const owner = browserTabOwner(tab);
    if (!owner || !browserInteractionAvailable() || closingBrowserTabIds.has(tab.id)) return;
    deps.props.onActivateBrowserTab(tab.id);
    deps.panels.setActiveRightPanel("browser-expanded", owner.id);
    deps.props.onSelectAgent(owner.id);
  }

  const [localSignIn, setLocalSignIn] = createSignal<LocalSignIn | null>(null);
  /** Only the desktop app opens a window on this computer, and only for a web page of a remote server. */
  const canSignInLocally = (tab: BrowserTab | undefined) =>
    !deps.props.runtime &&
    deps.props.server?.kind === "remote" &&
    serverSupportsCapability(deps.props.server, "browser-sign-in") &&
    webHost(tab?.url) !== null;

  /** A channel opens the takeover page in the owner's chat and this store unmounts, so only the owner's chat signs in. */
  const canSignInTakeoverLocally = () => {
    const tab = browserTakeoverTab();
    return tab !== undefined && browserTabs().some((entry) => entry.id === tab.id) && canSignInLocally(tab);
  };

  /** The agent found that the takeover page refused the sign-in from the server, and this computer can sign in. */
  function blockedTakeoverSignIn() {
    const tab = browserTakeoverTab();
    if (deps.props.browserTakeover?.reason !== "sign-in-blocked" || !tab || !canSignInTakeoverLocally())
      return undefined;
    return { server: deps.props.server?.name ?? "", signingIn: localSignIn()?.tabId === tab.id };
  }

  function updateLocalSignIn(tabId: string, change: Partial<LocalSignIn>) {
    setLocalSignIn((current) => (current?.tabId === tabId ? { ...current, ...change } : current));
  }

  /** The window opens on this computer, or comes to the front when it is open. */
  function openLocalSignInWindow(tabId: string, url: string) {
    updateLocalSignIn(tabId, { windowOpen: true, error: undefined });
    waitForLocalSignIn(tabId, url);
  }

  /** The request ends when the person closes the window, or when the site in it looks signed in. */
  function waitForLocalSignIn(tabId: string, url: string) {
    conversationPort()
      .browser.openLocalSignIn({ tabId, url })
      .then(
        ({ signedIn }) => {
          if (!signedIn) updateLocalSignIn(tabId, { windowOpen: false });
          else if (localSignIn()?.tabId === tabId) void finishLocalSignIn(true);
        },
        (error: unknown) =>
          updateLocalSignIn(tabId, {
            windowOpen: false,
            error: currentText().errorMessage(error, currentText().t("browser.signIn.failed")),
          }),
      );
  }

  function startLocalSignIn(tabId: string) {
    const tab = allBrowserTabs().find((entry) => entry.id === tabId);
    const site = webHost(tab?.url);
    if (!tab || !site) return;
    setLocalSignIn({ tabId, url: tab.url, site, windowOpen: true, pending: false });
    openLocalSignInWindow(tabId, tab.url);
  }

  /** The takeover card starts it: the page opens in the full view, where the dialog of the sign-in is. */
  function signInTakeoverTabLocally() {
    const tab = browserTakeoverTab();
    if (!tab) return;
    openBrowserTakeoverTab();
    startLocalSignIn(tab.id);
  }

  /**
   * Sends the sign-in to the server tab. Done sends it as it is. The window sends it with `check`
   * when the site looks signed in: then the window stays open while the server tab shows a sign-in
   * step, and the wait starts again.
   */
  async function finishLocalSignIn(check = false) {
    const current = localSignIn();
    if (!current || current.pending) return;
    const { t, errorMessage } = currentText();
    const server = deps.props.server?.name ?? "";
    updateLocalSignIn(current.tabId, { pending: true, error: undefined });
    try {
      const result = await conversationPort().browser.finishLocalSignIn({ send: true, check });
      if (!result?.signedIn) {
        // Without a result main has no sign-in left, so the window must open again.
        updateLocalSignIn(current.tabId, {
          pending: false,
          windowOpen: result !== null && (check || current.windowOpen),
          error:
            result && result.cookies > 0
              ? t("browser.signIn.stillSignedOut", { site: current.site, server })
              : t("browser.signIn.notFound", { site: current.site }),
        });
        if (result && check) waitForLocalSignIn(current.tabId, current.url);
        return;
      }
      setLocalSignIn(null);
      toast.success(t("browser.signIn.sent", { site: current.site, server }));
      // The agent waits for the person on this tab. The host loaded the page again, so it can continue.
      if (deps.props.browserTakeover?.tabId === current.tabId) void respondToBrowserTakeover("complete");
    } catch (error) {
      updateLocalSignIn(current.tabId, { pending: false, error: errorMessage(error, t("browser.signIn.failed")) });
    }
  }

  function cancelLocalSignIn() {
    if (!localSignIn()) return;
    setLocalSignIn(null);
    void conversationPort()
      .browser.finishLocalSignIn({ send: false })
      .catch(() => undefined);
  }

  const agentsByThreadId = createMemo(() => new Map(deps.props.agents.map((agent) => [agent.threadId, agent])));

  // Single pass, no copy and no localeCompare sort per evaluation.
  const newestSession = (sessions: readonly BrowserControlSession[]) => {
    let acting: BrowserControlSession | undefined;
    let newest: BrowserControlSession | undefined;
    for (const session of sessions) {
      if (!newest || session.startedAt > newest.startedAt) newest = session;
      if (session.phase === "acting" && (!acting || session.startedAt > acting.startedAt)) acting = session;
    }
    return acting ?? newest;
  };

  const activeBrowserControl = createMemo(() => {
    if (deps.props.browserEnabled === false) return undefined;
    const sessions = deps.props.browserControlState.sessions;
    const activeTab = activeBrowserTab();
    const forActiveTab = activeTab?.ownerThreadId
      ? sessions.filter((session) => session.threadId === activeTab.ownerThreadId)
      : [];
    const forActiveAgent = deps.props.agent?.threadId
      ? sessions.filter((session) => session.threadId === deps.props.agent?.threadId)
      : [];
    const candidates = forActiveTab.length > 0 ? forActiveTab : forActiveAgent;
    return newestSession(candidates);
  });
  const actingBrowserControl = createMemo(() => {
    const control = activeBrowserControl();
    return control?.phase === "acting" ? control : undefined;
  });
  const browserControlAgent = createMemo(() => {
    const control = activeBrowserControl();
    return control ? agentsByThreadId().get(control.threadId) : undefined;
  });
  const browserControlForTab = (tab: BrowserTab) => {
    const sessions = deps.props.browserControlState.sessions.filter(
      (session) =>
        session.tabId === tab.id ||
        (session.tabId === null && tab.id === activeBrowserTab()?.id && session.threadId === tab.ownerThreadId),
    );
    return newestSession(sessions);
  };
  const browserControllerForTab = (tab: BrowserTab) => {
    const control = browserControlForTab(tab);
    return control ? agentsByThreadId().get(control.threadId) : undefined;
  };

  /** Opens the address in the shown tab, or in a new tab. Resolves with the new tab, if one opened. */
  async function openBrowserAddress(address = deps.browserAddress(), newTab = false): Promise<BrowserTab | undefined> {
    if (!browserInteractionAvailable()) return;
    const value = address.trim();
    if (!value) return;
    const targetAgentId = deps.props.agent?.id;
    const target = targetAgentId ? { agentId: targetAgentId, serverId: deps.props.server?.id ?? "local" } : undefined;
    const analytics = desktopAnalytics.scope();
    const url = browserAddressUrl(value);
    // A host that cannot move an existing tab to an address gets a new tab for it instead: the
    // released navigate route carries a direction only.
    const canNavigateCurrentTab = serverSupportsCapability(deps.props.server, TEAM_BROWSER_NAVIGATION_CAPABILITY);
    const currentTab = newTab || !canNavigateCurrentTab ? undefined : activeBrowserTab();
    if (currentTab) {
      if (closingBrowserTabIds.has(currentTab.id)) return;
      try {
        await conversationRuntime(deps.props).browser.navigate({ tabId: currentTab.id, url });
      } catch (error) {
        deps.setComposerError(currentText().t("browser.error.openAddress"), target, error);
      }
      return;
    }
    const serverId = deps.props.server?.id ?? "local";
    const agentId = deps.props.agent?.id ?? null;
    const canonicalUrl = canonicalBrowserUrl(url);
    const requestKey = JSON.stringify([serverId, agentId, canonicalUrl]);
    const pendingRequest = deps.browserOpenRequests.get(requestKey);
    if (pendingRequest) return pendingRequest.promise;
    const request = (async () => {
      try {
        const tab = await conversationRuntime(deps.props).browser.open({
          url,
          ownerThreadId: deps.props.agent?.threadId ?? null,
          ownerAgentId: deps.props.agent?.id ?? null,
          focus: true,
        });
        deps.setBrowserAddress(tab.url);
        analytics.track("browser_action", { action: "open", result: "succeeded" });
        return tab;
      } catch {
        deps.setBrowserAddress(url);
        analytics.track("browser_action", {
          action: "open",
          result: "failed",
          failure_code: "browser_open_failed",
        });
        return undefined;
      }
    })();
    const pendingRequestState = {
      promise: request,
      serverId,
      agentId,
      url: canonicalUrl,
      existingTabIds: new Set(browserTabs().map((tab) => tab.id)),
    };
    deps.browserOpenRequests.set(requestKey, pendingRequestState);
    try {
      return await request;
    } finally {
      if (deps.browserOpenRequests.get(requestKey) === pendingRequestState) {
        deps.browserOpenRequests.delete(requestKey);
      }
    }
  }

  async function closeBrowserTab(tabId: string) {
    if (
      !browserInteractionAvailable() ||
      closingBrowserTabIds.has(tabId) ||
      !allBrowserTabs().some((tab) => tab.id === tabId)
    ) {
      return;
    }
    const agentId = deps.props.agent?.id;
    const target = agentId ? { agentId, serverId: deps.props.server?.id ?? "local" } : undefined;
    closingBrowserTabIds.add(tabId);
    setClosedTabIds((current) => new Set(current).add(tabId));
    try {
      await deps.props.onCloseBrowserTab(tabId);
      // A host that said yes and still lists the tab after a while kept it: the row shows it again.
      setTimeout(() => {
        if (untrack(listedBrowserTabs).some((tab) => tab.id === tabId)) reopenClosedTab(tabId);
      }, CLOSED_TAB_GRACE_MS);
    } catch (error) {
      reopenClosedTab(tabId);
      deps.setComposerError(currentText().t("browser.error.closeTab"), target, error);
    } finally {
      closingBrowserTabIds.delete(tabId);
    }
  }

  function activateBrowserTab(tabId: string) {
    if (
      !browserInteractionAvailable() ||
      closingBrowserTabIds.has(tabId) ||
      !browserTabs().some((tab) => tab.id === tabId)
    ) {
      return;
    }
    deps.props.onActivateBrowserTab(tabId);
  }

  /**
   * Makes the tab the one that its owner shows. The conversation of the owner then activates it when it
   * opens, so the switch to the owner's chat does not bring back the tab that the owner showed last.
   */
  function showBrowserTabOf(agent: Pick<AgentProfile, "id" | "threadId">, tabId: string) {
    if (!browserInteractionAvailable() || closingBrowserTabIds.has(tabId)) return false;
    const index = tabsOwnedBy(agent).findIndex((tab) => tab.id === tabId);
    if (index < 0) return false;
    lastShownTabs.set(agent.id, { id: tabId, index });
    return true;
  }

  async function reloadBrowserTab(tabId: string) {
    if (
      !browserInteractionAvailable() ||
      closingBrowserTabIds.has(tabId) ||
      !browserTabs().some((tab) => tab.id === tabId)
    ) {
      return;
    }
    const agentId = deps.props.agent?.id;
    const target = agentId ? { agentId, serverId: deps.props.server?.id ?? "local" } : undefined;
    const analytics = desktopAnalytics.scope();
    try {
      await conversationRuntime(deps.props).browser.reload(tabId);
      analytics.track("browser_action", { action: "reload", result: "succeeded" });
    } catch (error) {
      deps.setComposerError(currentText().t("browser.error.reloadTab"), target, error);
      analytics.track("browser_action", {
        action: "reload",
        result: "failed",
        failure_code: "browser_reload_failed",
      });
    }
  }

  async function stopBrowserTab(tabId: string) {
    if (
      !browserInteractionAvailable() ||
      closingBrowserTabIds.has(tabId) ||
      !browserTabs().some((tab) => tab.id === tabId)
    ) {
      return;
    }
    const agentId = deps.props.agent?.id;
    const target = agentId ? { agentId, serverId: deps.props.server?.id ?? "local" } : undefined;
    try {
      await conversationRuntime(deps.props).browser.stop(tabId);
    } catch (error) {
      deps.setComposerError(currentText().t("browser.error.stopLoading"), target, error);
    }
  }

  async function navigateBrowserTab(tabId: string, direction: "back" | "forward") {
    if (
      !browserInteractionAvailable() ||
      closingBrowserTabIds.has(tabId) ||
      !browserTabs().some((tab) => tab.id === tabId)
    ) {
      return;
    }
    const agentId = deps.props.agent?.id;
    const target = agentId ? { agentId, serverId: deps.props.server?.id ?? "local" } : undefined;
    try {
      await conversationRuntime(deps.props).browser.navigate({ tabId, direction });
    } catch (error) {
      deps.setComposerError(
        currentText().t(direction === "back" ? "browser.error.navigateBack" : "browser.error.navigateForward"),
        target,
        error,
      );
    }
  }

  /** The tabs that the user took in this view. Only the full view shows the control that gives them back. */
  const takenBrowserTabIds = new Set<string>();

  /** The owning agent's browser calls on this tab wait until the release. */
  async function takeBrowserControl(tabId: string) {
    if (await setBrowserControl(tabId, "take")) takenBrowserTabIds.add(tabId);
  }

  async function releaseBrowserControl(tabId: string) {
    if (await setBrowserControl(tabId, "release")) takenBrowserTabIds.delete(tabId);
  }

  // The user leaves the full view: the agents get their pages back, so no tab waits with no control in sight.
  let fullViewWasOpen = false;
  createEffect(browserExpandedOpen, (open) => {
    const closed = fullViewWasOpen && !open;
    fullViewWasOpen = open;
    if (!closed) return;
    const held = new Set(untrack(allBrowserTabs).flatMap((tab) => (tab.userControl ? [tab.id] : [])));
    for (const tabId of [...takenBrowserTabIds]) {
      if (held.has(tabId)) void releaseBrowserControl(tabId);
      else takenBrowserTabIds.delete(tabId);
    }
  });

  /** Whether the host took the request. */
  async function setBrowserControl(tabId: string, action: "take" | "release"): Promise<boolean> {
    // The user gives back a tab of any agent; the user takes only a tab of this agent.
    const tabs = action === "take" ? browserTabs() : allBrowserTabs();
    if (!browserInteractionAvailable() || closingBrowserTabIds.has(tabId) || !tabs.some((tab) => tab.id === tabId)) {
      return false;
    }
    const agentId = deps.props.agent?.id;
    const target = agentId ? { agentId, serverId: deps.props.server?.id ?? "local" } : undefined;
    const browser = conversationRuntime(deps.props).browser;
    try {
      if (action === "take") await browser.takeControl(tabId);
      else await browser.releaseControl(tabId);
      return true;
    } catch (error) {
      deps.setComposerError(
        currentText().t(action === "take" ? "browser.error.takeControl" : "browser.error.releaseControl"),
        target,
        error,
      );
      return false;
    }
  }

  return {
    browserInteractionAvailable,
    browserSidebarOpen,
    browserExpandedOpen,
    browserPipOpen,
    screenOpen,
    allBrowserTabs,
    browserTabs,
    activeBrowserTab,
    browserTakeoverTab,
    browserTakeoverLiveTab,
    browserTakeoverCovers,
    browserTakeoverPreview,
    browserTakeoverResolution,
    respondToBrowserTakeover,
    openBrowserTakeoverTab,
    canOpenBrowserTakeoverTab,
    localSignIn: {
      state: localSignIn,
      canStart: canSignInLocally,
      start: startLocalSignIn,
      canStartForTakeover: canSignInTakeoverLocally,
      startForTakeover: signInTakeoverTabLocally,
      blockedTakeover: blockedTakeoverSignIn,
      reopen: openLocalSignInWindow,
      finish: () => finishLocalSignIn(),
      cancel: cancelLocalSignIn,
    },
    activeBrowserControl,
    actingBrowserControl,
    browserControlAgent,
    browserControlForTab,
    browserControllerForTab,
    openBrowserAddress,
    closeBrowserTab,
    activateBrowserTab,
    showBrowserTabOf,
    browserTabOwner,
    reloadBrowserTab,
    stopBrowserTab,
    navigateBrowserTab,
    takeBrowserControl,
    releaseBrowserControl,
  };
}
