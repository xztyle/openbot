import { createMemo, createSignal, onCleanup, untrack } from "solid-js";

/**
 * The rows of a chat transcript in the normal flow of the page: each row is a block below the one
 * before it, so a row can never be drawn over another, whatever its height or however late it
 * grows.
 *
 * A long transcript draws only a window of its rows: the rows in the view and a few screens above
 * and below it. In place of the rows above and below the window, an empty block in the flow (a
 * spacer, see `spaceBefore` and `spaceAfter`) is as tall as those rows were when they were last
 * drawn. A row that was never drawn counts with the mean height of the drawn rows. As the reader
 * scrolls, the window moves with the view. So the page holds about the same number of elements for
 * a chat of 300 messages and one of 5,000, and a key press, a scroll frame or a streamed token costs
 * the same in both. A short transcript draws every row.
 *
 * Without a list of keys (`keys`), the flow draws every row, and in a long transcript the browser
 * skips the layout and paint of the rows away from the screen (`content-visibility: auto` on
 * `.chat-flow-row`).
 *
 * This keeps the reader's place when rows change above the view (an older page loads, a row above
 * grows, the window moves): the browser's own scroll anchoring does it where there is one; Safari has
 * none, so the flow moves the view by the change itself. Each row carries `data-index` (its place
 * in `keys`) and `data-row-key` (its message).
 */
export interface ChatFlow {
  /** The scroll container. */
  setScrollElement: (element: HTMLElement | undefined) => void;
  /** The element whose children are the rows. */
  setListElement: (element: HTMLElement | undefined) => void;
  /** The height of the rows, which changes as rows render, grow and load. */
  getTotalSize: () => number;
  /**
   * Where a row starts in the scroll content. A row out of the window starts where its spacer puts
   * it. Undefined when the row is not in the transcript.
   */
  itemStart: (index: number) => number | undefined;
  /**
   * Opens a row at the top of the view, or `offset` px below it. A smooth scroll animates there.
   * Until a later scroll by the code, it aligns the row again for a few frames, as rows near it draw.
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
  /** The keys of the rows to draw, in order: the window of `keys`, or all of them. */
  rowKeys: () => readonly string[];
  /** The height of the rows above the window, which the list holds as an empty block before the rows. */
  spaceBefore: () => number;
  /** The height of the rows below the window, which the list holds as an empty block after the rows. */
  spaceAfter: () => number;
}

/** From this many rows on, the browser skips the rows away from the screen. */
const LONG_TRANSCRIPT_ROWS = 60;
/** A transcript with more rows than this draws a window of them. */
const WINDOW_FROM_ROWS = 160;
/** The rows drawn on each side of the view. */
const OVERSCAN_ROWS = 50;
/** The window moves when fewer drawn rows than this are left on a side of the view. */
const MARGIN_ROWS = 15;
/** The rows a long transcript draws first, at its end, before it knows where the reader is. */
const FIRST_WINDOW_ROWS = 40;
/** The most rows the window adds in a frame, on each side. */
const STEP_ROWS = 8;
/** The height of a row that was never drawn, before any row was. */
const ROW_ESTIMATE_PX = 96;
/** The frames a jump aligns its row again, as the rows near it draw. */
const ALIGN_FRAMES = 4;

interface Place {
  key: string;
  /** The row's top, from the top of the view. */
  offset: number;
  /** The scroll position when the place was taken: a different one means someone scrolled since. */
  scrollTop: number;
}

/** The rows a window asks for, by their keys, so a page that loads above does not move it. */
interface WindowRequest {
  start: string;
  end: string;
}

/** The drawn rows: indices into the keys, both included. */
interface DrawnWindow {
  start: number;
  end: number;
  count: number;
  startKey: string | undefined;
  endKey: string | undefined;
  request: WindowRequest | null;
}

export function createChatFlow(options: {
  /** Whether the reader follows the newest message: the transcript's own code keeps them at the end. */
  following: () => boolean;
  /** Every row key of the transcript, in order. With it, a long transcript draws a window of its rows. */
  keys?: () => readonly string[];
  /** While true, every row is drawn, such as while a search reads the text of every row. */
  drawAll?: () => boolean;
}): ChatFlow {
  let scroller: HTMLElement | undefined;
  let list: HTMLElement | undefined;
  let place: Place | undefined;
  /**
   * The place was taken just before the rows changed (`ChatFlow.notePlace`), and the view has not been
   * put back on it yet. A later read of the place would take the changed rows' place instead.
   */
  let placeHeld = false;
  let alignFrame: number | undefined;
  let updateFrame: number | undefined;
  /** The frames `update` waited for the page to draw the window it asked for. */
  let waitedFrames = 0;
  /** The window still grows toward the screens above and below the view. */
  let growing = false;
  let listWidth = 0;
  const [totalSize, setTotalSize] = createSignal(0);

  // The height each row took when it was last drawn, by key, with the gap to the next row.
  const heights = new Map<string, number>();
  let measuredSum = 0;
  const [measured, setMeasured] = createSignal(0);
  const [request, setRequest] = createSignal<WindowRequest | null>(null);

  const allKeys = (): readonly string[] => options.keys?.() ?? [];
  const keyIndex = createMemo(() => new Map(allKeys().map((key, index) => [key, index])));
  const estimate = (): number => (heights.size > 0 ? measuredSum / heights.size : ROW_ESTIMATE_PX);
  /** `prefix[i]` is the height of the rows before row `i`, from their measured or estimated heights. */
  const prefix = createMemo(() => {
    measured();
    const keys = allKeys();
    const sums = new Float64Array(keys.length + 1);
    const guess = estimate();
    keys.forEach((key, index) => {
      sums[index + 1] = (sums[index] ?? 0) + (heights.get(key) ?? guess);
    });
    return sums;
  });

  const drawnWindow = createMemo<DrawnWindow>((previous) => {
    const keys = allKeys();
    const count = keys.length;
    const asked = request();
    if (!options.keys || count <= WINDOW_FROM_ROWS || options.drawAll?.())
      return { start: 0, end: count - 1, count, startKey: keys[0], endKey: keys.at(-1), request: asked };
    const index = keyIndex();
    const base =
      asked ?? (previous?.startKey && previous.endKey ? { start: previous.startKey, end: previous.endKey } : null);
    let start: number;
    let end: number;
    if (!base) {
      end = count - 1;
      start = Math.max(0, count - FIRST_WINDOW_ROWS);
    } else {
      start = index.get(base.start) ?? Math.min(previous?.start ?? 0, count - 1);
      end = index.get(base.end) ?? Math.min(previous?.end ?? count - 1, count - 1);
      // The rows changed and nobody asked for another window: a window at an edge of the transcript
      // keeps the rows that load or arrive at that edge, where the reader is.
      if (previous && previous.request === asked) {
        if (previous.start === 0) start = 0;
        if (previous.end === previous.count - 1) end = count - 1;
      }
    }
    if (end < start) end = Math.min(count - 1, start + FIRST_WINDOW_ROWS);
    return { start, end, count, startKey: keys[start], endKey: keys[end], request: asked };
  });

  const rowKeys = createMemo<readonly string[]>((previous) => {
    const keys = allKeys();
    const { start, end } = drawnWindow();
    if (start === 0 && end === keys.length - 1) return keys;
    const next = keys.slice(start, end + 1);
    if (previous && previous.length === next.length && previous.every((key, index) => key === next[index]))
      return previous;
    return next;
  });
  const spaceBefore = createMemo(() => prefix()[drawnWindow().start] ?? 0);
  const spaceAfter = createMemo(() => {
    const sums = prefix();
    const { end, count } = drawnWindow();
    return Math.max(0, (sums[count] ?? 0) - (sums[end + 1] ?? 0));
  });
  const windowed = (): boolean => {
    const { start, end, count } = untrack(drawnWindow);
    return start > 0 || end < count - 1;
  };

  // The drawn rows, read again after the list changes.
  let drawnCache: HTMLElement[] | undefined;
  const rows = (): HTMLElement[] => {
    if (!list) return [];
    if (!drawnCache)
      drawnCache = [...list.children].filter(
        (child): child is HTMLElement => child instanceof HTMLElement && child.dataset.rowKey !== undefined,
      );
    return drawnCache;
  };

  const rowAt = (index: number): HTMLElement | undefined => {
    const current = untrack(drawnWindow);
    // A row out of the window is not in the page.
    if (index < current.start || index > current.end) return undefined;
    const guess = rows()[index - current.start];
    if (guess?.isConnected && guess.dataset.index === String(index)) return guess;
    return list?.querySelector<HTMLElement>(`:scope > [data-index="${index}"]`) ?? undefined;
  };

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
    placeHeld = false;
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

  /** The place before a change of the rows: it stays until the view is put back on it. */
  function holdPlace(): void {
    notePlace();
    placeHeld = place !== undefined;
  }

  /**
   * Keeps the height of each drawn row with the gap to the next one, for its spacer when it leaves
   * the window. One layout for all of them.
   */
  function measureDrawn(): void {
    const drawn = rows();
    let changed = false;
    drawn.forEach((row, index) => {
      const key = row.dataset.rowKey;
      if (!key || !row.offsetParent) return;
      const next = drawn[index + 1];
      const height = next?.offsetParent ? next.offsetTop - row.offsetTop : row.offsetHeight;
      if (height < 0) return;
      const before = heights.get(key);
      if (before === height) return;
      measuredSum += height - (before ?? 0);
      heights.set(key, height);
      changed = true;
    });
    if (changed) setMeasured((value) => value + 1);
  }

  /** The keys of the rows from `first` to `last` around the view, as a window. */
  function ask(first: number, last: number): void {
    const keys = untrack(allKeys);
    const start = keys[Math.max(0, first)];
    const end = keys[Math.min(keys.length - 1, last)];
    if (start !== undefined && end !== undefined) setRequest({ start, end });
  }

  /**
   * The rows in the view, as indices into the keys: from the drawn rows, or from the spacers' heights
   * when the view is in a spacer, such as after a drag of the scroll bar.
   */
  function viewRows(drawn: HTMLElement[], current: DrawnWindow): { first: number; last: number } | undefined {
    if (!scroller || !list) return undefined;
    const top = scroller.getBoundingClientRect().top - list.getBoundingClientRect().top;
    const bottom = top + scroller.clientHeight;
    const sums = untrack(prefix);
    const firstRow = drawn[0];
    const lastRow = drawn.at(-1);
    const drawnTop = firstRow ? firstRow.offsetTop : (sums[current.start] ?? 0);
    const drawnBottom = lastRow ? lastRow.offsetTop + lastRow.offsetHeight : drawnTop;
    // A place in the transcript, from the drawn rows or the spacers, to the index of its row.
    const rowAtOffset = (offset: number): number => {
      if (offset < drawnTop) {
        // The spacer before the window: rows 0 to start - 1 end at their prefix sums.
        let low = 0;
        let high = current.start - 1;
        let found = Math.max(0, current.start - 1);
        while (low <= high) {
          const middle = (low + high) >> 1;
          if ((sums[middle + 1] ?? 0) > offset) {
            found = middle;
            high = middle - 1;
          } else low = middle + 1;
        }
        return found;
      }
      if (offset >= drawnBottom) {
        const base = sums[current.end + 1] ?? 0;
        let low = current.end + 1;
        let high = current.count - 1;
        let found = current.count - 1;
        while (low <= high) {
          const middle = (low + high) >> 1;
          if (drawnBottom + (sums[middle + 1] ?? 0) - base > offset) {
            found = middle;
            high = middle - 1;
          } else low = middle + 1;
        }
        return found;
      }
      let low = 0;
      let high = drawn.length - 1;
      let found = drawn.length - 1;
      while (low <= high) {
        const middle = (low + high) >> 1;
        const row = drawn[middle];
        if (row && row.offsetTop + row.offsetHeight > offset) {
          found = middle;
          high = middle - 1;
        } else low = middle + 1;
      }
      return Number(drawn[found]?.dataset.index ?? current.start + found);
    };
    return { first: rowAtOffset(top), last: rowAtOffset(Math.max(top, bottom - 1)) };
  }

  /** Moves the window with the view when the view nears an edge of it, or when it holds too many rows. */
  function update(): void {
    updateFrame = undefined;
    if (!scroller || !list || !options.keys) return;
    const current = untrack(drawnWindow);
    if (current.count <= WINDOW_FROM_ROWS || untrack(() => options.drawAll?.())) return;
    const drawn = rows();
    // The page has not drawn the window asked for yet: wait for it, a few frames at most.
    const keys = untrack(allKeys);
    if (drawn[0]?.dataset.rowKey !== keys[current.start] && waitedFrames < 3) {
      waitedFrames += 1;
      schedule();
      return;
    }
    waitedFrames = 0;
    const last = current.count - 1;
    const following = options.following();
    // The rows above the view may have changed since the place was taken, such as a page that loaded
    // into the space above: the view goes back to the reader's row before it says which rows to draw.
    // This frame's callbacks run before the resize observer that would do it.
    if (!following) keepPlace();
    /*
     * A reader who follows the newest message has the window at the end, with the screens above it:
     * nothing to read from the page. A streamed reply moves the view each frame, and a read of the
     * view's place would lay the page out before the frame's own layout.
     */
    if (following && current.end === last && !growing) {
      const size = current.end - current.start + 1;
      if (size >= OVERSCAN_ROWS && size <= 2 * (OVERSCAN_ROWS + MARGIN_ROWS)) return;
    }
    const view = viewRows(drawn, current);
    if (!view) return;
    const wantStart = Math.max(0, view.first - OVERSCAN_ROWS);
    const wantEnd = following ? last : Math.min(last, view.last + OVERSCAN_ROWS);
    const needStart = Math.max(0, view.first - MARGIN_ROWS);
    const needEnd = following ? last : Math.min(last, view.last + MARGIN_ROWS);
    const most = view.last - view.first + 1 + 2 * (OVERSCAN_ROWS + MARGIN_ROWS);
    const enough = current.start <= needStart && current.end >= needEnd && current.end - current.start + 1 <= most;
    if (enough && !growing) return;
    /*
     * A row costs a few milliseconds to draw, so the window grows by a few rows a frame, from the
     * side of the view, until it holds the screens above and below. Rows leave at once: that is
     * cheap. A view away from the drawn rows, such as after a drag of the scroll bar, draws the
     * rows in it first.
     */
    let start = wantStart;
    let end = wantEnd;
    if (view.last >= current.start && view.first <= current.end) {
      if (start < current.start) start = Math.max(start, current.start - STEP_ROWS);
      if (end > current.end) end = Math.min(end, current.end + STEP_ROWS);
    } else {
      start = Math.max(start, view.first - STEP_ROWS);
      end = Math.min(end, view.last + STEP_ROWS);
    }
    growing = start !== wantStart || end !== wantEnd;
    if (start !== current.start || end !== current.end) {
      measureDrawn();
      ask(start, end);
    }
    if (growing) schedule();
  }

  function schedule(): void {
    if (updateFrame !== undefined || !options.keys) return;
    updateFrame = requestAnimationFrame(update);
  }

  /*
   * The place is taken once a frame, before the frame's own changes, not on each scroll event: a
   * reply that streams scrolls the view for each word, and each read of a row's box lays the page
   * out again. A reader who follows the newest message needs no place.
   */
  let placeFrame: number | undefined;
  const onScroll = () => {
    placeFrame ??= requestAnimationFrame(() => {
      placeFrame = undefined;
      if (options.following()) place = undefined;
      // The rows changed after the place was held: the view goes back on it first.
      else if (placeHeld) keepPlace();
      else notePlace();
    });
    schedule();
  };
  // Each change of the rows' height: a row rendered, grew or loaded. It runs after layout and
  // before paint, so a correction is never seen.
  const resizeObserver =
    typeof ResizeObserver === "undefined"
      ? undefined
      : new ResizeObserver(() => {
          if (!list) return;
          setTotalSize(list.offsetHeight);
          // A new width wraps every row again: the heights of the rows out of the window are old.
          const width = list.clientWidth;
          if (width !== listWidth) {
            if (listWidth !== 0 && heights.size > 0) {
              heights.clear();
              measuredSum = 0;
              setMeasured((value) => value + 1);
            }
            listWidth = width;
          }
          schedule();
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
   * A long transcript without a window lets the browser skip the rows away from the screen
   * (`data-chat-flow="long"`, see timeline.css). A short one draws every row: skipping saves nothing
   * there, and each row would still pay for its containment. A window draws few rows, each at its
   * real size, so the spacers get the heights the rows really have.
   */
  function markLength(): void {
    if (!list) return;
    const long = !options.keys && list.childElementCount > LONG_TRANSCRIPT_ROWS;
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
          drawnCache = undefined;
          markLength();
          keepPlace();
          schedule();
        });

  function itemStart(index: number): number | undefined {
    if (!scroller || !list) return undefined;
    const row = rowAt(index);
    if (row) return row.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop;
    const current = untrack(drawnWindow);
    if (index < 0 || index >= current.count || !windowed()) return undefined;
    const sums = untrack(prefix);
    const listTop = list.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop;
    if (index < current.start) return listTop + (sums[index] ?? 0);
    if (index > current.end)
      return listTop + list.offsetHeight - untrack(spaceAfter) + (sums[index] ?? 0) - (sums[current.end + 1] ?? 0);
    return undefined;
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
    // A row out of the window: the window moves to it first. The row starts where the spacers put
    // it until it draws; the alignment below then puts it in its place.
    const current = untrack(drawnWindow);
    if (options.keys && windowed() && (index - MARGIN_ROWS < current.start || index + MARGIN_ROWS > current.end)) {
      measureDrawn();
      // The rows at the target first; the window grows from there, a few rows a frame.
      ask(index - STEP_ROWS, index + 3 * STEP_ROWS);
      growing = true;
    }
    const start = itemStart(index);
    if (start === undefined || !scroller) return;
    if (scroll?.smooth) {
      scroller.scrollTo({ top: start - gap, behavior: "smooth" });
      return;
    }
    setTop(start - gap);
    // The rows near the target draw at their real size once they are on the screen, and the ones
    // above it may not have been drawn before. Align again once they have.
    let frames = ALIGN_FRAMES;
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
    if (updateFrame !== undefined) cancelAnimationFrame(updateFrame);
    if (placeFrame !== undefined) cancelAnimationFrame(placeFrame);
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
      drawnCache = undefined;
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
    notePlace: holdPlace,
    rowKeys,
    spaceBefore,
    spaceAfter,
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
