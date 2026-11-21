import type { JSX } from "@solidjs/web";
import { createEffect, createSignal, onSettled, Show, untrack } from "solid-js";
import { Button } from "../../button";
import { ChevronDown } from "../../icons";
import { useText } from "../../text";

/** How many lines a long message shows while it is folded, as Slack's long posts. */
const FOLDED_LINES = 6;
/** Blocks that a fold never cuts through: it ends above them. */
const UNCUT_BLOCKS = ".message-code-block, .message-data-table-frame, .message-markdown-table-scroll, pre, table";

/** The messages that the reader opened or folded in this session, by id. */
const chosen = new Map<string, boolean>();

export interface LongMessageFoldProps {
  /** The message, so the reader's choice holds while the app runs. */
  id: string;
  /** Whether this message may fold: an agent's message to people, not a question or a card. */
  enabled: boolean;
  /** The text still streams in. A message the reader watched stream folds only once it is out of view. */
  live: boolean;
  children: JSX.Element;
}

/**
 * A long message of an agent, folded to its first lines with a fade and "Show more", as Slack folds
 * long posts. The fold ends above a code block or a table instead of inside it. "Show less" folds it
 * again and keeps the button where the reader's eyes are.
 */
export function LongMessageFold(props: LongMessageFoldProps): JSX.Element {
  // Most rows never fold: they get no observers and no wrappers.
  return (
    <Show when={props.enabled} fallback={props.children}>
      <FoldedText {...props} />
    </Show>
  );
}

function FoldedText(props: LongMessageFoldProps): JSX.Element {
  const { t } = useText();
  let body: HTMLDivElement | undefined;
  let inner: HTMLDivElement | undefined;
  let toggle: HTMLDivElement | undefined;
  /** The text runs past the fold, so it folds and shows "Show more". */
  const [long, setLong] = createSignal(false);
  /**
   * Open or folded. A message that the reader watched stream in starts open and folds once it leaves
   * the view; the reader's own choice holds for the session.
   */
  const id = untrack(() => props.id);
  const [open, setOpen] = createSignal(chosen.get(id) ?? untrack(() => props.live));
  const closed = () => !open() && !props.live;
  const foldable = () => !props.live && long();
  const folded = () => foldable() && !open();
  /*
   * A closed message always takes the same height, short or long, measured or not: a change of its
   * `max-height` would stop the browser from keeping the reader's place for that frame (scroll
   * anchoring) while the rows around take their real size.
   */
  const maxHeight = () => (closed() ? `${FOLDED_LINES}lh` : undefined);

  function measure() {
    if (!body || !inner) return;
    // A row that the browser skips (`content-visibility`) has no layout yet.
    const height = inner.scrollHeight;
    if (height === 0) return;
    const style = getComputedStyle(body);
    const line = Number.parseFloat(style.lineHeight) || Number.parseFloat(style.fontSize) * 1.46 || 20;
    const limit = line * FOLDED_LINES;
    const isLong = height > limit + 1;
    setLong(isLong);
    // A code block or a table that crosses the fold does not show cut: it hides, and the fold ends
    // above it. Its place stays, so the height of the fold does not change.
    const top = inner.getBoundingClientRect().top;
    for (const block of inner.querySelectorAll<HTMLElement>(UNCUT_BLOCKS)) {
      const box = block.getBoundingClientRect();
      // A block that opens the message is cut as text: hidden, the fold would show nothing.
      const crosses = box.top - top >= line * 0.75 && box.top - top < limit && box.bottom - top > limit;
      // Only a change is written: a write makes the next row's read lay the page out again.
      if (crosses !== (block.dataset.foldHidden !== undefined)) {
        if (crosses) block.dataset.foldHidden = "";
        else delete block.dataset.foldHidden;
      }
    }
  }

  // A message that stops streaming is measured again. The first measure is the resize observer's:
  // it runs after the layout of the frame, for all the rows that drew in it, so a page of rows that
  // draws at once costs one layout, not one for each row.
  let live = untrack(() => props.live);
  createEffect(
    () => props.live,
    (streaming) => {
      const ended = live && !streaming;
      live = streaming;
      if (ended) measure();
    },
  );

  onSettled(() => {
    if (!inner || !body) return;
    const resize = new ResizeObserver(() => measure());
    resize.observe(inner);
    // A message that streamed in while the reader followed it folds once it leaves the view.
    const view = new IntersectionObserver((entries) => {
      if (entries.some((entry) => !entry.isIntersecting) && !live && !chosen.has(id)) setOpen(false);
    });
    view.observe(body);
    return () => {
      resize.disconnect();
      view.disconnect();
    };
  });

  /**
   * Opens or folds it. "Show more" keeps the top of the text in place, so the reader reads on below.
   * "Show less" keeps the button where it was on screen, so the reader stays at the message.
   */
  function flip() {
    const next = !open();
    const anchor = next ? body : toggle;
    const before = anchor?.getBoundingClientRect().top;
    chosen.set(id, next);
    setOpen(next);
    if (before === undefined) return;
    requestAnimationFrame(() => {
      const after = anchor?.getBoundingClientRect().top;
      const scroller = scrollParent(anchor);
      if (after !== undefined && scroller) scroller.scrollTop += after - before;
    });
  }

  return (
    <div class="ws-fold" data-folded={folded() ? "" : undefined}>
      <div ref={body} class="ws-fold-body" style={maxHeight() ? { "max-height": maxHeight() } : undefined}>
        <div ref={inner}>{props.children}</div>
      </div>
      <Show when={foldable()}>
        <div ref={toggle} class="ws-fold-actions">
          <Button
            variant="link"
            size="xs"
            class="ws-fold-toggle"
            aria-expanded={folded() ? "false" : "true"}
            onClick={flip}
          >
            {t(folded() ? "workspace.message.showMore" : "workspace.message.showLess")}
            <ChevronDown class="ws-fold-chevron" aria-hidden="true" />
          </Button>
        </div>
      </Show>
    </div>
  );
}

function scrollParent(element: HTMLElement | undefined): HTMLElement | null {
  for (let node = element?.parentElement; node; node = node.parentElement) {
    const overflow = getComputedStyle(node).overflowY;
    if ((overflow === "auto" || overflow === "scroll") && node.scrollHeight > node.clientHeight) return node;
  }
  return null;
}
