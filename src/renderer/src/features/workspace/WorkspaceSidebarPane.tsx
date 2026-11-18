import {
  ArrowDown,
  ArrowLeftRight,
  ArrowUp,
  Bell,
  BellOff,
  Button,
  FolderInput,
  FolderPlus,
  Hash,
  Info,
  Input,
  LogOut,
  MessageSquare,
  Plus,
  Search,
  Settings,
  SquarePen,
  Star,
  StarOff,
  Undo2,
  Workflow,
  X,
} from "@openbot/ui";
import { SidebarSectionDialog } from "@openbot/ui/features/workspace/SidebarSectionDialog";
import { WorkspaceSidebar } from "@openbot/ui/features/workspace/WorkspaceSidebar";
import type { WorkspaceMenuItem } from "@openbot/ui/features/workspace/workspace-types";
import { useText } from "@openbot/ui/text";
import { createMemo, createSignal, Show } from "solid-js";
import { actionToast } from "../../action-toast";
import { WorkspaceSpaceRail } from "./WorkspaceSpaceRail";
import { useWorkspace } from "./workspace-context";
import { AGENT_DM_PREFIX } from "./workspace-model";
import {
  isCustomSection,
  newSectionId,
  STARRED_SECTION,
  sectionOf,
  withConversationIn,
  withNewSection,
  withoutSection,
  withSectionName,
  withSectionOptions,
} from "./workspace-sidebar-sections";

/** How many of the reader's sections a row menu offers by name; New section covers the rest. */
const MOVE_TARGET_LIMIT = 8;

/**
 * The section dialog that shows: a new section, with the conversation that asked for it, or the
 * rename of one. Null: none.
 */
type SectionDialog = { kind: "create"; conversationId?: string } | { kind: "rename"; sectionId: string } | null;

/** The dialog of the sidebar sections, opened from a section header, a row menu or the workspace menu. */
const [sectionDialog, setSectionDialog] = createSignal<SectionDialog>(null);

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
    {
      id: "new-section",
      label: t("workspace.sidebar.section.new"),
      icon: <FolderPlus aria-hidden="true" />,
      onSelect: () => setSectionDialog({ kind: "create" }),
    },
    ...(ws.env.routines?.available()
      ? [
          {
            id: "routines",
            label: t("workspace.app.menu.routines"),
            icon: <Workflow aria-hidden="true" />,
            onSelect: () => ws.openView("routines"),
          },
        ]
      : []),
    ...ws.env.menu(),
  ]);
}

/** The workspace sidebar: the server's name and menu, the jump field, the views, channels and DMs. */
export function WorkspaceSidebarPane(props: { searchShortcut: string }) {
  const { t } = useText();
  const ws = useWorkspace();
  const menu = useWorkspaceMenu();
  /** Star, the reader's sections, and back to the conversation's own group. */
  const sectionItems = (id: string, section: string): WorkspaceMenuItem[] => {
    const prefs = ws.state.sidebar;
    const starred = section === STARRED_SECTION;
    const current = sectionOf(prefs, id);
    const targets = (prefs.sections ?? []).filter((entry) => entry.id !== current).slice(0, MOVE_TARGET_LIMIT);
    return [
      {
        id: "star",
        label: t(starred ? "workspace.sidebar.unstar" : "workspace.sidebar.star"),
        icon: starred ? <StarOff aria-hidden="true" /> : <Star aria-hidden="true" />,
        onSelect: () =>
          ws.updateSidebarPrefs((value) => withConversationIn(value, id, starred ? null : STARRED_SECTION)),
      },
      ...targets.map((entry) => ({
        id: `move-section-${entry.id}`,
        label: t("workspace.sidebar.section.moveTo", { name: entry.name }),
        icon: <FolderInput aria-hidden="true" />,
        onSelect: () => ws.updateSidebarPrefs((value) => withConversationIn(value, id, entry.id)),
      })),
      {
        id: "move-section-new",
        label: t("workspace.sidebar.section.moveToNew"),
        icon: <FolderPlus aria-hidden="true" />,
        onSelect: () => setSectionDialog({ kind: "create", conversationId: id }),
      },
      ...(current && current !== STARRED_SECTION
        ? [
            {
              id: "move-section-home",
              label: t("workspace.sidebar.section.removeFrom", {
                name: prefs.sections?.find((entry) => entry.id === current)?.name ?? "",
              }),
              icon: <Undo2 aria-hidden="true" />,
              onSelect: () => ws.updateSidebarPrefs((value) => withConversationIn(value, id, null)),
            },
          ]
        : []),
    ];
  };
  /** Open, details or settings, mute, the keyboard's way to move a row (dragging moves it too), leave. */
  const rowMenu = (id: string, section: string): WorkspaceMenuItem[] => {
    const muted = ws.isMuted(id);
    const direct = id.startsWith(AGENT_DM_PREFIX) || ws.sidebarDirectMessages().some((row) => row.id === id);
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
      ...sectionItems(id, section),
      {
        id: "move-up",
        label: t("workspace.sidebar.moveUp"),
        icon: <ArrowUp aria-hidden="true" />,
        onSelect: () => ws.moveSidebarRow(section, id, -1),
      },
      {
        id: "move-down",
        label: t("workspace.sidebar.moveDown"),
        icon: <ArrowDown aria-hidden="true" />,
        onSelect: () => ws.moveSidebarRow(section, id, 1),
      },
      // Only the owner and the admins change spaces. A DM with one agent follows that agent.
      ...(ws.isAdmin() && ws.spaces.available() && (agentId || (channel && !ws.soleAgent(channel)))
        ? [
            {
              id: "move-space",
              label: t("workspace.spaces.moveToSpace"),
              icon: <FolderInput aria-hidden="true" />,
              onSelect: () =>
                ws.openDialog({
                  kind: "space-move",
                  agentIds: agentId ? [agentId] : [],
                  channelIds: agentId ? [] : [id],
                }),
            },
          ]
        : []),
      ...(direct
        ? [
            {
              id: "close",
              label: t("workspace.sidebar.close"),
              icon: <X aria-hidden="true" />,
              onSelect: () => ws.closeConversation(id),
            },
          ]
        : []),
      ...(!direct && channel && !channel.archived
        ? [
            {
              id: "leave",
              label: t("workspace.details.leave"),
              icon: <LogOut aria-hidden="true" />,
              danger: true,
              onSelect: () => ws.requestLeave(id),
            },
          ]
        : []),
    ];
  };
  /** Deletes a section at once; its conversations go back to their groups, and Undo puts it back. */
  const deleteSection = (sectionId: string) => {
    const before = ws.state.sidebar.sections ?? [];
    const index = before.findIndex((entry) => entry.id === sectionId);
    const removed = before[index];
    if (!removed) return;
    const options = ws.state.sidebar.groupOptions?.find((entry) => entry.id === sectionId);
    ws.updateSidebarPrefs((value) => withoutSection(value, sectionId));
    actionToast.success(t("workspace.sidebar.section.deleted", { name: removed.name }), {
      action: {
        label: t("common.undo"),
        onClick: () =>
          ws.updateSidebarPrefs((value) => {
            // Its conversations come back to it, unless the reader moved them meanwhile.
            const sections = [...(value.sections ?? [])];
            const ids = removed.ids.filter((conversationId) => !sectionOf(value, conversationId));
            sections.splice(Math.min(index, sections.length), 0, { ...removed, ids });
            const next = { ...value, sections };
            return options ? withSectionOptions(next, sectionId, options) : next;
          }),
      },
    });
  };
  const view = () => {
    // The welcome of a new workspace is no view of the list.
    if (ws.workspaceEmpty() && ws.state.view === null) return undefined;
    const route = ws.route();
    return route.kind === "view" ? route.view : undefined;
  };
  return (
    <div class="ws-spaces-layout">
      <Show when={ws.spaces.available()}>
        <WorkspaceSpaceRail />
      </Show>
      <WorkspaceSidebar
        workspaceName={
          ws.spaces.available()
            ? (ws.spaces.space(ws.spaces.current())?.name ?? ws.env.serverName())
            : ws.env.serverName()
        }
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
        collapsedGroups={ws.state.sidebar.collapsed ?? []}
        onCollapsedChange={(group, collapsed) => ws.setGroupCollapsed(group, collapsed)}
        sections={ws.sidebarSections()}
        onReorder={(section, ids) => ws.reorderSidebar(section, ids)}
        onMoveToSection={(conversationId, section, beforeId) =>
          ws.updateSidebarPrefs((value) => withConversationIn(value, conversationId, section, beforeId))
        }
        onSectionOptions={(section, options) =>
          ws.updateSidebarPrefs((value) => withSectionOptions(value, section, options))
        }
        onCreateSection={() => setSectionDialog({ kind: "create" })}
        onRenameSection={(sectionId) => setSectionDialog({ kind: "rename", sectionId })}
        onDeleteSection={deleteSection}
        draftCount={ws.draftCount()}
        rowMenu={rowMenu}
        activeView={view()}
        activeConversationId={ws.activeConversationId()}
        onSelectView={(next) => ws.openView(next)}
        onSelectConversation={(id) => ws.openConversation(id)}
        activityCount={ws.activityCount()}
        threadsUnread={ws.threadsUnread()}
        workingAgentCount={
          ws.fleet
            .agents()
            .filter((agent) => agent.status.state === "working" && ws.spaces.agentInCurrent(agent.member.id)).length
        }
        showSpaceAgents={ws.spaces.available()}
        showStorage={Boolean(ws.env.storageHygiene?.())}
        showSecrets={ws.env.secrets?.() === true && Boolean(ws.channels.port().agent.workspaceSecrets)}
        onOpenApps={ws.env.openApps}
        channels={ws.sidebarChannels()}
        directMessages={ws.sidebarDirectMessages()}
        onAddChannel={() => ws.openDialog({ kind: "browse" })}
        onAddAgent={ws.env.createAgent}
        onAddTeammate={ws.env.inviteTeammates}
      />
      <SidebarSectionDialogs />
    </div>
  );
}

/** Makes a section, with the conversation that asked for one, or renames a section. */
function SidebarSectionDialogs() {
  const ws = useWorkspace();
  const sections = () => ws.state.sidebar.sections ?? [];
  const renamed = () => {
    const current = sectionDialog();
    return current?.kind === "rename" ? sections().find((entry) => entry.id === current.sectionId) : undefined;
  };
  return (
    <SidebarSectionDialog
      open={sectionDialog() !== null}
      initialName={renamed()?.name ?? null}
      takenNames={sections()
        .filter((entry) => entry.id !== renamed()?.id)
        .map((entry) => entry.name)}
      onOpenChange={(open) => {
        if (!open) setSectionDialog(null);
      }}
      onSave={(name) => {
        const current = sectionDialog();
        if (!current) return;
        if (current.kind === "rename") {
          if (isCustomSection(ws.state.sidebar, current.sectionId))
            ws.updateSidebarPrefs((value) => withSectionName(value, current.sectionId, name));
          return;
        }
        const id = newSectionId();
        ws.updateSidebarPrefs((value) => withNewSection(value, id, name, current.conversationId));
      }}
    />
  );
}
