import type { JSX } from "@solidjs/web";
import { For, Match, Show, Switch } from "solid-js";
import { Button } from "../../button";
import { CheckCheck, Hash, Lock, MessageSquareText } from "../../icons";
import { useText } from "../../text";
import { cx } from "../../utils";
import { EmptyState, ErrorState, LoadingState } from "../../view-state";
import { messagePlainText } from "./MessageRow";
import { AvatarStack, MemberAvatar, MemberName } from "./WorkspaceAvatar";
import { WorkspaceList, WorkspaceListRow } from "./WorkspaceList";
import { WorkspacePaneHeader } from "./WorkspacePaneHeader";
import { useRecentTime } from "./workspace-format";
import type { ChannelVisibility, MessageSegment, WorkspaceMember } from "./workspace-types";

export interface ThreadListItem {
  /** The id of the root message. */
  id: string;
  channelName: string;
  visibility: ChannelVisibility;
  author: WorkspaceMember;
  text: readonly MessageSegment[];
  replyCount: number;
  lastReplyAt: number;
  participants: readonly WorkspaceMember[];
  /** Replies that the reader has not read. */
  unreadCount?: number | undefined;
}

export interface ThreadsViewProps {
  threads: readonly ThreadListItem[];
  /** The first read runs: placeholder rows show. */
  loading?: boolean | undefined;
  /** The list could not load and nothing is shown yet. */
  failed?: boolean | undefined;
  onRetry?: (() => void) | undefined;
  onOpen: (threadId: string) => void;
  /** Reads every unread thread. The button shows while one is unread. */
  onMarkAllRead?: (() => void) | undefined;
  onBack?: (() => void) | undefined;
  class?: string;
}

/** The threads that the reader follows: unread ones first, then the newest reply first. */
export function ThreadsView(props: ThreadsViewProps): JSX.Element {
  const { t } = useText();
  const recent = useRecentTime();
  return (
    <section class={cx("ws-view ws-threads", props.class)} aria-label={t("workspace.view.threads")}>
      <WorkspacePaneHeader
        icon={<MessageSquareText aria-hidden="true" />}
        title={t("workspace.view.threads")}
        onBack={props.onBack}
        actions={
          <Show when={props.onMarkAllRead && props.threads.some((thread) => (thread.unreadCount ?? 0) > 0)}>
            <Button variant="ghost" size="xs" onClick={() => props.onMarkAllRead?.()}>
              <CheckCheck aria-hidden="true" />
              {t("workspace.activity.markAllRead")}
            </Button>
          </Show>
        }
      />
      <div class="ws-view-scroll">
        <Show
          when={props.threads.length > 0}
          fallback={
            <Switch>
              <Match when={props.failed}>
                <ErrorState title={t("workspace.activity.loadFailed")} onRetry={props.onRetry} />
              </Match>
              <Match when={props.loading}>
                <LoadingState label={t("workspace.view.threads")} />
              </Match>
              <Match when={true}>
                <EmptyState
                  icon={<MessageSquareText />}
                  title={t("workspace.threads.emptyTitle")}
                  description={t("workspace.threads.empty")}
                />
              </Match>
            </Switch>
          }
        >
          <WorkspaceList>
            <For each={props.threads} keyed={(thread) => thread.id}>
              {(thread) => (
                <WorkspaceListRow
                  class="ws-thread-row"
                  unread={(thread().unreadCount ?? 0) > 0}
                  onOpen={() => props.onOpen(thread().id)}
                  title={
                    <>
                      <Show when={thread().visibility === "private"} fallback={<Hash aria-hidden="true" />}>
                        <Lock aria-hidden="true" />
                      </Show>
                      {thread().channelName}
                    </>
                  }
                  titleEnd={
                    <Show when={(thread().unreadCount ?? 0) > 0}>
                      <span class="ws-mention-badge">
                        {t("workspace.threads.new", { count: thread().unreadCount ?? 0 })}
                      </span>
                    </Show>
                  }
                >
                  <span class="ws-thread-row-root">
                    <MemberAvatar member={thread().author} size="md" />
                    <span class="ws-thread-row-text">
                      <MemberName member={thread().author} />
                      <span class="ws-feed-preview">{messagePlainText(thread().text)}</span>
                    </span>
                  </span>
                  <span class="ws-thread-row-summary">
                    <AvatarStack members={thread().participants} max={4} size="xs" />
                    <span class="ws-thread-summary-count">
                      {t("workspace.thread.replies", { count: thread().replyCount })}
                    </span>
                    <span class="ws-row-title-end">
                      {t("workspace.thread.lastReply", { time: recent(thread().lastReplyAt) })}
                    </span>
                  </span>
                </WorkspaceListRow>
              )}
            </For>
          </WorkspaceList>
        </Show>
      </div>
    </section>
  );
}
