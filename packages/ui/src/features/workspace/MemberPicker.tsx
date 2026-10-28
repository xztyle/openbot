import type { JSX } from "@solidjs/web";
import { createSignal, For, Show } from "solid-js";
import { Button, IconButton } from "../../button";
import { Input } from "../../form";
import { Check, Search, X } from "../../icons";
import { useText } from "../../text";
import { cx } from "../../utils";
import { AiBadge, MemberAvatar } from "./WorkspaceAvatar";
import type { WorkspaceMember } from "./workspace-types";

export interface MemberPickerProps {
  candidates: readonly WorkspaceMember[];
  selectedIds: readonly string[];
  onChange: (ids: string[]) => void;
  /** The most members that can be chosen. */
  max?: number | undefined;
  /** The accessible name of the search field. */
  label: string;
  /** Moves focus to the search field when the picker opens. */
  autofocus?: boolean | undefined;
  class?: string;
}

/** Search, chosen chips, and the people and agents to choose from. */
export function MemberPicker(props: MemberPickerProps): JSX.Element {
  const { t } = useText();
  const [query, setQuery] = createSignal("");
  const selected = () => new Set(props.selectedIds);
  const chosen = () => props.selectedIds.flatMap((id) => props.candidates.filter((member) => member.id === id));
  const matches = () => {
    const text = query().trim().toLocaleLowerCase();
    return text
      ? props.candidates.filter((member) => member.name.toLocaleLowerCase().includes(text))
      : props.candidates;
  };
  const humans = () => matches().filter((member) => member.kind === "human");
  const agents = () => matches().filter((member) => member.kind === "agent");
  const full = () => props.max !== undefined && props.selectedIds.length >= props.max;
  const toggle = (id: string) => {
    if (selected().has(id)) props.onChange(props.selectedIds.filter((current) => current !== id));
    else if (!full()) props.onChange([...props.selectedIds, id]);
  };
  const row = (member: WorkspaceMember) => (
    <li>
      <Button
        variant="ghost"
        class="ws-picker-row"
        aria-pressed={selected().has(member.id) ? "true" : "false"}
        disabled={!selected().has(member.id) && full()}
        onClick={() => toggle(member.id)}
      >
        <MemberAvatar member={member} size="sm" showStatus />
        <span class="ws-picker-name">{member.name}</span>
        <Show when={member.kind === "agent"}>
          <AiBadge />
        </Show>
        <span class="ws-picker-check" aria-hidden="true">
          <Show when={selected().has(member.id)}>
            <Check />
          </Show>
        </span>
      </Button>
    </li>
  );
  return (
    <div class={cx("ws-picker", props.class)}>
      <div class="ws-picker-field">
        <Search class="ws-picker-search-icon" aria-hidden="true" />
        <For each={chosen()} keyed={(member) => member.id}>
          {(member) => (
            <span class="ws-picker-chip">
              <MemberAvatar member={member()} size="xs" />
              {member().name}
              <IconButton
                variant="ghost"
                size="icon-xs"
                class="ws-picker-chip-remove"
                label={t("workspace.picker.remove", { name: member().name })}
                onClick={() => toggle(member().id)}
              >
                <X />
              </IconButton>
            </span>
          )}
        </For>
        <Input
          ref={(element) => {
            if (props.autofocus) requestAnimationFrame(() => element.focus());
          }}
          class="ws-picker-input"
          size="sm"
          value={query()}
          aria-label={props.label}
          placeholder={t("workspace.picker.placeholder")}
          onValueChange={setQuery}
          onKeyDown={(event: KeyboardEvent) => {
            if (event.key === "Backspace" && query() === "" && props.selectedIds.length > 0) {
              props.onChange(props.selectedIds.slice(0, -1));
            }
          }}
        />
      </div>
      <Show when={full()}>
        <p class="ws-picker-note">{t("workspace.picker.full", { count: props.max ?? 0 })}</p>
      </Show>
      <div class="ws-picker-list">
        <Show when={humans().length > 0}>
          <h3 class="ws-picker-heading">{t("workspace.picker.people")}</h3>
          <ul>
            <For each={humans()}>{(member) => row(member)}</For>
          </ul>
        </Show>
        <Show when={agents().length > 0}>
          <h3 class="ws-picker-heading">{t("workspace.picker.agents")}</h3>
          <ul>
            <For each={agents()}>{(member) => row(member)}</For>
          </ul>
        </Show>
        <Show when={matches().length === 0}>
          <p class="ws-picker-note">{t("workspace.picker.noMatch", { query: query().trim() })}</p>
        </Show>
      </div>
    </div>
  );
}
