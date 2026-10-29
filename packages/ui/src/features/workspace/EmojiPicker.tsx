import type { AppTextKey } from "@openbot/i18n";
import type { ComponentProps, JSX } from "@solidjs/web";
import { createMemo, createSignal, createUniqueId, For, flush, onSettled, Show } from "solid-js";
import { Button, buttonVariants, IconButton } from "../../button";
import { Popover } from "../../complex";
import { Input } from "../../form";
import { Clock3, Search } from "../../icons";
import { OptionGrid, OptionGridOption } from "../../option-grid";
import { useText } from "../../text";
import { cx } from "../../utils";
import {
  EMOJI_CATEGORIES,
  type EmojiCategoryId,
  type EmojiEntry,
  findEmoji,
  SKIN_TONES,
  searchEmoji,
  withSkinTone,
} from "./emoji-data";

/** The options in one grid row. The stylesheet uses the same count. */
const COLUMNS = 9;
/** Three rows of recent emoji, as Slack shows. */
const RECENT_LIMIT = COLUMNS * 3;
const SEARCH_LIMIT = 200;
/** How far outside the scroll view a section starts to render, in pixels. */
const RENDER_MARGIN = "240px 0px";

type BrowseSectionId = EmojiCategoryId | "recent";
type SectionId = BrowseSectionId | "search";

const SECTION_LABEL = {
  recent: "workspace.emoji.category.recent",
  people: "workspace.emoji.category.people",
  nature: "workspace.emoji.category.nature",
  food: "workspace.emoji.category.food",
  activity: "workspace.emoji.category.activity",
  travel: "workspace.emoji.category.travel",
  objects: "workspace.emoji.category.objects",
  symbols: "workspace.emoji.category.symbols",
  flags: "workspace.emoji.category.flags",
} as const satisfies Record<BrowseSectionId, AppTextKey>;

/** The name of each skin tone, by the index in `SKIN_TONES`. */
const TONE_LABEL = [
  "workspace.emoji.tone.default",
  "workspace.emoji.tone.light",
  "workspace.emoji.tone.mediumLight",
  "workspace.emoji.tone.medium",
  "workspace.emoji.tone.mediumDark",
  "workspace.emoji.tone.dark",
] as const satisfies readonly AppTextKey[];

/** The hand that shows each skin tone on the tone buttons. */
const TONE_HAND: EmojiEntry = { e: "✋", n: "raised hand", s: 1 };

interface PickerCell {
  readonly entry: EmojiEntry;
  readonly index: number;
  /** `section:index`, the roving tab stop key. */
  readonly key: string;
}

interface PickerSection<Id extends SectionId = SectionId> {
  readonly id: Id;
  readonly icon?: string | undefined;
  readonly entries: readonly EmojiEntry[];
  readonly cells: readonly PickerCell[];
  /** The rows that the cells take in the grid. */
  readonly rowCount: number;
}

function pickerSection<Id extends SectionId>(id: Id, entries: readonly EmojiEntry[], icon?: string): PickerSection<Id> {
  const cells = entries.map((entry, index) => ({ entry, index, key: `${id}:${index}` }));
  return { id, icon, entries, cells, rowCount: Math.ceil(entries.length / COLUMNS) };
}

// The category sections never change, so they are built once, when a picker first opens.
let categorySections: readonly PickerSection<EmojiCategoryId>[] | undefined;
function categories(): readonly PickerSection<EmojiCategoryId>[] {
  categorySections ??= EMOJI_CATEGORIES.map((category) => pickerSection(category.id, category.emoji, category.icon));
  return categorySections;
}

interface GridPosition {
  readonly section: number;
  readonly index: number;
}

/** The cell that an arrow key moves to. Up and down keep the column across section edges. */
function nextPosition(sections: readonly PickerSection[], from: GridPosition, key: string): GridPosition | undefined {
  const length = sections[from.section]?.entries.length ?? 0;
  const before = sections[from.section - 1]?.entries.length ?? 0;
  const after = sections[from.section + 1]?.entries.length ?? 0;
  const column = from.index % COLUMNS;
  const rowStart = (count: number) => count - 1 - ((count - 1) % COLUMNS);
  switch (key) {
    case "ArrowRight":
      if (from.index + 1 < length) return { section: from.section, index: from.index + 1 };
      return after > 0 ? { section: from.section + 1, index: 0 } : undefined;
    case "ArrowLeft":
      if (from.index > 0) return { section: from.section, index: from.index - 1 };
      return before > 0 ? { section: from.section - 1, index: before - 1 } : undefined;
    case "ArrowDown":
      if (from.index + COLUMNS < length) return { section: from.section, index: from.index + COLUMNS };
      // The last row is short: go to its last cell.
      if (from.index < rowStart(length)) return { section: from.section, index: length - 1 };
      return after > 0 ? { section: from.section + 1, index: Math.min(column, after - 1) } : undefined;
    case "ArrowUp":
      if (from.index >= COLUMNS) return { section: from.section, index: from.index - COLUMNS };
      return before > 0
        ? { section: from.section - 1, index: Math.min(rowStart(before) + column, before - 1) }
        : undefined;
    default:
      return undefined;
  }
}

function isTextKey(event: KeyboardEvent): boolean {
  return event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey;
}

export interface EmojiPickerProps {
  /** Called with the emoji, with the skin tone applied where the emoji takes one. */
  onPick: (emoji: string) => void;
  /** The emoji the reader used last, most recent first. They show as they are, with their own tone. */
  recent?: readonly string[] | undefined;
  /** 0 is no modifier; 1 to 5 go from light to dark. */
  skinTone?: number | undefined;
  /** Shows the skin tone control. */
  onSkinToneChange?: ((tone: number) => void) | undefined;
  /** Moves focus to the search field when the picker opens. */
  autofocus?: boolean | undefined;
  class?: string | undefined;
}

/**
 * The full emoji picker: search, category tabs, the emoji grid and a preview of the emoji under the
 * pointer or focus. The first sections render at once and the others when they scroll near the
 * view, so opening the picker does not build all of its cells.
 */
export function EmojiPicker(props: EmojiPickerProps): JSX.Element {
  const { t } = useText();
  const baseId = createUniqueId();
  const [query, setQuery] = createSignal("");
  const [rendered, setRendered] = createSignal<ReadonlySet<string>>(
    new Set<string>(["recent", EMOJI_CATEGORIES[0]?.id ?? "people"]),
  );
  const [active, setActive] = createSignal<string | undefined>();
  const [preview, setPreview] = createSignal<{ entry: EmojiEntry; emoji: string } | undefined>();
  const [current, setCurrent] = createSignal<BrowseSectionId | undefined>();
  const [toneOpen, setToneOpen] = createSignal(false);
  let scroller: HTMLDivElement | undefined;
  let searchField: HTMLInputElement | undefined;
  let toneBar: HTMLDivElement | undefined;

  const tone = () => props.skinTone ?? 0;
  const searching = createMemo(() => query().trim().length > 0);
  const recentSection = createMemo(() => {
    const recent = props.recent?.slice(0, RECENT_LIMIT) ?? [];
    return recent.length > 0
      ? pickerSection(
          "recent",
          recent.map((emoji) => ({ e: emoji, n: findEmoji(emoji)?.n ?? emoji })),
        )
      : undefined;
  });
  const sections = createMemo((): readonly PickerSection<BrowseSectionId>[] => {
    const recent = recentSection();
    return recent ? [recent, ...categories()] : categories();
  });
  const results = createMemo(() => pickerSection("search", searching() ? searchEmoji(query(), SEARCH_LIMIT) : []));
  /** The sections that the arrow keys move through: the results while searching. */
  const navSections = (): readonly PickerSection[] => (searching() ? [results()] : sections());
  /** The one cell with tabindex 0: the active cell, else the first cell. */
  const tabStop = createMemo(() => {
    const key = active();
    const nav = navSections();
    const inView = key !== undefined && nav.some((section) => key.startsWith(`${section.id}:`));
    return inView ? key : nav[0]?.cells[0]?.key;
  });
  const shown = (entry: EmojiEntry) => withSkinTone(entry, tone());

  // A section renders when its placeholder comes near the view. Without IntersectionObserver (a test
  // DOM), every section renders.
  let observer: IntersectionObserver | undefined;
  const waiting = new Set<HTMLElement>();
  const reveal = (ids: readonly string[]) => {
    if (ids.every((id) => rendered().has(id))) return;
    setRendered((previous) => new Set([...previous, ...ids]));
  };
  const observe = (element: HTMLElement) => {
    if (observer) observer.observe(element);
    else waiting.add(element);
  };
  const unobserve = (element: HTMLElement) => {
    waiting.delete(element);
    observer?.unobserve(element);
  };
  onSettled(() => {
    if (typeof IntersectionObserver === "undefined") {
      reveal(EMOJI_CATEGORIES.map((category) => category.id));
      return;
    }
    observer = new IntersectionObserver(
      (entries) => {
        const ids = entries.flatMap((entry) =>
          entry.isIntersecting && entry.target instanceof HTMLElement && entry.target.dataset.section
            ? [entry.target.dataset.section]
            : [],
        );
        if (ids.length > 0) reveal(ids);
      },
      { root: scroller ?? null, rootMargin: RENDER_MARGIN },
    );
    for (const element of waiting) observer.observe(element);
    waiting.clear();
    return () => observer?.disconnect();
  });

  const cellAt = (target: EventTarget | null) => {
    const cell = target instanceof Element ? target.closest<HTMLElement>("[data-emoji-cell]") : null;
    if (!cell) return undefined;
    const nav = navSections();
    const section = nav.findIndex((item) => item.id === cell.dataset.section);
    const index = Number(cell.dataset.index);
    const entry = nav[section]?.entries[index];
    return entry ? { cell, entry, position: { section, index } } : undefined;
  };

  const pick = (entry: EmojiEntry) => props.onPick(shown(entry));

  const focusCell = (position: GridPosition) => {
    const section = navSections()[position.section];
    if (!section || !scroller) return;
    if (!rendered().has(section.id)) {
      reveal([section.id]);
      flush();
    }
    const cell = scroller.querySelector<HTMLElement>(
      `[data-section="${section.id}"][data-index="${String(position.index)}"]`,
    );
    if (!cell) return;
    cell.focus({ preventScroll: true });
    cell.scrollIntoView({ block: "nearest" });
  };

  const jump = (id: BrowseSectionId) => {
    setQuery("");
    reveal([id]);
    flush();
    const section = scroller?.querySelector<HTMLElement>(`[data-emoji-section="${id}"]`);
    if (scroller && section) scroller.scrollTop = section.offsetTop;
    setCurrent(id);
  };

  // The tab of the section at the top of the view lights up while the grid scrolls.
  let scrollFrame: number | undefined;
  const onScroll = () => {
    if (scrollFrame !== undefined) return;
    scrollFrame = requestAnimationFrame(() => {
      scrollFrame = undefined;
      if (!scroller) return;
      const top = scroller.scrollTop + 1;
      let id: string | undefined;
      for (const section of scroller.querySelectorAll<HTMLElement>("[data-emoji-section]")) {
        if (section.offsetTop <= top) id = section.dataset.emojiSection;
      }
      setCurrent(sections().find((section) => section.id === id)?.id);
    });
  };

  // The tone buttons replace the toggle, so focus moves with them.
  const showTones = (open: boolean) => {
    setToneOpen(open);
    flush();
    toneBar?.querySelector<HTMLElement>(open ? '[aria-pressed="true"]' : "button")?.focus();
  };

  const onGridKeyDown = (event: KeyboardEvent) => {
    const hit = cellAt(event.target);
    if (!hit) return;
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      pick(hit.entry);
      return;
    }
    if (isTextKey(event) || event.key === "Backspace") {
      // Typing in the grid goes on in the search field.
      event.preventDefault();
      setQuery((text) => (event.key === "Backspace" ? text.slice(0, -1) : text + event.key));
      searchField?.focus();
      return;
    }
    if (event.key === "Home" || event.key === "End") {
      // The first or the last emoji of the section; with Ctrl or Cmd, of the whole picker.
      event.preventDefault();
      const nav = navSections();
      const whole = event.ctrlKey || event.metaKey;
      const section = whole ? (event.key === "Home" ? 0 : nav.length - 1) : hit.position.section;
      const length = nav[section]?.entries.length ?? 0;
      if (length > 0) focusCell({ section, index: event.key === "Home" ? 0 : length - 1 });
      return;
    }
    if (!event.key.startsWith("Arrow")) return;
    event.preventDefault();
    const next = nextPosition(navSections(), hit.position, event.key);
    if (next) focusCell(next);
    else if (event.key === "ArrowUp") searchField?.focus();
  };

  const onSearchKeyDown = (event: KeyboardEvent) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      focusCell({ section: 0, index: 0 });
    } else if (event.key === "Enter" && searching()) {
      event.preventDefault();
      const first = results().entries[0];
      if (first) pick(first);
    }
  };

  const showPreview = (target: EventTarget | null) => {
    const hit = cellAt(target);
    if (hit) setPreview({ entry: hit.entry, emoji: hit.cell.textContent ?? hit.entry.e });
  };

  // A listbox per section, with one tab stop over all of them. An option is a plain button with the
  // cell style rather than a kit button, and the grid handles click, keys and focus for all of its options.
  const grid = (section: PickerSection, label: { labelledBy?: string; label?: string }) => (
    <OptionGrid
      class="ws-emoji-grid"
      aria-labelledby={label.labelledBy}
      aria-label={label.label}
      onClick={(event) => {
        const hit = cellAt(event.target);
        if (hit) pick(hit.entry);
      }}
      onKeyDown={onGridKeyDown}
      onFocusIn={(event) => {
        const hit = cellAt(event.target);
        if (!hit) return;
        setActive(`${section.id}:${String(hit.position.index)}`);
        showPreview(event.target);
      }}
      onPointerOver={(event) => showPreview(event.target)}
    >
      <For each={section.cells}>
        {(cell) => (
          <OptionGridOption
            class="ws-emoji-cell"
            data-emoji-cell=""
            data-section={section.id}
            data-index={cell.index}
            active={tabStop() === cell.key}
            aria-label={cell.entry.n}
          >
            {cell.entry.s ? shown(cell.entry) : cell.entry.e}
          </OptionGridOption>
        )}
      </For>
    </OptionGrid>
  );

  /** What a screen reader hears after the query changes. */
  const resultStatus = () => {
    const count = results().entries.length;
    return count > 0
      ? t("workspace.emoji.resultCount", { count })
      : t("workspace.emoji.noResults", { query: query().trim() });
  };

  return (
    <div class={cx("ws-emoji-picker", props.class)}>
      <div class="ws-emoji-search">
        <Search class="ws-emoji-search-icon" aria-hidden="true" />
        <Input
          ref={(element) => {
            searchField = element;
            if (props.autofocus) requestAnimationFrame(() => element.focus());
          }}
          type="search"
          class="ws-emoji-search-input"
          size="sm"
          value={query()}
          aria-label={t("workspace.emoji.search")}
          placeholder={t("workspace.emoji.searchPlaceholder")}
          onValueChange={setQuery}
          onKeyDown={onSearchKeyDown}
        />
      </div>
      <p class="sr-only" aria-live="polite">
        <Show when={searching()}>{resultStatus()}</Show>
      </p>
      <div class="ws-emoji-tabs" role="toolbar" aria-label={t("workspace.emoji.categories")}>
        <For each={sections()}>
          {(section) => (
            <IconButton
              variant="ghost"
              size="icon-sm"
              class="ws-emoji-tab"
              label={t(SECTION_LABEL[section.id])}
              aria-current={!searching() && current() === section.id ? "true" : undefined}
              onClick={() => jump(section.id)}
            >
              <Show when={section.icon} fallback={<Clock3 aria-hidden="true" />}>
                {(icon) => <span aria-hidden="true">{icon()}</span>}
              </Show>
            </IconButton>
          )}
        </For>
      </div>
      <div ref={(element) => (scroller = element)} class="ws-emoji-scroll" onScroll={onScroll}>
        <Show when={searching()}>
          <Show
            when={results().entries.length > 0}
            fallback={<p class="ws-emoji-empty">{t("workspace.emoji.noResults", { query: query().trim() })}</p>}
          >
            {grid(results(), { label: t("workspace.emoji.results") })}
          </Show>
        </Show>
        <div class="ws-emoji-sections" hidden={searching()}>
          <For each={sections()}>
            {(section) => (
              <section class="ws-emoji-section" data-emoji-section={section.id}>
                <h3 id={`${baseId}-${section.id}`} class="ws-emoji-heading">
                  {t(SECTION_LABEL[section.id])}
                </h3>
                <Show
                  when={rendered().has(section.id)}
                  fallback={
                    <SectionPlaceholder
                      section={section.id}
                      rows={section.rowCount}
                      observe={observe}
                      unobserve={unobserve}
                    />
                  }
                >
                  {grid(section, { labelledBy: `${baseId}-${section.id}` })}
                </Show>
              </section>
            )}
          </For>
        </div>
      </div>
      <div class="ws-emoji-footer">
        <div class="ws-emoji-preview" aria-hidden="true">
          <Show
            when={preview()}
            fallback={<span class="ws-emoji-preview-hint">{t("workspace.emoji.previewHint")}</span>}
          >
            {(item) => (
              <>
                <span class="ws-emoji-preview-glyph">{item().emoji}</span>
                <span class="ws-emoji-preview-name">{item().entry.n}</span>
              </>
            )}
          </Show>
        </div>
        <Show when={props.onSkinToneChange}>
          {(change) => (
            <div
              ref={(element) => (toneBar = element)}
              class="ws-emoji-tones"
              role="toolbar"
              aria-label={t("workspace.emoji.skinTone")}
            >
              <Show
                when={toneOpen()}
                fallback={
                  <IconButton
                    variant="ghost"
                    size="icon-sm"
                    class="ws-emoji-tone"
                    label={t("workspace.emoji.skinTone")}
                    aria-expanded="false"
                    onClick={() => showTones(true)}
                  >
                    <span aria-hidden="true">{withSkinTone(TONE_HAND, tone())}</span>
                  </IconButton>
                }
              >
                <For each={SKIN_TONES}>
                  {(_modifier, index) => (
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      class="ws-emoji-tone"
                      aria-label={t(TONE_LABEL[index()] ?? "workspace.emoji.tone.default")}
                      aria-pressed={tone() === index() ? "true" : "false"}
                      onClick={() => {
                        change()(index());
                        showTones(false);
                      }}
                    >
                      {withSkinTone(TONE_HAND, index())}
                    </Button>
                  )}
                </For>
              </Show>
            </div>
          )}
        </Show>
      </div>
    </div>
  );
}

/** Holds the height of a section that has not rendered yet, and tells the picker when it comes near the view. */
function SectionPlaceholder(props: {
  section: string;
  rows: number;
  observe: (element: HTMLElement) => void;
  unobserve: (element: HTMLElement) => void;
}): JSX.Element {
  let element: HTMLDivElement | undefined;
  onSettled(() => {
    const target = element;
    if (!target) return;
    props.observe(target);
    return () => props.unobserve(target);
  });
  return (
    <div
      ref={(node) => (element = node)}
      class="ws-emoji-placeholder"
      data-section={props.section}
      style={{ "--ws-emoji-rows": String(props.rows) }}
    />
  );
}

type PopoverPlacement = ComponentProps<typeof Popover.Root>["placement"];

export interface EmojiPickerPopoverProps extends EmojiPickerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The content of the trigger button, such as an icon. */
  trigger: JSX.Element;
  /** The accessible name and tooltip of the trigger. */
  triggerLabel: string;
  triggerClass?: string | undefined;
  placement?: PopoverPlacement | undefined;
}

/** A trigger button and the emoji picker that it opens. A pick closes the popover. */
export function EmojiPickerPopover(props: EmojiPickerPopoverProps): JSX.Element {
  const { t } = useText();
  return (
    <Popover.Root
      open={props.open}
      onOpenChange={props.onOpenChange}
      placement={props.placement ?? "top-end"}
      gutter={4}
    >
      <Popover.Trigger
        class={cx(buttonVariants({ variant: "ghost", size: "icon-sm" }), "ui-icon-button", props.triggerClass)}
        aria-label={props.triggerLabel}
        title={props.triggerLabel}
      >
        {props.trigger}
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content class="ui-popover-menu-surface ws-emoji-popover" aria-label={t("workspace.emoji.label")}>
          <Show when={props.open}>
            <EmojiPicker
              onPick={(emoji) => {
                props.onPick(emoji);
                props.onOpenChange(false);
              }}
              recent={props.recent}
              skinTone={props.skinTone}
              onSkinToneChange={props.onSkinToneChange}
              autofocus={props.autofocus ?? true}
              class={props.class}
            />
          </Show>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
