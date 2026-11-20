import { GENERAL_SPACE_ID } from "@openbot/contracts/ipc";
import {
  type ActionSheetItem,
  Activity,
  ArrowLeftRight,
  Bell,
  Blocks,
  Bookmark,
  Bot,
  Ellipsis,
  Hand,
  HardDrive,
  Hash,
  House,
  Inbox,
  KeyRound,
  LayoutDashboard,
  MessageSquareText,
  MessagesSquare,
  Pencil,
  Plus,
  Search,
  Workflow,
} from "@openbot/ui";
import {
  type PhoneChip,
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
import { WorkspaceDmsView } from "../workspace/WorkspaceInboxViews";
import { useWorkspaceMenu, WorkspaceSidebarPane } from "../workspace/WorkspaceSidebarPane";
import { WorkspaceMentions } from "../workspace/WorkspaceView";
import { WorkspaceViewPane } from "../workspace/WorkspaceViews";
import { useWorkspace } from "../workspace/workspace-context";

/** The tabs of the phone workspace, as Slack's bottom bar: Home, DMs, Activity and More. */
export type WebPhoneTab = "home" | "dms" | "activity" | "more";

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

  const openView = (view: WorkspaceView) => ws.openView(view);
  const chips = createMemo((): PhoneChip[] => {
    const working = ws.fleet
      .agents()
      .filter((agent) => agent.status.state === "working" && ws.spaces.agentInCurrent(agent.member.id)).length;
    const needsYou = ws.needsYou().length;
    return [
      ...(needsYou > 0
        ? [
            {
              id: "needs-you",
              label: t("workspace.needsYou.title"),
              icon: <Hand />,
              detail: String(needsYou),
              urgent: true,
              onSelect: () => openView("activity"),
            },
          ]
        : []),
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
        id: "fleet",
        label: t("workspace.view.fleet"),
        icon: <Activity />,
        detail: working > 0 ? t("workspace.sidebar.workingCount", { count: working }) : undefined,
        onSelect: () => openView("fleet"),
      },
      ...(ws.spaces.available()
        ? [
            {
              id: "space-agents",
              label: t("workspace.view.spaceAgents"),
              icon: <Bot />,
              onSelect: () => openView("space-agents"),
            },
          ]
        : []),
      {
        id: "artifacts",
        label: t("workspace.view.artifacts"),
        icon: <LayoutDashboard />,
        onSelect: () => openView("artifacts"),
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

  /** Slack's DMs badge counts conversations, not messages. */
  const unreadDms = () =>
    ws.sidebarDirectMessages().filter((row) => !row.muted && (row.unread || (row.mentionCount ?? 0) > 0)).length;

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
    if (ws.viewAvailable("secrets"))
      rows.push({
        id: "secrets",
        label: t("workspace.view.secrets"),
        icon: <KeyRound />,
        onSelect: () => openView("secrets"),
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

  const tabs = createMemo((): PhoneTab[] => [
    { id: "home", label: t("workspace.phone.home"), icon: <House /> },
    {
      id: "dms",
      label: t("workspace.phone.dms"),
      icon: <MessagesSquare />,
      count: unreadDms(),
      badgeLabel: t("workspace.phone.unreadConversations", { count: unreadDms() }),
    },
    {
      id: "activity",
      label: t("workspace.phone.activity"),
      icon: <Bell />,
      // What waits for the reader is at the top of Activity, so it counts there too.
      count: ws.activityCount() + ws.needsYou().length,
      badgeLabel: t("workspace.phone.newActivity", { count: ws.activityCount() + ws.needsYou().length }),
    },
    { id: "more", label: t("workspace.phone.more"), icon: <Ellipsis /> },
  ]);

  function selectTab(id: string): void {
    const tab = id === "dms" || id === "activity" || id === "more" ? id : "home";
    if (tab === "activity") void ws.refreshActivity();
    props.onTab(tab);
  }

  return (
    <div class="ws-phone-shell-body">
      <div class="ws-phone-shell-banner">{props.banner}</div>
      <div class="ws-phone-shell-screen">
        <Switch>
          <Match when={props.tab === "home"}>
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
          <Match when={props.tab === "dms"}>
            <div class="ws-phone-tab-view">
              <WorkspaceDmsView tab />
            </div>
          </Match>
          <Match when={props.tab === "activity"}>
            <WorkspaceMentions>
              <div class="ws-phone-tab-view">
                <WorkspaceViewPane view="activity" />
              </div>
            </WorkspaceMentions>
          </Match>
          <Match when={props.tab === "more"}>
            <PhoneMoreScreen
              account={props.account}
              onOpenAccount={props.onOpenAccount}
              sections={[{ id: "views", title: t("workspace.phone.views"), rows: viewRows() }, ...props.moreSections]}
            />
          </Match>
        </Switch>
      </div>
      <PhoneTabBar tabs={tabs()} active={props.tab} onSelect={selectTab} label={t("workspace.phone.tabs")} />
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
