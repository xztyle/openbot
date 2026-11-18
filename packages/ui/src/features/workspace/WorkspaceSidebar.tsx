import type { AppTranslate } from "@openbot/i18n";
import type { JSX } from "@solidjs/web";
import { createSignal, For, Show } from "solid-js";
import { ActionSheet, type ActionSheetItem } from "../../action-sheet";
import { Button, buttonVariants, IconButton } from "../../button";
import { DropdownMenu } from "../../complex";
import {
  Activity,
  ArrowLeftRight,
  AtSign,
  Blocks,
  Bookmark,
  Bot,
  Check,
  ChevronDown,
  ChevronRight,
  Ellipsis,
  FolderPlus,
  HardDrive,
  Hash,
  Inbox,
  KeyRound,
  LayoutDashboard,
  ListFilter,
  Lock,
  MessageSquareText,
  MessagesSquare,
  Pencil,
  Plus,
  SquarePen,
  Trash2,
  UserRoundPlus,
  UsersRound,
} from "../../icons";
import { useText } from "../../text";
import { cx, usesTouchLayout } from "../../utils";
import { AiBadge, AvatarStack, MemberAvatar, presenceLabelKey } from "./WorkspaceAvatar";
import { WorkspaceContextMenu } from "./WorkspaceContextMenu";
import { WorkspaceMenu } from "./WorkspaceMenu";
import type { ChannelVisibility, WorkspaceMember, WorkspaceMenuItem } from "./workspace-types";

/** The views above the channel list. */
export type WorkspaceView =
  | "threads"
  | "activity"
  | "fleet"
  | "artifacts"
  | "agents"
  | "storage"
  | "routines"
  | "secrets"
  /** The agents of the space that shows. */
  | "space-agents"
  /** Slack's Drafts & sent: the unsent drafts of each conversation, and the reader's sent messages. */
  | "drafts"
  /** Slack's All unreads: the unread messages of each conversation. */
  | "unreads"
  /** Slack's Later: the saved messages, in progress and completed. */
  | "later"
  /** Every DM and group DM, newest first, with the last message. */
  | "dms"
  /** The results of a message search. */
  | "search";

export interface SidebarChannel {
  id: string;
  name: string;
  visibility: ChannelVisibility;
  /** Has messages the reader has not read. The name shows in bold. */
  unread?: boolean | undefined;
  /** Mentions of the reader that are not read. */
  mentionCount?: number | undefined;
  muted?: boolean | undefined;
  /** The reader wrote a message here and did not send it: a pencil shows, as in Slack. */
  draft?: boolean | undefined;
  /** The time of the newest message, in milliseconds, for the Recent activity sort. */
  activityAt?: number | undefined;
}

export interface SidebarDirectMessage {
  id: string;
  kind: "dm" | "group";
  /** The other members. A DM has one; a group DM has two or more. */
  members: readonly WorkspaceMember[];
  unread?: boolean | undefined;
  mentionCount?: number | undefined;
  muted?: boolean | undefined;
  draft?: boolean | undefined;
  activityAt?: number | undefined;
}

/** How a sidebar section sorts its rows, as Slack's "Sort". `custom` is the reader's own order. */
export type SidebarSort = "custom" | "alpha" | "recent" | "priority";
/** Which rows a section shows, as Slack's "Show". */
export type SidebarShow = "all" | "unreads" | "mentions";

/** One conversation row of a section: a channel, or a DM or group DM. */
export type SidebarItem = { type: "channel"; row: SidebarChannel } | { type: "direct"; row: SidebarDirectMessage };

/**
 * A section of the sidebar: Starred, a section that the reader made, Channels or Direct messages.
 * The caller sorts and filters the items; the sidebar draws them in the order it gets them.
 */
export interface SidebarSection {
  /** `starred`, `channels`, `direct`, or the id of a section that the reader made. */
  id: string;
  kind: "starred" | "channels" | "direct" | "custom";
  /** The name of a section that the reader made. */
  name?: string | undefined;
  items: readonly SidebarItem[];
  sort?: SidebarSort | undefined;
  show?: SidebarShow | undefined;
}

/** A change of a section's sort or filter. */
export interface SidebarSectionOptions {
  sort?: SidebarSort;
  show?: SidebarShow;
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
  /** A conversation has unread messages: the Unreads row is bold. */
  unreadsUnread?: boolean | undefined;
  /** Shows Later, for a host that keeps saved messages. */
  showLater?: boolean | undefined;
  /** Saved messages that are not completed. */
  laterCount?: number | undefined;
  /** Agents that work now. */
  workingAgentCount?: number | undefined;
  /** Shows the Drafts & sent row, with the number of drafts. Absent: no row. */
  draftCount?: number | undefined;
  /** Shows the Storage view, for an owner or an admin of a host that reports its storage. */
  showStorage?: boolean | undefined;
  /** The agent key store, for the owner and the admins. */
  showSecrets?: boolean | undefined;
  /** Shows the Agents view of the space that shows, on a host with spaces. */
  showSpaceAgents?: boolean | undefined;
  /** Opens the server's apps (Discord, Slack, Telegram and other connectors), for an owner or an admin. */
  onOpenApps?: (() => void) | undefined;
  channels: readonly SidebarChannel[];
  directMessages: readonly SidebarDirectMessage[];
  /**
   * The sections in the order they show. Absent: Channels and Direct messages, from `channels` and
   * `directMessages`, in the order they come.
   */
  sections?: readonly SidebarSection[] | undefined;
  onAddChannel?: (() => void) | undefined;
  onAddTeammate?: (() => void) | undefined;
  onAddAgent?: (() => void) | undefined;
  /** A drag handle for a row, when the caller lets the reader sort them. */
  dragHandle?: ((id: string) => JSX.Element) | undefined;
  /**
   * Lets the reader drag the rows of a section into their own order. It gets the section id and the
   * ids of the section in the new order.
   */
  onReorder?: ((section: string, ids: string[]) => void) | undefined;
  /**
   * Lets the reader drag a row into another section, or onto its header. `beforeId` is the row it
   * lands above, or null for the end.
   */
  onMoveToSection?: ((conversationId: string, section: string, beforeId: string | null) => void) | undefined;
  /** The items of a row's menu, such as mute and move. The menu is built when the row is hovered. */
  rowMenu?: ((id: string, section: string) => readonly WorkspaceMenuItem[]) | undefined;
  /** Changes the sort or the filter of a section. Without it, the section headers have no options menu. */
  onSectionOptions?: ((section: string, options: SidebarSectionOptions) => void) | undefined;
  onCreateSection?: (() => void) | undefined;
  onRenameSection?: ((section: string) => void) | undefined;
  onDeleteSection?: ((section: string) => void) | undefined;
  /** A filter is on: the groups show what matches, and say so when nothing does. */
  filtering?: boolean | undefined;
  /** The sections the reader collapsed. Absent: the sidebar keeps the state itself for the session. */
  collapsedGroups?: readonly string[] | undefined;
  onCollapsedChange?: ((section: string, collapsed: boolean) => void) | undefined;
  class?: string;
}

/** The views under More: the admin and agent views that Slack keeps out of the top rows. */
const MORE_VIEWS = [
  "dms",
  "space-agents",
  "artifacts",
  "agents",
  "storage",
  "secrets",
] as const satisfies readonly WorkspaceView[];
type MoreView = (typeof MORE_VIEWS)[number];

/** The groups of conversations that every sidebar has. */
export type SidebarGroupId = "channels" | "direct";

const SORTS = [
  { sort: "custom", label: "workspace.sidebar.sort.custom" },
  { sort: "alpha", label: "workspace.sidebar.sort.alpha" },
  { sort: "recent", label: "workspace.sidebar.sort.recent" },
  { sort: "priority", label: "workspace.sidebar.sort.priority" },
] as const satisfies readonly { sort: SidebarSort; label: string }[];
const SHOWS = [
  { show: "all", label: "workspace.sidebar.show.all" },
  { show: "unreads", label: "workspace.sidebar.show.unreads" },
  { show: "mentions", label: "workspace.sidebar.show.mentions" },
] as const satisfies readonly { show: SidebarShow; label: string }[];

/** A row that a collapsed section keeps: unread and not muted, mentioned, or open. */
function rowNeedsReader(row: SidebarChannel | SidebarDirectMessage): boolean {
  return (row.unread === true && !row.muted) || (row.mentionCount ?? 0) > 0;
}

/** The name of a row, as it shows. */
export function sidebarItemLabel(item: SidebarItem): string {
  return item.type === "channel" ? item.row.name : item.row.members.map((member) => member.name).join(", ");
}

/**
 * The Slack sidebar: workspace header, the fixed rows (Unreads, Threads, Activity, Drafts & sent,
 * Later, Fleet) and More for the
 * other views, then the sections: Starred, the reader's own, Channels and Direct messages. A
 * collapsed section still shows its unread rows and the open conversation. Up and Down move between
 * rows; Left and Right collapse and open a section; a letter moves to the next row with that letter.
 */
export function WorkspaceSidebar(props: WorkspaceSidebarProps): JSX.Element {
  const { t } = useText();
  const [localCollapsed, setLocalCollapsed] = createSignal<ReadonlySet<string>>(new Set());
  const collapsed = (section: string) =>
    props.collapsedGroups ? props.collapsedGroups.includes(section) : localCollapsed().has(section);
  const toggleSection = (section: string, next = !collapsed(section)) => {
    if (next === collapsed(section)) return;
    if (props.onCollapsedChange) props.onCollapsedChange(section, next);
    else
      setLocalCollapsed((current) => {
        const copy = new Set(current);
        if (next) copy.add(section);
        else copy.delete(section);
        return copy;
      });
  };
  const sections = (): readonly SidebarSection[] =>
    props.sections ?? [
      { id: "channels", kind: "channels", items: props.channels.map((row) => ({ type: "channel", row })) },
      { id: "direct", kind: "direct", items: props.directMessages.map((row) => ({ type: "direct", row })) },
    ];
  const moreAvailable = (view: MoreView) =>
    view === "space-agents"
      ? Boolean(props.showSpaceAgents)
      : view === "storage"
        ? Boolean(props.showStorage)
        : view === "secrets"
          ? Boolean(props.showSecrets)
          : true;
  const MORE_ICON: Record<MoreView, () => JSX.Element> = {
    dms: () => <MessagesSquare aria-hidden="true" />,
    "space-agents": () => <Bot aria-hidden="true" />,
    artifacts: () => <LayoutDashboard aria-hidden="true" />,
    agents: () => <ArrowLeftRight aria-hidden="true" />,
    storage: () => <HardDrive aria-hidden="true" />,
    secrets: () => <KeyRound aria-hidden="true" />,
  };
  const moreLabel = (view: MoreView) =>
    view === "dms"
      ? t("workspace.view.dms")
      : view === "space-agents"
        ? t("workspace.view.spaceAgents")
        : view === "artifacts"
          ? t("workspace.view.artifacts")
          : view === "agents"
            ? t("workspace.view.agents")
            : view === "storage"
              ? t("storageHygiene.title")
              : t("workspace.view.secrets");
  /** The view under More that shows now: it gets a row of its own above More while it shows. */
  const activeMore = () => MORE_VIEWS.find((view) => view === props.activeView && moreAvailable(view));
  const moreItems = (): WorkspaceMenuItem[] => [
    ...MORE_VIEWS.filter(moreAvailable).map((view) => ({
      id: view,
      label: moreLabel(view),
      icon: MORE_ICON[view](),
      onSelect: () => props.onSelectView(view),
    })),
    ...(props.onOpenApps
      ? [
          {
            id: "apps",
            label: t("workspace.view.apps"),
            icon: <Blocks aria-hidden="true" />,
            onSelect: props.onOpenApps,
          },
        ]
      : []),
  ];
  const sectionLabel = (section: SidebarSection) =>
    section.kind === "custom"
      ? (section.name ?? "")
      : section.kind === "starred"
        ? t("workspace.sidebar.starred")
        : section.kind === "channels"
          ? t("workspace.sidebar.channels")
          : t("workspace.sidebar.directMessages");
  return (
    <WorkspaceContextMenu
      items={() => props.workspaceMenu ?? []}
      label={t("workspace.sidebar.workspaceMenu", { name: props.workspaceName })}
    >
      <nav
        class={cx("ws-sidebar", props.class)}
        aria-label={t("workspace.sidebar.label")}
        onKeyDown={(event) => sidebarKeys(event, toggleSection)}
      >
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
              view="unreads"
              icon={<Inbox aria-hidden="true" />}
              label={t("workspace.view.unreads")}
              active={props.activeView === "unreads"}
              unread={props.unreadsUnread}
              onSelect={props.onSelectView}
            />
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
            <Show when={props.draftCount !== undefined}>
              <QuickRow
                view="drafts"
                icon={<Pencil aria-hidden="true" />}
                label={t("workspace.view.drafts")}
                active={props.activeView === "drafts"}
                trailing={
                  <Show when={props.draftCount}>
                    {(count) => (
                      <span class="ws-sidebar-draft-count">
                        <span aria-hidden="true">{Math.min(count(), 99)}</span>
                        <span class="sr-only">{t("workspace.drafts.count", { count: count() })}</span>
                      </span>
                    )}
                  </Show>
                }
                onSelect={props.onSelectView}
              />
            </Show>
            <Show when={props.showLater}>
              <QuickRow
                view="later"
                icon={<Bookmark aria-hidden="true" />}
                label={t("workspace.view.later")}
                active={props.activeView === "later"}
                trailing={
                  <Show when={props.laterCount}>
                    {(count) => <span class="ws-sidebar-later-count">{count()}</span>}
                  </Show>
                }
                onSelect={props.onSelectView}
              />
            </Show>
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
            <Show when={activeMore()}>
              {(view) => (
                <QuickRow
                  view={view()}
                  icon={MORE_ICON[view()]()}
                  label={moreLabel(view())}
                  active
                  onSelect={props.onSelectView}
                />
              )}
            </Show>
            <WorkspaceMenu
              row
              items={moreItems()}
              label={t("workspace.sidebar.more")}
              triggerClass="ws-sidebar-row ws-sidebar-more"
              placement="right-start"
            >
              <span class="ws-sidebar-row-icon">
                <Ellipsis aria-hidden="true" />
              </span>
              <span class="ws-sidebar-row-label">{t("workspace.sidebar.more")}</span>
            </WorkspaceMenu>
          </div>

          <For each={sections()} keyed={(section) => section.id}>
            {(section) => {
              // A filter shows every match, also in a collapsed section.
              const open = () => !collapsed(section().id) || Boolean(props.filtering);
              const items = () =>
                open()
                  ? section().items
                  : section().items.filter(
                      (item) => rowNeedsReader(item.row) || item.row.id === props.activeConversationId,
                    );
              const onAdd = () =>
                section().kind === "channels"
                  ? props.onAddChannel
                  : section().kind === "direct"
                    ? props.onNewMessage
                    : undefined;
              return (
                <SidebarGroup
                  section={section()}
                  label={sectionLabel(section())}
                  open={open()}
                  hiddenUnread={!open() && section().items.some((item) => rowNeedsReader(item.row))}
                  onToggle={() => toggleSection(section().id)}
                  onAdd={onAdd()}
                  addLabel={t(
                    section().kind === "channels" ? "workspace.sidebar.addChannel" : "workspace.sidebar.newMessage",
                  )}
                  onOptions={props.onSectionOptions}
                  onCreateSection={props.onCreateSection}
                  onRenameSection={props.onRenameSection}
                  onDeleteSection={props.onDeleteSection}
                  onMoveToSection={props.onMoveToSection}
                >
                  <Show when={props.filtering && section().items.length === 0}>
                    <p class="ws-sidebar-empty">{t("workspace.sidebar.noMatches")}</p>
                  </Show>
                  <Show when={!props.filtering && open() && section().kind === "custom" && !section().items.length}>
                    <p class="ws-sidebar-empty">{t("workspace.sidebar.sectionEmpty")}</p>
                  </Show>
                  <For each={items()} keyed={(item) => item.row.id}>
                    {(item) => (
                      <SidebarItemRow
                        item={item()}
                        section={section()}
                        active={props.activeConversationId === item().row.id}
                        dragHandle={props.dragHandle}
                        order={() => items().map((entry) => entry.row.id)}
                        onReorder={props.onReorder}
                        onMoveToSection={props.onMoveToSection}
                        menu={props.rowMenu}
                        onSelect={props.onSelectConversation}
                      />
                    )}
                  </For>
                  <Show when={open() && section().kind === "channels" && props.onAddChannel}>
                    {(add) => (
                      <Button
                        variant="ghost"
                        class="ws-sidebar-row ws-sidebar-add"
                        data-ws-row=""
                        onClick={() => add()()}
                      >
                        <span class="ws-sidebar-row-icon ws-sidebar-add-icon">
                          <Plus aria-hidden="true" />
                        </span>
                        <span class="ws-sidebar-row-label">{t("workspace.sidebar.addChannels")}</span>
                      </Button>
                    )}
                  </Show>
                  <Show when={open() && section().kind === "direct" && props.onAddAgent}>
                    {(add) => (
                      <Button
                        variant="ghost"
                        class="ws-sidebar-row ws-sidebar-add"
                        data-ws-row=""
                        onClick={() => add()()}
                      >
                        <span class="ws-sidebar-row-icon ws-sidebar-add-icon">
                          <Bot aria-hidden="true" />
                        </span>
                        <span class="ws-sidebar-row-label">{t("workspace.sidebar.addAgent")}</span>
                      </Button>
                    )}
                  </Show>
                  <Show when={open() && section().kind === "direct" && props.onAddTeammate}>
                    {(add) => (
                      <Button
                        variant="ghost"
                        class="ws-sidebar-row ws-sidebar-add"
                        data-ws-row=""
                        onClick={() => add()()}
                      >
                        <span class="ws-sidebar-row-icon ws-sidebar-add-icon">
                          <UserRoundPlus aria-hidden="true" />
                        </span>
                        <span class="ws-sidebar-row-label">{t("workspace.sidebar.addTeammates")}</span>
                      </Button>
                    )}
                  </Show>
                </SidebarGroup>
              );
            }}
          </For>
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

/** The row that a drag in the sidebar carries. One drag at a time, so one record. */
let dragged: { id: string; section: string; type: SidebarItem["type"] } | null = null;

/** Whether a section takes a row of this type: Channels takes channels, Direct messages takes DMs. */
function sectionTakes(section: SidebarSection, type: SidebarItem["type"]): boolean {
  if (section.kind === "channels") return type === "channel";
  if (section.kind === "direct") return type === "direct";
  return true;
}

function SidebarGroup(props: {
  section: SidebarSection;
  label: string;
  open: boolean;
  /** Collapsed with unread rows in it: the header says so, as Slack's does. */
  hiddenUnread?: boolean | undefined;
  onToggle: () => void;
  onAdd?: (() => void) | undefined;
  addLabel: string;
  onOptions?: ((section: string, options: SidebarSectionOptions) => void) | undefined;
  onCreateSection?: (() => void) | undefined;
  onRenameSection?: ((section: string) => void) | undefined;
  onDeleteSection?: ((section: string) => void) | undefined;
  onMoveToSection?: ((conversationId: string, section: string, beforeId: string | null) => void) | undefined;
  children: JSX.Element;
}): JSX.Element {
  const { t } = useText();
  const [dropping, setDropping] = createSignal(false);
  const filtered = () => (props.section.show ?? "all") !== "all";
  const accepts = () =>
    Boolean(
      props.onMoveToSection &&
        dragged &&
        dragged.section !== props.section.id &&
        sectionTakes(props.section, dragged.type),
    );
  return (
    <section class="ws-sidebar-group" aria-label={props.label} data-ws-section={props.section.id}>
      <div
        class="ws-sidebar-group-header"
        data-drop={dropping() ? "" : undefined}
        ref={(element: HTMLDivElement) => {
          // A row dropped on the header goes to the end of this section.
          element.addEventListener("dragover", (event) => {
            if (!accepts()) return;
            event.preventDefault();
            if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
            setDropping(true);
          });
          element.addEventListener("dragleave", () => setDropping(false));
          element.addEventListener("drop", (event) => {
            setDropping(false);
            const source = dragged;
            if (!source || !accepts()) return;
            event.preventDefault();
            props.onMoveToSection?.(source.id, props.section.id, null);
          });
        }}
      >
        <Button
          variant="ghost"
          class="ws-sidebar-group-toggle"
          data-ws-row=""
          data-ws-section-toggle={props.section.id}
          aria-expanded={props.open ? "true" : "false"}
          data-unread={props.hiddenUnread ? "" : undefined}
          onClick={() => props.onToggle()}
        >
          <Show when={props.open} fallback={<ChevronRight aria-hidden="true" />}>
            <ChevronDown aria-hidden="true" />
          </Show>
          <span class="ws-truncate">{props.label}</span>
          <Show when={filtered()}>
            <ListFilter class="ws-sidebar-group-filtered" aria-hidden="true" />
            <span class="sr-only">
              {t(
                props.section.show === "mentions"
                  ? "workspace.sidebar.show.mentions"
                  : "workspace.sidebar.show.unreads",
              )}
            </span>
          </Show>
          <Show when={props.hiddenUnread}>
            <span class="sr-only">{t("workspace.sidebar.groupHasUnread")}</span>
          </Show>
        </Button>
        <Show when={props.onOptions}>
          {(onOptions) => (
            <SectionMenu
              section={props.section}
              label={t("workspace.sidebar.sectionMenu", { name: props.label })}
              onOptions={onOptions()}
              onCreateSection={props.onCreateSection}
              onRenameSection={props.onRenameSection}
              onDeleteSection={props.onDeleteSection}
            />
          )}
        </Show>
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
      <div class="ws-sidebar-group-rows">{props.children}</div>
    </section>
  );
}

/** The options of a section header, as Slack's: sort, show, and the reader's own sections. */
function SectionMenu(props: {
  section: SidebarSection;
  label: string;
  onOptions: (section: string, options: SidebarSectionOptions) => void;
  onCreateSection?: (() => void) | undefined;
  onRenameSection?: ((section: string) => void) | undefined;
  onDeleteSection?: ((section: string) => void) | undefined;
}): JSX.Element {
  const { t } = useText();
  const sort = () => props.section.sort ?? "custom";
  const show = () => props.section.show ?? "all";
  // A phone has no hover and small menus: the options rise in a sheet, with rows a finger can hit.
  if (usesTouchLayout()) return <SectionSheet {...props} />;
  return (
    <DropdownMenu.Root placement="bottom-end" gutter={4}>
      <DropdownMenu.Trigger
        class={cx(buttonVariants({ variant: "ghost", size: "icon-xs" }), "ws-sidebar-group-options")}
        aria-label={props.label}
      >
        <Ellipsis aria-hidden="true" />
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content class="ws-sidebar-section-menu">
          <div class="ws-sidebar-menu-label" aria-hidden="true">
            {t("workspace.sidebar.sort.label")}
          </div>
          <DropdownMenu.RadioGroup
            value={sort()}
            aria-label={t("workspace.sidebar.sort.label")}
            onChange={(value) => {
              const next = SORTS.find((entry) => entry.sort === value)?.sort;
              if (next) props.onOptions(props.section.id, { sort: next });
            }}
          >
            <For each={SORTS}>
              {(entry) => (
                <DropdownMenu.RadioItem value={entry.sort} closeOnSelect>
                  <span class="ws-sidebar-menu-check">
                    <Show when={sort() === entry.sort}>
                      <Check aria-hidden="true" />
                    </Show>
                  </span>
                  <span>{t(entry.label)}</span>
                </DropdownMenu.RadioItem>
              )}
            </For>
          </DropdownMenu.RadioGroup>
          <DropdownMenu.Separator />
          <div class="ws-sidebar-menu-label" aria-hidden="true">
            {t("workspace.sidebar.show.label")}
          </div>
          <DropdownMenu.RadioGroup
            value={show()}
            aria-label={t("workspace.sidebar.show.label")}
            onChange={(value) => {
              const next = SHOWS.find((entry) => entry.show === value)?.show;
              if (next) props.onOptions(props.section.id, { show: next });
            }}
          >
            <For each={SHOWS}>
              {(entry) => (
                <DropdownMenu.RadioItem value={entry.show} closeOnSelect>
                  <span class="ws-sidebar-menu-check">
                    <Show when={show() === entry.show}>
                      <Check aria-hidden="true" />
                    </Show>
                  </span>
                  <span>{t(entry.label)}</span>
                </DropdownMenu.RadioItem>
              )}
            </For>
          </DropdownMenu.RadioGroup>
          <Show when={props.onCreateSection || (props.section.kind === "custom" && props.onRenameSection)}>
            <DropdownMenu.Separator />
          </Show>
          <Show when={props.onCreateSection}>
            {(create) => (
              <DropdownMenu.Item onSelect={() => create()()}>
                <FolderPlus aria-hidden="true" />
                <span>{t("workspace.sidebar.section.new")}</span>
              </DropdownMenu.Item>
            )}
          </Show>
          <Show when={props.section.kind === "custom" && props.onRenameSection}>
            {(rename) => (
              <DropdownMenu.Item onSelect={() => rename()(props.section.id)}>
                <Pencil aria-hidden="true" />
                <span>{t("workspace.sidebar.section.rename")}</span>
              </DropdownMenu.Item>
            )}
          </Show>
          <Show when={props.section.kind === "custom" && props.onDeleteSection}>
            {(remove) => (
              <DropdownMenu.Item class="ui-action-menu-danger" onSelect={() => remove()(props.section.id)}>
                <Trash2 aria-hidden="true" />
                <span>{t("workspace.sidebar.section.delete")}</span>
              </DropdownMenu.Item>
            )}
          </Show>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

/** The options of a section on a phone: Sort and Show as choices, then the section actions. */
function SectionSheet(props: {
  section: SidebarSection;
  label: string;
  onOptions: (section: string, options: SidebarSectionOptions) => void;
  onCreateSection?: (() => void) | undefined;
  onRenameSection?: ((section: string) => void) | undefined;
  onDeleteSection?: ((section: string) => void) | undefined;
}): JSX.Element {
  const { t } = useText();
  const [open, setOpen] = createSignal(false);
  const sort = () => props.section.sort ?? "custom";
  const show = () => props.section.show ?? "all";
  const choose = (options: SidebarSectionOptions) => {
    setOpen(false);
    props.onOptions(props.section.id, options);
  };
  const items = (): ActionSheetItem[] => [
    ...(props.onCreateSection
      ? [
          {
            id: "new",
            label: t("workspace.sidebar.section.new"),
            icon: <FolderPlus aria-hidden="true" />,
            onSelect: props.onCreateSection,
          },
        ]
      : []),
    ...(props.section.kind === "custom" && props.onRenameSection
      ? [
          {
            id: "rename",
            label: t("workspace.sidebar.section.rename"),
            icon: <Pencil aria-hidden="true" />,
            onSelect: () => props.onRenameSection?.(props.section.id),
          },
        ]
      : []),
    ...(props.section.kind === "custom" && props.onDeleteSection
      ? [
          {
            id: "delete",
            label: t("workspace.sidebar.section.delete"),
            icon: <Trash2 aria-hidden="true" />,
            danger: true,
            onSelect: () => props.onDeleteSection?.(props.section.id),
          },
        ]
      : []),
  ];
  const choice = (label: string, selected: boolean, onPick: () => void) => (
    <Button
      variant="ghost"
      class="ui-sheet-item ws-sidebar-sheet-choice"
      aria-pressed={selected ? "true" : "false"}
      onClick={onPick}
    >
      <span class="ws-sidebar-menu-check">
        <Show when={selected}>
          <Check aria-hidden="true" />
        </Show>
      </span>
      <span>{label}</span>
    </Button>
  );
  return (
    <>
      <IconButton
        class="ws-sidebar-group-options"
        variant="ghost"
        size="icon-xs"
        label={props.label}
        onClick={() => setOpen(true)}
      >
        <Ellipsis />
      </IconButton>
      <Show when={open()}>
        <ActionSheet
          open
          onOpenChange={setOpen}
          title={props.label}
          header={
            <div class="ws-sidebar-sheet-choices">
              <fieldset class="ws-sidebar-sheet-group">
                <legend class="ws-sidebar-menu-label">{t("workspace.sidebar.sort.label")}</legend>
                <For each={SORTS}>
                  {(entry) => choice(t(entry.label), sort() === entry.sort, () => choose({ sort: entry.sort }))}
                </For>
              </fieldset>
              <fieldset class="ws-sidebar-sheet-group">
                <legend class="ws-sidebar-menu-label">{t("workspace.sidebar.show.label")}</legend>
                <For each={SHOWS}>
                  {(entry) => choice(t(entry.label), show() === entry.show, () => choose({ show: entry.show }))}
                </For>
              </fieldset>
            </div>
          }
          items={items()}
        />
      </Show>
    </>
  );
}

function SidebarItemRow(props: {
  item: SidebarItem;
  section: SidebarSection;
  active: boolean;
  dragHandle?: ((id: string) => JSX.Element) | undefined;
  /** The ids of the section, in the order it shows. */
  order: () => string[];
  onReorder?: ((section: string, ids: string[]) => void) | undefined;
  onMoveToSection?: ((conversationId: string, section: string, beforeId: string | null) => void) | undefined;
  menu?: ((id: string, section: string) => readonly WorkspaceMenuItem[]) | undefined;
  onSelect: (id: string) => void;
}): JSX.Element {
  const { t } = useText();
  const channel = () => (props.item.type === "channel" ? props.item.row : null);
  const direct = () => (props.item.type === "direct" ? props.item.row : null);
  return (
    <SidebarRow
      id={props.item.row.id}
      type={props.item.type}
      section={props.section}
      active={props.active}
      unread={props.item.row.unread}
      mentionCount={props.item.row.mentionCount}
      muted={props.item.row.muted}
      draft={props.item.row.draft}
      dragHandle={props.dragHandle}
      order={props.order}
      onReorder={props.onReorder}
      onMoveToSection={props.onMoveToSection}
      menu={props.menu}
      label={sidebarItemLabel(props.item)}
      accessibleLabel={(() => {
        const row = channel();
        if (row)
          return t(
            row.visibility === "private" ? "workspace.sidebar.privateChannel" : "workspace.sidebar.publicChannel",
            { name: row.name },
          );
        const dm = direct();
        return dm ? directLabel(dm, t) : "";
      })()}
      icon={
        <Show when={channel()} fallback={<Show when={direct()}>{(dm) => <DirectIcon dm={dm()} />}</Show>}>
          {(row) => (
            <Show when={row().visibility === "private"} fallback={<Hash aria-hidden="true" />}>
              <Lock aria-hidden="true" />
            </Show>
          )}
        </Show>
      }
      badge={
        <Show when={direct()}>
          {(dm) => (
            <Show when={dm().kind === "dm" && dm().members[0]?.kind === "agent"}>
              <AiBadge />
              <Show when={dm().members[0]?.working}>
                <span class="ws-working-pulse" aria-hidden="true" />
              </Show>
            </Show>
          )}
        </Show>
      }
      onSelect={props.onSelect}
    />
  );
}

function SidebarRow(props: {
  id: string;
  type: SidebarItem["type"];
  label: string;
  accessibleLabel: string;
  icon: JSX.Element;
  badge?: JSX.Element;
  active: boolean;
  unread?: boolean | undefined;
  mentionCount?: number | undefined;
  muted?: boolean | undefined;
  draft?: boolean | undefined;
  dragHandle?: ((id: string) => JSX.Element) | undefined;
  section: SidebarSection;
  /** The ids of the section, in the order it shows. */
  order: () => string[];
  onReorder?: ((section: string, ids: string[]) => void) | undefined;
  onMoveToSection?: ((conversationId: string, section: string, beforeId: string | null) => void) | undefined;
  menu?: ((id: string, section: string) => readonly WorkspaceMenuItem[]) | undefined;
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
  const draggable = () => Boolean(props.onReorder || props.onMoveToSection);
  /** What a drop of the dragged row here does: reorder this section, or move the row into it. */
  const dropKind = (): "reorder" | "move" | null => {
    if (!dragged || dragged.id === props.id) return null;
    if (dragged.section === props.section.id) return props.onReorder ? "reorder" : null;
    return props.onMoveToSection && sectionTakes(props.section, dragged.type) ? "move" : null;
  };
  return (
    <div
      class="ws-sidebar-item"
      draggable={draggable() ? "true" : undefined}
      data-drop={drop() ?? undefined}
      data-menu-open={menuOpen() ? "" : undefined}
      ref={(element: HTMLDivElement) => {
        // The row's button takes the pointer and the keyboard; the item only builds its menu on the
        // first visit, and carries the drag. Move up and Move down in the menu reorder by keyboard.
        element.addEventListener("pointerenter", arm);
        element.addEventListener("focusin", arm);
        element.addEventListener("dragstart", (event) => {
          if (!draggable()) return;
          dragged = { id: props.id, section: props.section.id, type: props.type };
          event.dataTransfer?.setData("text/plain", props.label);
          if (event.dataTransfer) event.dataTransfer.effectAllowed = "move";
        });
        element.addEventListener("dragend", () => {
          dragged = null;
          setDrop(null);
        });
        element.addEventListener("dragover", (event) => {
          if (!dropKind()) return;
          event.preventDefault();
          event.stopPropagation();
          if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
          setDrop(dropSide(element, event));
        });
        element.addEventListener("dragleave", () => setDrop(null));
        element.addEventListener("drop", (event) => {
          const source = dragged;
          const kind = dropKind();
          setDrop(null);
          if (!source || !kind) return;
          event.preventDefault();
          event.stopPropagation();
          const side = dropSide(element, event);
          if (kind === "move") {
            const ids = props.order();
            const before = side === "before" ? props.id : (ids[ids.indexOf(props.id) + 1] ?? null);
            props.onMoveToSection?.(source.id, props.section.id, before);
            return;
          }
          const ids = props.order().filter((id) => id !== source.id);
          const at = ids.indexOf(props.id) + (side === "after" ? 1 : 0);
          ids.splice(at, 0, source.id);
          props.onReorder?.(props.section.id, ids);
        });
      }}
    >
      <Show when={props.dragHandle}>{(handle) => <span class="ws-sidebar-drag">{handle()(props.id)}</span>}</Show>
      <WorkspaceContextMenu
        items={() => props.menu?.(props.id, props.section.id) ?? []}
        label={t("workspace.sidebar.rowMenu", { name: props.label })}
      >
        <Button
          variant="ghost"
          class="ws-sidebar-row"
          data-ws-row=""
          data-ws-conversation={props.id}
          data-active={props.active ? "" : undefined}
          data-unread={(props.unread || mentions() > 0) && !props.muted ? "" : undefined}
          data-muted={props.muted ? "" : undefined}
          aria-current={props.active ? "page" : undefined}
          aria-label={[
            props.accessibleLabel,
            mentions() > 0
              ? t("workspace.sidebar.mentions", { count: mentions() })
              : props.unread && !props.muted
                ? t("workspace.sidebar.unread")
                : "",
            props.muted ? t("workspace.sidebar.muted") : "",
            props.draft ? t("workspace.sidebar.hasDraft") : "",
          ]
            .filter(Boolean)
            .join(", ")}
          onClick={() => props.onSelect(props.id)}
        >
          <span class="ws-sidebar-row-icon">{props.icon}</span>
          <span class="ws-sidebar-row-label">{props.label}</span>
          {props.badge}
          <Show when={(props.draft && !props.active) || mentions() > 0}>
            <span class="ws-sidebar-row-end">
              <Show when={props.draft && !props.active}>
                <Pencil class="ws-sidebar-row-draft" aria-hidden="true" />
              </Show>
              <Show when={mentions() > 0}>
                <span class="ws-mention-badge" aria-hidden="true">
                  {Math.min(mentions(), 99)}
                </span>
              </Show>
            </span>
          </Show>
        </Button>
      </WorkspaceContextMenu>
      <Show when={armed() && props.menu}>
        {(menu) => (
          <WorkspaceMenu
            items={menu()(props.id, props.section.id)}
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

/**
 * The keys of the sidebar, as Slack's: Up and Down move between the rows, Home and End to the first
 * and the last; Left on an open section header collapses it, Right opens it, and Left on a row goes
 * to its section header; a letter moves to the next conversation whose name starts with it.
 */
function sidebarKeys(
  event: KeyboardEvent & { currentTarget: HTMLElement },
  toggle: (section: string, collapsed: boolean) => void,
): void {
  if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) return;
  const active = document.activeElement;
  if (!(active instanceof HTMLElement) || !event.currentTarget.contains(active)) return;
  if (active.matches("input, textarea, [contenteditable='true'], [contenteditable='']")) return;
  const rows = [...event.currentTarget.querySelectorAll<HTMLElement>("[data-ws-row]")];
  const index = rows.indexOf(active);
  if (index < 0) return;
  const sectionToggle = active.dataset.wsSectionToggle;
  if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
    if (sectionToggle) {
      event.preventDefault();
      toggle(sectionToggle, event.key === "ArrowLeft");
      return;
    }
    if (event.key === "ArrowLeft") {
      const header = active
        .closest<HTMLElement>("[data-ws-section]")
        ?.querySelector<HTMLElement>("[data-ws-section-toggle]");
      if (header) {
        event.preventDefault();
        header.focus();
      }
    }
    return;
  }
  if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
    event.preventDefault();
    const next =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? rows.length - 1
          : Math.min(rows.length - 1, Math.max(0, index + (event.key === "ArrowDown" ? 1 : -1)));
    rows[next]?.focus();
    return;
  }
  // Type to find: the next conversation row whose name starts with the letter.
  if (event.key.length !== 1 || event.shiftKey || !/\p{L}|\p{N}/u.test(event.key)) return;
  const letter = event.key.toLocaleLowerCase();
  const conversations = rows.filter((row) => row.dataset.wsConversation !== undefined);
  const start = conversations.indexOf(active);
  const ordered = [...conversations.slice(start + 1), ...conversations.slice(0, Math.max(0, start + 1))];
  const match = ordered.find((row) =>
    (row.querySelector(".ws-sidebar-row-label")?.textContent ?? "").trim().toLocaleLowerCase().startsWith(letter),
  );
  if (match) {
    event.preventDefault();
    match.focus();
  }
}
