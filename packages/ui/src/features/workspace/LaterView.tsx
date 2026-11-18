import type { JSX } from "@solidjs/web";
import { For, Match, Show, Switch } from "solid-js";
import { Button, IconButton } from "../../button";
import { Bookmark, BookmarkCheck, Check, RotateCcw, X } from "../../icons";
import { SlidingTabs } from "../../sliding-tabs";
import { useText } from "../../text";
import { cx } from "../../utils";
import { EmptyState, ErrorState, LoadingState } from "../../view-state";
import { MemberAvatar, MemberName } from "./WorkspaceAvatar";
import { WorkspacePaneHeader } from "./WorkspacePaneHeader";
import { useRecentTime } from "./workspace-format";
import type { WorkspaceMember } from "./workspace-types";

export type LaterTab = "saved" | "done";

export interface LaterItem {
  /** `<channelId>/<messageId>`. */
  id: string;
  author: WorkspaceMember;
  /** Where the message is: `#general`, or the names of a DM. */
  where: string;
  /** The message is a reply in a thread. */
  inThread: boolean;
  at: number;
  /** The start of the message. Empty for a deleted message. */
  preview: string;
  deleted: boolean;
}

export interface LaterViewProps {
  tab: LaterTab;
  onTabChange: (tab: LaterTab) => void;
  items: readonly LaterItem[];
  /** The items that are not completed, for the tab label. */
  savedCount: number;
  loading?: boolean | undefined;
  failed?: boolean | undefined;
  onRetry?: (() => void) | undefined;
  hasMore?: boolean | undefined;
  loadingMore?: boolean | undefined;
  onLoadMore?: (() => void) | undefined;
  onOpen: (id: string) => void;
  /** Moves an item to Completed, or back to In progress. */
  onSetDone: (id: string, done: boolean) => void;
  onRemove: (id: string) => void;
  onBack?: (() => void) | undefined;
  class?: string;
}

/**
 * Slack's Later: the messages the reader saved. In progress holds the open ones, Completed the ones
 * they checked off. A row opens its message; its buttons complete, reopen or remove it.
 */
export function LaterView(props: LaterViewProps): JSX.Element {
  const { t } = useText();
  const recent = useRecentTime();
  return (
    <section class={cx("ws-view ws-later", props.class)} aria-label={t("workspace.view.later")}>
      <WorkspacePaneHeader
        icon={<Bookmark aria-hidden="true" />}
        title={t("workspace.view.later")}
        onBack={props.onBack}
      />
      <div class="ws-view-toolbar">
        <SlidingTabs.Root
          value={props.tab}
          onChange={(value) => {
            if (value === "saved" || value === "done") props.onTabChange(value);
          }}
        >
          <SlidingTabs.List aria-label={t("workspace.later.tabs")}>
            <SlidingTabs.Trigger value="saved">
              {props.savedCount > 0
                ? t("workspace.later.inProgressCount", { count: props.savedCount })
                : t("workspace.later.inProgress")}
            </SlidingTabs.Trigger>
            <SlidingTabs.Trigger value="done">{t("workspace.later.completed")}</SlidingTabs.Trigger>
          </SlidingTabs.List>
        </SlidingTabs.Root>
      </div>
      <div class="ws-view-scroll">
        <Show
          when={props.items.length > 0}
          fallback={
            <Switch>
              <Match when={props.failed}>
                <ErrorState title={t("workspace.later.loadFailed")} onRetry={props.onRetry} />
              </Match>
              <Match when={props.loading}>
                <LoadingState label={t("workspace.view.later")} />
              </Match>
              <Match when={props.tab === "done"}>
                <EmptyState
                  icon={<BookmarkCheck />}
                  title={t("workspace.later.emptyDoneTitle")}
                  description={t("workspace.later.emptyDone")}
                />
              </Match>
              <Match when={true}>
                <EmptyState
                  icon={<Bookmark />}
                  title={t("workspace.later.emptyTitle")}
                  description={t("workspace.later.empty")}
                />
              </Match>
            </Switch>
          }
        >
          <ul class="ws-feed">
            <For each={props.items} keyed={(item) => item.id}>
              {(item) => (
                <li class="ws-later-item" data-done={props.tab === "done" ? "" : undefined}>
                  <Button variant="ghost" class="ws-feed-row ws-later-row" onClick={() => props.onOpen(item().id)}>
                    <span class="ws-feed-avatar">
                      <MemberAvatar member={item().author} size="lg" />
                    </span>
                    <span class="ws-feed-copy">
                      <span class="ws-feed-heading">
                        <MemberName member={item().author} class="ws-feed-what" />
                        <span class="ws-feed-time">{recent(item().at)}</span>
                      </span>
                      <span class="ws-feed-where">
                        {item().inThread ? t("workspace.later.inThread", { where: item().where }) : item().where}
                      </span>
                      <span class="ws-feed-preview">
                        <Show when={!item().deleted} fallback={<em>{t("workspace.later.deleted")}</em>}>
                          {item().preview}
                        </Show>
                      </span>
                    </span>
                  </Button>
                  <span class="ws-row-actions">
                    <Show
                      when={props.tab === "saved"}
                      fallback={
                        <IconButton
                          variant="ghost"
                          label={t("workspace.later.reopen")}
                          onClick={() => props.onSetDone(item().id, false)}
                        >
                          <RotateCcw />
                        </IconButton>
                      }
                    >
                      <IconButton
                        variant="ghost"
                        label={t("workspace.later.complete")}
                        onClick={() => props.onSetDone(item().id, true)}
                      >
                        <Check />
                      </IconButton>
                    </Show>
                    <IconButton
                      variant="ghost"
                      label={t("workspace.later.remove")}
                      onClick={() => props.onRemove(item().id)}
                    >
                      <X />
                    </IconButton>
                  </span>
                </li>
              )}
            </For>
          </ul>
          <Show when={props.hasMore}>
            <div class="ws-view-more">
              <Button variant="secondary" size="sm" loading={props.loadingMore} onClick={() => props.onLoadMore?.()}>
                {t("workspace.view.showMore")}
              </Button>
            </div>
          </Show>
        </Show>
      </div>
    </section>
  );
}
