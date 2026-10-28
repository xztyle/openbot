import type { JSX } from "@solidjs/web";
import { For } from "solid-js";
import { buttonVariants } from "../../button";
import { DropdownMenu } from "../../complex";
import { cx } from "../../utils";
import type { WorkspaceMenuItem } from "./workspace-types";

export interface WorkspaceMenuProps {
  items: readonly WorkspaceMenuItem[];
  /** The accessible name of the trigger. */
  label: string;
  /** The content of the trigger, such as an icon or a name with a chevron. */
  children: JSX.Element;
  triggerClass?: string;
  placement?: "bottom-start" | "bottom-end" | "top-end";
  onOpenChange?: (open: boolean) => void;
}

/** A trigger and the menu of actions that it opens. */
export function WorkspaceMenu(props: WorkspaceMenuProps): JSX.Element {
  return (
    <DropdownMenu.Root placement={props.placement ?? "bottom-end"} gutter={4} onOpenChange={props.onOpenChange}>
      <DropdownMenu.Trigger
        class={cx(buttonVariants({ variant: "ghost", size: "icon-sm" }), props.triggerClass)}
        aria-label={props.label}
      >
        {props.children}
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content>
          <For each={props.items} keyed={(item) => item.id}>
            {(item) => (
              <DropdownMenu.Item
                class={item().danger ? "ui-action-menu-danger" : undefined}
                disabled={item().disabled}
                onSelect={() => item().onSelect()}
              >
                {item().icon}
                <span>{item().label}</span>
              </DropdownMenu.Item>
            )}
          </For>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
