import type { AppTextKey } from "@openbot/i18n";
import { Bot, Button, MessageCircle, Workflow } from "@openbot/ui";
import { useText } from "@openbot/ui/text";
import { Dynamic } from "@solidjs/web";
import { For, Show } from "solid-js";
import { createWebVisualViewport } from "./web-visual-viewport";

export type WebMobilePane = "conversation" | "workspace";

interface WebMobileNavigationProps {
  activePane: WebMobilePane;
  /** The workspace has its own back buttons, so the switch steps aside. */
  hidden?: boolean;
  /** The Routines view is on: the conversation pane shows the routine canvas. */
  routines?: boolean;
  onChange: (pane: WebMobilePane) => void;
  /** The agents that need the user or have a new reply. The Agents tab shows a dot while there is one. */
  attentionCount?: number;
}

interface PaneButton {
  id: WebMobilePane;
  label: AppTextKey;
  Icon: typeof MessageCircle;
}

const PANES: ReadonlyArray<PaneButton> = [
  { id: "conversation", label: "webClient.pane.chat", Icon: MessageCircle },
  { id: "workspace", label: "webClient.pane.agents", Icon: Bot },
];

/**
 * The small-screen switch for the existing workspace and conversation surfaces. It steps aside while
 * the keyboard is open, so it does not sit on the keyboard and push the composer up.
 */
export function WebMobileNavigation(props: WebMobileNavigationProps) {
  const { t } = useText();
  const keyboardOpen = createWebVisualViewport();
  const shown = (pane: PaneButton): PaneButton =>
    pane.id === "conversation" && props.routines ? { ...pane, label: "webClient.pane.routines", Icon: Workflow } : pane;
  return (
    <nav
      class="web-mobile-navigation"
      hidden={props.hidden}
      aria-label={t("webClient.pane.navigation")}
      data-keyboard-open={keyboardOpen() ? "true" : undefined}
    >
      <div class="web-mobile-navigation-list">
        <For each={PANES}>
          {(pane) => (
            <Button
              variant="ghost"
              type="button"
              class="web-mobile-navigation-button"
              data-active={props.activePane === pane.id ? "true" : undefined}
              aria-pressed={props.activePane === pane.id ? "true" : "false"}
              onClick={() => props.onChange(pane.id)}
            >
              <Dynamic component={shown(pane).Icon} aria-hidden="true" />
              <span>{t(shown(pane).label)}</span>
              <Show when={pane.id === "workspace" && (props.attentionCount ?? 0) > 0}>
                <span
                  class="web-mobile-navigation-dot"
                  role="img"
                  aria-label={t("webClient.pane.agentsAttention", { count: props.attentionCount ?? 0 })}
                />
              </Show>
            </Button>
          )}
        </For>
      </div>
    </nav>
  );
}
