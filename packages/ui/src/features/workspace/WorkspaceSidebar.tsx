import type { AppTranslate } from "@openbot/i18n";
import type { JSX } from "@solidjs/web";
import { createSignal, For, Show } from "solid-js";
import { Button, IconButton } from "../../button";
import {
  Activity,
  ArrowLeftRight,
  AtSign,
  Blocks,
  ChevronDown,
  ChevronRight,
  Ellipsis,
  HardDrive,
  Hash,
  LayoutDashboard,
  Lock,
  MessageSquareText,
  Plus,
  SquarePen,
  UserRoundPlus,
  UsersRound,
} from "../../icons";
import { useText } from "../../text";
import { cx } from "../../utils";
import { AiBadge, AvatarStack, MemberAvatar, presenceLabelKey } from "./WorkspaceAvatar";
import { WorkspaceContextMenu } from "./WorkspaceContextMenu";
import { WorkspaceMenu } from "./WorkspaceMenu";
import type { ChannelVisibility, WorkspaceMember, WorkspaceMenuItem } from "./workspace-types";

/** The views above the channel list. */
export type WorkspaceView = "threads" | "activity" | "fleet" | "artifacts" | "agents" | "storage";

export interface SidebarChannel {
  id: string;
  name: string;
  visibility: ChannelVisibility;
  /** Has messages the reader has not read. The name shows in bold. */
  unread?: boolean | undefined;
  /** Mentions of the reader that are not read. */
  mentionCount?: number | undefined;
  muted?: boolean | undefined;
}

export interface SidebarDirectMessage {
  id: string;
  kind: "dm" | "group";
  /** The other members. A DM has one; a group DM has two or more. */
  members: readonly WorkspaceMember[];
  unread?: boolean | undefined;
  mentionCount?: number | undefined;
  muted?: boolean | undefined;
}

export interface WorkspaceSidebarProps {
  workspaceName: string;
  /** The items of the menu that the workspace name opens. */
  workspaceMenu?: readonly WorkspaceMenuItem[] | undefined;
  onNewMessage?: (() => void) | undefined;
  /** A slot under the header, such as the ⌘K jump field. */
  search?: JSX.Element;
  /** The view or the conversation id that shows now. */
  activeView?: WorkspaceView | undefined;
  activeConversationId?: string | undefined;
  onSelectView: (view: WorkspaceView) => void;
  onSelectConversation: (id: string) => void;
  /** Unread activity: mentions, replies and DMs. */
  activityCount?: number | undefined;
  threadsUnread?: boolean | undefined;
  /** Agents that work now. */
  workingAgentCount?: number | undefined;
  /** Shows the Storage view, for an owner or an admin of a host that reports its storage. */
  showStorage?: boolean | undefined;
  /** Opens the server's apps (Discord, Slack, Telegram and other connectors), for an owner or an admin. */
  onOpenApps?: (() => void) | undefined;
  channels: readonly SidebarChannel[];
  directMessages: readonly SidebarDirectMessage[];
  onAddChannel?: (() => void) | undefined;
  onAddTeammate?: (() => void) | undefined;
  /** A drag handle for a row, when the caller lets the reader sort them. */
  dragHandle?: ((id: string) => JSX.Element) | undefined;
  /**
   * Lets the reader drag the rows of a group into their own order. It gets the ids of the group in
   * the new order.
   */
  onReorder?: ((group: SidebarGroupId, ids: string[]) => void) | undefined;
  /** The items of a row's menu, such as mute and move. The menu is built when the row is hovered. */
  rowMenu?: ((id: string, group: SidebarGroupId) => readonly WorkspaceMenuItem[]) | undefined;
  /** A filter is on: the groups show what matches, and say so when nothing does. */
  filtering?: boolean | undefined;
  class?: string;
}

/** The groups of conversations in the sidebar. */
export type SidebarGroupId = "channels" | "direct";

/**
 * The Slack sidebar: workspace header, Threads, Activity, Fleet and Artifacts, then Channels and
 * Direct messages in groups that collapse. Up and Down move between rows.
 */
export function WorkspaceSidebar(props: WorkspaceSidebarProps): JSX.Element {
  const { t } = useText();
  const [channelsOpen, setChannelsOpen] = createSignal(true);
  const [directOpen, setDirectOpen] = createSignal(true);
  return (
    <WorkspaceContextMenu
      items={() => props.workspaceMenu ?? []}
      label={t("workspace.sidebar.workspaceMenu", { name: props.workspaceName })}
    >
      <nav class={cx("ws-sidebar", props.class)} aria-label={t("workspace.sidebar.label")} onKeyDown={moveRowFocus}>
        <header class="ws-sidebar-header">
          <Show
            when={props.workspaceMenu?.length}
            fallback={<h2 class="ws-sidebar-workspace">{props.workspaceName}</h2>}
          >
            <WorkspaceMenu
              items={props.workspaceMenu ?? []}
              label={t("workspace.sidebar.workspaceMenu", { name: props.workspaceName })}
              triggerClass="ws-sidebar-workspace ws-sidebar-workspace-trigger"
              placement="bottom-start"
            >
              <span class="ws-truncate">{props.workspaceName}</span>
              <ChevronDown aria-hidden="true" />
            </WorkspaceMenu>
          </Show>
          <Show when={props.onNewMessage}>
            {(onNew) => (
              <IconButton
                class="ws-sidebar-compose"
                variant="secondary"
                label={t("workspace.sidebar.newMessage")}
                onClick={() => onNew()()}
              >
                <SquarePen />
              </IconButton>
            )}
          </Show>
        </header>
        <Show when={props.search}>
          <div class="ws-sidebar-search">{props.search}</div>
        </Show>
        <div class="ws-sidebar-scroll">
          <div class="ws-sidebar-quick">
            <QuickRow
              view="threads"
              icon={<MessageSquareText aria-hidden="true" />}
              label={t("workspace.view.threads")}
              active={props.activeView === "threads"}
              unread={props.threadsUnread}
              onSelect={props.onSelectView}
            />
            <QuickRow
              view="activity"
              icon={<AtSign aria-hidden="true" />}
              label={t("workspace.view.activity")}
              active={props.activeView === "activity"}
              count={props.activityCount}
              onSelect={props.onSelectView}
            />
            <QuickRow
              view="fleet"
              icon={<Activity aria-hidden="true" />}
              label={t("workspace.view.fleet")}
              active={props.activeView === "fleet"}
              trailing={
                <Show when={props.workingAgentCount}>
                  {(count) => (
                    <span class="ws-sidebar-working-count">
                      <span class="ws-working-pulse" aria-hidden="true" />
                      {t("workspace.sidebar.workingCount", { count: count() })}
                    </span>
                  )}
                </Show>
              }
              onSelect={props.onSelectView}
            />
            <QuickRow
              view="artifacts"
              icon={<LayoutDashboard aria-hidden="true" />}
              label={t("workspace.view.artifacts")}
              active={props.activeView === "artifacts"}
              onSelect={props.onSelectView}
            />
            <QuickRow
              view="agents"
              icon={<ArrowLeftRight aria-hidden="true" />}
              label={t("workspace.view.agents")}
              active={props.activeView === "agents"}
              onSelect={props.onSelectView}
            />
            <Show when={props.showStorage}>
              <QuickRow
                view="storage"
                icon={<HardDrive aria-hidden="true" />}
                label={t("storageHygiene.title")}
                active={props.activeView === "storage"}
                onSelect={props.onSelectView}
              />
            </Show>
            <Show when={props.onOpenApps}>
              {(open) => (
                <Button variant="ghost" class="ws-sidebar-row" data-ws-row="" onClick={() => open()()}>
                  <span class="ws-sidebar-row-icon">
                    <Blocks aria-hidden="true" />
                  </span>
                  <span class="ws-sidebar-row-label">{t("workspace.view.apps")}</span>
                </Button>
              )}
            </Show>
          </div>

          <SidebarGroup
            label={t("workspace.sidebar.channels")}
            open={channelsOpen()}
            onToggle={() => setChannelsOpen((open) => !open)}
            onAdd={props.onAddChannel}
            addLabel={t("workspace.sidebar.addChannel")}
          >
            <Show when={props.filtering && props.channels.length === 0}>
              <p class="ws-sidebar-empty">{t("workspace.sidebar.noMatches")}</p>
            </Show>
            <For each={props.channels} keyed={(channel) => channel.id}>
              {(channel) => (
                <SidebarRow
                  id={channel().id}
                  active={props.activeConversationId === channel().id}
                  unread={channel().unread}
                  mentionCount={channel().mentionCount}
                  muted={channel().muted}
                  dragHandle={props.dragHandle}
                  group="channels"
                  order={() => props.channels.map((row) => row.id)}
                  onReorder={props.onReorder}
                  menu={props.rowMenu}
                  label={channel().name}
                  accessibleLabel={t(
                    channel().visibility === "private"
                      ? "workspace.sidebar.privateChannel"
                      : "workspace.sidebar.publicChannel",
                    { name: channel().name },
                  )}
                  icon={
                    <Show when={channel().visibility === "private"} fallback={<Hash aria-hidden="true" />}>
                      <Lock aria-hidden="true" />
                    </Show>
                  }
                  onSelect={props.onSelectConversation}
                />
              )}
            </For>
            <Show when={props.onAddChannel}>
              {(add) => (
                <Button variant="ghost" class="ws-sidebar-row ws-sidebar-add" data-ws-row="" onClick={() => add()()}>
                  <span class="ws-sidebar-row-icon ws-sidebar-add-icon">
                    <Plus aria-hidden="true" />
                  </span>
                  <span class="ws-sidebar-row-label">{t("workspace.sidebar.addChannels")}</span>
                </Button>
              )}
            </Show>
          </SidebarGroup>

          <SidebarGroup
            label={t("workspace.sidebar.directMessages")}
            open={directOpen()}
            onToggle={() => setDirectOpen((open) => !open)}
            onAdd={props.onNewMessage}
            addLabel={t("workspace.sidebar.newMessage")}
          >
            <Show when={props.filtering && props.directMessages.length === 0}>
              <p class="ws-sidebar-empty">{t("workspace.sidebar.noMatches")}</p>
            </Show>
            <For each={props.directMessages} keyed={(dm) => dm.id}>
              {(dm) => (
                <SidebarRow
                  id={dm().id}
                  active={props.activeConversationId === dm().id}
                  unread={dm().unread}
                  mentionCount={dm().mentionCount}
                  muted={dm().muted}
                  dragHandle={props.dragHandle}
                  group="direct"
                  order={() => props.directMessages.map((row) => row.id)}
                  onReorder={props.onReorder}
                  menu={props.rowMenu}
                  label={dm()
                    .members.map((member) => member.name)
                    .join(", ")}
                  accessibleLabel={directLabel(dm(), t)}
                  icon={<DirectIcon dm={dm()} />}
                  badge={
                    <Show when={dm().kind === "dm" && dm().members[0]?.kind === "agent"}>
                      <AiBadge />
                      <Show when={dm().members[0]?.working}>
                        <span class="ws-working-pulse" aria-hidden="true" />
                      </Show>
                    </Show>
                  }
                  onSelect={props.onSelectConversation}
                />
              )}
            </For>
            <Show when={props.onAddTeammate}>
              {(add) => (
                <Button variant="ghost" class="ws-sidebar-row ws-sidebar-add" data-ws-row="" onClick={() => add()()}>
                  <span class="ws-sidebar-row-icon ws-sidebar-add-icon">
                    <UserRoundPlus aria-hidden="true" />
                  </span>
                  <span class="ws-sidebar-row-label">{t("workspace.sidebar.addTeammates")}</span>
                </Button>
              )}
            </Show>
          </SidebarGroup>
        </div>
      </nav>
    </WorkspaceContextMenu>
  );
}

function directLabel(dm: SidebarDirectMessage, t: AppTranslate): string {
  const [first] = dm.members;
  if (dm.kind === "group" || !first)
    return t("workspace.sidebar.groupDm", { names: dm.members.map((m) => m.name).join(", ") });
  if (first.kind === "agent") {
    return t(first.working ? "workspace.sidebar.agentDmWorking" : "workspace.sidebar.agentDm", { name: first.name });
  }
  return t("workspace.sidebar.humanDm", {
    name: first.name,
    presence: t(presenceLabelKey(first.presence)),
  });
}

function DirectIcon(props: { dm: SidebarDirectMessage }): JSX.Element {
  return (
    <Show
      when={props.dm.kind === "group"}
      fallback={
        <Show when={props.dm.members[0]} fallback={<UsersRound aria-hidden="true" />}>
          {(member) => <MemberAvatar member={member()} size="xs" showStatus animate />}
        </Show>
      }
    >
      <AvatarStack members={props.dm.members} max={2} size="xs" class="ws-sidebar-group-faces" />
    </Show>
  );
}

function QuickRow(props: {
  view: WorkspaceView;
  icon: JSX.Element;
  label: string;
  active: boolean;
  count?: number | undefined;
  unread?: boolean | undefined;
  trailing?: JSX.Element;
  onSelect: (view: WorkspaceView) => void;
}): JSX.Element {
  return (
    <Button
      variant="ghost"
      class="ws-sidebar-row"
      data-ws-row=""
      data-active={props.active ? "" : undefined}
      data-unread={props.unread || (props.count ?? 0) > 0 ? "" : undefined}
      aria-current={props.active ? "page" : undefined}
      onClick={() => props.onSelect(props.view)}
    >
      <span class="ws-sidebar-row-icon">{props.icon}</span>
      <span class="ws-sidebar-row-label">{props.label}</span>
      {props.trailing}
      <Show when={props.count}>{(count) => <span class="ws-mention-badge">{Math.min(count(), 99)}</span>}</Show>
    </Button>
  );
}

function SidebarGroup(props: {
  label: string;
  open: boolean;
  onToggle: () => void;
  onAdd?: (() => void) | undefined;
  addLabel: string;
  children: JSX.Element;
}): JSX.Element {
  return (
    <section class="ws-sidebar-group" aria-label={props.label}>
      <div class="ws-sidebar-group-header">
        <Button
          variant="ghost"
          class="ws-sidebar-group-toggle"
          data-ws-row=""
          aria-expanded={props.open ? "true" : "false"}
          onClick={() => props.onToggle()}
        >
          <Show when={props.open} fallback={<ChevronRight aria-hidden="true" />}>
            <ChevronDown aria-hidden="true" />
          </Show>
          <span>{props.label}</span>
        </Button>
        <Show when={props.onAdd}>
          {(add) => (
            <IconButton
              class="ws-sidebar-group-add"
              variant="ghost"
              size="icon-xs"
              label={props.addLabel}
              onClick={() => add()()}
            >
              <Plus />
            </IconButton>
          )}
        </Show>
      </div>
      <Show when={props.open}>
        <div class="ws-sidebar-group-rows">{props.children}</div>
      </Show>
    </section>
  );
}

/** The row that a drag in the sidebar carries. One drag at a time, so one record. */
let dragged: { id: string; group: SidebarGroupId } | null = null;

function SidebarRow(props: {
  id: string;
  label: string;
  accessibleLabel: string;
  icon: JSX.Element;
  badge?: JSX.Element;
  active: boolean;
  unread?: boolean | undefined;
  mentionCount?: number | undefined;
  muted?: boolean | undefined;
  dragHandle?: ((id: string) => JSX.Element) | undefined;
  group: SidebarGroupId;
  /** The ids of the group, in the order it shows. */
  order: () => string[];
  onReorder?: ((group: SidebarGroupId, ids: string[]) => void) | undefined;
  menu?: ((id: string, group: SidebarGroupId) => readonly WorkspaceMenuItem[]) | undefined;
  onSelect: (id: string) => void;
}): JSX.Element {
  const { t } = useText();
  const mentions = () => props.mentionCount ?? 0;
  const [armed, setArmed] = createSignal(false);
  const [menuOpen, setMenuOpen] = createSignal(false);
  const [drop, setDrop] = createSignal<"before" | "after" | null>(null);
  const arm = () => {
    if (!armed()) setArmed(true);
  };
  const dropSide = (element: HTMLElement, event: DragEvent) => {
    const box = element.getBoundingClientRect();
    return event.clientY < box.top + box.height / 2 ? "before" : "after";
  };
  return (
    <div
      class="ws-sidebar-item"
      draggable={props.onReorder ? "true" : undefined}
      data-drop={drop() ?? undefined}
      data-menu-open={menuOpen() ? "" : undefined}
      ref={(element: HTMLDivElement) => {
        // The row's button takes the pointer and the keyboard; the item only builds its menu on the
        // first visit, and carries the drag. Move up and Move down in the menu reorder by keyboard.
        element.addEventListener("pointerenter", arm);
        element.addEventListener("focusin", arm);
        element.addEventListener("dragstart", (event) => {
          if (!props.onReorder) return;
          dragged = { id: props.id, group: props.group };
          event.dataTransfer?.setData("text/plain", props.label);
          if (event.dataTransfer) event.dataTransfer.effectAllowed = "move";
        });
        element.addEventListener("dragend", () => {
          dragged = null;
          setDrop(null);
        });
        element.addEventListener("dragover", (event) => {
          if (!props.onReorder || !dragged || dragged.group !== props.group || dragged.id === props.id) return;
          event.preventDefault();
          if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
          setDrop(dropSide(element, event));
        });
        element.addEventListener("dragleave", () => setDrop(null));
        element.addEventListener("drop", (event) => {
          const source = dragged;
          setDrop(null);
          if (!props.onReorder || !source || source.group !== props.group || source.id === props.id) return;
          event.preventDefault();
          const ids = props.order().filter((id) => id !== source.id);
          const at = ids.indexOf(props.id) + (dropSide(element, event) === "after" ? 1 : 0);
          ids.splice(at, 0, source.id);
          props.onReorder(props.group, ids);
        });
      }}
    >
      <Show when={props.dragHandle}>{(handle) => <span class="ws-sidebar-drag">{handle()(props.id)}</span>}</Show>
      <WorkspaceContextMenu
        items={() => props.menu?.(props.id, props.group) ?? []}
        label={t("workspace.sidebar.rowMenu", { name: props.label })}
      >
        <Button
          variant="ghost"
          class="ws-sidebar-row"
          data-ws-row=""
          data-active={props.active ? "" : undefined}
          data-unread={(props.unread || mentions() > 0) && !props.muted ? "" : undefined}
          data-muted={props.muted ? "" : undefined}
          aria-current={props.active ? "page" : undefined}
          aria-label={[
            props.accessibleLabel,
            mentions() > 0
              ? t("workspace.sidebar.mentions", { count: mentions() })
              : props.unread
                ? t("workspace.sidebar.unread")
                : "",
            props.muted ? t("workspace.sidebar.muted") : "",
          ]
            .filter(Boolean)
            .join(", ")}
          onClick={() => props.onSelect(props.id)}
        >
          <span class="ws-sidebar-row-icon">{props.icon}</span>
          <span class="ws-sidebar-row-label">{props.label}</span>
          {props.badge}
          <Show when={mentions() > 0}>
            <span class="ws-mention-badge" aria-hidden="true">
              {Math.min(mentions(), 99)}
            </span>
          </Show>
        </Button>
      </WorkspaceContextMenu>
      <Show when={armed() && props.menu}>
        {(menu) => (
          <WorkspaceMenu
            items={menu()(props.id, props.group)}
            label={t("workspace.sidebar.rowMenu", { name: props.label })}
            triggerClass="ws-sidebar-row-more"
            placement="bottom-start"
            onOpenChange={setMenuOpen}
          >
            <Ellipsis aria-hidden="true" />
          </WorkspaceMenu>
        )}
      </Show>
    </div>
  );
}

/** Up and Down move between the rows of the sidebar, Home and End to the first and the last. */
function moveRowFocus(event: KeyboardEvent & { currentTarget: HTMLElement }): void {
  if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
  const rows = [...event.currentTarget.querySelectorAll<HTMLElement>("[data-ws-row]")];
  const index = rows.findIndex((row) => row === document.activeElement);
  if (index < 0) return;
  event.preventDefault();
  const next =
    event.key === "Home"
      ? 0
      : event.key === "End"
        ? rows.length - 1
        : Math.min(rows.length - 1, Math.max(0, index + (event.key === "ArrowDown" ? 1 : -1)));
  rows[next]?.focus();
}
