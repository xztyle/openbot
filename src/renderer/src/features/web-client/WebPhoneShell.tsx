import { GENERAL_SPACE_ID } from "@openbot/contracts/ipc";
import { isDynamicRecord } from "@openbot/contracts/runtime-values";
import {
  ActionSheet,
  type ActionSheetItem,
  ArrowLeftRight,
  Bell,
  Blocks,
  BookOpen,
  Bookmark,
  Bot,
  Briefcase,
  Coins,
  Gauge,
  HardDrive,
  Hash,
  IconButton,
  Inbox,
  Kanban,
  KeyRound,
  LayoutDashboard,
  MessageSquareText,
  MessagesSquare,
  Network,
  Pencil,
  Plus,
  Search,
  ShieldCheck,
  Sparkles,
  SquarePen,
  Sunrise,
  Target,
  UserAvatar,
  Workflow,
} from "@openbot/ui";
import {
  type PhoneChip,
  PhoneChips,
  PhoneHomeHeader,
  type PhoneMoreRow,
  PhoneMoreScreen,
  type PhoneMoreSection,
  type PhoneSwitcherServer,
  PhoneSwitcherSheet,
} from "@openbot/ui/features/workspace/PhoneScreens";
import { type PhoneTab, PhoneTabBar } from "@openbot/ui/features/workspace/PhoneTabBar";
import type { WorkspaceView } from "@openbot/ui/features/workspace/WorkspaceSidebar";
import { useText } from "@openbot/ui/text";
import type { JSX } from "@solidjs/web";
import { createMemo, createSignal, Match, Switch } from "solid-js";
import { useWorkspaceMenu, WorkspaceSidebarPane } from "../workspace/WorkspaceSidebarPane";
import { WorkspaceTodayView } from "../workspace/WorkspaceToday";
import { WorkspaceMentions } from "../workspace/WorkspaceView";
import { WorkspaceViewPane } from "../workspace/WorkspaceViews";
import { useWorkspace } from "../workspace/workspace-context";
import { useDecisionQueue } from "../workspace/workspace-decisions";
import { openInsightTab } from "../workspace/workspace-insight-report";

/**
 * The tabs of the phone workspace: Today (what waits on the owner, who works, the briefing), Chat
 * (the space's channels and DMs), Agents (the fleet and its views) and Inbox (mentions and replies),
 * around a centre "+". More (the account, the views and the server's pages) opens from Today's header.
 */
export type WebPhoneTab = "today" | "chat" | "agents" | "inbox" | "more";

const PHONE_TABS: readonly WebPhoneTab[] = ["today", "chat", "agents", "inbox", "more"];
/** The key of the history state that holds the tab of the entry. */
export const PHONE_TAB_KEY = "openbotPhoneTab";

/** The tab that a history entry holds, or null for an entry without one. */
export function phoneTabOfState(state: unknown): WebPhoneTab | null {
  const value = isDynamicRecord(state) ? state[PHONE_TAB_KEY] : undefined;
  return PHONE_TABS.find((tab) => tab === value) ?? null;
}

/** The view that a tab shows, so the address names it: Chat and More have none. */
export function viewOfPhoneTab(tab: WebPhoneTab): "today" | "activity" | "fleet" | undefined {
  if (tab === "today") return "today";
  if (tab === "inbox") return "activity";
  if (tab === "agents") return "fleet";
  return undefined;
}

/** The tab that shows a view on a phone, for a view that is a tab. */
export function phoneTabOfView(view: WorkspaceView): "today" | "inbox" | "agents" | undefined {
  if (view === "today") return "today";
  if (view === "activity") return "inbox";
  if (view === "fleet") return "agents";
  return undefined;
}

export interface WebPhoneShellProps {
  tab: WebPhoneTab;
  onTab: (tab: WebPhoneTab) => void;
  searchShortcut: string;
  account: { name: string; email: string; avatarUrl: string | null };
  onOpenAccount: () => void;
  /** The account's servers, for the switcher. */
  servers: readonly PhoneSwitcherServer[];
  onSelectServer: (serverId: string) => void;
  /** The server's pages and the app's links, after the workspace views in the More tab. */
  moreSections: readonly PhoneMoreSection[];
  /** The notices about the server, such as Reconnecting, as a bar over each tab. */
  banner?: JSX.Element;
}

/**
 * The workspace on a phone, as Slack's mobile app: one tab at a time over a bottom tab bar. Home is
 * the space's channels and DMs under a row of shortcuts, DMs lists the DMs with their last message,
 * Activity shows the mentions and replies (DMs and Activity are the same views as on a computer), and More holds the profile, the views that the desktop
 * keeps under More, and the server's pages. A conversation pushes over the tab with its back button;
 * the tab bar shows only on the tab level.
 */
export function WebPhoneShell(props: WebPhoneShellProps) {
  const { t } = useText();
  const ws = useWorkspace();
  const menu = useWorkspaceMenu();
  const [switcherOpen, setSwitcherOpen] = createSignal(false);

  const spaceItems = createMemo(() =>
    ws.spaces.available()
      ? ws.spaces.list().map((space) => {
          const unread = ws.spaceUnread().get(space.id);
          return {
            id: space.id,
            name: space.name,
            icon: space.icon,
            hue: space.hue,
            unread: unread?.unread ?? false,
            mentionCount: unread?.mentions ?? 0,
            general: space.id === GENERAL_SPACE_ID,
          };
        })
      : [],
  );
  const currentSpace = () => spaceItems().find((space) => space.id === ws.spaces.current());
  const title = () => currentSpace()?.name ?? ws.env.serverName();
  const elsewhere = createMemo(() => {
    let count = 0;
    let unread = false;
    for (const space of spaceItems()) {
      if (space.id === ws.spaces.current()) continue;
      count += space.mentionCount;
      unread ||= space.unread;
    }
    return { count, unread };
  });
  const switcherAvailable = () => spaceItems().length > 1 || props.servers.length > 1;

  /** Slack's DMs badge counts conversations, not messages. */
  const unreadDms = () =>
    ws.sidebarDirectMessages().filter((row) => !row.muted && (row.unread || (row.mentionCount ?? 0) > 0)).length;
  const openView = (view: WorkspaceView) => ws.openView(view);
  // After `unreadDms`: a memo computes when it is made, and a Chat tab that a reload restored reads it.
  const chips = createMemo((): PhoneChip[] => {
    return [
      {
        id: "unreads",
        label: t("workspace.view.unreads"),
        icon: <Inbox />,
        unread: ws.unreads.hasUnread(),
        onSelect: () => openView("unreads"),
      },
      {
        id: "threads",
        label: t("workspace.view.threads"),
        icon: <MessageSquareText />,
        unread: ws.threadsUnread(),
        onSelect: () => openView("threads"),
      },
      ...(ws.later.supported()
        ? [
            {
              id: "later",
              label: t("workspace.view.later"),
              icon: <Bookmark />,
              detail: ws.later.count() > 0 ? String(ws.later.count()) : undefined,
              onSelect: () => openView("later"),
            },
          ]
        : []),
      {
        id: "drafts",
        label: t("workspace.view.drafts"),
        icon: <Pencil />,
        detail: ws.draftCount() > 0 ? t("workspace.drafts.count", { count: ws.draftCount() }) : undefined,
        onSelect: () => openView("drafts"),
      },
      {
        id: "dms",
        label: t("workspace.view.dms"),
        icon: <MessagesSquare />,
        unread: unreadDms() > 0,
        onSelect: () => openView("dms"),
      },
    ];
  });

  const switcherActions = createMemo((): ActionSheetItem[] => {
    if (!ws.isAdmin() || !ws.spaces.available()) return [];
    const current = ws.spaces.current();
    return [
      {
        id: "create-space",
        label: t("workspace.spaces.create"),
        icon: <Plus aria-hidden="true" />,
        onSelect: () => ws.openDialog({ kind: "space-edit", spaceId: null }),
      },
      ...(current !== GENERAL_SPACE_ID
        ? [
            {
              id: "edit-space",
              label: t("workspace.spaces.edit"),
              icon: <Pencil aria-hidden="true" />,
              onSelect: () => ws.openDialog({ kind: "space-edit", spaceId: current }),
            },
          ]
        : []),
    ];
  });

  /** The views that the desktop sidebar keeps under More, in the same order. */
  const viewRows = createMemo((): PhoneMoreRow[] => {
    const rows: PhoneMoreRow[] = [];
    // The message search and Slack's pages, which a phone also reaches from the Home chips.
    if (ws.search.supported())
      rows.push({ id: "search", label: t("workspace.view.search"), icon: <Search />, onSelect: () => ws.openSearch() });
    rows.push(
      { id: "unreads", label: t("workspace.view.unreads"), icon: <Inbox />, onSelect: () => openView("unreads") },
      {
        id: "threads",
        label: t("workspace.view.threads"),
        icon: <MessageSquareText />,
        onSelect: () => openView("threads"),
      },
    );
    if (ws.later.supported())
      rows.push({
        id: "later",
        label: t("workspace.view.later"),
        icon: <Bookmark />,
        onSelect: () => openView("later"),
      });
    rows.push({
      id: "browse",
      label: t("workspace.shortcuts.browse"),
      icon: <Hash />,
      onSelect: () => ws.openDialog({ kind: "browse" }),
    });
    if (ws.spaces.available())
      rows.push({
        id: "space-agents",
        label: t("workspace.view.spaceAgents"),
        icon: <Bot />,
        onSelect: () => openView("space-agents"),
      });
    rows.push(
      {
        id: "artifacts",
        label: t("workspace.view.artifacts"),
        icon: <LayoutDashboard />,
        onSelect: () => openView("artifacts"),
      },
      { id: "agents", label: t("workspace.view.agents"), icon: <ArrowLeftRight />, onSelect: () => openView("agents") },
    );
    if (ws.viewAvailable("storage"))
      rows.push({
        id: "storage",
        label: t("storageHygiene.title"),
        icon: <HardDrive />,
        onSelect: () => openView("storage"),
      });
    if (ws.viewAvailable("loops"))
      rows.push({ id: "loops", label: t("workspace.view.loops"), icon: <Kanban />, onSelect: () => openView("loops") });
    if (ws.viewAvailable("secrets"))
      rows.push({
        id: "secrets",
        label: t("workspace.view.secrets"),
        icon: <KeyRound />,
        onSelect: () => openView("secrets"),
      });
    if (ws.viewAvailable("reviews"))
      rows.push({
        id: "reviews",
        label: t("efficiency.view.title"),
        icon: <Gauge />,
        onSelect: () => openView("reviews"),
      });
    if (ws.viewAvailable("portfolio"))
      rows.push({
        id: "portfolio",
        label: t("portfolio.title"),
        icon: <Briefcase />,
        onSelect: () => openView("portfolio"),
      });
    if (ws.viewAvailable("insights"))
      rows.push({
        id: "insights",
        label: t("insight.title"),
        icon: <Target />,
        onSelect: () => openView("insights"),
      });
    if (ws.viewAvailable("trust"))
      rows.push({
        id: "trust",
        label: t("trust.title"),
        icon: <ShieldCheck />,
        onSelect: () => openView("trust"),
      });
    if (ws.viewAvailable("knowledge"))
      rows.push({
        id: "knowledge",
        label: t("workspace.knowledge.title"),
        icon: <BookOpen />,
        onSelect: () => openView("knowledge"),
      });
    const apps = ws.env.openApps;
    if (apps) rows.push({ id: "apps", label: t("workspace.view.apps"), icon: <Blocks />, onSelect: apps });
    if (ws.viewAvailable("routines"))
      rows.push({
        id: "routines",
        label: t("workspace.app.menu.routines"),
        icon: <Workflow />,
        onSelect: () => openView("routines"),
      });
    return rows;
  });

  /** The views of the agents, over the fleet on the Agents tab. */
  const agentChips = createMemo((): PhoneChip[] => {
    const chips: PhoneChip[] = [];
    if (ws.viewAvailable("loops"))
      chips.push({
        id: "loops",
        label: t("workspace.view.loops"),
        icon: <Kanban />,
        onSelect: () => openView("loops"),
      });
    if (ws.viewAvailable("money"))
      chips.push({ id: "money", label: t("workspace.view.money"), icon: <Coins />, onSelect: () => openView("money") });
    if (ws.viewAvailable("insights"))
      chips.push({ id: "insights", label: t("insight.title"), icon: <Target />, onSelect: () => openView("insights") });
    if (ws.viewAvailable("knowledge"))
      chips.push({
        id: "knowledge",
        label: t("workspace.knowledge.title"),
        icon: <BookOpen />,
        onSelect: () => openView("knowledge"),
      });
    if (ws.viewAvailable("portfolio"))
      chips.push({
        id: "portfolio",
        label: t("portfolio.title"),
        icon: <Briefcase />,
        onSelect: () => openView("portfolio"),
      });
    chips.push(
      { id: "org", label: t("workspace.view.org"), icon: <Network />, onSelect: () => openView("org") },
      {
        id: "artifacts",
        label: t("workspace.view.artifacts"),
        icon: <LayoutDashboard />,
        onSelect: () => openView("artifacts"),
      },
    );
    if (ws.spaces.available())
      chips.push({
        id: "space-agents",
        label: t("workspace.view.spaceAgents"),
        icon: <Bot />,
        onSelect: () => openView("space-agents"),
      });
    return chips;
  });

  /** Unread channels and DMs: the Chat tab has a dot, not a count. */
  const chatUnread = () =>
    unreadDms() > 0 || ws.sidebarChannels().some((row) => !row.muted && (row.unread || (row.mentionCount ?? 0) > 0));
  const queue = useDecisionQueue();
  const tabs = createMemo((): PhoneTab[] => [
    {
      id: "today",
      label: t("workspace.view.today"),
      icon: <Sunrise />,
      // Only what waits on the owner counts, in amber: every space's requests, loop decisions and alerts.
      count: queue.queue().length,
      tone: "attention",
      badgeLabel: t("workspace.phone.waiting", { count: queue.queue().length }),
    },
    {
      id: "chat",
      label: t("workspace.phone.chat"),
      icon: <MessagesSquare />,
      dot: chatUnread(),
      badgeLabel: t("workspace.sidebar.unread"),
    },
    {
      id: "agents",
      label: t("workspace.phone.agents"),
      icon: <Bot />,
    },
    {
      id: "inbox",
      label: t("workspace.phone.inbox"),
      icon: <Bell />,
      dot: ws.activityCount() > 0,
      badgeLabel: t("workspace.phone.newActivity", { count: ws.activityCount() }),
    },
  ]);
  const [createOpen, setCreateOpen] = createSignal(false);
  /** The "+" of the bar: ask an agent, write a message, or start a channel, a loop or a goal. */
  const createItems = createMemo((): ActionSheetItem[] => [
    {
      id: "ask",
      label: t("workspace.phone.askAgent"),
      icon: <Sparkles aria-hidden="true" />,
      onSelect: () => ws.openDialog({ kind: "switcher" }),
    },
    {
      id: "message",
      label: t("workspace.sidebar.newMessage"),
      icon: <SquarePen aria-hidden="true" />,
      onSelect: () => ws.openDialog({ kind: "new-message" }),
    },
    {
      id: "channel",
      label: t("workspace.phone.newChannel"),
      icon: <Hash aria-hidden="true" />,
      onSelect: () => ws.openDialog({ kind: "create-channel" }),
    },
    ...(ws.viewAvailable("loops")
      ? [
          {
            id: "loop",
            label: t("workspace.loops.new"),
            icon: <Kanban aria-hidden="true" />,
            onSelect: () => openView("loops"),
          },
        ]
      : []),
    ...(ws.viewAvailable("insights")
      ? [
          {
            id: "goal",
            label: t("workspace.phone.newGoal"),
            icon: <Target aria-hidden="true" />,
            onSelect: () => openInsightTab(ws, "goals"),
          },
        ]
      : []),
  ]);

  function selectTab(id: string): void {
    const tab = id === "chat" || id === "agents" || id === "inbox" ? id : "today";
    if (tab === "inbox") void ws.refreshActivity();
    props.onTab(tab);
  }

  return (
    <div class="ws-phone-shell-body">
      <div class="ws-phone-shell-banner">{props.banner}</div>
      <div class="ws-phone-shell-screen">
        <Switch>
          <Match when={props.tab === "today"}>
            <WorkspaceMentions>
              <div class="ws-phone-tab-view">
                <WorkspaceTodayView
                  actions={
                    <IconButton
                      variant="ghost"
                      class="ws-phone-account-button"
                      label={t("workspace.phone.more")}
                      onClick={() => props.onTab("more")}
                    >
                      <UserAvatar user={props.account} decorative />
                    </IconButton>
                  }
                />
              </div>
            </WorkspaceMentions>
          </Match>
          <Match when={props.tab === "chat"}>
            <PhoneHomeHeader
              title={title()}
              mark={currentSpace() ?? { name: ws.env.serverName(), icon: null, hue: null }}
              elsewhereCount={elsewhere().count}
              elsewhereUnread={elsewhere().unread}
              onOpenSwitcher={switcherAvailable() ? () => setSwitcherOpen(true) : undefined}
              menuItems={menu()}
              onSearch={() => ws.openDialog({ kind: "switcher" })}
              onCompose={() => ws.openDialog({ kind: "new-message" })}
              chips={chips()}
            />
            <div class="ws-phone-home-list">
              <WorkspaceSidebarPane searchShortcut={props.searchShortcut} />
            </div>
          </Match>
          <Match when={props.tab === "agents"}>
            <div class="ws-phone-tab-view ws-phone-agents">
              <PhoneChips chips={agentChips()} label={t("workspace.phone.agentViews")} />
              <WorkspaceViewPane view="fleet" />
            </div>
          </Match>
          <Match when={props.tab === "inbox"}>
            <WorkspaceMentions>
              <div class="ws-phone-tab-view">
                <WorkspaceViewPane view="activity" />
              </div>
            </WorkspaceMentions>
          </Match>
          <Match when={props.tab === "more"}>
            <PhoneMoreScreen
              onBack={() => props.onTab("today")}
              account={props.account}
              onOpenAccount={props.onOpenAccount}
              sections={[{ id: "views", title: t("workspace.phone.views"), rows: viewRows() }, ...props.moreSections]}
            />
          </Match>
        </Switch>
      </div>
      <PhoneTabBar
        tabs={tabs()}
        // More is a screen of Today, so Today stays lit, and a tap on it goes back.
        active={props.tab === "more" ? "today" : props.tab}
        onSelect={selectTab}
        label={t("workspace.phone.tabs")}
        center={{ label: t("workspace.phone.create"), icon: <Plus />, onSelect: () => setCreateOpen(true) }}
      />
      <ActionSheet
        open={createOpen()}
        onOpenChange={setCreateOpen}
        title={t("workspace.phone.create")}
        items={createItems()}
      />
      <PhoneSwitcherSheet
        open={switcherOpen()}
        onOpenChange={setSwitcherOpen}
        spaces={spaceItems()}
        activeSpaceId={ws.spaces.current()}
        onSelectSpace={(spaceId) => ws.selectSpace(spaceId)}
        servers={props.servers}
        onSelectServer={props.onSelectServer}
        actions={switcherActions()}
      />
    </div>
  );
}
