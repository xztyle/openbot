import { INPUT_LIMITS } from "@openbot/contracts/input-limits";
import type { DirectConversationSnapshot, DirectMessage, TeamPresenceMember } from "@openbot/contracts/ipc";
import {
  Bubble,
  BubbleContent,
  Button,
  Message,
  MessageContent,
  MessageFooter,
  MessageGroup,
  Textarea,
} from "@openbot/ui";
import { TypingDots } from "@openbot/ui/components/TypingDots";
import { formatChatTimestamp } from "@openbot/ui/features/conversation/chat-timestamp";
import { ScrollToLatestButton, scrollToLatestMessage } from "@openbot/ui/features/conversation/MessageNavigation";
import {
  scrollToUnreadBoundary,
  UnreadMessagesBanner,
  UnreadMessagesDivider,
  unreadMessagesDividerIsVisible,
} from "@openbot/ui/features/conversation/UnreadMessages";
import { TeamPersonAvatar, teamMemberName } from "@openbot/ui/features/team/TeamPersonAvatar";
import { type TextValue, useText } from "@openbot/ui/text";
import { createEffect, createMemo, createSignal, For, onCleanup, onSettled, Show, untrack } from "solid-js";
import { ChatScrollRail, createChatScrollRail, type UnloadedHistory } from "./ChatScrollRail";
import { chatHistoryBoundaryReached, createChatFlow } from "./createChatFlow";
import { anchorNewMessages, type NewMessageTally, tallyNewMessages } from "./new-message-tally";
import { isSendShortcutKey, type SendShortcut, sendShortcutAriaKey, sendShortcutHintKey } from "./send-shortcut";

interface DirectConversationProps {
  member: TeamPresenceMember;
  currentMemberId: string;
  snapshot: DirectConversationSnapshot | undefined;
  loading: boolean;
  loadError: string | null;
  hasOlder?: boolean;
  /** The messages above the loaded page, for the scroll rail. Absent when the host does not count them. */
  unloadedHistory?: UnloadedHistory | undefined;
  loadingOlder?: boolean;
  olderError?: string | null;
  typing: boolean;
  connectionReady?: boolean;
  onSend: (text: string, clientMessageId: string) => Promise<{ message: DirectMessage; readError?: string }>;
  onMarkRead: () => Promise<void>;
  onLoadOlder?: () => void;
  onOpenMessage?: (messageId: string) => Promise<void>;
  onTypingChange: (typing: boolean) => void;
  /**
   * Which chord sends the message. Enter keeps the current behavior; in the modifier mode
   * plain Enter adds a line. The renderer resolves the platform and passes it.
   */
  sendShortcut?: SendShortcut;
}

export function DirectConversation(props: DirectConversationProps) {
  const { t, format, errorMessage } = useText();
  const [text, setText] = createSignal("");
  const [sending, setSending] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const [markingRead, setMarkingRead] = createSignal(false);
  const [showScrollToLatest, setShowScrollToLatest] = createSignal(false);
  const [unreadDividerVisible, setUnreadDividerVisible] = createSignal(false);
  const [newMessageCount, setNewMessageCount] = createSignal(0);
  let messageList: HTMLDivElement | undefined;
  let unreadMessagesDivider: HTMLDivElement | undefined;
  let unreadVisibilityFrame: number | undefined;
  let currentUnreadCount = 0;
  let typingIdleTimer: ReturnType<typeof setTimeout> | undefined;
  let stickToLatest = true;
  let lastThreadId: string | undefined;
  let newMessages: NewMessageTally = { count: 0, anchorId: undefined };
  /* Every message anchors the count, but the reader's own arrival is not news to them. */
  const timelineRows = createMemo(
    () =>
      props.snapshot?.messages.map((message) => ({
        id: message.id,
        countable: message.senderMemberId !== props.currentMemberId,
      })) ?? [],
  );
  const clearNewMessages = (): void => {
    newMessages = anchorNewMessages(timelineRows());
    setNewMessageCount(0);
  };
  // The rows are in the normal flow of the page, so a row can never be drawn over another.
  const messageFlow = createChatFlow({ following: () => stickToLatest });
  /* One row per message id, so a row stays the same element when messages load above it. */
  const rowKeys = createMemo<readonly string[]>((previous) => {
    const keys = props.snapshot?.messages.map((message) => message.id) ?? [];
    if (previous && previous.length === keys.length && previous.every((key, index) => key === keys[index]))
      return previous;
    // The rows change before they are drawn: take the reader's place now, so the flow keeps it.
    messageFlow.notePlace();
    return keys;
  });
  const indexById = createMemo(
    () => new Map((props.snapshot?.messages ?? []).map((message, index) => [message.id, index])),
  );
  /* The reader is at the top of the loaded messages: the next older page loads. */
  function loadOlderAtTop(): void {
    if (chatHistoryBoundaryReached(messageList) && props.hasOlder && !props.loadingOlder) props.onLoadOlder?.();
  }
  const rail = createChatScrollRail({
    rows: () => props.snapshot?.messages ?? [],
    question: (message) => (message.senderMemberId === props.currentMemberId ? message.text : undefined),
    unloaded: () => props.unloadedHistory,
    flow: messageFlow,
    onLoadOlder: () => props.onLoadOlder?.(),
    onJump: () => {
      stickToLatest = false;
    },
  });
  createEffect(
    () => {
      const rows = timelineRows();
      return {
        threadId: props.snapshot?.threadId,
        revision: props.snapshot?.revision ?? -1,
        messageCount: rows.length,
        unreadCount: props.snapshot?.readState?.unreadCount ?? 0,
        latestMessageId: rows.at(-1)?.id,
      };
    },
    ({ threadId, unreadCount }) => {
      currentUnreadCount = unreadCount;
      const rows = timelineRows();
      if (threadId !== lastThreadId) {
        lastThreadId = threadId;
        stickToLatest = true;
        newMessages = anchorNewMessages(rows);
        setNewMessageCount(0);
      } else {
        // The sticky flag has to be read here: the frame below has already moved the view.
        newMessages = tallyNewMessages(newMessages, rows, stickToLatest);
        setNewMessageCount(newMessages.count);
      }
      requestAnimationFrame(() => {
        if (!messageList) return;
        if (stickToLatest) messageList.scrollTop = messageList.scrollHeight;
        updateScrollState(messageList);
        updateUnreadDividerVisibility();
        loadOlderAtTop();
      });
    },
  );

  onCleanup(() => {
    if (typingIdleTimer) clearTimeout(typingIdleTimer);
    if (unreadVisibilityFrame !== undefined) cancelAnimationFrame(unreadVisibilityFrame);
    props.onTypingChange(false);
  });

  onSettled(() => {
    const resizeObserver = new ResizeObserver(() => {
      if (messageList && stickToLatest) messageList.scrollTop = messageList.scrollHeight;
      updateUnreadDividerVisibility();
    });
    if (messageList) resizeObserver.observe(messageList);
    return () => resizeObserver.disconnect();
  });

  function updateText(value: string): void {
    setText(value);
    if (typingIdleTimer) clearTimeout(typingIdleTimer);
    if (!value.trim()) {
      props.onTypingChange(false);
      return;
    }
    props.onTypingChange(true);
    typingIdleTimer = setTimeout(() => props.onTypingChange(false), 3_000);
  }

  function updateScrollState(element: HTMLElement): void {
    const remaining = element.scrollHeight - element.scrollTop - element.clientHeight;
    setShowScrollToLatest(remaining > 80);
    if (remaining <= 80) clearNewMessages();
  }

  function updateUnreadDividerVisibility(): void {
    setUnreadDividerVisible(
      Boolean(
        currentUnreadCount > 0 &&
          messageList &&
          unreadMessagesDivider &&
          unreadMessagesDividerIsVisible(messageList, unreadMessagesDivider),
      ),
    );
  }

  function scheduleUnreadDividerVisibilityUpdate(): void {
    if (unreadVisibilityFrame !== undefined) cancelAnimationFrame(unreadVisibilityFrame);
    unreadVisibilityFrame = requestAnimationFrame(() => {
      unreadVisibilityFrame = undefined;
      updateUnreadDividerVisibility();
    });
  }

  async function send(): Promise<void> {
    const body = text().trim();
    if (!body || sending() || props.connectionReady === false) return;
    if (typingIdleTimer) clearTimeout(typingIdleTimer);
    props.onTypingChange(false);
    setSending(true);
    setError(null);
    try {
      const result = await props.onSend(body, crypto.randomUUID());
      setText("");
      if (result.readError) setError(result.readError);
    } catch (cause) {
      setError(errorMessage(cause, t("conversation.direct.sendFailed")));
    } finally {
      setSending(false);
    }
  }

  async function markUnreadMessages(): Promise<void> {
    if (markingRead()) return;
    setMarkingRead(true);
    setError(null);
    try {
      await props.onMarkRead();
    } catch (cause) {
      setError(errorMessage(cause, t("conversation.direct.markReadFailed")));
    } finally {
      setMarkingRead(false);
    }
  }

  async function jumpToUnreadMessages(): Promise<void> {
    if (!messageList) return;
    const firstUnreadMessageId = props.snapshot?.readState?.firstUnreadMessageId;
    if (!unreadMessagesDivider && firstUnreadMessageId && props.onOpenMessage) {
      await props.onOpenMessage(firstUnreadMessageId);
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    }
    if (!unreadMessagesDivider) return;
    const divider = unreadMessagesDivider;
    const firstUnreadMessage = divider.nextElementSibling instanceof HTMLElement ? divider.nextElementSibling : divider;
    scrollToUnreadBoundary(messageList, firstUnreadMessage);
    await markUnreadMessages();
    requestAnimationFrame(() => {
      if (!messageList) return;
      const settledBoundary = divider.isConnected ? divider : firstUnreadMessage;
      if (settledBoundary.isConnected) {
        scrollToUnreadBoundary(messageList, settledBoundary);
      }
    });
  }

  function jumpToLatestMessage(): void {
    if (!messageList) return;
    stickToLatest = true;
    clearNewMessages();
    scrollToLatestMessage(messageList);
  }

  return (
    <main
      class="direct-conversation"
      aria-label={t("conversation.direct.label", { name: teamMemberName(props.member) })}
    >
      <header class="window-drag direct-conversation-header">
        <div class="direct-conversation-person no-drag">
          <TeamPersonAvatar member={props.member} />
          <div>
            <h1>{teamMemberName(props.member)}</h1>
            <span class={props.member.online ? "online" : undefined}>
              <i aria-hidden="true" />
              {props.member.online ? t("conversation.direct.online") : t("conversation.direct.offline")}
            </span>
          </div>
        </div>
        <span class="direct-private-label no-drag">
          <LockIcon /> {t("conversation.direct.private")}
        </span>
      </header>

      <Show when={(props.snapshot?.readState?.unreadCount ?? 0) > 0 && !unreadDividerVisible()}>
        <UnreadMessagesBanner
          count={props.snapshot?.readState?.unreadCount ?? 0}
          busy={markingRead()}
          onJumpToUnread={jumpToUnreadMessages}
          onMarkRead={() => void markUnreadMessages()}
        />
      </Show>

      <div
        ref={(element) => {
          messageList = element;
          rail.ref(element);
          messageFlow.setScrollElement(element);
        }}
        class="direct-message-list"
        role="log"
        onScroll={(event) => {
          const element = event.currentTarget;
          stickToLatest = element.scrollHeight - element.scrollTop - element.clientHeight <= 80;
          updateScrollState(element);
          updateUnreadDividerVisibility();
          loadOlderAtTop();
        }}
      >
        <ChatScrollRail {...rail.props} />
        <Show when={showScrollToLatest()}>
          <ScrollToLatestButton
            onClick={jumpToLatestMessage}
            newMessageCount={newMessageCount()}
            onDismiss={clearNewMessages}
          />
        </Show>
        <Show
          when={!props.loading}
          fallback={<div class="direct-conversation-state">{t("conversation.direct.loading")}</div>}
        >
          <Show
            when={!props.loadError}
            fallback={
              <div class="direct-conversation-state" role="alert">
                <strong>{t("conversation.direct.loadFailed")}</strong>
                <span>{props.loadError}</span>
              </div>
            }
          >
            <Show
              when={(props.snapshot?.messages.length ?? 0) > 0}
              fallback={
                <div class="direct-conversation-empty">
                  <TeamPersonAvatar member={props.member} large />
                  <h2>{t("conversation.direct.emptyTitle", { name: teamMemberName(props.member) })}</h2>
                  <p>{t("conversation.direct.emptyBody")}</p>
                </div>
              }
            >
              <Show when={props.loadingOlder || props.olderError}>
                <div class="conversation-history-status" role={props.olderError ? "alert" : "status"}>
                  <Show when={props.olderError} fallback={t("conversation.direct.loadingOlder")}>
                    <span>{props.olderError}</span>
                    <Button type="button" variant="ghost" size="xs" onClick={() => props.onLoadOlder?.()}>
                      {t("common.retry")}
                    </Button>
                  </Show>
                </div>
              </Show>
              <MessageGroup ref={(element) => messageFlow.setListElement(element)} class="virtual-chat-list">
                <For each={rowKeys()}>
                  {(rowKey) => {
                    const index = () => indexById().get(rowKey) ?? -1;
                    const message = untrack(() => props.snapshot?.messages[index()]);
                    if (!message) return null;
                    const own = () => message.senderMemberId === props.currentMemberId;
                    const previous = () => props.snapshot?.messages[index() - 1];
                    // The unread boundary keeps the full entry gap so its divider stays legible.
                    const grouped = () =>
                      previous()?.senderMemberId === message.senderMemberId &&
                      message.id !== props.snapshot?.readState?.firstUnreadMessageId;
                    return (
                      <div
                        data-index={index()}
                        data-row-key={rowKey}
                        data-grouped={grouped() ? "sender" : undefined}
                        class="virtual-chat-row chat-flow-row"
                      >
                        <Show when={message.id === props.snapshot?.readState?.firstUnreadMessageId}>
                          <UnreadMessagesDivider
                            elementRef={(element) => {
                              unreadMessagesDivider = element;
                              scheduleUnreadDividerVisibilityUpdate();
                            }}
                          />
                        </Show>
                        <Message
                          role="article"
                          align={own() ? "end" : "start"}
                          class={["direct-message", { own: own() }]}
                          data-author={own() ? "user" : "member"}
                          aria-label={t("conversation.direct.messageLabel", {
                            name: own() ? t("conversation.direct.you") : teamMemberName(props.member),
                            time: messageTime(message.createdAt, format),
                          })}
                        >
                          <MessageContent>
                            <Bubble
                              align={own() ? "end" : "start"}
                              variant={own() ? "secondary" : "muted"}
                              data-author={own() ? "user" : "member"}
                            >
                              <BubbleContent>{message.text}</BubbleContent>
                            </Bubble>
                            <MessageFooter>
                              <time datetime={message.createdAt}>{messageTime(message.createdAt, format)}</time>
                            </MessageFooter>
                          </MessageContent>
                        </Message>
                      </div>
                    );
                  }}
                </For>
              </MessageGroup>
            </Show>
          </Show>
        </Show>
      </div>

      <div class="direct-composer-wrap">
        <Show when={props.typing}>
          <div class="direct-typing-indicator" role="status" aria-live="polite">
            <TypingDots class="team-typing-dots" />
            {t("conversation.direct.typing", { name: teamMemberName(props.member) })}
          </div>
        </Show>
        <Show when={error()}>{(message) => <p class="direct-message-error">{message()}</p>}</Show>
        <div class="direct-composer">
          <Textarea
            value={text()}
            rows="1"
            maxlength={INPUT_LIMITS.directMessageText}
            aria-label={t("conversation.direct.input", { name: teamMemberName(props.member) })}
            placeholder={t("conversation.direct.input", { name: teamMemberName(props.member) })}
            disabled={sending()}
            onValueChange={updateText}
            onKeyDown={(event) => {
              // The browser owns the key that commits an IME composition. Safari sends it
              // after `compositionend` without `isComposing`; keyCode 229 marks it.
              if (event.isComposing || event.keyCode === 229) return;
              const shortcut = props.sendShortcut ?? "enter";
              // Enter to send keeps the previous chord: every Enter without Shift sends.
              if (shortcut === "enter") {
                if (event.key !== "Enter" || event.shiftKey) return;
              } else if (!isSendShortcutKey(event, shortcut)) return;
              event.preventDefault();
              void send();
            }}
          />
          <Button
            variant="default"
            type="button"
            aria-label={t("conversation.direct.send")}
            aria-keyshortcuts={sendShortcutAriaKey(props.sendShortcut ?? "enter")}
            title={t(sendShortcutHintKey(props.sendShortcut ?? "enter", "send"))}
            disabled={!text().trim() || sending() || props.connectionReady === false}
            onClick={() => void send()}
          >
            {sending() ? "…" : "↑"}
          </Button>
        </div>
      </div>
    </main>
  );
}

function messageTime(value: string, format: TextValue["format"]): string {
  return formatChatTimestamp(new Date(value), format);
}

function LockIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 16 16">
      <rect x="3.5" y="7" width="9" height="6.5" rx="1.5" />
      <path d="M5.5 7V5.2a2.5 2.5 0 0 1 5 0V7" />
    </svg>
  );
}
