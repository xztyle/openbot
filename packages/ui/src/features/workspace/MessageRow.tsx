import type { JSX } from "@solidjs/web";
import { createSignal, For, Show } from "solid-js";
import { Button, buttonVariants, IconButton } from "../../button";
import { Popover } from "../../complex";
import { ChevronRight, Ellipsis, MessageSquareReply, SmilePlus } from "../../icons";
import { useText } from "../../text";
import { LabelTooltip, LabelTooltipTrigger } from "../../tooltip";
import { cx } from "../../utils";
import { MemberProfilePopover } from "./MemberProfileCard";
import { AvatarStack, MemberAvatar, MemberName } from "./WorkspaceAvatar";
import { WorkspaceMenu } from "./WorkspaceMenu";
import { useMessageTime, useRecentTime } from "./workspace-format";
import type {
  MessageSegment,
  ThreadSummary,
  WorkspaceMember,
  WorkspaceMenuItem,
  WorkspaceReaction,
} from "./workspace-types";

/** The emoji that the react button offers first, as Slack's frequent row. */
export const QUICK_REACTIONS = ["👍", "❤️", "😂", "🎉", "👀", "✅"] as const;

export interface MessageRowProps {
  author: WorkspaceMember;
  /** The send time, in milliseconds since the epoch. */
  sentAt: number;
  /** The text, with mentions and channel links as their own runs. */
  text?: readonly MessageSegment[] | undefined;
  /** More content under the text: a step trail, artifact cards, attachments. */
  children?: JSX.Element;
  /** A follow-up from the same author within minutes: no avatar and no name. */
  grouped?: boolean | undefined;
  edited?: boolean | undefined;
  deleted?: boolean | undefined;
  /** Lights the row, such as a linked message or the root of the open thread. */
  highlighted?: boolean | undefined;
  /** The reader is mentioned: the row gets the mention tint. */
  mentionsReader?: boolean | undefined;
  reactions?: readonly WorkspaceReaction[] | undefined;
  onToggleReaction?: ((emoji: string) => void) | undefined;
  /** Opens the full emoji picker. The quick row of the react button does not need it. */
  onOpenEmojiPicker?: (() => void) | undefined;
  quickReactions?: readonly string[] | undefined;
  thread?: ThreadSummary | undefined;
  onOpenThread?: (() => void) | undefined;
  /** The items of the "more" menu: edit, copy link, mark unread, delete. */
  menuItems?: readonly WorkspaceMenuItem[] | undefined;
  /** The author's profile card, which the avatar and the name open. */
  profile?: JSX.Element;
  class?: string;
}

/**
 * One Slack-style message: avatar, name, time and text, no bubble. Hover or focus shows the action
 * bar; reactions and the thread summary sit under the text.
 */
export function MessageRow(props: MessageRowProps): JSX.Element {
  const { t, format } = useText();
  const time = useMessageTime();
  const [menuOpen, setMenuOpen] = createSignal(false);
  const fullTime = () => format.date(props.sentAt, { dateStyle: "full", timeStyle: "short" });
  return (
    <article
      class={cx("ws-message", props.class)}
      data-grouped={props.grouped ? "" : undefined}
      data-highlighted={props.highlighted ? "" : undefined}
      data-mention={props.mentionsReader ? "" : undefined}
      data-menu-open={menuOpen() ? "" : undefined}
      aria-label={t("workspace.message.label", { name: props.author.name, time: time(props.sentAt) })}
    >
      <div class="ws-message-gutter">
        <Show
          when={!props.grouped}
          fallback={
            <time class="ws-message-gutter-time" datetime={new Date(props.sentAt).toISOString()} title={fullTime()}>
              {time(props.sentAt)}
            </time>
          }
        >
          <MemberProfilePopover card={props.profile} label={t("workspace.profile.open", { name: props.author.name })}>
            <MemberAvatar member={props.author} size="lg" />
          </MemberProfilePopover>
        </Show>
      </div>
      <div class="ws-message-body">
        <Show when={!props.grouped}>
          <div class="ws-message-meta">
            <MemberProfilePopover
              card={props.profile}
              label={t("workspace.profile.open", { name: props.author.name })}
              class="ws-message-author"
            >
              <MemberName member={props.author} />
            </MemberProfilePopover>
            <time class="ws-message-time" datetime={new Date(props.sentAt).toISOString()} title={fullTime()}>
              {time(props.sentAt)}
            </time>
          </div>
        </Show>
        <Show
          when={!props.deleted}
          fallback={<p class="ws-message-text ws-message-deleted">{t("workspace.message.deleted")}</p>}
        >
          <Show when={props.text?.length}>
            <p class="ws-message-text">
              <MessageText segments={props.text ?? []} />
              <Show when={props.edited}>
                <span class="ws-message-edited">{t("workspace.message.edited")}</span>
              </Show>
            </p>
          </Show>
          {props.children}
          <Show when={props.reactions?.length}>
            <ReactionBar
              reactions={props.reactions ?? []}
              onToggle={props.onToggleReaction}
              quickReactions={props.quickReactions}
              onOpenEmojiPicker={props.onOpenEmojiPicker}
            />
          </Show>
          <Show when={props.thread}>
            {(thread) => <ThreadSummaryRow thread={thread()} onOpen={props.onOpenThread} />}
          </Show>
        </Show>
      </div>
      <Show when={!props.deleted}>
        <div class="ws-message-actions" role="toolbar" aria-label={t("workspace.message.actions")}>
          <Show when={props.onToggleReaction}>
            {(toggle) => (
              <ReactionPicker
                quickReactions={props.quickReactions}
                onPick={toggle()}
                onOpenEmojiPicker={props.onOpenEmojiPicker}
              />
            )}
          </Show>
          <Show when={props.onOpenThread}>
            {(open) => (
              <IconButton variant="ghost" size="icon-xs" label={t("workspace.message.reply")} onClick={() => open()()}>
                <MessageSquareReply />
              </IconButton>
            )}
          </Show>
          <Show when={props.menuItems?.length}>
            <WorkspaceMenu
              items={props.menuItems ?? []}
              label={t("workspace.message.more")}
              triggerClass="ws-message-action-more"
              onOpenChange={setMenuOpen}
            >
              <Ellipsis aria-hidden="true" />
            </WorkspaceMenu>
          </Show>
        </div>
      </Show>
    </article>
  );
}

/** Message text with highlighted mentions, channel links, links and inline code. */
export function MessageText(props: { segments: readonly MessageSegment[] }): JSX.Element {
  return <For each={props.segments}>{(segment) => renderSegment(segment)}</For>;
}

/** The text of the runs without markup, for a preview inside a button. */
export function messagePlainText(segments: readonly MessageSegment[]): string {
  return segments
    .map((segment) => {
      switch (segment.kind) {
        case "mention":
          return `@${segment.label}`;
        case "broadcast":
          return `@${segment.label}`;
        case "channel":
          return `#${segment.name}`;
        default:
          return segment.text;
      }
    })
    .join("");
}

function renderSegment(segment: MessageSegment): JSX.Element {
  switch (segment.kind) {
    case "text":
      return segment.text;
    case "mention":
      return (
        <span class="ws-mention" data-self={segment.self ? "" : undefined}>
          @{segment.label}
        </span>
      );
    case "broadcast":
      return (
        <span class="ws-mention" data-self="">
          @{segment.label}
        </span>
      );
    case "channel":
      return <span class="ws-mention ws-channel-link">#{segment.name}</span>;
    case "link":
      return (
        <a class="ws-link" href={segment.href} target="_blank" rel="noreferrer">
          {segment.text}
        </a>
      );
    case "code":
      return <code class="ws-inline-code">{segment.text}</code>;
  }
}

export interface ReactionBarProps {
  reactions: readonly WorkspaceReaction[];
  onToggle?: ((emoji: string) => void) | undefined;
  quickReactions?: readonly string[] | undefined;
  onOpenEmojiPicker?: (() => void) | undefined;
}

/** The reaction pills under a message, and the button that adds one. */
export function ReactionBar(props: ReactionBarProps): JSX.Element {
  const { t, format } = useText();
  const tooltip = (reaction: WorkspaceReaction) =>
    reaction.actors?.length
      ? t("workspace.reaction.by", { names: format.list(reaction.actors), emoji: reaction.emoji })
      : t("workspace.reaction.count", { count: reaction.count, emoji: reaction.emoji });
  return (
    <div class="ws-reactions">
      <For each={props.reactions} keyed={(reaction) => reaction.emoji}>
        {(reaction) => (
          <LabelTooltip content={tooltip(reaction())}>
            <LabelTooltipTrigger
              as={Button}
              variant="outline"
              size="xs"
              class="ws-reaction"
              data-reacted={reaction().reacted ? "" : undefined}
              aria-pressed={reaction().reacted ? "true" : "false"}
              aria-label={tooltip(reaction())}
              disabled={!props.onToggle}
              onClick={() => props.onToggle?.(reaction().emoji)}
            >
              <span class="ws-reaction-emoji">{reaction().emoji}</span>
              <span class="ws-reaction-count">{reaction().count}</span>
            </LabelTooltipTrigger>
          </LabelTooltip>
        )}
      </For>
      <Show when={props.onToggle}>
        {(toggle) => (
          <ReactionPicker
            quickReactions={props.quickReactions}
            onPick={toggle()}
            onOpenEmojiPicker={props.onOpenEmojiPicker}
            triggerClass="ws-reaction ws-reaction-add"
          />
        )}
      </Show>
    </div>
  );
}

function ReactionPicker(props: {
  quickReactions?: readonly string[] | undefined;
  onPick: (emoji: string) => void;
  onOpenEmojiPicker?: (() => void) | undefined;
  triggerClass?: string;
}): JSX.Element {
  const { t } = useText();
  const [open, setOpen] = createSignal(false);
  return (
    <Popover.Root open={open()} onOpenChange={setOpen} placement="top-end" gutter={4}>
      <Popover.Trigger
        class={cx(buttonVariants({ variant: "ghost", size: "icon-xs" }), "ui-icon-button", props.triggerClass)}
        aria-label={t("workspace.message.react")}
        title={t("workspace.message.react")}
      >
        <SmilePlus aria-hidden="true" />
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content class="ui-popover-menu-surface ws-quick-reactions">
          <For each={props.quickReactions ?? QUICK_REACTIONS}>
            {(emoji) => (
              <Button
                variant="ghost"
                size="icon-sm"
                class="ws-quick-reaction"
                aria-label={t("workspace.reaction.add", { emoji })}
                onClick={() => {
                  props.onPick(emoji);
                  setOpen(false);
                }}
              >
                {emoji}
              </Button>
            )}
          </For>
          <Show when={props.onOpenEmojiPicker}>
            {(more) => (
              <IconButton
                variant="ghost"
                label={t("workspace.reaction.more")}
                onClick={() => {
                  setOpen(false);
                  more()();
                }}
              >
                <Ellipsis />
              </IconButton>
            )}
          </Show>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

/** "3 replies · Last reply today at 3:42 PM", with the faces of the people who replied. */
export function ThreadSummaryRow(props: { thread: ThreadSummary; onOpen?: (() => void) | undefined }): JSX.Element {
  const { t } = useText();
  const recent = useRecentTime();
  return (
    <Button
      variant="ghost"
      size="xs"
      class="ws-thread-summary"
      data-unread={props.thread.unread ? "" : undefined}
      disabled={!props.onOpen}
      onClick={() => props.onOpen?.()}
    >
      <AvatarStack members={props.thread.participants} max={4} size="xs" />
      <span class="ws-thread-summary-count">{t("workspace.thread.replies", { count: props.thread.replyCount })}</span>
      <span class="ws-thread-summary-last">
        {t("workspace.thread.lastReply", { time: recent(props.thread.lastReplyAt) })}
      </span>
      <span class="ws-thread-summary-view">{t("workspace.thread.view")}</span>
      <ChevronRight class="ws-thread-summary-chevron" aria-hidden="true" />
    </Button>
  );
}
