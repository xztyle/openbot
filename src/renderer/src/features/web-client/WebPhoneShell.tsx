import { GENERAL_SPACE_ID } from "@openbot/contracts/ipc";
import {
  type ActionSheetItem,
  Activity,
  ArrowLeftRight,
  Bell,
  BellOff,
  Blocks,
  Bookmark,
  Bot,
  Ellipsis,
  HardDrive,
  House,
  Inbox,
  KeyRound,
  LayoutDashboard,
  MessageSquare,
  MessageSquareText,
  MessagesSquare,
  Pencil,
  Plus,
  Settings,
  Workflow,
  X,
} from "@openbot/ui";
import {
  type PhoneChip,
  PhoneDirectMessages,
  type PhoneDirectRow,
  PhoneHomeHeader,
  type PhoneMoreRow,
  PhoneMoreScreen,
  type PhoneMoreSection,
  type PhoneSwitcherServer,
  PhoneSwitcherSheet,
} from "@openbot/ui/features/workspace/PhoneScreens";
import { type PhoneTab, PhoneTabBar } from "@openbot/ui/features/workspace/PhoneTabBar";
import type { WorkspaceView } from "@openbot/ui/features/workspace/WorkspaceSidebar";
import type { WorkspaceMenuItem } from "@openbot/ui/features/workspace/workspace-types";
import { useText } from "@openbot/ui/text";
import { createMemo, createSignal, Match, Switch } from "solid-js";
import { useWorkspaceMenu, WorkspaceSidebarPane } from "../workspace/WorkspaceSidebarPane";
import { WorkspaceMentions } from "../workspace/WorkspaceView";
import { WorkspaceViewPane } from "../workspace/WorkspaceViews";
import { useWorkspace } from "../workspace/workspace-context";
import { AGENT_DM_PREFIX, previewText } from "../workspace/workspace-model";

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
}

/**
 * The workspace on a phone, as Slack's mobile app: one tab at a time over a bottom tab bar. Home is
 * the space's channels and DMs under a row of shortcuts, DMs lists the DMs with their last message,
 * Activity shows the mentions and replies, and More holds the profile, the views that the desktop
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

  /** The DMs of the space, with the last message of each that the host listed. */
  const directRows = createMemo((): PhoneDirectRow[] =>
    ws.sidebarDirectMessages().map((row) => {
      const last = ws.summary(row.id)?.lastMessage;
      if (!last) return row;
      const text = previewText(last.text, 120);
      const otherName = row.kind === "dm" ? row.members[0]?.name : undefined;
      return {
        ...row,
        preview: last.authorName && last.authorName !== otherName ? `${last.authorName}: ${text}` : text,
        at: Date.parse(last.at),
      };
    }),
  );
  /** A long press on a DM: open it, its agent's settings, mute it, or close it. */
  function directMenu(id: string): WorkspaceMenuItem[] {
    const muted = ws.isMuted(id);
    const agentId = id.startsWith(AGENT_DM_PREFIX) ? id.slice(AGENT_DM_PREFIX.length) : null;
    return [
      {
        id: "open",
        label: t("common.open"),
        icon: <MessageSquare aria-hidden="true" />,
        onSelect: () => ws.openConversation(id),
      },
      ...(agentId
        ? [
            {
              id: "agent-settings",
              label: t("workspace.profile.settings"),
              icon: <Settings aria-hidden="true" />,
              onSelect: () => ws.env.openAgentSettings(agentId),
            },
          ]
        : []),
      {
        id: "mute",
        label: t(muted ? "workspace.sidebar.unmute" : "workspace.sidebar.mute"),
        icon: muted ? <Bell aria-hidden="true" /> : <BellOff aria-hidden="true" />,
        onSelect: () => ws.setMuted(id, !muted),
      },
      {
        id: "close",
        label: t("workspace.sidebar.close"),
        icon: <X aria-hidden="true" />,
        onSelect: () => ws.closeConversation(id),
      },
    ];
  }
  /** Slack's DMs badge counts conversations, not messages. */
  const unreadDms = () =>
    ws.sidebarDirectMessages().filter((row) => !row.muted && (row.unread || (row.mentionCount ?? 0) > 0)).length;

  /** The views that the desktop sidebar keeps under More, in the same order. */
  const viewRows = createMemo((): PhoneMoreRow[] => {
    const rows: PhoneMoreRow[] = [];
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
      count: ws.activityCount(),
      badgeLabel: t("workspace.phone.newActivity", { count: ws.activityCount() }),
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
            <PhoneDirectMessages
              rows={directRows()}
              rowMenu={directMenu}
              activeId={ws.activeConversationId()}
              onSelect={(id) => ws.openConversation(id)}
              onCompose={() => ws.openDialog({ kind: "new-message" })}
            />
          </Match>
          <Match when={props.tab === "activity"}>
            <WorkspaceMentions>
              <div class="ws-phone-activity">
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
