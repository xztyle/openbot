import type { JSX } from "@solidjs/web";
import { For, Match, Show, Switch } from "solid-js";
import { Button, IconButton } from "../../button";
import { Hash, Lock, MessageSquare, MessageSquareText, Pencil, Send, Trash2 } from "../../icons";
import { SlidingTabs } from "../../sliding-tabs";
import { useText } from "../../text";
import { cx } from "../../utils";
import { EmptyState, ErrorState, LoadingState } from "../../view-state";
import { WorkspaceList, WorkspaceListRow } from "./WorkspaceList";
import { WorkspacePaneHeader } from "./WorkspacePaneHeader";
import { useRecentTime } from "./workspace-format";

/** Where a draft or a sent message is: a channel, a DM or group DM, or a thread in one of them. */
export interface DraftPlace {
  /** `#general`, `Ana`, or a name the reader cannot open now. */
  name: string;
  kind: "channel" | "private-channel" | "direct";
  inThread: boolean;
}

export interface DraftListItem {
  /** The draft key: the conversation id, or the conversation and thread ids. */
  id: string;
  place: DraftPlace;
  text: string;
  /** When the reader last changed it, in milliseconds. Absent for a draft from before times were kept. */
  at?: number | undefined;
  /** Files that wait with the draft. */
  fileCount?: number | undefined;
}

export interface SentListItem {
  id: string;
  place: DraftPlace;
  text: string;
  at: number;
}

export type DraftsTab = "drafts" | "sent";

export interface DraftsViewProps {
  tab: DraftsTab;
  onTabChange: (tab: DraftsTab) => void;
  drafts: readonly DraftListItem[];
  onOpenDraft: (id: string) => void;
  onDeleteDraft: (id: string) => void;
  /** The reader's sent messages, newest first. */
  sent: readonly SentListItem[];
  /** The first page of sent messages loads. */
  sentLoading?: boolean | undefined;
  /** The sent messages could not load, and none show yet. */
  sentFailed?: boolean | undefined;
  /** The server cannot list sent messages: an older host. */
  sentUnsupported?: boolean | undefined;
  onRetrySent?: (() => void) | undefined;
  onOpenSent: (id: string) => void;
  /** Loads the next page of sent messages, when there is one. */
  onMoreSent?: (() => void) | undefined;
  sentLoadingMore?: boolean | undefined;
  onBack?: (() => void) | undefined;
  class?: string;
}

function PlaceIcon(props: { place: DraftPlace }): JSX.Element {
  return (
    <Switch fallback={<MessageSquare aria-hidden="true" />}>
      <Match when={props.place.inThread}>
        <MessageSquareText aria-hidden="true" />
      </Match>
      <Match when={props.place.kind === "channel"}>
        <Hash aria-hidden="true" />
      </Match>
      <Match when={props.place.kind === "private-channel"}>
        <Lock aria-hidden="true" />
      </Match>
    </Switch>
  );
}

/**
 * Slack's Drafts & sent: the messages that the reader started and did not send, one for each
 * conversation and thread, and the messages that they sent, newest first. A draft opens where it
 * was written, with its text in the box; a sent message opens at its place in the conversation.
 */
export function DraftsView(props: DraftsViewProps): JSX.Element {
  const { t } = useText();
  const recent = useRecentTime();
  const placeName = (place: DraftPlace) =>
    place.inThread ? t("workspace.drafts.inThread", { name: place.name }) : place.name;
  return (
    <section class={cx("ws-view ws-drafts", props.class)} aria-label={t("workspace.view.drafts")}>
      <WorkspacePaneHeader
        icon={<Pencil aria-hidden="true" />}
        title={t("workspace.view.drafts")}
        subtitle={t("workspace.drafts.subtitle")}
        onBack={props.onBack}
      />
      <div class="ws-view-toolbar">
        <SlidingTabs.Root
          value={props.tab}
          onChange={(value) => {
            if (value === "drafts" || value === "sent") props.onTabChange(value);
          }}
        >
          <SlidingTabs.List aria-label={t("workspace.drafts.tabs")}>
            <SlidingTabs.Trigger value="drafts">
              {t("workspace.drafts.tab.drafts")}
              <Show when={props.drafts.length}>{(count) => <span class="ws-drafts-tab-count">{count()}</span>}</Show>
            </SlidingTabs.Trigger>
            <SlidingTabs.Trigger value="sent">{t("workspace.drafts.tab.sent")}</SlidingTabs.Trigger>
          </SlidingTabs.List>
        </SlidingTabs.Root>
      </div>
      <div class="ws-view-scroll">
        <Show
          when={props.tab === "drafts"}
          fallback={
            <Show
              when={props.sent.length > 0}
              fallback={
                <Switch>
                  <Match when={props.sentUnsupported}>
                    <EmptyState
                      icon={<Send />}
                      title={t("workspace.drafts.sentEmpty")}
                      description={t("workspace.drafts.sentUnsupported")}
                    />
                  </Match>
                  <Match when={props.sentFailed}>
                    <ErrorState title={t("workspace.drafts.sentFailed")} onRetry={props.onRetrySent} />
                  </Match>
                  <Match when={props.sentLoading}>
                    <LoadingState label={t("workspace.drafts.tab.sent")} />
                  </Match>
                  <Match when={true}>
                    <EmptyState
                      icon={<Send />}
                      title={t("workspace.drafts.sentEmpty")}
                      description={t("workspace.drafts.sentEmptyHint")}
                    />
                  </Match>
                </Switch>
              }
            >
              <WorkspaceList label={t("workspace.drafts.tab.sent")}>
                <For each={props.sent} keyed={(item) => item.id}>
                  {(item) => (
                    <WorkspaceListRow
                      class="ws-draft-row"
                      onOpen={() => props.onOpenSent(item().id)}
                      leading={
                        <span class="ws-draft-place-icon">
                          <PlaceIcon place={item().place} />
                        </span>
                      }
                      title={placeName(item().place)}
                      titleEnd={recent(item().at)}
                    >
                      <span class="ws-feed-preview">{item().text}</span>
                    </WorkspaceListRow>
                  )}
                </For>
              </WorkspaceList>
              <Show when={props.onMoreSent}>
                {(more) => (
                  <div class="ws-drafts-more">
                    <Button variant="secondary" size="sm" loading={props.sentLoadingMore} onClick={() => more()()}>
                      {t("workspace.drafts.older")}
                    </Button>
                  </div>
                )}
              </Show>
            </Show>
          }
        >
          <Show
            when={props.drafts.length > 0}
            fallback={
              <EmptyState
                icon={<Pencil />}
                title={t("workspace.drafts.empty")}
                description={t("workspace.drafts.emptyHint")}
              />
            }
          >
            <WorkspaceList label={t("workspace.drafts.tab.drafts")}>
              <For each={props.drafts} keyed={(item) => item.id}>
                {(item) => (
                  <WorkspaceListRow
                    class="ws-draft-row"
                    leading={
                      <span class="ws-draft-place-icon">
                        <PlaceIcon place={item().place} />
                      </span>
                    }
                    title={placeName(item().place)}
                    titleEnd={<Show when={item().at}>{(at) => recent(at())}</Show>}
                    actions={
                      <>
                        <IconButton
                          variant="ghost"
                          size="icon-sm"
                          label={t("workspace.drafts.edit", { name: placeName(item().place) })}
                          onClick={() => props.onOpenDraft(item().id)}
                        >
                          <Pencil />
                        </IconButton>
                        <IconButton
                          variant="ghost"
                          size="icon-sm"
                          label={t("workspace.drafts.delete")}
                          onClick={() => props.onDeleteDraft(item().id)}
                        >
                          <Trash2 />
                        </IconButton>
                      </>
                    }
                  >
                    <Button
                      variant="link"
                      class="ws-draft-text"
                      aria-label={t("workspace.drafts.edit", { name: placeName(item().place) })}
                      onClick={() => props.onOpenDraft(item().id)}
                    >
                      {item().text}
                    </Button>
                    <Show when={item().fileCount}>
                      {(count) => (
                        <span class="ws-feed-where">{t("workspace.drafts.withFiles", { count: count() })}</span>
                      )}
                    </Show>
                  </WorkspaceListRow>
                )}
              </For>
            </WorkspaceList>
          </Show>
        </Show>
      </div>
    </section>
  );
}
