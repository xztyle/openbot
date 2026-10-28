import type { JSX } from "@solidjs/web";
import { Show } from "solid-js";
import { IconButton } from "../../button";
import { ChevronLeft, X } from "../../icons";
import { useText } from "../../text";
import { cx } from "../../utils";

export interface WorkspacePaneHeaderProps {
  title: JSX.Element;
  /** A second line or a muted part after the title, such as `#general` in a thread. */
  subtitle?: JSX.Element;
  icon?: JSX.Element;
  actions?: JSX.Element;
  /** The narrow layout's back button. It shows only there. */
  onBack?: (() => void) | undefined;
  onClose?: (() => void) | undefined;
  class?: string;
}

/** The header of a workspace pane or panel: back, icon, title, actions and close. */
export function WorkspacePaneHeader(props: WorkspacePaneHeaderProps): JSX.Element {
  const { t } = useText();
  return (
    <header class={cx("ws-pane-header", props.class)}>
      <Show when={props.onBack}>
        {(back) => (
          <IconButton class="ws-phone-only" variant="ghost" label={t("workspace.layout.back")} onClick={() => back()()}>
            <ChevronLeft />
          </IconButton>
        )}
      </Show>
      <Show when={props.icon}>
        <span class="ws-pane-header-icon">{props.icon}</span>
      </Show>
      <div class="ws-pane-header-copy">
        <h2 class="ws-pane-header-title">{props.title}</h2>
        <Show when={props.subtitle}>
          <span class="ws-pane-header-subtitle">{props.subtitle}</span>
        </Show>
      </div>
      <div class="ws-pane-header-actions">
        {props.actions}
        <Show when={props.onClose}>
          {(close) => (
            <IconButton variant="ghost" label={t("common.close")} onClick={() => close()()}>
              <X />
            </IconButton>
          )}
        </Show>
      </div>
    </header>
  );
}
