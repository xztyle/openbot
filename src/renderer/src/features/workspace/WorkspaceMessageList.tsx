import type { ChannelMessage } from "@openbot/contracts/ipc";
import { Button, ChevronDown } from "@openbot/ui";
import {
  calculateChatScrollMargin,
  chatHistoryBoundaryReached,
  createChatVirtualizer,
} from "@openbot/ui/features/conversation/createChatVirtualizer";
import { useText } from "@openbot/ui/text";
import type { JSX } from "@solidjs/web";
import { createEffect, createMemo, createSignal, For, onCleanup, onSettled, Show, untrack } from "solid-js";
import { WorkspaceMessage } from "./WorkspaceMessage";
import { messageRows } from "./workspace-model";

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
  hasOlder: boolean;
  onLoadOlder: () => Promise<void> | void;
  /** The root of the open thread. */
  highlightedId?: string | undefined;
  /** Shown when the channel has no messages yet. */
  empty?: JSX.Element;
  /** Reports whether the reader reads the newest messages. */
  onAtEnd?: (atEnd: boolean) => void;
}

/**
 * The transcript of a channel as a virtual list: only the rows near the view are in the page, so a
 * channel with thousands of messages scrolls as smoothly as a short one. It follows new messages
 * while the reader is at the end, keeps its place when older ones load above, and loads the next
 * older page when the reader reaches the top.
 */
export function WorkspaceMessageList(props: WorkspaceMessageListProps) {
  const { t } = useText();
  let scroller: HTMLDivElement | undefined;
  let virtualRoot: HTMLDivElement | undefined;
  const [margin, setMargin] = createSignal(0);
  const [atEnd, setAtEnd] = createSignal(true);
  const [loadingOlder, setLoadingOlder] = createSignal(false);
  let follow = true;
  let opened = false;

  const rows = createMemo(() =>
    messageRows(props.entries, { firstUnreadId: props.firstUnreadId, working: props.working }),
  );
  const indexByKey = createMemo(() => new Map(rows().map((row, index) => [row.key, index])));

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

  function updateAtEnd() {
    if (!scroller) return;
    const remaining = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight;
    follow = remaining <= FOLLOW_DISTANCE;
    if (follow !== atEnd()) {
      setAtEnd(follow);
      props.onAtEnd?.(follow);
    }
  }

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
          const unread = untrack(() => rows().findIndex((row) => row.firstUnread));
          if (unread > 0) {
            virtualizer.scrollToIndex(Math.max(0, unread - 1));
            requestAnimationFrame(updateAtEnd);
            return;
          }
        }
        if (follow) scrollToEnd();
        updateAtEnd();
      });
    },
  );

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
        ref={(element) => (scroller = element)}
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
      <Show when={!atEnd()}>
        <Button
          variant="secondary"
          size="xs"
          class="ws-jump-latest"
          onClick={() => {
            follow = true;
            scrollToEnd();
          }}
        >
          <ChevronDown aria-hidden="true" />
          {t("workspace.app.channel.jumpToLatest")}
        </Button>
      </Show>
    </div>
  );
}
