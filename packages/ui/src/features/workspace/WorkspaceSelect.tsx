import type { JSX } from "@solidjs/web";
import { Show } from "solid-js";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../../select";
import { cx } from "../../utils";

export interface WorkspaceSelectOption<Value extends string> {
  value: Value;
  label: string;
  /** A second line under the label in the list. */
  description?: string | undefined;
}

export interface WorkspaceSelectProps<Value extends string> {
  value: Value;
  options: readonly WorkspaceSelectOption<Value>[];
  onChange: (value: Value) => void;
  /** The accessible name. */
  label: string;
  /** A visible prefix in the trigger, such as "Kind:". */
  prefix?: string | undefined;
  disabled?: boolean | undefined;
  class?: string;
}

/** A small select of text options, for filters and per-member settings. */
export function WorkspaceSelect<Value extends string>(props: WorkspaceSelectProps<Value>): JSX.Element {
  const labelOf = (value: Value) => props.options.find((option) => option.value === value)?.label ?? value;
  const descriptionOf = (value: Value) => props.options.find((option) => option.value === value)?.description;
  return (
    <Select<Value>
      class={cx("ws-select", props.class)}
      options={props.options.map((option) => option.value)}
      value={props.value}
      disabled={props.disabled}
      sameWidth={false}
      placement="bottom-start"
      onChange={(next) => {
        if (next !== null && next !== props.value) props.onChange(next);
      }}
      itemComponent={(item) => (
        <SelectItem item={item.item} class="ws-select-option">
          <span class="ws-select-option-copy">
            <span>{labelOf(item.item.rawValue)}</span>
            <Show when={descriptionOf(item.item.rawValue)}>
              {(description) => <span class="ws-select-option-description">{description()}</span>}
            </Show>
          </span>
        </SelectItem>
      )}
    >
      <SelectTrigger size="sm" class="ws-select-trigger" aria-label={props.label}>
        <Show when={props.prefix}>
          <span class="ws-select-prefix">{props.prefix}</span>
        </Show>
        <SelectValue<Value>>{(state) => labelOf(state.selectedOption() ?? props.value)}</SelectValue>
      </SelectTrigger>
      <SelectContent class="ws-select-content" />
    </Select>
  );
}
