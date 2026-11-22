import type { JSX } from "@solidjs/web";
import { For, Show } from "solid-js";
import { Button } from "./button";
import { Dialog } from "./complex";
import { sheetDragToDismiss } from "./sheet-drag";
import { cx } from "./utils";

export interface ActionSheetItem {
  id: string;
  label: string;
  icon?: JSX.Element;
  /** Red, and after a divider when it follows other items. */
  danger?: boolean | undefined;
  disabled?: boolean | undefined;
  onSelect: () => void;
}

export interface ActionSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The accessible name of the sheet, such as "Message actions". */
  title: string;
  /** Shows the title as a heading. Without it the title is for screen readers only. */
  showTitle?: boolean | undefined;
  /** Above the items, such as a row of quick reactions. */
  header?: JSX.Element;
  items: readonly ActionSheetItem[];
  class?: string | undefined;
}

/**
 * The phone form of a menu: a sheet that rises from the bottom edge, with rows a finger can hit.
 * It is a modal dialog on the overlay layer, so a dialog that one of its items opens stacks above
 * it. An item closes the sheet first, then runs. A tap on the backdrop, a drag down or Escape closes it.
 */
export function ActionSheet(props: ActionSheetProps): JSX.Element {
  const firstDanger = () => props.items.findIndex((item) => item.danger);
  return (
    <Dialog.Root open={props.open} onOpenChange={props.onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay class="ui-sheet-overlay">
          <Dialog.Content class={cx("ui-sheet", props.class)} ref={sheetDragToDismiss(() => props.onOpenChange(false))}>
            <span class="ui-sheet-handle" aria-hidden="true" />
            <Dialog.Title class={props.showTitle ? "ui-sheet-title" : "sr-only"}>{props.title}</Dialog.Title>
            <Show when={props.header}>
              <div class="ui-sheet-header">{props.header}</div>
            </Show>
            <Show when={props.items.length > 0}>
              <ul class="ui-sheet-items">
                <For each={props.items} keyed={(item) => item.id}>
                  {(item, index) => (
                    <li
                      class="ui-sheet-item-row"
                      data-divided={index() > 0 && index() === firstDanger() ? "" : undefined}
                    >
                      <Button
                        variant="ghost"
                        class="ui-sheet-item"
                        data-danger={item().danger ? "" : undefined}
                        disabled={item().disabled}
                        onClick={() => {
                          const action = item().onSelect;
                          props.onOpenChange(false);
                          action();
                        }}
                      >
                        {item().icon}
                        <span>{item().label}</span>
                      </Button>
                    </li>
                  )}
                </For>
              </ul>
            </Show>
          </Dialog.Content>
        </Dialog.Overlay>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
