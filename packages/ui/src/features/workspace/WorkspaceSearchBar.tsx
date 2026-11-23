import type { JSX } from "@solidjs/web";
import { createEffect, createMemo, createSignal, createUniqueId, Show, untrack } from "solid-js";
import { IconButton } from "../../button";
import { Listbox } from "../../complex";
import { createFieldListPress } from "../../field-list-press";
import { Input } from "../../form";
import { CircleQuestionMark, Hash, History, Lock, Search } from "../../icons";
import { Kbd } from "../../surface";
import { useText } from "../../text";
import { cx } from "../../utils";
import { AiBadge, MemberAvatar } from "./WorkspaceAvatar";
import type { WorkspaceMember } from "./workspace-types";

/** A conversation or a person that the search field offers to open while the reader types. */
export interface SearchSuggestion {
  id: string;
  label: string;
  kind: "channel" | "dm" | "agent" | "person";
  private?: boolean | undefined;
  member?: WorkspaceMember | undefined;
}

type Row =
  | { id: string; kind: "search"; text: string }
  | { id: string; kind: "recent"; text: string }
  | { id: string; kind: "suggestion"; suggestion: SearchSuggestion };

export interface WorkspaceSearchBarApi {
  /** Puts the focus in the field, with `text` when given, and opens the list. */
  focus: (text?: string) => void;
}

export interface WorkspaceSearchBarProps {
  /** "Search Acme": the field's placeholder. */
  placeholder: string;
  /** The search chord, such as ⌘G. */
  shortcut?: string | undefined;
  /** The query of the results that show, so the field holds it again. */
  query?: string | undefined;
  recent: readonly string[];
  /** Conversations and people that match the text, at most a few. */
  suggestions: (text: string) => readonly SearchSuggestion[];
  onSubmit: (query: string) => void;
  onOpenSuggestion: (id: string) => void;
  /** Opens the keyboard shortcuts. */
  onShortcuts?: (() => void) | undefined;
  shortcutsLabel?: string | undefined;
  ref?: ((api: WorkspaceSearchBarApi) => void) | undefined;
  class?: string;
}

/**
 * The search field of the workspace's top bar, as Slack's: a click or ⌘G shows the recent searches;
 * typing offers "Search for …" and the conversations and people that match. Enter searches the
 * messages. The field keeps the focus while the reader moves in the list.
 */
export function WorkspaceSearchBar(props: WorkspaceSearchBarProps): JSX.Element {
  const { t } = useText();
  const listId = createUniqueId();
  const press = createFieldListPress();
  const [open, setOpen] = createSignal(false);
  // The first value only: the effect below brings each later query.
  const [text, setText] = createSignal(untrack(() => props.query) ?? "");
  const [active, setActive] = createSignal(0);
  let input: HTMLInputElement | undefined;
  // A search that runs from elsewhere (a recent search, a filter) shows its query here.
  createEffect(
    () => props.query,
    (query) => {
      if (query !== undefined && document.activeElement !== input) setText(query);
    },
  );

  const rows = createMemo((): Row[] => {
    if (!open()) return [];
    const typed = text().trim();
    const list: Row[] = [];
    if (typed) list.push({ id: "search", kind: "search", text: typed });
    const lower = typed.toLocaleLowerCase();
    for (const query of props.recent)
      if (!typed || (query.toLocaleLowerCase().includes(lower) && query !== typed))
        list.push({ id: `recent:${query}`, kind: "recent", text: query });
    if (typed)
      for (const suggestion of props.suggestions(typed).slice(0, 6))
        list.push({ id: `open:${suggestion.id}`, kind: "suggestion", suggestion });
    return list.slice(0, 14);
  });
  const listOpen = () => open() && rows().length > 0;
  const activeValue = createMemo(() => {
    const row = rows()[active()];
    return row ? new Set([row.id]) : new Set<string>();
  });

  const close = () => {
    setOpen(false);
    setActive(0);
  };
  const choose = (row: Row) => {
    close();
    input?.blur();
    if (row.kind === "suggestion") {
      setText("");
      props.onOpenSuggestion(row.suggestion.id);
      return;
    }
    setText(row.text);
    props.onSubmit(row.text);
  };

  props.ref?.({
    focus: (value) => {
      if (value !== undefined) setText(value);
      else setText(props.query ?? text());
      setOpen(true);
      setActive(0);
      input?.focus();
      if (value !== undefined) {
        // The caret goes after the given words once they show. If the reader typed before that
        // frame, the caret stays where their words end.
        const end = value.length;
        requestAnimationFrame(() => {
          if (input?.value === value) input.setSelectionRange(end, end);
        });
      } else input?.select();
    },
  });

  const onKeyDown = (event: KeyboardEvent & { currentTarget: HTMLInputElement }) => {
    if (event.isComposing || event.keyCode === 229) return;
    const list = rows();
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (!open()) {
        setOpen(true);
        return;
      }
      if (!list.length) return;
      const step = event.key === "ArrowDown" ? 1 : -1;
      setActive((index) => (index + step + list.length) % list.length);
    } else if (event.key === "Enter") {
      event.preventDefault();
      const row = list[active()];
      if (row && open()) choose(row);
      else if (event.currentTarget.value.trim())
        choose({ id: "search", kind: "search", text: event.currentTarget.value.trim() });
    } else if (event.key === "Escape") {
      // The field's Escape closes the list, then leaves the field; the workspace does not see it.
      event.preventDefault();
      event.stopPropagation();
      if (open()) close();
      else event.currentTarget.blur();
    }
  };

  return (
    <div class={cx("ws-searchbar", props.class)} data-open={listOpen() ? "" : undefined}>
      <form class="ws-searchbar-field" onSubmit={(event) => event.preventDefault()}>
        <Search aria-hidden="true" />
        <Input
          ref={(element: HTMLInputElement) => (input = element)}
          type="text"
          role="combobox"
          autocomplete="off"
          spellcheck={false}
          aria-label={props.placeholder}
          aria-autocomplete="list"
          aria-expanded={listOpen() ? "true" : "false"}
          aria-controls={listOpen() ? listId : undefined}
          aria-activedescendant={listOpen() ? `${listId}-${active()}` : undefined}
          placeholder={props.placeholder}
          value={text()}
          onInput={(event: InputEvent & { currentTarget: HTMLInputElement }) => {
            setText(event.currentTarget.value);
            setOpen(true);
            setActive(0);
          }}
          onFocus={() => {
            setOpen(true);
            setActive(0);
          }}
          onBlur={() => {
            if (!press.pressing()) close();
          }}
          onKeyDown={onKeyDown}
        />
        <Show when={props.shortcut && !open()}>
          <Kbd class="ws-searchbar-key">{props.shortcut}</Kbd>
        </Show>
      </form>
      <Show when={props.onShortcuts}>
        {(show) => (
          <IconButton
            variant="ghost"
            class="ws-searchbar-help"
            label={props.shortcutsLabel ?? t("workspace.shortcuts.title")}
            onClick={() => show()()}
          >
            <CircleQuestionMark />
          </IconButton>
        )}
      </Show>
      <Show when={listOpen()}>
        <Listbox.Root<Row>
          as="div"
          id={listId}
          aria-label={t("workspace.search.suggestions")}
          class="ui-popover-menu-surface ws-searchbar-list"
          {...press.rootProps}
          options={rows()}
          optionValue={(row) => row.id}
          optionTextValue={(row) => (row.kind === "suggestion" ? row.suggestion.label : row.text)}
          selectionMode="single"
          disallowEmptySelection={true}
          allowDuplicateSelectionEvents={true}
          shouldUseVirtualFocus={true}
          shouldSelectOnPressUp={true}
          value={activeValue()}
          onChange={(keys) => {
            const key = keys.values().next().value;
            const row = rows().find((candidate) => candidate.id === key);
            if (row) choose(row);
          }}
          renderItem={(item) => {
            const row = item.rawValue;
            const index = () => rows().findIndex((candidate) => candidate.id === item.key);
            return (
              <Listbox.Item
                item={item}
                id={`${listId}-${index()}`}
                class="ws-searchbar-row"
                data-highlighted={index() === active() ? "" : undefined}
                onMouseMove={() => setActive(index())}
                {...press.optionProps(() => choose(row))}
              >
                <span class="ws-searchbar-glyph" aria-hidden="true">
                  {row.kind === "search" ? (
                    <Search />
                  ) : row.kind === "recent" ? (
                    <History />
                  ) : row.suggestion.member ? (
                    <MemberAvatar member={row.suggestion.member} size="xs" />
                  ) : row.suggestion.private ? (
                    <Lock />
                  ) : (
                    <Hash />
                  )}
                </span>
                <span class="ws-searchbar-label">
                  {row.kind === "search"
                    ? t("workspace.search.searchFor", { query: row.text })
                    : row.kind === "recent"
                      ? row.text
                      : row.suggestion.label}
                </span>
                <Show when={row.kind === "suggestion" && row.suggestion.kind === "agent"}>
                  <AiBadge />
                </Show>
              </Listbox.Item>
            );
          }}
        />
      </Show>
    </div>
  );
}
