import type { JSX } from "@solidjs/web";
import { createSignal, For, Show, untrack } from "solid-js";
import { ActionSheet } from "../../action-sheet";
import { ContextMenu } from "../../complex";
import { createLongPress } from "../../long-press";
import { cx, usesTouchLayout } from "../../utils";
import type { WorkspaceMenuItem } from "./workspace-types";

/** What the sheet's header can do: close the sheet, or hide the items for a larger view. */
export interface WorkspaceSheetControls {
  close: () => void;
  setItemsHidden: (hidden: boolean) => void;
}

export interface WorkspaceContextMenuProps {
  /** Read when the menu opens. No item: the browser's own menu shows. */
  items: () => readonly WorkspaceMenuItem[];
  /** The accessible name of the menu. */
  label: string;
  children: JSX.Element;
  class?: string | undefined;
  /** Above the items in the phone sheet, such as a message's quick reactions. */
  sheetHeader?: ((controls: WorkspaceSheetControls) => JSX.Element) | undefined;
}

/**
 * A field, a link or selected text keeps the browser's own menu, for copy, paste and spelling.
 * `currentTarget` is the trigger: a selection inside it is text the person means to copy.
 */
const NATIVE_MENU_TARGETS = "input, textarea, select, [contenteditable=''], [contenteditable='true'], a[href]";

/** A field or a link: a press there selects text or opens the link, never the workspace menu. */
function isNativeTarget(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest(NATIVE_MENU_TARGETS) !== null;
}

function wantsNativeMenu(event: MouseEvent): boolean {
  if (isNativeTarget(event.target)) return true;
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
 *
 * On a touch screen a long press opens the same items in a bottom sheet instead, with rows a finger
 * can hit, as Slack does on a phone.
 */
export function WorkspaceContextMenu(props: WorkspaceContextMenuProps): JSX.Element {
  const firstDanger = () => props.items().findIndex((item) => item.danger);
  const touch = usesTouchLayout();
  const [sheet, setSheet] = createSignal<{ open: boolean; itemsHidden: boolean }>({ open: false, itemsHidden: false });
  const press = createLongPress({
    enabled: () => touch && props.items().length > 0,
    onLongPress: () => setSheet({ open: true, itemsHidden: false }),
  });
  const controls: WorkspaceSheetControls = {
    close: () => setSheet({ open: false, itemsHidden: false }),
    setItemsHidden: (itemsHidden) => setSheet((current) => ({ ...current, itemsHidden })),
  };
  return (
    <ContextMenu.Root>
      <ContextMenu.Trigger
        class={cx("ws-context-trigger", props.class)}
        disabled={touch}
        // A long press or a double tap in the message box selects a word; it must not open the sheet.
        onPointerDown={(event: PointerEvent) => {
          if (!isNativeTarget(event.target)) press.onPointerDown(event);
        }}
        onPointerMove={press.onPointerMove}
        onPointerUp={press.onPointerUp}
        onPointerCancel={press.onPointerCancel}
        onContextMenu={press.onContextMenu}
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
      <Show when={!touch}>
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
      </Show>
      <Show when={touch && sheet().open}>
        {(_) => {
          // Built once per opening: the header keeps its own state, such as the full emoji list.
          const header = untrack(() => props.sheetHeader?.(controls));
          return (
            <ActionSheet
              open
              onOpenChange={(open) => {
                if (!open) controls.close();
              }}
              title={props.label}
              header={header}
              items={sheet().itemsHidden ? [] : props.items()}
            />
          );
        }}
      </Show>
    </ContextMenu.Root>
  );
}
