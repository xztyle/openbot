import {
  ArrowDown,
  ArrowLeftRight,
  ArrowUp,
  Bell,
  BellOff,
  Button,
  Hash,
  Info,
  Input,
  LogOut,
  MessageSquare,
  Plus,
  Search,
  Settings,
  SquarePen,
} from "@openbot/ui";
import { type SidebarGroupId, WorkspaceSidebar } from "@openbot/ui/features/workspace/WorkspaceSidebar";
import type { WorkspaceMenuItem } from "@openbot/ui/features/workspace/workspace-types";
import { useText } from "@openbot/ui/text";
import { createMemo } from "solid-js";
import { useWorkspace } from "./workspace-context";
import { AGENT_DM_PREFIX } from "./workspace-model";

/** The workspace's own actions: the server menu, and the right-click menu where nothing nearer has one. */
export function useWorkspaceMenu(): () => WorkspaceMenuItem[] {
  const { t } = useText();
  const ws = useWorkspace();
  return createMemo((): WorkspaceMenuItem[] => [
    {
      id: "create-channel",
      label: t("workspace.app.menu.createChannel"),
      icon: <Plus aria-hidden="true" />,
      onSelect: () => ws.openDialog({ kind: "create-channel" }),
    },
    {
      id: "browse-channels",
      label: t("workspace.app.menu.browseChannels"),
      icon: <Hash aria-hidden="true" />,
      onSelect: () => ws.openDialog({ kind: "browse" }),
    },
    {
      id: "new-message",
      label: t("workspace.sidebar.newMessage"),
      icon: <SquarePen aria-hidden="true" />,
      onSelect: () => ws.openDialog({ kind: "new-message" }),
    },
    ...ws.env.menu(),
  ]);
}

/** The workspace sidebar: the server's name and menu, the jump field, the views, channels and DMs. */
export function WorkspaceSidebarPane(props: { searchShortcut: string }) {
  const { t } = useText();
  const ws = useWorkspace();
  const menu = useWorkspaceMenu();
  /** Open, details or settings, mute, the keyboard's way to move a row (dragging moves it too), leave. */
  const rowMenu = (id: string, group: SidebarGroupId): WorkspaceMenuItem[] => {
    const muted = ws.isMuted(id);
    const agentId = id.startsWith(AGENT_DM_PREFIX) ? id.slice(AGENT_DM_PREFIX.length) : null;
    const channel = agentId ? undefined : ws.summary(id);
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
            {
              id: "agent-talk",
              label: t("workspace.agentTalk.open"),
              icon: <ArrowLeftRight aria-hidden="true" />,
              onSelect: () => ws.openAgentTalk(agentId),
            },
          ]
        : [
            {
              id: "details",
              label: t("workspace.details.title"),
              icon: <Info aria-hidden="true" />,
              onSelect: () => {
                ws.openConversation(id);
                ws.openDetails(id, "about");
              },
            },
          ]),
      {
        id: "mute",
        label: t(muted ? "workspace.sidebar.unmute" : "workspace.sidebar.mute"),
        icon: muted ? <Bell aria-hidden="true" /> : <BellOff aria-hidden="true" />,
        onSelect: () => ws.setMuted(id, !muted),
      },
      {
        id: "move-up",
        label: t("workspace.sidebar.moveUp"),
        icon: <ArrowUp aria-hidden="true" />,
        onSelect: () => ws.moveSidebarRow(group, id, -1),
      },
      {
        id: "move-down",
        label: t("workspace.sidebar.moveDown"),
        icon: <ArrowDown aria-hidden="true" />,
        onSelect: () => ws.moveSidebarRow(group, id, 1),
      },
      ...(group === "channels" && channel && !channel.archived
        ? [
            {
              id: "leave",
              label: t("workspace.details.leave"),
              icon: <LogOut aria-hidden="true" />,
              danger: true,
              onSelect: () => void ws.leave(id),
            },
          ]
        : []),
    ];
  };
  const view = () => {
    // The welcome of a new workspace is no view of the list.
    if (ws.workspaceEmpty() && ws.state.view === null) return undefined;
    const route = ws.route();
    return route.kind === "view" ? route.view : undefined;
  };
  return (
    <WorkspaceSidebar
      workspaceName={ws.env.serverName()}
      workspaceMenu={menu()}
      onNewMessage={() => ws.openDialog({ kind: "new-message" })}
      search={
        <>
          <Button variant="ghost" class="ws-jump" onClick={() => ws.openDialog({ kind: "switcher" })}>
            <Search aria-hidden="true" />
            <span class="ws-jump-label">{t("workspace.app.switcher.jump")}</span>
            <kbd class="ws-jump-key">{props.searchShortcut}</kbd>
          </Button>
          <Input
            type="search"
            size="sm"
            class="ws-sidebar-filter"
            value={ws.state.sidebarFilter}
            placeholder={t("workspace.sidebar.filter")}
            aria-label={t("workspace.sidebar.filter")}
            onValueChange={(text: string) => ws.setSidebarFilter(text)}
            onKeyDown={(event: KeyboardEvent) => {
              if (event.key === "Escape" && ws.state.sidebarFilter) {
                event.preventDefault();
                event.stopPropagation();
                ws.setSidebarFilter("");
              }
            }}
          />
        </>
      }
      filtering={ws.state.sidebarFilter.trim().length > 0}
      onReorder={(group, ids) => ws.reorderSidebar(group, ids)}
      rowMenu={rowMenu}
      activeView={view()}
      activeConversationId={ws.activeConversationId()}
      onSelectView={(next) => ws.openView(next)}
      onSelectConversation={(id) => ws.openConversation(id)}
      activityCount={ws.activityCount()}
      threadsUnread={ws.threadsUnread()}
      workingAgentCount={ws.fleet.agents().filter((agent) => agent.status.state === "working").length}
      showStorage={Boolean(ws.env.storageHygiene?.())}
      onOpenApps={ws.env.openApps}
      channels={ws.sidebarChannels()}
      directMessages={ws.sidebarDirectMessages()}
      onAddChannel={() => ws.openDialog({ kind: "browse" })}
      onAddTeammate={ws.env.inviteTeammates}
    />
  );
}
