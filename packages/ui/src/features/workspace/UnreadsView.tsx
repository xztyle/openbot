import type { JSX } from "@solidjs/web";
import { createSignal, For, Match, Show, Switch } from "solid-js";
import { Button, IconButton } from "../../button";
import { CheckCheck, ChevronDown, ChevronRight, Hash, Inbox, Lock, RefreshCw } from "../../icons";
import { SlidingTabs } from "../../sliding-tabs";
import { useText } from "../../text";
import { cx } from "../../utils";
import { EmptyState, ErrorState, LoadingState } from "../../view-state";
import { MessageText } from "./MessageRow";
import { AvatarStack, MemberAvatar, MemberName } from "./WorkspaceAvatar";
import { WorkspacePaneHeader } from "./WorkspacePaneHeader";
import { WorkspaceSelect } from "./WorkspaceSelect";
import { useRecentTime } from "./workspace-format";
import type { ChannelVisibility, MessageSegment, WorkspaceMember } from "./workspace-types";

export interface UnreadMessageItem {
  id: string;
  author: WorkspaceMember;
  at: number;
  text: readonly MessageSegment[];
}

export interface UnreadGroup {
  /** The conversation id. */
  id: string;
  /** The channel name without `#`, or the names of a DM. */
  name: string;
  kind: "channel" | "dm" | "group";
  visibility: ChannelVisibility;
  /** The others of a DM or a group, for the faces. */
  members?: readonly WorkspaceMember[] | undefined;
  count: number;
  messages: readonly UnreadMessageItem[];
  /** Marked read in this view: the group folds and offers Undo. */
  read: boolean;
  collapsed: boolean;
}

/** Which conversations the list shows: all, channels, or DMs and groups. */
export type UnreadsFilter = "all" | "channels" | "direct";
/** The order of the groups: the sidebar's, or by their newest or oldest unread message. */
export type UnreadsSort = "sidebar" | "newest" | "oldest";

export interface UnreadsViewProps {
  groups: readonly UnreadGroup[];
  loading?: boolean | undefined;
  failed?: boolean | undefined;
  onRetry?: (() => void) | undefined;
  /** New unreads came after the list loaded; the header offers to load them. */
  stale?: boolean | undefined;
  onRefresh: () => void;
  onOpenMessage: (groupId: string, messageId: string) => void;
  onOpenConversation: (groupId: string) => void;
  onMarkRead: (groupId: string) => void;
  /** Absent when the host cannot mark a conversation unread again. */
  onUndo?: ((groupId: string) => void) | undefined;
  onToggle: (groupId: string) => void;
  onMarkAllRead: () => void;
  onBack?: (() => void) | undefined;
  class?: string;
}

/**
 * Slack's All unreads: one group for each unread conversation with its unread messages. Mark as
 * read folds a group and offers Undo; Mark all messages read reads every group. Up and Down move
 * between the messages, Left and Right fold and open a group, Escape marks the group read.
 */
export function UnreadsView(props: UnreadsViewProps): JSX.Element {
  const { t } = useText();
  const recent = useRecentTime();
  let list: HTMLDivElement | undefined;
  const [filter, setFilter] = createSignal<UnreadsFilter>("all");
  const [sort, setSort] = createSignal<UnreadsSort>("sidebar");
  const latest = (group: UnreadGroup) => Math.max(0, ...group.messages.map((message) => message.at));
  const earliest = (group: UnreadGroup) =>
    Math.min(Number.MAX_SAFE_INTEGER, ...group.messages.map((message) => message.at));
  /** The groups that the filter keeps, in the chosen order. */
  const shown = () => {
    const kept = props.groups.filter(
      (group) => filter() === "all" || (filter() === "channels") === (group.kind === "channel"),
    );
    if (sort() === "newest") return [...kept].sort((left, right) => latest(right) - latest(left));
    if (sort() === "oldest") return [...kept].sort((left, right) => earliest(left) - earliest(right));
    return kept;
  };
  const open = () => props.groups.filter((group) => !group.read);

  /** The rows that the arrows move through: each group's header and its messages. */
  const rows = () => [...(list?.querySelectorAll<HTMLElement>("[data-unreads-row]") ?? [])];
  const groupOf = (element: Element | null) =>
    element?.closest<HTMLElement>("[data-unreads-group]")?.dataset.unreadsGroup ?? null;
  const onKeyDown = (event: KeyboardEvent) => {
    const target = event.target instanceof HTMLElement ? event.target : null;
    if (!target?.hasAttribute("data-unreads-row")) return;
    const all = rows();
    const index = all.indexOf(target);
    const group = groupOf(target);
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      all[event.key === "ArrowDown" ? Math.min(all.length - 1, index + 1) : Math.max(0, index - 1)]?.focus();
    } else if (event.key === "Home" || event.key === "End") {
      event.preventDefault();
      (event.key === "Home" ? all[0] : all.at(-1))?.focus();
    } else if (group && (event.key === "ArrowLeft" || event.key === "ArrowRight")) {
      const item = props.groups.find((candidate) => candidate.id === group);
      if (item && item.collapsed === (event.key === "ArrowRight")) {
        event.preventDefault();
        props.onToggle(group);
      }
    } else if (group && event.key === "Escape") {
      // The group's Escape: the workspace's own Escape (mark the open channel read) does not run.
      event.preventDefault();
      event.stopPropagation();
      const next = all.slice(index + 1).find((row) => groupOf(row) !== group);
      props.onMarkRead(group);
      next?.focus();
    }
  };

  return (
    <section class={cx("ws-view ws-unreads", props.class)} aria-label={t("workspace.view.unreads")}>
      <WorkspacePaneHeader
        icon={<Inbox aria-hidden="true" />}
        title={t("workspace.view.unreads")}
        subtitle={open().length ? t("workspace.unreads.conversations", { count: open().length }) : undefined}
        onBack={props.onBack}
        actions={
          <>
            <Show when={props.stale}>
              <Button variant="ghost" size="xs" onClick={() => props.onRefresh()}>
                <RefreshCw aria-hidden="true" />
                {t("workspace.unreads.newMessages")}
              </Button>
            </Show>
            <Show when={open().length > 0}>
              <Button variant="ghost" size="xs" class="ws-unreads-header-action" onClick={() => props.onMarkAllRead()}>
                <CheckCheck aria-hidden="true" />
                {t("workspace.unreads.markAllRead")}
              </Button>
            </Show>
          </>
        }
      />
      <Show when={props.groups.length > 0}>
        <div class="ws-view-toolbar">
          <SlidingTabs.Root
            value={filter()}
            onChange={(value) => {
              if (value === "all" || value === "channels" || value === "direct") setFilter(value);
            }}
          >
            <SlidingTabs.List aria-label={t("workspace.unreads.filter")}>
              <SlidingTabs.Trigger value="all">{t("workspace.activity.all")}</SlidingTabs.Trigger>
              <SlidingTabs.Trigger value="channels">{t("workspace.sidebar.channels")}</SlidingTabs.Trigger>
              <SlidingTabs.Trigger value="direct">{t("workspace.activity.dms")}</SlidingTabs.Trigger>
            </SlidingTabs.List>
          </SlidingTabs.Root>
          <WorkspaceSelect<UnreadsSort>
            value={sort()}
            onChange={setSort}
            label={t("workspace.unreads.sort")}
            prefix={t("workspace.unreads.sortPrefix")}
            options={[
              { value: "sidebar", label: t("workspace.unreads.sortSidebar") },
              { value: "newest", label: t("workspace.unreads.sortNewest") },
              { value: "oldest", label: t("workspace.unreads.sortOldest") },
            ]}
          />
        </div>
      </Show>
      <div class="ws-view-scroll" ref={(element) => (list = element)}>
        <Show
          when={shown().length > 0}
          fallback={
            <Switch>
              <Match when={props.groups.length > 0}>
                <EmptyState
                  size="compact"
                  icon={<Inbox />}
                  title={t("workspace.view.noMatch")}
                  description={t("workspace.view.noMatchHint")}
                  action={
                    <Button variant="secondary" size="sm" onClick={() => setFilter("all")}>
                      {t("workspace.view.clearFilters")}
                    </Button>
                  }
                />
              </Match>
              <Match when={props.failed}>
                <ErrorState title={t("workspace.unreads.loadFailed")} onRetry={props.onRetry} />
              </Match>
              <Match when={props.loading}>
                <LoadingState label={t("workspace.view.unreads")} />
              </Match>
              <Match when={true}>
                <EmptyState
                  icon={<CheckCheck />}
                  title={t("workspace.unreads.emptyTitle")}
                  description={t("workspace.unreads.empty")}
                  action={
                    <Show when={props.stale}>
                      <Button variant="secondary" size="sm" onClick={() => props.onRefresh()}>
                        {t("workspace.unreads.newMessages")}
                      </Button>
                    </Show>
                  }
                />
              </Match>
            </Switch>
          }
        >
          <ul class="ws-unreads-groups">
            <For each={shown()} keyed={(group) => group.id}>
              {(group) => (
                <li class="ws-unreads-group" data-unreads-group={group().id} data-read={group().read ? "" : undefined}>
                  <header class="ws-unreads-group-header">
                    <IconButton
                      variant="ghost"
                      class="ws-unreads-toggle"
                      label={t(group().collapsed ? "workspace.unreads.expand" : "workspace.unreads.collapse", {
                        name: group().name,
                      })}
                      aria-expanded={group().collapsed ? "false" : "true"}
                      onClick={() => props.onToggle(group().id)}
                    >
                      <Show when={group().collapsed} fallback={<ChevronDown />}>
                        <ChevronRight />
                      </Show>
                    </IconButton>
                    <Button
                      variant="ghost"
                      class="ws-unreads-name"
                      data-unreads-row=""
                      onKeyDown={onKeyDown}
                      onClick={() => props.onOpenConversation(group().id)}
                    >
                      <Switch>
                        <Match when={group().kind !== "channel" && group().members?.length}>
                          <AvatarStack members={group().members ?? []} max={3} size="xs" />
                        </Match>
                        <Match when={group().visibility === "private"}>
                          <Lock aria-hidden="true" />
                        </Match>
                        <Match when={true}>
                          <Hash aria-hidden="true" />
                        </Match>
                      </Switch>
                      <span class="ws-truncate">{group().name}</span>
                      <Show when={!group().read}>
                        <span class="ws-unreads-count">{t("workspace.unreads.count", { count: group().count })}</span>
                      </Show>
                    </Button>
                    <Show
                      when={group().read}
                      fallback={
                        <Button variant="secondary" size="xs" onClick={() => props.onMarkRead(group().id)}>
                          {t("workspace.unreads.markRead")}
                        </Button>
                      }
                    >
                      <span class="ws-unreads-done">
                        {t("workspace.unreads.marked")}
                        <Show when={props.onUndo}>
                          {(undo) => (
                            <Button variant="link" size="xs" onClick={() => undo()(group().id)}>
                              {t("common.undo")}
                            </Button>
                          )}
                        </Show>
                      </span>
                    </Show>
                  </header>
                  <Show when={!group().collapsed}>
                    <ul class="ws-unreads-messages">
                      <For each={group().messages} keyed={(message) => message.id}>
                        {(message) => (
                          <li>
                            <Button
                              variant="ghost"
                              class="ws-unreads-message"
                              data-unreads-row=""
                              onKeyDown={onKeyDown}
                              onClick={() => props.onOpenMessage(group().id, message().id)}
                            >
                              <MemberAvatar member={message().author} size="md" />
                              <span class="ws-unreads-message-copy">
                                <span class="ws-unreads-message-heading">
                                  <MemberName member={message().author} />
                                  <span class="ws-unreads-time">{recent(message().at)}</span>
                                </span>
                                <span class="ws-unreads-message-text">
                                  <MessageText segments={message().text} />
                                </span>
                              </span>
                            </Button>
                          </li>
                        )}
                      </For>
                    </ul>
                  </Show>
                </li>
              )}
            </For>
          </ul>
          <Show when={open().length > 0}>
            <div class="ws-unreads-footer">
              <Button variant="secondary" size="sm" onClick={() => props.onMarkAllRead()}>
                {t("workspace.unreads.markAllMessagesRead")}
              </Button>
            </div>
          </Show>
        </Show>
      </div>
    </section>
  );
}
