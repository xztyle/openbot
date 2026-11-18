import type { AppTextKey } from "@openbot/i18n";
import { Bot, Button, MessageCircle, Workflow } from "@openbot/ui";
import { useText } from "@openbot/ui/text";
import { Dynamic } from "@solidjs/web";
import { createSignal, For, onSettled, Show } from "solid-js";

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
 * How much the visible height must shrink, with a text field focused, to count as an on-screen
 * keyboard. The browser bars of a phone change the height by less than this when they hide.
 */
const KEYBOARD_MIN_HEIGHT = 150;
/** The visible height while the keyboard is open. `web-client.css` sizes the app with it. */
const VISIBLE_HEIGHT_PROPERTY = "--web-keyboard-visible-height";

/**
 * Whether an on-screen keyboard covers the page. iOS shrinks only the visual viewport, and Android
 * with `interactive-widget=resizes-content` shrinks the layout too, so the test compares against the
 * tallest height seen at the current width instead of `innerHeight`. A new width is a rotation.
 *
 * iOS keeps the layout at full height under the keyboard and scrolls the document to the field. So
 * while the keyboard is open the app takes the visible height, and the document goes back to the top.
 */
function createKeyboardOpen() {
  const [open, setOpen] = createSignal(false);
  onSettled(() => {
    const viewport = window.visualViewport;
    if (!viewport) return;
    let width = viewport.width;
    let tallest = viewport.height;
    const measure = () => {
      if (viewport.width !== width) {
        width = viewport.width;
        tallest = viewport.height;
      }
      tallest = Math.max(tallest, viewport.height);
      const typing = document.activeElement?.matches("input, textarea, [contenteditable='true']") ?? false;
      const covered = typing && tallest - viewport.height > KEYBOARD_MIN_HEIGHT;
      setOpen(covered);
      const root = document.documentElement.style;
      if (covered) {
        root.setProperty(VISIBLE_HEIGHT_PROPERTY, `${viewport.height}px`);
        window.scrollTo(0, 0);
      } else root.removeProperty(VISIBLE_HEIGHT_PROPERTY);
    };
    /*
     * Focus can leave a field for a moment, such as when a press in its list or menu moves it and
     * the field takes it back. Giving the page its full height back at once moved the composer and
     * its list under the finger before the tap ended, so a focus change is measured a frame later.
     * A keyboard that really closes also resizes the viewport.
     */
    let focusFrame: number | undefined;
    const focusChanged = () => {
      if (focusFrame !== undefined) cancelAnimationFrame(focusFrame);
      focusFrame = requestAnimationFrame(() => {
        focusFrame = undefined;
        measure();
      });
    };
    viewport.addEventListener("resize", measure);
    document.addEventListener("focusout", focusChanged);
    return () => {
      if (focusFrame !== undefined) cancelAnimationFrame(focusFrame);
      viewport.removeEventListener("resize", measure);
      document.removeEventListener("focusout", focusChanged);
      document.documentElement.style.removeProperty(VISIBLE_HEIGHT_PROPERTY);
    };
  });
  return open;
}

/**
 * The small-screen switch for the existing workspace and conversation surfaces. It steps aside while
 * the keyboard is open, so it does not sit on the keyboard and push the composer up.
 */
export function WebMobileNavigation(props: WebMobileNavigationProps) {
  const { t } = useText();
  const keyboardOpen = createKeyboardOpen();
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
