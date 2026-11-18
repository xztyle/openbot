import type { JSX } from "@solidjs/web";
import { createSignal, For, Match, Show, Switch } from "solid-js";
import { Button } from "../../button";
import { Input } from "../../form";
import { MessagesSquare, Search } from "../../icons";
import { Switch as Toggle } from "../../switch";
import { useText } from "../../text";
import { cx } from "../../utils";
import { EmptyState, LoadingState } from "../../view-state";
import { AiBadge, AvatarStack, MemberAvatar } from "./WorkspaceAvatar";
import { PaneHeaderAction, WorkspacePaneHeader } from "./WorkspacePaneHeader";
import { useRecentTime } from "./workspace-format";
import type { WorkspaceMember } from "./workspace-types";

export interface DirectMessageItem {
  /** The conversation id, or the sidebar id of an agent's chat. */
  id: string;
  kind: "dm" | "group";
  /** The others in the conversation. */
  members: readonly WorkspaceMember[];
  name: string;
  /** The start of the last message. */
  preview?: string | undefined;
  /** The reader wrote the last message: the preview starts with "You:". */
  fromReader?: boolean | undefined;
  /** The author of the last message in a group, when it is not the reader. */
  author?: string | undefined;
  at?: number | undefined;
  unread: boolean;
  /** Unread messages; a DM counts every one, as in Slack. */
  count: number;
  muted?: boolean | undefined;
}

export interface DirectMessagesViewProps {
  items: readonly DirectMessageItem[];
  activeId?: string | undefined;
  loading?: boolean | undefined;
  onOpen: (id: string) => void;
  onNewMessage?: (() => void) | undefined;
  onBack?: (() => void) | undefined;
  class?: string;
}

/**
 * Slack's DMs: every DM and group DM, newest first, with the last message and its time. Unread ones
 * are bold with their count. A field finds a conversation by name; a switch keeps the unread ones.
 */
export function DirectMessagesView(props: DirectMessagesViewProps): JSX.Element {
  const { t } = useText();
  const recent = useRecentTime();
  const [query, setQuery] = createSignal("");
  const [unreadOnly, setUnreadOnly] = createSignal(false);
  const shown = () => {
    const text = query().trim().toLocaleLowerCase();
    return props.items.filter(
      (item) => (!unreadOnly() || item.unread) && (!text || item.name.toLocaleLowerCase().includes(text)),
    );
  };
  const preview = (item: DirectMessageItem) => {
    if (!item.preview) return "";
    if (item.fromReader) return t("workspace.dms.fromYou", { text: item.preview });
    if (item.kind === "group" && item.author)
      return t("workspace.dms.fromName", { name: item.author, text: item.preview });
    return item.preview;
  };
  return (
    <section class={cx("ws-view ws-dms", props.class)} aria-label={t("workspace.view.dms")}>
      <WorkspacePaneHeader
        icon={<MessagesSquare aria-hidden="true" />}
        title={t("workspace.view.dms")}
        onBack={props.onBack}
        actions={
          <Show when={props.onNewMessage}>
            {(start) => <PaneHeaderAction label={t("workspace.sidebar.newMessage")} onClick={() => start()()} />}
          </Show>
        }
      />
      <div class="ws-view-toolbar">
        <div class="ws-view-search ws-dms-search">
          <Search aria-hidden="true" />
          <Input
            type="search"
            size="sm"
            value={query()}
            onValueChange={setQuery}
            placeholder={t("workspace.dms.search")}
            aria-label={t("workspace.dms.search")}
          />
        </div>
        <span class="ws-inline-switch">
          <span aria-hidden="true">{t("workspace.activity.unreadOnly")}</span>
          <Toggle
            size="sm"
            aria-label={t("workspace.activity.unreadOnly")}
            checked={unreadOnly()}
            onChange={(checked: boolean) => setUnreadOnly(checked)}
          />
        </span>
      </div>
      <div class="ws-view-scroll">
        <Show
          when={shown().length > 0}
          fallback={
            <Switch>
              <Match when={props.items.length > 0}>
                <EmptyState
                  size="compact"
                  icon={<Search />}
                  title={t("workspace.view.noMatch")}
                  description={t("workspace.view.noMatchHint")}
                  action={
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() => {
                        setQuery("");
                        setUnreadOnly(false);
                      }}
                    >
                      {t("workspace.view.clearFilters")}
                    </Button>
                  }
                />
              </Match>
              <Match when={props.loading}>
                <LoadingState label={t("workspace.view.dms")} />
              </Match>
              <Match when={true}>
                <EmptyState
                  icon={<MessagesSquare />}
                  title={t("workspace.dms.emptyTitle")}
                  description={t("workspace.dms.empty")}
                  action={
                    <Show when={props.onNewMessage}>
                      {(start) => (
                        <Button size="sm" onClick={() => start()()}>
                          {t("workspace.sidebar.newMessage")}
                        </Button>
                      )}
                    </Show>
                  }
                />
              </Match>
            </Switch>
          }
        >
          <ul class="ws-feed ws-dms-list">
            <For each={shown()} keyed={(item) => item.id}>
              {(item) => (
                <li>
                  <Button
                    variant="ghost"
                    class="ws-feed-row ws-dm-row"
                    data-unread={item().unread && !item().muted ? "" : undefined}
                    data-muted={item().muted ? "" : undefined}
                    aria-current={props.activeId === item().id ? "page" : undefined}
                    onClick={() => props.onOpen(item().id)}
                  >
                    <span class="ws-feed-avatar">
                      <Show
                        when={item().members.length > 1}
                        fallback={
                          <Show when={item().members[0]}>
                            {(member) => <MemberAvatar member={member()} size="lg" />}
                          </Show>
                        }
                      >
                        <AvatarStack members={item().members} max={2} size="sm" />
                      </Show>
                    </span>
                    <span class="ws-feed-copy">
                      <span class="ws-feed-heading">
                        <span class="ws-feed-what ws-dm-name">
                          <span class="ws-truncate">{item().name}</span>
                          <Show when={item().members.length === 1 && item().members[0]?.kind === "agent"}>
                            <AiBadge />
                          </Show>
                        </span>
                        <Show when={item().at}>{(at) => <span class="ws-feed-time">{recent(at())}</span>}</Show>
                      </span>
                      <Show when={item().preview || (item().count > 0 && !item().muted)}>
                        <span class="ws-dm-preview">
                          <span class="ws-feed-preview">{preview(item())}</span>
                          <Show when={item().count > 0 && !item().muted}>
                            <span class="ws-mention-badge">{item().count}</span>
                          </Show>
                        </span>
                      </Show>
                    </span>
                  </Button>
                </li>
              )}
            </For>
          </ul>
        </Show>
      </div>
    </section>
  );
}
