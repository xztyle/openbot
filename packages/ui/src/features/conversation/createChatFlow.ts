import { createSignal, onCleanup } from "solid-js";

/**
 * The rows of a chat transcript in the normal flow of the page: each row is a block below the one
 * before it, so a row can never be drawn over another, whatever its height or however late it
 * grows. The browser does the work a virtual list did: in a long transcript, a row away from the
 * screen skips its layout and paint (`content-visibility: auto` on `.chat-flow-row`), and keeps the
 * size it had when it was last drawn (`contain-intrinsic-size: auto`).
 *
 * This keeps the reader's place when rows change above the view (an older page loads, a row above
 * grows): the browser's own scroll anchoring does it where there is one; Safari has none, so the
 * flow moves the view by the change itself. Each row carries `data-index` (its place) and
 * `data-row-key` (its message).
 */
export interface ChatFlow {
  /** The scroll container. */
  setScrollElement: (element: HTMLElement | undefined) => void;
  /** The element whose children are the rows. */
  setListElement: (element: HTMLElement | undefined) => void;
  /** The height of the rows, which changes as rows render, grow and load. */
  getTotalSize: () => number;
  /** Where a row starts in the scroll content, or undefined when it is not in the page. */
  itemStart: (index: number) => number | undefined;
  /**
   * Opens a row at the top of the view, or `offset` px below it. A smooth scroll animates there.
   * Until a later scroll by the code, it aligns the row again for two frames, as rows near it draw.
   */
  scrollToIndex: (index: number, options?: { smooth?: boolean; offset?: number }) => void;
  /** Scrolls to a position in the scroll content. It ends the alignment of an earlier `scrollToIndex`. */
  scrollToOffset: (offset: number) => void;
  /**
   * Takes the reader's place from the view as it is now. Call it just before the rows change, such
   * as when the keys of the rows change and before they are drawn: the place from the last scroll
   * event can be a frame old, and the browser's own anchoring does not act at the very top.
   */
  notePlace: () => void;
}

/** From this many rows on, the browser skips the rows away from the screen. */
const LONG_TRANSCRIPT_ROWS = 60;

interface Place {
  key: string;
  /** The row's top, from the top of the view. */
  offset: number;
  /** The scroll position when the place was taken: a different one means someone scrolled since. */
  scrollTop: number;
}

export function createChatFlow(options: {
  /** Whether the reader follows the newest message: the transcript's own code keeps them at the end. */
  following: () => boolean;
}): ChatFlow {
  let scroller: HTMLElement | undefined;
  let list: HTMLElement | undefined;
  let place: Place | undefined;
  let alignFrame: number | undefined;
  const [totalSize, setTotalSize] = createSignal(0);

  const rows = (): HTMLElement[] =>
    list ? [...list.children].filter((child): child is HTMLElement => child instanceof HTMLElement) : [];

  const rowAt = (index: number): HTMLElement | undefined =>
    list?.querySelector<HTMLElement>(`:scope > [data-index="${index}"]`) ?? undefined;

  /** The first row whose bottom is below the top of the view: rows are in order, so a binary search. */
  function topRow(): HTMLElement | undefined {
    if (!scroller) return undefined;
    const children = rows();
    const top = scroller.getBoundingClientRect().top;
    let low = 0;
    let high = children.length - 1;
    let found: HTMLElement | undefined;
    while (low <= high) {
      const middle = (low + high) >> 1;
      const child = children[middle];
      if (!child) break;
      if (child.getBoundingClientRect().bottom > top) {
        found = child;
        high = middle - 1;
      } else low = middle + 1;
    }
    return found;
  }

  function notePlace(): void {
    if (!scroller) return;
    const row = topRow();
    const key = row?.dataset.rowKey;
    place =
      row && key
        ? {
            key,
            offset: row.getBoundingClientRect().top - scroller.getBoundingClientRect().top,
            scrollTop: scroller.scrollTop,
          }
        : undefined;
  }

  /**
   * Puts the reader's row back where it was after the rows changed. It does nothing when the reader
   * follows the newest message, when the view moved since the place was taken (the browser's own
   * anchoring did the work, or the reader or the code scrolled), or when the row is gone.
   */
  function keepPlace(): void {
    if (!scroller || !list) return;
    if (options.following() || !place) {
      notePlace();
      return;
    }
    if (Math.abs(scroller.scrollTop - place.scrollTop) > 0.5) {
      notePlace();
      return;
    }
    const key = place.key;
    const row = rows().find((child) => child.dataset.rowKey === key);
    if (row) {
      const offset = row.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
      const delta = offset - place.offset;
      if (Math.abs(delta) >= 1) scroller.scrollTop += delta;
    }
    notePlace();
  }

  const onScroll = () => notePlace();
  // Each change of the rows' height: a row rendered, grew or loaded. It runs after layout and
  // before paint, so a correction is never seen.
  const resizeObserver =
    typeof ResizeObserver === "undefined"
      ? undefined
      : new ResizeObserver(() => {
          if (!list) return;
          setTotalSize(list.offsetHeight);
          // A reader at the end stays there as a message grows or arrives, before the frame paints.
          if (scroller && options.following()) {
            scroller.scrollTop = scroller.scrollHeight;
            notePlace();
            return;
          }
          // With the browser's anchoring, the view has already moved; this only takes the new place,
          // or corrects a change it does not cover (it does not anchor at the very top).
          keepPlace();
        });
  /*
   * A long transcript lets the browser skip the rows away from the screen (`data-chat-flow="long"`,
   * see timeline.css). A short one draws every row: skipping saves nothing there, and each row would
   * still pay for its containment.
   */
  function markLength(): void {
    if (!list) return;
    const long = list.childElementCount > LONG_TRANSCRIPT_ROWS;
    if ((list.dataset.chatFlow === "long") !== long) {
      if (long) list.dataset.chatFlow = "long";
      else delete list.dataset.chatFlow;
    }
  }
  // Rows added or removed without a change of height still change the reader's row.
  const mutationObserver =
    typeof MutationObserver === "undefined"
      ? undefined
      : new MutationObserver(() => {
          markLength();
          keepPlace();
        });

  function itemStart(index: number): number | undefined {
    const row = rowAt(index);
    if (!row || !scroller) return undefined;
    return row.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop;
  }

  function setTop(offset: number): void {
    if (!scroller) return;
    scroller.scrollTop = Math.max(0, offset);
    notePlace();
  }

  function cancelAlign(): void {
    if (alignFrame !== undefined) cancelAnimationFrame(alignFrame);
    alignFrame = undefined;
  }

  function scrollToOffset(offset: number): void {
    cancelAlign();
    setTop(offset);
  }

  function scrollToIndex(index: number, scroll?: { smooth?: boolean; offset?: number }): void {
    cancelAlign();
    const gap = scroll?.offset ?? 0;
    const start = itemStart(index);
    if (start === undefined || !scroller) return;
    if (scroll?.smooth) {
      scroller.scrollTo({ top: start - gap, behavior: "smooth" });
      return;
    }
    setTop(start - gap);
    // The rows near the target draw at their real size once they are on the screen, and the ones
    // above it may not have been drawn before. Align again once they have.
    let frames = 2;
    const align = () => {
      alignFrame = undefined;
      const again = itemStart(index);
      if (again !== undefined && scroller && Math.abs(scroller.scrollTop - (again - gap)) >= 1) setTop(again - gap);
      if (--frames > 0) alignFrame = requestAnimationFrame(align);
    };
    alignFrame = requestAnimationFrame(align);
  }

  onCleanup(() => {
    scroller?.removeEventListener("scroll", onScroll);
    resizeObserver?.disconnect();
    mutationObserver?.disconnect();
    cancelAlign();
  });

  return {
    setScrollElement: (element) => {
      if (scroller === element) return;
      scroller?.removeEventListener("scroll", onScroll);
      scroller = element;
      if (!element) return;
      element.addEventListener("scroll", onScroll, { passive: true });
    },
    setListElement: (element) => {
      if (list === element) return;
      if (list) {
        resizeObserver?.unobserve(list);
        mutationObserver?.disconnect();
      }
      list = element;
      if (!element) return;
      resizeObserver?.observe(element);
      mutationObserver?.observe(element, { childList: true });
      markLength();
      setTotalSize(element.offsetHeight);
    },
    getTotalSize: totalSize,
    itemStart,
    scrollToIndex,
    scrollToOffset,
    notePlace,
  };
}

/* The reader is at the start of the loaded transcript when the view is at its top. */
const HISTORY_BOUNDARY_DISTANCE = 80;

/**
 * Whether the reader has reached the start of the loaded transcript, which is what asks the chat
 * for the next older page. A transcript shorter than its view is always at its start, so it loads
 * pages until it fills the view or has no more.
 */
export function chatHistoryBoundaryReached(scrollElement: HTMLElement | undefined): boolean {
  if (!scrollElement) return false;
  return scrollElement.scrollTop <= HISTORY_BOUNDARY_DISTANCE;
}
