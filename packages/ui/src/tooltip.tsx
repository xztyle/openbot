import type { TooltipRootOptions } from "@kobalte/core/tooltip";
import type { JSX } from "@solidjs/web";
import { createSignal } from "solid-js";
import { Tooltip } from "./complex";
import { cx } from "./utils";

type Side = "top" | "right" | "bottom" | "left";

export interface LabelTooltipProps {
  /** The text that names the control. */
  content: JSX.Element;
  /** The preferred side. The tooltip goes to the other side when it has no space. */
  placement?: TooltipRootOptions["placement"];
  class?: string;
  /** Keeps the tooltip closed. */
  disabled?: boolean;
  /** Contains one `LabelTooltipTrigger`. */
  children: JSX.Element;
}

/**
 * The tooltip that names a control. It opens on hover and on keyboard focus, and closes as soon as
 * the pointer leaves, a press, Escape, a scroll or the window losing the focus. One tooltip shows at
 * a time (see `Tooltip.Root`). It shows on the tooltip layer, above dialogs and menus.
 */
export function LabelTooltip(props: LabelTooltipProps): JSX.Element {
  const [side, setSide] = createSignal<Side>("top");
  return (
    <Tooltip.Root
      onCurrentPlacementChange={(placement) => {
        const [current = "top"] = placement.split("-");
        if (current === "top" || current === "right" || current === "bottom" || current === "left") {
          setSide(current);
        }
      }}
      placement={props.placement ?? "top"}
      gutter={8}
      openDelay={250}
      closeDelay={0}
      disabled={props.disabled ?? false}
    >
      {props.children}
      <Tooltip.Portal>
        <Tooltip.Content class={cx("ui-tooltip", props.class)} data-placement={side()}>
          {props.content}
        </Tooltip.Content>
      </Tooltip.Portal>
    </Tooltip.Root>
  );
}

/** The control that opens the `LabelTooltip` around it. It takes the props of `Tooltip.Trigger`. */
export const LabelTooltipTrigger: typeof Tooltip.Trigger = (props) => <Tooltip.Trigger {...props} />;
