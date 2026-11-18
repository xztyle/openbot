import type { JSX } from "@solidjs/web";
import { Show } from "solid-js";
import { Button } from "../../button";
import { cx } from "../../utils";
import { WorkspaceContextMenu } from "./WorkspaceContextMenu";
import type { WorkspaceMenuItem } from "./workspace-types";

export interface WorkspaceListProps {
  /** The accessible name of the list, when the view header does not name it. */
  label?: string | undefined;
  class?: string | undefined;
  children: JSX.Element;
}

/** The list of a workspace view: rows with a line between them (docs/ux/standard.md § 3). */
export function WorkspaceList(props: WorkspaceListProps): JSX.Element {
  return (
    <ul class={cx("ws-list", props.class)} aria-label={props.label}>
      {props.children}
    </ul>
  );
}

export interface WorkspaceListRowProps {
  /** An avatar, a checkbox and an avatar, or an icon. */
  leading?: JSX.Element;
  /** The name of the row, in bold when the row is unread. */
  title: JSX.Element;
  /** At the end of the title line: a time, a badge. */
  titleEnd?: JSX.Element;
  /** The lines under the title: a place, a preview, a summary. */
  children?: JSX.Element;
  /** After the text: an unread dot, a count. */
  trailing?: JSX.Element;
  /**
   * Buttons of the row. A row with actions is not a button itself; it opens through one of them.
   * On a computer they show on hover and focus; on a touch screen always.
   */
  actions?: JSX.Element;
  /** The whole row opens one thing. Ignored when the row has actions. */
  onOpen?: (() => void) | undefined;
  unread?: boolean | undefined;
  selected?: boolean | undefined;
  /** The accessible name of a row that is a button, when its text alone does not say enough. */
  label?: string | undefined;
  /**
   * The actions of the row's thing: a right-click opens them on a computer, a long press in a sheet
   * on a touch screen, as the sidebar rows do.
   */
  menu?: { items: () => readonly WorkspaceMenuItem[]; label: string } | undefined;
  class?: string | undefined;
}

/**
 * One row of a workspace list. A row that opens one thing is a button over its whole width
 * (Threads, Activity, Between agents); a row with several actions keeps them at its end
 * (Space agents, Secrets).
 */
export function WorkspaceListRow(props: WorkspaceListRowProps): JSX.Element {
  const content = () => (
    <>
      <Show when={props.leading}>
        <span class="ws-row-leading">{props.leading}</span>
      </Show>
      <span class="ws-row-copy">
        <span class="ws-row-heading">
          <span class="ws-row-title">{props.title}</span>
          <Show when={props.titleEnd}>
            <span class="ws-row-title-end">{props.titleEnd}</span>
          </Show>
        </span>
        {props.children}
      </span>
      <Show when={props.trailing}>
        <span class="ws-row-trailing">{props.trailing}</span>
      </Show>
    </>
  );
  const row = () => (
    <Show
      when={!props.actions && props.onOpen}
      fallback={
        <div
          class={cx("ws-row", props.class)}
          data-unread={props.unread ? "" : undefined}
          data-selected={props.selected ? "" : undefined}
        >
          {content()}
          <Show when={props.actions}>
            <span class="ws-row-actions">{props.actions}</span>
          </Show>
        </div>
      }
    >
      {(open) => (
        <Button
          variant="ghost"
          class={cx("ws-row", props.class)}
          data-unread={props.unread ? "" : undefined}
          data-selected={props.selected ? "" : undefined}
          aria-label={props.label}
          onClick={() => open()()}
        >
          {content()}
        </Button>
      )}
    </Show>
  );
  return (
    <li class="ws-list-item">
      <Show when={props.menu} fallback={row()}>
        {(menu) => (
          <WorkspaceContextMenu items={menu().items} label={menu().label}>
            {row()}
          </WorkspaceContextMenu>
        )}
      </Show>
    </li>
  );
}
