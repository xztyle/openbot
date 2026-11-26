import type { JSX } from "@solidjs/web";
import { createSignal, For, getOwner, runWithOwner, Show, untrack } from "solid-js";
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
  /**
   * Read when the menu opens, with the element under the pointer or the finger (null when the
   * keyboard opened it). A message gives the items of an image, a link or a code block first. No
   * item: the browser's own menu shows.
   */
  items: (pressed: Element | null) => readonly WorkspaceMenuItem[];
  /** The accessible name of the menu. */
  label: string;
  children: JSX.Element;
  class?: string | undefined;
  /** Above the items in the phone sheet, such as a message's quick reactions. */
  sheetHeader?: ((controls: WorkspaceSheetControls) => JSX.Element) | undefined;
  /**
   * False for the menu of a whole area, such as the workspace's menu around the conversation: on a
   * touch screen a long press there lands on the message box, a button or the space between rows,
   * so it opens nothing. The area's own menu button has the same items.
   */
  longPress?: boolean | undefined;
}

/**
 * A field keeps the browser's own menu, for paste and spelling. A link and selected text get the
 * workspace menu, which offers to open, copy and quote them.
 */
const NATIVE_MENU_TARGETS = "input, textarea, select, [contenteditable=''], [contenteditable='true']";

/** A field: a press there selects text or places the caret, never the workspace menu. */
function isNativeTarget(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest(NATIVE_MENU_TARGETS) !== null;
}

function wantsNativeMenu(event: MouseEvent): boolean {
  // Shift with a right-click opens the browser's menu, with Inspect, on a computer.
  if (event.shiftKey) return true;
  if (isNativeTarget(event.target)) return true;
  // Text selected inside a field: the field's own copy and paste.
  const selection = globalThis.getSelection?.();
  return Boolean(selection && !selection.isCollapsed && isNativeTarget(selection.anchorNode?.parentElement ?? null));
}

/**
 * The right-click menu of a part of the workspace, with the same items as its "More" menu. The
 * innermost menu with items wins: the trigger stops the event. A menu with no item for the press
 * never opens: it lets the event go on to the menu around it, and when no menu has an item, the
 * browser's own menu shows. The trigger box does not take part in the layout.
 *
 * On a touch screen a long press opens the same items in a bottom sheet instead, with rows a finger
 * can hit, as Slack does on a phone. Shift+F10 or the Menu key opens it for the keyboard, at the
 * focused element.
 */
export function WorkspaceContextMenu(props: WorkspaceContextMenuProps): JSX.Element {
  const touch = usesTouchLayout();
  /*
   * The items are read in event handlers, which run outside any owner, and they hold icons: a lucide
   * icon reads a context, and a production build throws when no owner is there to read it from. That
   * error left the menu open with nothing in it. The items are read under this menu's owner, and a
   * failure reads as no item, so the menu never opens empty.
   */
  const owner = getOwner();
  const readItems = (at: Element | null): readonly WorkspaceMenuItem[] => {
    try {
      return runWithOwner(owner, () => props.items(at)) ?? [];
    } catch (error) {
      // Reported as an uncaught error is, but the right-click goes on.
      globalThis.reportError?.(error);
      return [];
    }
  };
  /** The element under the press that opens the menu. Read once, when the menu opens. */
  let pressed: Element | null = null;
  const [shown, setShown] = createSignal<readonly WorkspaceMenuItem[]>([]);
  /** Whether the menu shows. */
  let open = false;
  /**
   * A right-click for which this menu has no item. Kobalte opens a context menu on every right-click
   * and on a pen's long press, whatever it would show, so the trigger declines the press: it reads as
   * disabled while Kobalte handles it, and the menu around it takes the event.
   */
  let declined: Event | null = null;
  let declining = false;
  const decline = (event: Event) => {
    declining = event === declined;
    if (declining)
      queueMicrotask(() => {
        declining = false;
      });
  };
  const firstDanger = () => shown().findIndex((item) => item.danger);
  const [sheet, setSheet] = createSignal<{ open: boolean; itemsHidden: boolean }>({ open: false, itemsHidden: false });
  const press = createLongPress({
    enabled: () => touch && props.longPress !== false,
    onLongPress: () => {
      const items = readItems(pressed);
      if (items.length === 0) return;
      setShown(items);
      setSheet({ open: true, itemsHidden: false });
    },
  });
  const controls: WorkspaceSheetControls = {
    close: () => setSheet({ open: false, itemsHidden: false }),
    setItemsHidden: (itemsHidden) => setSheet((current) => ({ ...current, itemsHidden })),
  };
  /** The keyboard opens the menu at the focused element, with the message's items. */
  const openFromKeyboard = (event: KeyboardEvent) => {
    if (event.key !== "ContextMenu" && !(event.shiftKey && event.key === "F10")) return;
    if (isNativeTarget(event.target)) return;
    event.preventDefault();
    event.stopPropagation();
    const anchor = event.target instanceof HTMLElement ? event.target : null;
    if (!anchor) return;
    const bounds = anchor.getBoundingClientRect();
    const items = readItems(null);
    if (items.length === 0) return;
    if (touch) {
      setShown(items);
      setSheet({ open: true, itemsHidden: false });
      return;
    }
    pressed = null;
    anchor.dispatchEvent(
      new MouseEvent("contextmenu", {
        bubbles: true,
        cancelable: true,
        clientX: bounds.left + Math.min(bounds.width, 24),
        clientY: bounds.top + Math.min(bounds.height, 24),
      }),
    );
  };
  function isDeclining() {
    return declining;
  }
  return (
    <ContextMenu.Root
      onOpenChange={(next) => {
        open = next;
        if (next) setShown(readItems(pressed));
      }}
    >
      <ContextMenu.Trigger
        class={cx("ws-context-trigger", props.class)}
        // Read live while Kobalte handles the event: a declined right-click does not open this menu.
        disabled={touch || isDeclining()}
        // A long press or a double tap in the message box selects a word; it must not open the sheet.
        onPointerDown={(event: PointerEvent) => {
          if (isNativeTarget(event.target)) return;
          pressed = event.target instanceof Element ? event.target : null;
          press.onPointerDown(event);
          // Kobalte's own long press, for a pen on a computer: none for a press with no item.
          if (!touch && event.pointerType === "pen" && readItems(pressed).length === 0) declined = event;
          decline(event);
        }}
        onPointerMove={press.onPointerMove}
        onPointerUp={press.onPointerUp}
        onPointerCancel={press.onPointerCancel}
        onContextMenu={(event: MouseEvent) => {
          press.onContextMenu(event);
          // Kobalte calls this first, then reads `disabled` in the same call.
          decline(event);
        }}
        onKeyDown={openFromKeyboard}
        ref={(element: HTMLElement) =>
          // Before the trigger and the menus around it see the event, so none of them opens.
          element.addEventListener(
            "contextmenu",
            (event) => {
              if (event.isTrusted) pressed = event.target instanceof Element ? event.target : null;
              if (wantsNativeMenu(event)) {
                event.stopPropagation();
                return;
              }
              const items = readItems(pressed);
              if (items.length === 0) {
                declined = event;
                return;
              }
              // A right-click while the menu shows moves it to the new place, with that place's items.
              if (open) setShown(items);
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
            <For each={shown()} keyed={(item) => item.id}>
              {(item, index) => (
                <>
                  <Show when={index() > 0 && (item().divider || index() === firstDanger())}>
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
              items={sheet().itemsHidden ? [] : shown()}
            />
          );
        }}
      </Show>
    </ContextMenu.Root>
  );
}
