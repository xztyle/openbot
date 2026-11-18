import type { JSX } from "@solidjs/web";
import { For, Show } from "solid-js";
import { Button } from "./button";
import { TriangleAlert } from "./icons";
import { Skeleton } from "./surface";
import { useText } from "./text";
import { cx } from "./utils";

export interface EmptyStateProps {
  /** A Lucide icon for the kind of thing the view lists. */
  icon?: JSX.Element;
  /** What is missing: "No secrets yet", "No matches". */
  title: JSX.Element;
  /** One sentence that says what fills the view or how to change the filter. */
  description?: JSX.Element;
  /** The action that fills the view, such as "Add agent", or "Clear filters". */
  action?: JSX.Element;
  /** `compact` inside a card or a panel; `default` fills a view. */
  size?: "default" | "compact";
  class?: string;
}

/** A view with nothing to show. See `docs/ux/standard.md`. */
export function EmptyState(props: EmptyStateProps): JSX.Element {
  return (
    <div class={cx("ui-view-state", props.class)} data-size={props.size ?? "default"}>
      <Show when={props.icon}>
        <span class="ui-view-state-icon" aria-hidden="true">
          {props.icon}
        </span>
      </Show>
      <p class="ui-view-state-title">{props.title}</p>
      <Show when={props.description}>
        <p class="ui-view-state-text">{props.description}</p>
      </Show>
      <Show when={props.action}>
        <div class="ui-view-state-actions">{props.action}</div>
      </Show>
    </div>
  );
}

export interface ErrorStateProps {
  /** What could not load: "Couldn't load the secrets". */
  title: JSX.Element;
  /** The reason, in the reader's language. */
  description?: JSX.Element;
  /** Shows a Retry button. */
  onRetry?: (() => void) | undefined;
  /** The retry runs. */
  retrying?: boolean;
  size?: "default" | "compact";
  class?: string;
}

/** A view whose data could not load, with Retry. See `docs/ux/standard.md`. */
export function ErrorState(props: ErrorStateProps): JSX.Element {
  const { t } = useText();
  return (
    <div class={cx("ui-view-state", props.class)} data-size={props.size ?? "default"} data-tone="danger" role="alert">
      <span class="ui-view-state-icon" aria-hidden="true">
        <TriangleAlert />
      </span>
      <p class="ui-view-state-title">{props.title}</p>
      <Show when={props.description}>
        <p class="ui-view-state-text">{props.description}</p>
      </Show>
      <Show when={props.onRetry}>
        {(retry) => (
          <div class="ui-view-state-actions">
            <Button variant="secondary" size="sm" loading={props.retrying} onClick={() => retry()()}>
              {t("common.retry")}
            </Button>
          </div>
        )}
      </Show>
    </div>
  );
}

export interface LoadingStateProps {
  /** How many placeholder rows. */
  rows?: number;
  /** The accessible name of the busy region. */
  label?: string;
  class?: string;
}

/** Placeholder rows while a list loads. See `docs/ux/standard.md`. */
export function LoadingState(props: LoadingStateProps): JSX.Element {
  const { t } = useText();
  const rows = () => Array.from({ length: props.rows ?? 4 }, (_, index) => index);
  return (
    <div
      class={cx("ui-view-state-skeleton", props.class)}
      role="status"
      aria-busy="true"
      aria-label={props.label ?? t("common.loading")}
    >
      <For each={rows()}>
        {() => (
          <div class="ui-view-state-skeleton-row">
            <Skeleton class="ui-view-state-skeleton-avatar" />
            <div class="ui-view-state-skeleton-lines">
              <Skeleton class="ui-view-state-skeleton-line" />
              <Skeleton class="ui-view-state-skeleton-line" />
            </div>
          </div>
        )}
      </For>
    </div>
  );
}
