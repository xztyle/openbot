import type { ChannelMessage, ChannelTask } from "@openbot/contracts/ipc";
import { ArrowUp, Button, CheckCheck, ChevronDown } from "@openbot/ui";
import { type ChatFlow, createChatFlow } from "@openbot/ui/features/conversation/createChatFlow";
import { useText } from "@openbot/ui/text";
import type { JSX } from "@solidjs/web";
import { createEffect, createMemo, createSignal, For, onCleanup, onSettled, Show, untrack } from "solid-js";
import { WorkspaceMessage } from "./WorkspaceMessage";
import { useWorkspace } from "./workspace-context";
import { debugMode } from "./workspace-debug";
import {
  agentNotes,
  foldProgressRows,
  keepUnchangedRows,
  messageRows,
  peopleNames,
  type WorkspaceMessageRowModel,
} from "./workspace-model";
import { savedScrollPlace, saveScrollPlace } from "./workspace-scroll-places";

/** How close to the end still counts as reading the newest messages. */
const FOLLOW_DISTANCE = 80;
/** How close to the top of the loaded rows asks for the next older page. */
const HISTORY_TOP = 200;

export interface WorkspaceMessageListProps {
  channelId: string;
  channelName: string;
  entries: readonly ChannelMessage[];
  /** The tasks of the channel: the answer of a task that an agent assigned folds to one line. */
  tasks?: readonly ChannelTask[];
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
 * The transcript of a channel. Each message is a row in the normal flow of the page, below the one
 * before it, so no row is ever drawn over another; a long channel draws only the rows around the
 * view (see `createChatFlow`). It follows new messages while the reader is at the
 * end, keeps its place when older ones load above, and loads the next older page when the reader
 * reaches the top.
 */
export function WorkspaceMessageList(props: WorkspaceMessageListProps) {
  const { t, format } = useText();
  const ws = useWorkspace();
  let scroller: HTMLDivElement | undefined;
  let rowList: HTMLDivElement | undefined;
  const [atEnd, setAtEnd] = createSignal(true);
  const [loadingOlder, setLoadingOlder] = createSignal(false);
  let follow = true;
  /** The flow, once it exists: the row keys below are read when it is made. */
  let rowFlow: ChatFlow | undefined;
  let opened = false;

  const rows = createMemo<readonly WorkspaceMessageRowModel[]>((previous) =>
    keepUnchangedRows(
      (debugMode() ? (rows: WorkspaceMessageRowModel[]) => rows : foldProgressRows)(
        messageRows(props.entries, {
          firstUnreadId: props.firstUnreadId,
          working: props.working,
          membersAnswer: props.membersAnswer === true,
          note: debugMode()
            ? undefined
            : agentNotes(ws.directory().agents, props.tasks ?? [], peopleNames(ws.directory())),
          steps: debugMode(),
          everything: debugMode(),
        }),
      ),
      previous,
    ),
  );
  const indexByKey = createMemo(() => new Map(rows().map((row, index) => [row.key, index])));
  /* One element per row key, so a row stays the same element while its message changes. */
  const rowKeys = createMemo<readonly string[]>((previous) => {
    const keys = rows().map((row) => row.key);
    if (previous && previous.length === keys.length && previous.every((key, index) => key === keys[index]))
      return previous;
    // The rows change before they are drawn: take the reader's place now, so the flow keeps it.
    rowFlow?.notePlace();
    return keys;
  });
  // A long channel draws a window of its rows around the view (see `createChatFlow`).
  const flow = createChatFlow({ following: () => follow, keys: rowKeys });
  rowFlow = flow;
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
      if (!scroller || !rowList || !opened) return;
      if (follow) {
        saveScrollPlace(placeId, null);
        return;
      }
      const top = scroller.getBoundingClientRect().top;
      for (const element of rowList.children) {
        const box = element.getBoundingClientRect();
        if (box.bottom <= top) continue;
        // The spacers in place of the rows out of the window have no key.
        const key = element.getAttribute("data-row-key");
        if (!key) continue;
        saveScrollPlace(placeId, { key, offset: box.top - top });
        return;
      }
    });
  }

  /** Opens the list where the reader left it: that row, as far from the top as it was. */
  function restorePlace(index: number, offset: number) {
    follow = false;
    flow.scrollToIndex(index, { offset });
    requestAnimationFrame(updateAtEnd);
  }

  /** The scroll position at the last check, to tell a move up from content that grew below. */
  let lastScrollTop = 0;
  function updateAtEnd() {
    if (!scroller) return;
    const remaining = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight;
    // Only a move up leaves the end. A message that grows below the view moves the end away
    // without a scroll, and the list follows it.
    if (remaining <= FOLLOW_DISTANCE) follow = true;
    else if (scroller.scrollTop < lastScrollTop - 1) follow = false;
    lastScrollTop = scroller.scrollTop;
    notePlace();
    if (follow !== atEnd()) {
      setAtEnd(follow);
      setAwayKey(follow ? null : (untrack(rows).at(-1)?.key ?? null));
      props.onAtEnd?.(follow);
    }
    const unread = untrack(unreadIndex);
    const start = unread >= 0 ? flow.itemStart(unread) : undefined;
    const above = start !== undefined && start < scroller.scrollTop;
    if (above !== untrack(unreadAbove)) setUnreadAbove(above);
  }

  function jumpToUnread() {
    const unread = untrack(unreadIndex);
    if (unread < 0) return;
    follow = false;
    flow.scrollToIndex(Math.max(0, unread - 1));
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
      return {
        id,
        index: rows().findIndex((row) => row.entry.id === id && !row.pending),
        older: props.hasOlder,
        // A page that lands while another loads asks again once that one is done.
        loading: loadingOlder(),
      };
    },
    (focus) => {
      if (!focus) {
        focused = undefined;
        focusLoads = 0;
        return;
      }
      if (focus.id === focused) return;
      if (focus.index < 0) {
        if (focus.older && !focus.loading && focusLoads < FOCUS_LOAD_LIMIT) {
          focusLoads += 1;
          void loadOlder();
        }
        return;
      }
      focused = focus.id;
      follow = false;
      requestAnimationFrame(() => {
        flow.scrollToIndex(Math.max(0, focus.index - 1));
        requestAnimationFrame(updateAtEnd);
      });
    },
  );

  // The first rows open at the "new" divider, or at the end. Each later change follows the end
  // while the reader is there.
  createEffect(
    () => ({ count: rows().length, last: rows().at(-1)?.key, size: flow.getTotalSize() }),
    () => {
      requestAnimationFrame(() => {
        if (!scroller) return;
        if (!opened && rows().length > 0) {
          opened = true;
          // A linked message takes the place of the divider and the end.
          if (untrack(() => props.focusId)) return;
          const unread = untrack(() => rows().findIndex((row) => row.firstUnread));
          if (unread > 0) {
            follow = false;
            flow.scrollToIndex(Math.max(0, unread - 1));
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
        // A transcript shorter than the view has no scroll to reach its top: it loads the next page.
        if (opened && scroller.scrollTop <= HISTORY_TOP) void loadOlder();
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
          flow.setScrollElement(element);
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
          if (scroller && scroller.scrollTop < HISTORY_TOP && opened) void loadOlder();
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
          ref={(element) => {
            rowList = element;
            flow.setListElement(element);
          }}
          class="ws-timeline"
        >
          <div class="chat-flow-space" aria-hidden="true" style={{ height: `${flow.spaceBefore()}px` }} />
          <For each={flow.rowKeys()}>
            {(key) => {
              const index = createMemo(() => indexByKey().get(key));
              const row = createMemo(() => {
                const current = index();
                return current === undefined ? undefined : rows()[current];
              });
              return (
                <div data-index={index()} data-row-key={key} class="ws-timeline-row chat-flow-row">
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
          <div class="chat-flow-space" aria-hidden="true" style={{ height: `${flow.spaceAfter()}px` }} />
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
