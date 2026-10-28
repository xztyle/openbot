import { Dynamic, type JSX } from "@solidjs/web";
import { createSignal, For, Show } from "solid-js";
import { Button } from "../../button";
import { AtSign, MessageSquare, MessageSquareReply, SmilePlus } from "../../icons";
import { SlidingTabs } from "../../sliding-tabs";
import { Switch } from "../../switch";
import { useText } from "../../text";
import { cx } from "../../utils";
import { MemberAvatar, MemberName } from "./WorkspaceAvatar";
import { WorkspacePaneHeader } from "./WorkspacePaneHeader";
import { useRecentTime } from "./workspace-format";
import type { WorkspaceMember } from "./workspace-types";

export type ActivityKind = "mention" | "reply" | "dm" | "reaction";

export interface ActivityItem {
  id: string;
  kind: ActivityKind;
  actor: WorkspaceMember;
  /** The channel without `#`. A DM has none. */
  channelName?: string | undefined;
  /** The start of the message. */
  preview: string;
  /** The emoji of a reaction. */
  emoji?: string | undefined;
  at: number;
  unread: boolean;
}

const KIND_TEXT = {
  mention: "workspace.activity.mention",
  reply: "workspace.activity.reply",
  dm: "workspace.activity.dm",
  reaction: "workspace.activity.reaction",
} as const satisfies Record<ActivityKind, string>;

const KIND_ICON = {
  mention: AtSign,
  reply: MessageSquareReply,
  dm: MessageSquare,
  reaction: SmilePlus,
} as const;

type ActivityFilter = "all" | "mention" | "reply" | "dm";

export interface ActivityViewProps {
  items: readonly ActivityItem[];
  onOpen: (itemId: string) => void;
  onMarkAllRead?: (() => void) | undefined;
  onBack?: (() => void) | undefined;
  class?: string;
}

/** Mentions, thread replies, DMs and reactions for the reader, newest first. */
export function ActivityView(props: ActivityViewProps): JSX.Element {
  const { t } = useText();
  const recent = useRecentTime();
  const [filter, setFilter] = createSignal<ActivityFilter>("all");
  const [unreadOnly, setUnreadOnly] = createSignal(false);
  const shown = () =>
    props.items.filter((item) => (filter() === "all" || item.kind === filter()) && (!unreadOnly() || item.unread));
  const where = (item: ActivityItem) =>
    item.channelName
      ? t("workspace.activity.in", { channel: item.channelName })
      : t("workspace.activity.directMessage");
  return (
    <section class={cx("ws-view ws-activity", props.class)} aria-label={t("workspace.view.activity")}>
      <WorkspacePaneHeader
        icon={<AtSign aria-hidden="true" />}
        title={t("workspace.view.activity")}
        onBack={props.onBack}
        actions={
          <Show when={props.onMarkAllRead && props.items.some((item) => item.unread)}>
            <Button variant="ghost" size="xs" onClick={() => props.onMarkAllRead?.()}>
              {t("workspace.activity.markAllRead")}
            </Button>
          </Show>
        }
      />
      <div class="ws-view-toolbar">
        <SlidingTabs.Root
          value={filter()}
          onChange={(value) => {
            if (value === "all" || value === "mention" || value === "reply" || value === "dm") setFilter(value);
          }}
        >
          <SlidingTabs.List aria-label={t("workspace.activity.filter")}>
            <SlidingTabs.Trigger value="all">{t("workspace.activity.all")}</SlidingTabs.Trigger>
            <SlidingTabs.Trigger value="mention">{t("workspace.activity.mentions")}</SlidingTabs.Trigger>
            <SlidingTabs.Trigger value="reply">{t("workspace.activity.threads")}</SlidingTabs.Trigger>
            <SlidingTabs.Trigger value="dm">{t("workspace.activity.dms")}</SlidingTabs.Trigger>
          </SlidingTabs.List>
        </SlidingTabs.Root>
        <span class="ws-inline-switch">
          <span aria-hidden="true">{t("workspace.activity.unreadOnly")}</span>
          <Switch
            size="sm"
            aria-label={t("workspace.activity.unreadOnly")}
            checked={unreadOnly()}
            onChange={(checked: boolean) => setUnreadOnly(checked)}
          />
        </span>
      </div>
      <div class="ws-view-scroll">
        <Show when={shown().length > 0} fallback={<p class="ws-view-empty">{t("workspace.activity.empty")}</p>}>
          <ul class="ws-feed">
            <For each={shown()} keyed={(item) => item.id}>
              {(item) => (
                <li>
                  <Button
                    variant="ghost"
                    class="ws-feed-row"
                    data-unread={item().unread ? "" : undefined}
                    onClick={() => props.onOpen(item().id)}
                  >
                    <span class="ws-feed-avatar">
                      <MemberAvatar member={item().actor} size="lg" />
                      <span class="ws-feed-kind" data-kind={item().kind} aria-hidden="true">
                        <Dynamic component={KIND_ICON[item().kind]} />
                      </span>
                    </span>
                    <span class="ws-feed-copy">
                      <span class="ws-feed-heading">
                        <span class="ws-feed-what">
                          {t(KIND_TEXT[item().kind], { name: item().actor.name, emoji: item().emoji ?? "" })}
                        </span>
                        <span class="ws-feed-time">{recent(item().at)}</span>
                      </span>
                      <span class="ws-feed-where">{where(item())}</span>
                      <span class="ws-feed-preview">
                        <MemberName member={item().actor} class="ws-feed-preview-author" />
                        {item().preview}
                      </span>
                    </span>
                    <Show when={item().unread}>
                      <span class="ws-unread-dot" aria-hidden="true" />
                      <span class="sr-only">{t("workspace.sidebar.unread")}</span>
                    </Show>
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
