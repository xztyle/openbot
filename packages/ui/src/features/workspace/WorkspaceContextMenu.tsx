import type { JSX } from "@solidjs/web";
import { For, Show } from "solid-js";
import { ContextMenu } from "../../complex";
import { cx } from "../../utils";
import type { WorkspaceMenuItem } from "./workspace-types";

export interface WorkspaceContextMenuProps {
  /** Read when the menu opens. No item: the browser's own menu shows. */
  items: () => readonly WorkspaceMenuItem[];
  /** The accessible name of the menu. */
  label: string;
  children: JSX.Element;
  class?: string | undefined;
}

/**
 * A field, a link or selected text keeps the browser's own menu, for copy, paste and spelling.
 * `currentTarget` is the trigger: a selection inside it is text the person means to copy.
 */
function wantsNativeMenu(event: MouseEvent): boolean {
  const target = event.target;
  if (
    target instanceof Element &&
    target.closest("input, textarea, select, [contenteditable=''], [contenteditable='true'], a[href]")
  )
    return true;
  const selection = globalThis.getSelection?.();
  const trigger = event.currentTarget;
  return Boolean(
    selection &&
      !selection.isCollapsed &&
      selection.toString().trim() &&
      trigger instanceof Node &&
      selection.anchorNode &&
      trigger.contains(selection.anchorNode),
  );
}

/**
 * The right-click menu of a part of the workspace, with the same items as its "More" menu. The
 * innermost menu wins: the trigger stops the event. The trigger box does not take part in the layout.
 */
export function WorkspaceContextMenu(props: WorkspaceContextMenuProps): JSX.Element {
  const firstDanger = () => props.items().findIndex((item) => item.danger);
  return (
    <ContextMenu.Root>
      <ContextMenu.Trigger
        class={cx("ws-context-trigger", props.class)}
        ref={(element: HTMLElement) =>
          // Before the trigger and the menus around it see the event, so none of them opens.
          element.addEventListener(
            "contextmenu",
            (event) => {
              if (wantsNativeMenu(event) || props.items().length === 0) event.stopPropagation();
            },
            { capture: true },
          )
        }
      >
        {props.children}
      </ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Content class="agent-context-menu" aria-label={props.label}>
          <For each={props.items()} keyed={(item) => item.id}>
            {(item, index) => (
              <>
                <Show when={index() > 0 && index() === firstDanger()}>
                  <ContextMenu.Separator />
                </Show>
                <ContextMenu.Item
                  class={item().danger ? "ui-action-menu-danger agent-context-danger" : undefined}
                  disabled={item().disabled}
                  onSelect={() => item().onSelect()}
                >
                  {item().icon}
                  <span>{item().label}</span>
                </ContextMenu.Item>
              </>
            )}
          </For>
        </ContextMenu.Content>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  );
}
