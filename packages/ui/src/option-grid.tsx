import type { JSX } from "@solidjs/web";
import { omit } from "solid-js";

/**
 * A listbox whose options flow in rows, such as the cells of an emoji picker. The owner lays out
 * the rows with CSS and moves the focus with the arrow keys. One option of all the grids of a
 * picker is the tab stop (a roving tabindex), and the owner marks it `active`.
 */
export function OptionGrid(props: JSX.HTMLAttributes<HTMLDivElement>): JSX.Element {
  return <div role="listbox" {...props} />;
}

export interface OptionGridOptionProps extends JSX.ButtonHTMLAttributes<HTMLButtonElement> {
  /** The tab stop: the option that Tab goes to and that shows as selected. */
  active: boolean;
}

/**
 * One option of an `OptionGrid`. It is a native button, so it can take the focus, with no style of
 * its own: the owner's class sets all of it.
 */
export function OptionGridOption(props: OptionGridOptionProps): JSX.Element {
  const others = omit(props, "active");
  return (
    <button
      type="button"
      role="option"
      aria-selected={props.active ? "true" : "false"}
      tabindex={props.active ? 0 : -1}
      {...others}
    />
  );
}
