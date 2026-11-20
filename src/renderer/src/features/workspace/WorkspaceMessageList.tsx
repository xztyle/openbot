import type { ChannelMessage } from "@openbot/contracts/ipc";
import { ArrowUp, Button, CheckCheck, ChevronDown } from "@openbot/ui";
import {
  calculateChatScrollMargin,
  chatHistoryBoundaryReached,
  createChatVirtualizer,
} from "@openbot/ui/features/conversation/createChatVirtualizer";
import { useText } from "@openbot/ui/text";
import type { JSX } from "@solidjs/web";
import { createEffect, createMemo, createSignal, For, onCleanup, onSettled, Show, untrack } from "solid-js";
import { WorkspaceMessage } from "./WorkspaceMessage";
import { useWorkspace } from "./workspace-context";
import { keepUnchangedRows, messageRows, type WorkspaceMessageRowModel } from "./workspace-model";
import { savedScrollPlace, saveScrollPlace } from "./workspace-scroll-places";

/** How close to the end still counts as reading the newest messages. */
const FOLLOW_DISTANCE = 80;

export interface WorkspaceMessageListProps {
  channelId: string;
  channelName: string;
  entries: readonly ChannelMessage[];
  /** The first message the reader had not read when the channel opened. */
  firstUnreadId: string | null;
  /** Agents whose work runs in the channel. */
  working: ReadonlySet<string>;
  /** The members answer for themselves, so a result note that restates an answer is left out. */
  membersAnswer?: boolean;
  hasOlder: boolean;
  onLoadOlder: () => Promise<void> | void;
  /** The root of the open thread, or the message that a link named. */
  highlightedId?: string | undefined;
  /** A message that a link named: the list scrolls to it, and loads older pages until it has it. */
  focusId?: string | undefined;
  /** Shown when the channel has no messages yet. */
  empty?: JSX.Element;
  /** Reports whether the reader reads the newest messages. */
  onAtEnd?: (atEnd: boolean) => void;
  /** Marks the conversation read: the unread banner's button. */
  onMarkRead?: () => void;
}

/**
 * The transcript of a channel as a virtual list: only the rows near the view are in the page, so a
 * channel with thousands of messages scrolls as smoothly as a short one. It follows new messages
 * while the reader is at the end, keeps its place when older ones load above, and loads the next
 * older page when the reader reaches the top.
 */
export function WorkspaceMessageList(props: WorkspaceMessageListProps) {
  const { t, format } = useText();
  const ws = useWorkspace();
  let scroller: HTMLDivElement | undefined;
  let virtualRoot: HTMLDivElement | undefined;
  const [margin, setMargin] = createSignal(0);
  const [atEnd, setAtEnd] = createSignal(true);
  const [loadingOlder, setLoadingOlder] = createSignal(false);
  let follow = true;
  let opened = false;

  const rows = createMemo<readonly WorkspaceMessageRowModel[]>((previous) =>
    keepUnchangedRows(
      messageRows(props.entries, {
        firstUnreadId: props.firstUnreadId,
        working: props.working,
        membersAnswer: props.membersAnswer === true,
      }),
      previous,
    ),
  );
  const indexByKey = createMemo(() => new Map(rows().map((row, index) => [row.key, index])));
  const unreadIndex = createMemo(() => rows().findIndex((row) => row.firstUnread));
  /** The messages of others from the "new" divider on, for "12 new messages since 10:15". */
  const unreadCount = createMemo(() => {
    const from = unreadIndex();
    if (from < 0) return 0;
    return rows()
      .slice(from)
      .filter((row) => !row.pending && !(row.entry.author.kind === "member" && ws.env.isReader(row.entry.author.id)))
      .length;
  });
  /** "12 new messages since 10:15", or only the time when every message after the divider is the reader's. */
  const unreadLabel = () => {
    const time = format.date(Date.parse(rows()[unreadIndex()]?.entry.message.createdAt ?? ""), { timeStyle: "short" });
    const count = unreadCount();
    return count > 0
      ? t("workspace.app.channel.unreadCountSince", { count, time })
      : t("workspace.app.channel.unreadSince", { time });
  };
  /** Where the reader left this conversation, for their next visit while the app runs. */
  const placeId = `${ws.env.storageKey()}:channel:${props.channelId}`;
  /** The last row when the reader left the end: the rows after it are new to them. */
  const [awayKey, setAwayKey] = createSignal<string | null>(null);
  const newSinceAway = createMemo(() => {
    const key = awayKey();
    if (key === null) return 0;
    const from = indexByKey().get(key);
    if (from === undefined) return 0;
    return rows()
      .slice(from + 1)
      .filter((row) => !row.pending).length;
  });
  /** The "new" divider is above the screen: the banner offers to jump back to it. */
  const [unreadAbove, setUnreadAbove] = createSignal(false);

  async function loadOlder() {
    if (loadingOlder() || !props.hasOlder) return;
    setLoadingOlder(true);
    try {
      await props.onLoadOlder();
    } finally {
      setLoadingOlder(false);
    }
  }

  const virtualizer = createChatVirtualizer<HTMLDivElement, HTMLDivElement>({
    count: () => rows().length,
    getScrollElement: () => scroller ?? null,
    estimateSize: () => 64,
    getItemKey: (index) => rows()[index]?.key ?? index,
    keyVersion: () => {
      const list = rows();
      return `${list[0]?.key ?? ""}:${list.at(-1)?.key ?? ""}:${list.length}`;
    },
    scrollMargin: margin,
    stickToLatest: () => follow,
    // A page of the host holds 100 messages; only the rows near the view are built.
    staticLimit: 24,
    onChange: (instance) => {
      const first = instance.getVirtualItems()[0];
      if (first && opened && chatHistoryBoundaryReached(scroller, first.index)) void loadOlder();
    },
  });

  function measure() {
    setMargin(calculateChatScrollMargin(scroller, virtualRoot));
  }

  function scrollToEnd() {
    if (!scroller) return;
    scroller.scrollTop = scroller.scrollHeight;
  }

  /** The row at the top of the view and its distance from the top, read on the next frame. */
  let placeQueued = false;
  function notePlace() {
    if (placeQueued) return;
    placeQueued = true;
    requestAnimationFrame(() => {
      placeQueued = false;
      if (!scroller || !virtualRoot || !opened) return;
      if (follow) {
        saveScrollPlace(placeId, null);
        return;
      }
      const top = scroller.getBoundingClientRect().top;
      for (const element of virtualRoot.children) {
        const box = element.getBoundingClientRect();
        if (box.bottom <= top) continue;
        const key = untrack(rows)[Number(element.getAttribute("data-index"))]?.key;
        if (key) saveScrollPlace(placeId, { key, offset: box.top - top });
        return;
      }
    });
  }

  /** Opens the list where the reader left it: that row, as far from the top as it was. */
  function restorePlace(index: number, offset: number) {
    follow = false;
    virtualizer.scrollToIndex(index);
    requestAnimationFrame(() => {
      const element = virtualRoot?.querySelector(`[data-index="${index}"]`);
      if (scroller && element)
        scroller.scrollTop += element.getBoundingClientRect().top - scroller.getBoundingClientRect().top - offset;
      requestAnimationFrame(updateAtEnd);
    });
  }

  function updateAtEnd() {
    if (!scroller) return;
    const remaining = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight;
    follow = remaining <= FOLLOW_DISTANCE;
    notePlace();
    if (follow !== atEnd()) {
      setAtEnd(follow);
      setAwayKey(follow ? null : (untrack(rows).at(-1)?.key ?? null));
      props.onAtEnd?.(follow);
    }
    const unread = untrack(unreadIndex);
    const start = unread >= 0 ? virtualizer.itemStart(unread) : undefined;
    const above = start !== undefined && start + untrack(margin) < scroller.scrollTop;
    if (above !== untrack(unreadAbove)) setUnreadAbove(above);
  }

  function jumpToUnread() {
    const unread = untrack(unreadIndex);
    if (unread < 0) return;
    follow = false;
    virtualizer.scrollToIndex(Math.max(0, unread - 1));
    requestAnimationFrame(updateAtEnd);
  }

  /** The linked message the list scrolled to last, so a new message does not scroll back to it. */
  let focused: string | undefined;
  /** Older pages loaded to find a linked message. The search stops after a few. */
  let focusLoads = 0;
  const FOCUS_LOAD_LIMIT = 10;
  createEffect(
    () => {
      const id = props.focusId;
      if (!id) return null;
      return { id, index: rows().findIndex((row) => row.entry.id === id && !row.pending), older: props.hasOlder };
    },
    (focus) => {
      if (!focus) {
        focused = undefined;
        focusLoads = 0;
        return;
      }
      if (focus.id === focused) return;
      if (focus.index < 0) {
        if (focus.older && focusLoads < FOCUS_LOAD_LIMIT) {
          focusLoads += 1;
          void loadOlder();
        }
        return;
      }
      focused = focus.id;
      follow = false;
      requestAnimationFrame(() => {
        virtualizer.scrollToIndex(Math.max(0, focus.index - 1));
        requestAnimationFrame(updateAtEnd);
      });
    },
  );

  // The first rows open at the "new" divider, or at the end. Each later change follows the end
  // while the reader is there.
  createEffect(
    () => ({ count: rows().length, last: rows().at(-1)?.key, size: virtualizer.getTotalSize() }),
    () => {
      requestAnimationFrame(() => {
        if (!scroller) return;
        measure();
        if (!opened && rows().length > 0) {
          opened = true;
          // A linked message takes the place of the divider and the end.
          if (untrack(() => props.focusId)) return;
          const unread = untrack(() => rows().findIndex((row) => row.firstUnread));
          if (unread > 0) {
            virtualizer.scrollToIndex(Math.max(0, unread - 1));
            requestAnimationFrame(updateAtEnd);
            return;
          }
          // With nothing new, the reader comes back to the place they left, as in Slack.
          const place = savedScrollPlace(placeId);
          const index = place?.key === undefined ? undefined : untrack(indexByKey).get(place.key);
          if (place && index !== undefined) {
            restorePlace(index, place.offset);
            return;
          }
        }
        if (follow) scrollToEnd();
        updateAtEnd();
      });
    },
  );

  // ⌘J (Ctrl+J), as Slack's: the oldest unread message of the conversation, at the "New" line.
  onSettled(() => {
    const jumpKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || !(event.metaKey || event.ctrlKey) || event.shiftKey || event.altKey) return;
      if (event.key?.toLocaleLowerCase() !== "j" || document.querySelector('[aria-modal="true"]')) return;
      event.preventDefault();
      jumpToUnread();
    };
    window.addEventListener("keydown", jumpKey, true);
    return () => window.removeEventListener("keydown", jumpKey, true);
  });

  onSettled(() => {
    const observer = new ResizeObserver(() => {
      measure();
      if (follow) scrollToEnd();
    });
    if (scroller) observer.observe(scroller);
    return () => observer.disconnect();
  });
  onCleanup(() => {
    opened = false;
  });

  return (
    <div class="ws-message-list">
      <div
        ref={(element) => {
          scroller = element;
          // A link to a message of this workspace opens it here, not in the browser. The links
          // take the keyboard themselves, so the list only hears their clicks.
          element.addEventListener("click", (event) => {
            const target = event.target;
            const anchor = target instanceof Element ? target.closest<HTMLAnchorElement>("a.ws-link[href]") : null;
            if (anchor && ws.openLink(anchor.href)) event.preventDefault();
          });
        }}
        class="ws-message-scroll"
        onScroll={() => {
          updateAtEnd();
          if (scroller && scroller.scrollTop < 200 && opened) void loadOlder();
        }}
      >
        <Show when={loadingOlder()}>
          <p class="ws-message-older" role="status">
            {t("workspace.app.channel.loadingOlder")}
          </p>
        </Show>
        <Show when={!props.hasOlder && rows().length > 0}>
          <div class="ws-message-start">{props.empty}</div>
        </Show>
        <Show when={rows().length === 0}>{props.empty}</Show>
        <div
          ref={(element) => (virtualRoot = element)}
          class="ws-virtual-list"
          data-static={virtualizer.isVirtualized() ? undefined : ""}
          style={{ height: virtualizer.isVirtualized() ? `${virtualizer.getTotalSize()}px` : "auto" }}
        >
          <For each={virtualizer.getVirtualItems()}>
            {(item) => {
              const row = createMemo(() => {
                const index = indexByKey().get(String(item.key));
                return index === undefined ? undefined : rows()[index];
              });
              return (
                <div
                  data-index={item.index}
                  ref={virtualizer.measureElement}
                  class="ws-virtual-row"
                  style={{
                    transform: virtualizer.isVirtualized()
                      ? `translateY(${item.start - virtualizer.scrollMargin()}px)`
                      : "none",
                  }}
                >
                  <Show when={row()}>
                    {(current) => (
                      <WorkspaceMessage
                        row={current()}
                        channelId={props.channelId}
                        channelName={props.channelName}
                        highlighted={props.highlightedId === current().entry.id}
                      />
                    )}
                  </Show>
                </div>
              );
            }}
          </For>
        </div>
      </div>
      <Show when={unreadAbove() && unreadIndex() >= 0}>
        <div class="ws-unread-banner" role="status">
          <Button variant="ghost" size="xs" class="ws-unread-banner-jump" onClick={jumpToUnread}>
            <ArrowUp aria-hidden="true" />
            <span class="ws-unread-banner-label">{unreadLabel()}</span>
          </Button>
          <Show when={props.onMarkRead}>
            {(markRead) => (
              <Button
                variant="ghost"
                size="xs"
                class="ws-unread-banner-read"
                aria-label={t("workspace.app.channel.markRead")}
                title={t("workspace.app.channel.markRead")}
                onClick={() => markRead()()}
              >
                <CheckCheck aria-hidden="true" />
                <span class="ws-unread-banner-read-label">{t("workspace.app.channel.markRead")}</span>
              </Button>
            )}
          </Show>
        </div>
      </Show>
      <Show when={!atEnd()}>
        <Button
          variant={newSinceAway() > 0 ? "default" : "secondary"}
          size="xs"
          class="ws-jump-latest"
          onClick={() => {
            follow = true;
            scrollToEnd();
          }}
        >
          <ChevronDown aria-hidden="true" />
          {newSinceAway() > 0
            ? t("workspace.app.channel.newMessages", { count: newSinceAway() })
            : t("workspace.app.channel.jumpToLatest")}
        </Button>
      </Show>
    </div>
  );
}
