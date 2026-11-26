import type { JSX } from "@solidjs/web";
import { createSignal, For, Show } from "solid-js";
import { Button, buttonVariants, IconButton } from "../../button";
import { Popover } from "../../complex";
import {
  ArrowRight,
  Bookmark,
  ChevronDown,
  ChevronRight,
  Ellipsis,
  MessageSquareReply,
  Pin,
  SmilePlus,
} from "../../icons";
import { useText } from "../../text";
import { LabelTooltip, LabelTooltipTrigger } from "../../tooltip";
import { cx, usesTouchLayout } from "../../utils";
import { EmojiPicker, type EmojiPickerProps } from "./emoji-picker-lazy";
import { LongMessageFold } from "./LongMessageFold";
import { MemberProfilePopover } from "./MemberProfileCard";
import {
  createMessageTargetItems,
  joinContextItems,
  type MessageTargetActions,
  resolveMessageContextTarget,
} from "./message-context-target";
import { AvatarStack, MemberAvatar, MemberName } from "./WorkspaceAvatar";
import { WorkspaceContextMenu, type WorkspaceSheetControls } from "./WorkspaceContextMenu";
import { WorkspaceMenu } from "./WorkspaceMenu";
import { useMessageTime, useRecentTime } from "./workspace-format";
import type {
  MessageSegment,
  ThreadSummary,
  WorkspaceMember,
  WorkspaceMenuItem,
  WorkspaceReaction,
} from "./workspace-types";

/** What the reaction picker needs for its full emoji list. */
export type ReactionEmojiPicker = Pick<EmojiPickerProps, "recent" | "skinTone" | "onSkinToneChange">;

/** The emoji that the react button offers first, as Slack's frequent row. */
export const QUICK_REACTIONS = ["👍", "❤️", "😂", "🎉", "👀", "✅"] as const;

export interface MessageRowProps {
  author: WorkspaceMember;
  /** The send time, in milliseconds since the epoch. NaN for a message with no stored time. */
  sentAt: number;
  /** The time to show when `sentAt` is not a number: the time that an old message printed. */
  timeLabel?: string | undefined;
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
  /** The message is pinned to its channel: "Pinned by <name>" over it, and a light tint. */
  pinnedBy?: string | undefined;
  /** The reader saved the message for later: "Saved for later" over it. */
  saved?: boolean | undefined;
  /**
   * A thread reply that was also sent to the channel, as Slack's "replied to a thread": the start of
   * the root's text (null when it is not loaded), and the action that opens the thread.
   */
  repliedTo?: { text: string | null; onOpen: () => void } | undefined;
  reactions?: readonly WorkspaceReaction[] | undefined;
  onToggleReaction?: ((emoji: string) => void) | undefined;
  /** Opens the full emoji picker. The quick row of the react button does not need it. */
  onOpenEmojiPicker?: (() => void) | undefined;
  quickReactions?: readonly string[] | undefined;
  /** The full emoji picker behind the react button's "more": recent emoji and the skin tone. */
  emojiPicker?: ReactionEmojiPicker | undefined;
  thread?: ThreadSummary | undefined;
  onOpenThread?: (() => void) | undefined;
  /** The name of the reply button, when it does not open a thread: the agent chat quotes the message. */
  replyLabel?: string | undefined;
  /** The items of the "more" menu: edit, copy link, mark unread, delete. */
  menuItems?: readonly WorkspaceMenuItem[] | undefined;
  /**
   * What a right-click or a long press on an image, a file, a link, a code block, selected text or
   * the author offers, before the message's items. Absent: only the items that need no action, such
   * as copying a code block, show.
   */
  targetActions?: MessageTargetActions | undefined;
  /** Draws the author's profile card, which the avatar and the name open. */
  profile?: (() => JSX.Element) | undefined;
  /**
   * An editor in place of the text, as Slack's edit in place: while it is set, the row shows it
   * instead of the text, the content, the reactions and the thread, and has no action bar.
   */
  editor?: JSX.Element;
  /**
   * A message that the author agent wrote for other agents. The row is one quiet line, the faces of
   * the author and the recipients and a summary, and opens to the text and the content in place, as
   * Slack's "Show more". Reactions and the thread summary still show under the line.
   */
  note?: MessageRowNote | undefined;
  /** A long text folds to its first lines with "Show more": the message, and whether it may fold and still streams. */
  fold?: { id: string; enabled: boolean; live: boolean } | undefined;
  class?: string;
}

/** The one-line form of a message between agents. */
export interface MessageRowNote {
  recipients: readonly WorkspaceMember[];
  summary: string;
  /** The text says more than the summary: the line opens it. */
  expandable: boolean;
}

/**
 * One Slack-style message: avatar, name, time and text, no bubble. Hover or focus shows the action
 * bar; reactions and the thread summary sit under the text.
 */
export function MessageRow(props: MessageRowProps): JSX.Element {
  const { t, format } = useText();
  const time = useMessageTime();
  const [menuOpen, setMenuOpen] = createSignal(false);
  // A touch screen has no hover bar: a long press opens the actions in a sheet, as in Slack.
  const touch = usesTouchLayout();
  // The action bar and the profile popovers are built when the row is first hovered or focused. A
  // long channel builds a few rows on each scroll frame, and those controls were most of their cost.
  const [armed, setArmed] = createSignal(false);
  const arm = () => {
    if (!armed()) setArmed(true);
  };
  const timed = () => Number.isFinite(props.sentAt);
  const shownTime = () => (timed() ? time(props.sentAt) : (props.timeLabel ?? ""));
  const fullTime = () => (timed() ? format.date(props.sentAt, { dateStyle: "full", timeStyle: "short" }) : undefined);
  const isoTime = () => (timed() ? new Date(props.sentAt).toISOString() : undefined);
  const profileLabel = () => t("workspace.profile.open", { name: props.author.name });
  const [noteOpen, setNoteOpen] = createSignal(false);
  /** A folded note shows its line only; the text and the content wait for the reader to open it. */
  const folded = () => props.note !== undefined && !noteOpen() && !props.editor;
  let row: HTMLElement | undefined;
  const targetItems = createMessageTargetItems(() => props.targetActions);
  /** The items of what was pressed first, then the message's own under a divider. */
  const contextItems = (pressed: Element | null) => {
    const own = props.menuItems ?? [];
    if (!pressed || !row || props.deleted || props.editor) return own;
    return joinContextItems(targetItems(resolveMessageContextTarget(pressed, row)), own);
  };
  return (
    <WorkspaceContextMenu
      items={contextItems}
      label={t(touch ? "workspace.message.actions" : "workspace.message.more")}
      sheetHeader={
        props.onToggleReaction && !props.deleted
          ? (controls) => (
              <SheetReactions
                controls={controls}
                quickReactions={props.quickReactions}
                emojiPicker={props.emojiPicker}
                onOpenEmojiPicker={props.onOpenEmojiPicker}
                onPick={(emoji) => props.onToggleReaction?.(emoji)}
              />
            )
          : undefined
      }
    >
      <article
        ref={row}
        class={cx("ws-message", props.class)}
        tabindex="0"
        data-grouped={props.grouped ? "" : undefined}
        data-note={props.note ? (noteOpen() ? "open" : "folded") : undefined}
        data-highlighted={props.highlighted ? "" : undefined}
        data-mention={props.mentionsReader ? "" : undefined}
        data-pinned={props.pinnedBy !== undefined && !props.deleted ? "" : undefined}
        data-menu-open={menuOpen() ? "" : undefined}
        aria-label={t("workspace.message.label", { name: props.author.name, time: shownTime() })}
        onPointerEnter={arm}
        onFocusIn={arm}
      >
        <div class="ws-message-gutter">
          <Show
            when={!props.grouped && !props.note}
            fallback={
              <Show
                when={props.note}
                fallback={
                  <time class="ws-message-gutter-time" datetime={isoTime()} title={fullTime()}>
                    {shownTime()}
                  </time>
                }
              >
                <MemberProfilePopover card={armed() ? props.profile : undefined} label={profileLabel()}>
                  <MemberAvatar member={props.author} size="xs" />
                </MemberProfilePopover>
              </Show>
            }
          >
            <MemberProfilePopover card={armed() ? props.profile : undefined} label={profileLabel()}>
              <MemberAvatar member={props.author} size="lg" />
            </MemberProfilePopover>
          </Show>
        </div>
        <div class="ws-message-body">
          <Show when={!props.deleted && (props.pinnedBy !== undefined || props.saved)}>
            <p class="ws-message-marks">
              <Show when={props.saved}>
                <span class="ws-message-mark" data-mark="saved">
                  <Bookmark aria-hidden="true" />
                  {t("workspace.message.savedMark")}
                </span>
              </Show>
              <Show when={props.pinnedBy}>
                {(name) => (
                  <span class="ws-message-mark" data-mark="pinned">
                    <Pin aria-hidden="true" />
                    {t("workspace.message.pinnedBy", { name: name() })}
                  </span>
                )}
              </Show>
            </p>
          </Show>
          <Show when={props.note}>
            {(note) => (
              <NoteLine
                author={props.author}
                note={note()}
                open={noteOpen()}
                time={shownTime()}
                isoTime={isoTime()}
                fullTime={fullTime()}
                onToggle={note().expandable ? () => setNoteOpen((open) => !open) : undefined}
              />
            )}
          </Show>
          <Show when={!props.grouped && !props.note}>
            <div class="ws-message-meta">
              <MemberProfilePopover
                card={armed() ? props.profile : undefined}
                label={profileLabel()}
                class="ws-message-author"
              >
                <MemberName member={props.author} />
              </MemberProfilePopover>
              <time class="ws-message-time" datetime={isoTime()} title={fullTime()}>
                {shownTime()}
              </time>
            </div>
          </Show>
          <Show when={!props.deleted && props.repliedTo}>
            {(replied) => (
              <Button variant="link" size="xs" class="ws-message-replied" onClick={() => replied().onOpen()}>
                <MessageSquareReply aria-hidden="true" />
                <span class="ws-truncate">
                  {replied().text
                    ? t("workspace.message.repliedTo", { text: replied().text ?? "" })
                    : t("workspace.message.repliedToThread")}
                </span>
              </Button>
            )}
          </Show>
          <Show when={props.editor}>
            <div class="ws-message-editor">{props.editor}</div>
          </Show>
          <Show
            when={!props.deleted && !props.editor}
            fallback={
              <Show when={!props.editor}>
                <p class="ws-message-text ws-message-deleted">{t("workspace.message.deleted")}</p>
              </Show>
            }
          >
            <Show when={!folded() && props.text?.length}>
              <LongMessageFold
                id={props.fold?.id ?? ""}
                enabled={props.fold?.enabled === true}
                live={props.fold?.live === true}
              >
                <p class="ws-message-text">
                  <MessageText segments={props.text ?? []} />
                  <Show when={props.edited}>
                    <span class="ws-message-edited">{t("workspace.message.edited")}</span>
                  </Show>
                </p>
              </LongMessageFold>
            </Show>
            <Show when={!folded()}>{props.children}</Show>
            {/* A message drawn by the content renderer has no text run: the mark goes under it. */}
            <Show when={!folded() && props.edited && !props.text?.length}>
              <span class="ws-message-edited ws-message-edited-block">{t("workspace.message.edited")}</span>
            </Show>
            <Show when={props.reactions?.length}>
              <ReactionBar
                reactions={props.reactions ?? []}
                onToggle={props.onToggleReaction}
                quickReactions={props.quickReactions}
                onOpenEmojiPicker={props.onOpenEmojiPicker}
                emojiPicker={props.emojiPicker}
              />
            </Show>
            <Show when={props.thread}>
              {(thread) => <ThreadSummaryRow thread={thread()} onOpen={props.onOpenThread} />}
            </Show>
          </Show>
        </div>
        <Show when={!touch && armed() && !props.deleted && !props.editor}>
          <div class="ws-message-actions" role="toolbar" aria-label={t("workspace.message.actions")}>
            <Show when={props.onToggleReaction}>
              {(toggle) => (
                <>
                  <For each={(props.quickReactions ?? QUICK_REACTIONS).slice(0, 3)}>
                    {(emoji) => (
                      <Button
                        variant="ghost"
                        size="icon-xs"
                        class="ws-message-action-emoji"
                        aria-label={t("workspace.reaction.add", { emoji })}
                        title={t("workspace.reaction.add", { emoji })}
                        onClick={() => toggle()(emoji)}
                      >
                        {emoji}
                      </Button>
                    )}
                  </For>
                  <ReactionPicker
                    quickReactions={props.quickReactions}
                    onPick={toggle()}
                    onOpenEmojiPicker={props.onOpenEmojiPicker}
                    emojiPicker={props.emojiPicker}
                  />
                </>
              )}
            </Show>
            <Show when={props.onOpenThread}>
              {(open) => (
                <IconButton
                  variant="ghost"
                  size="icon-xs"
                  label={props.replyLabel ?? t("workspace.message.reply")}
                  onClick={() => open()()}
                >
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
    </WorkspaceContextMenu>
  );
}

/**
 * The line of a message between agents: the faces of whom it is for after an arrow, the summary on
 * one ellipsized line, the time, and the chevron that opens the text.
 */
function NoteLine(props: {
  author: WorkspaceMember;
  note: MessageRowNote;
  open: boolean;
  time: string;
  isoTime: string | undefined;
  fullTime: string | undefined;
  onToggle: (() => void) | undefined;
}): JSX.Element {
  const { t, format } = useText();
  const label = () =>
    t("workspace.message.agentNote.label", {
      from: props.author.name,
      to: format.list(props.note.recipients.map((member) => member.name)),
      summary: props.note.summary,
    });
  const content = (
    <>
      <ArrowRight class="ws-note-arrow" aria-hidden="true" />
      <AvatarStack members={props.note.recipients} max={3} size="xs" class="ws-note-faces" />
      <span class="ws-note-summary">{props.note.summary}</span>
      <time class="ws-note-time" datetime={props.isoTime} title={props.fullTime}>
        {props.time}
      </time>
    </>
  );
  return (
    <Show
      when={props.onToggle}
      fallback={
        <p class="ws-note-line" title={label()}>
          {content}
        </p>
      }
    >
      {(toggle) => (
        <Button
          variant="ghost"
          size="xs"
          class="ws-note-line"
          aria-expanded={props.open ? "true" : "false"}
          aria-label={`${label()}. ${t(props.open ? "workspace.message.agentNote.hide" : "workspace.message.agentNote.show")}`}
          title={label()}
          onClick={() => toggle()()}
        >
          {content}
          <ChevronDown class="ws-note-chevron" aria-hidden="true" />
        </Button>
      )}
    </Show>
  );
}

/**
 * The top of a message's phone sheet: the quick reactions and "more", which shows every emoji in
 * the sheet in place of the actions.
 */
function SheetReactions(props: {
  controls: WorkspaceSheetControls;
  quickReactions?: readonly string[] | undefined;
  emojiPicker?: ReactionEmojiPicker | undefined;
  onOpenEmojiPicker?: (() => void) | undefined;
  onPick: (emoji: string) => void;
}): JSX.Element {
  const { t } = useText();
  const [full, setFull] = createSignal(false);
  const pick = (emoji: string) => {
    props.onPick(emoji);
    props.controls.close();
  };
  return (
    <Show
      when={full() && props.emojiPicker}
      fallback={
        <QuickReactionRow
          quickReactions={props.quickReactions}
          onPick={pick}
          onMore={
            props.emojiPicker
              ? () => {
                  setFull(true);
                  props.controls.setItemsHidden(true);
                }
              : props.onOpenEmojiPicker
                ? () => {
                    props.controls.close();
                    props.onOpenEmojiPicker?.();
                  }
                : undefined
          }
        />
      }
    >
      {(picker) => (
        <section class="ws-sheet-emoji" aria-label={t("workspace.emoji.label")}>
          <EmojiPicker
            recent={picker().recent}
            skinTone={picker().skinTone}
            onSkinToneChange={picker().onSkinToneChange}
            onPick={pick}
          />
        </section>
      )}
    </Show>
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
  emojiPicker?: ReactionEmojiPicker | undefined;
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
            emojiPicker={props.emojiPicker}
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
  emojiPicker?: ReactionEmojiPicker | undefined;
  triggerClass?: string;
}): JSX.Element {
  const { t } = useText();
  const [open, setOpen] = createSignal(false);
  /** The popover shows every emoji, after "more" in the quick row. */
  const [full, setFull] = createSignal(false);
  const changeOpen = (next: boolean) => {
    setOpen(next);
    if (!next) setFull(false);
  };
  return (
    <Popover.Root open={open()} onOpenChange={changeOpen} placement="top-end" gutter={4}>
      <Popover.Trigger
        class={cx(buttonVariants({ variant: "ghost", size: "icon-xs" }), "ui-icon-button", props.triggerClass)}
        aria-label={t("workspace.message.react")}
        title={t("workspace.message.react")}
      >
        <SmilePlus aria-hidden="true" />
      </Popover.Trigger>
      <Popover.Portal>
        <Show
          when={full() && props.emojiPicker}
          fallback={
            <Popover.Content class="ui-popover-menu-surface ws-quick-reactions">
              <QuickReactionRow
                quickReactions={props.quickReactions}
                onPick={(emoji) => {
                  props.onPick(emoji);
                  changeOpen(false);
                }}
                onMore={
                  props.emojiPicker
                    ? () => setFull(true)
                    : props.onOpenEmojiPicker
                      ? () => {
                          changeOpen(false);
                          props.onOpenEmojiPicker?.();
                        }
                      : undefined
                }
              />
            </Popover.Content>
          }
        >
          {(picker) => (
            <Popover.Content class="ui-popover-menu-surface ws-emoji-popover" aria-label={t("workspace.emoji.label")}>
              <EmojiPicker
                autofocus
                recent={picker().recent}
                skinTone={picker().skinTone}
                onSkinToneChange={picker().onSkinToneChange}
                onPick={(emoji) => {
                  props.onPick(emoji);
                  changeOpen(false);
                }}
              />
            </Popover.Content>
          )}
        </Show>
      </Popover.Portal>
    </Popover.Root>
  );
}

/** The frequent emoji in a row, and the button that opens every emoji. */
function QuickReactionRow(props: {
  quickReactions?: readonly string[] | undefined;
  onPick: (emoji: string) => void;
  onMore?: (() => void) | undefined;
}): JSX.Element {
  const { t } = useText();
  return (
    <>
      <For each={props.quickReactions ?? QUICK_REACTIONS}>
        {(emoji) => (
          <Button
            variant="ghost"
            size="icon-sm"
            class="ws-quick-reaction"
            aria-label={t("workspace.reaction.add", { emoji })}
            onClick={() => props.onPick(emoji)}
          >
            {emoji}
          </Button>
        )}
      </For>
      <Show when={props.onMore}>
        {(more) => (
          <IconButton variant="ghost" label={t("workspace.reaction.more")} onClick={() => more()()}>
            <Ellipsis />
          </IconButton>
        )}
      </Show>
    </>
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
