import { Button, Hash, Plus, Search, SquarePen } from "@openbot/ui";
import { WorkspaceSidebar } from "@openbot/ui/features/workspace/WorkspaceSidebar";
import type { WorkspaceMenuItem } from "@openbot/ui/features/workspace/workspace-types";
import { useText } from "@openbot/ui/text";
import { createMemo } from "solid-js";
import { useWorkspace } from "./workspace-context";

/** The workspace sidebar: the server's name and menu, the jump field, the views, channels and DMs. */
export function WorkspaceSidebarPane(props: { searchShortcut: string }) {
  const { t } = useText();
  const ws = useWorkspace();
  const menu = createMemo((): WorkspaceMenuItem[] => [
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
  const view = () => {
    const route = ws.route();
    return route.kind === "view" ? route.view : undefined;
  };
  return (
    <WorkspaceSidebar
      workspaceName={ws.env.serverName()}
      workspaceMenu={menu()}
      onNewMessage={() => ws.openDialog({ kind: "new-message" })}
      search={
        <Button variant="ghost" class="ws-jump" onClick={() => ws.openDialog({ kind: "switcher" })}>
          <Search aria-hidden="true" />
          <span class="ws-jump-label">{t("workspace.app.switcher.jump")}</span>
          <kbd class="ws-jump-key">{props.searchShortcut}</kbd>
        </Button>
      }
      activeView={view()}
      activeConversationId={ws.activeConversationId()}
      onSelectView={(next) => ws.openView(next)}
      onSelectConversation={(id) => ws.openConversation(id)}
      activityCount={ws.activityCount()}
      threadsUnread={ws.threadsUnread()}
      workingAgentCount={ws.fleet.agents().filter((agent) => agent.status.state === "working").length}
      channels={ws.sidebarChannels()}
      directMessages={ws.sidebarDirectMessages()}
      onAddChannel={() => ws.openDialog({ kind: "browse" })}
      onAddTeammate={ws.env.inviteTeammates}
    />
  );
}
