import type { AppTextKey } from "@openbot/i18n";
import { Button, Globe2, MessageCircle } from "@openbot/ui";
import { useText } from "@openbot/ui/text";
import { Dynamic } from "@solidjs/web";
import { createSignal, For, onSettled } from "solid-js";

export type WebMobilePane = "conversation" | "workspace";

interface WebMobileNavigationProps {
  activePane: WebMobilePane;
  onChange: (pane: WebMobilePane) => void;
}

const PANES: ReadonlyArray<{
  id: WebMobilePane;
  label: AppTextKey;
  Icon: typeof MessageCircle;
}> = [
  { id: "conversation", label: "webClient.pane.chat", Icon: MessageCircle },
  { id: "workspace", label: "webClient.pane.workspace", Icon: Globe2 },
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
    viewport.addEventListener("resize", measure);
    document.addEventListener("focusout", measure);
    return () => {
      viewport.removeEventListener("resize", measure);
      document.removeEventListener("focusout", measure);
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
  return (
    <nav
      class="web-mobile-navigation"
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
              <Dynamic component={pane.Icon} aria-hidden="true" />
              <span>{t(pane.label)}</span>
            </Button>
          )}
        </For>
      </div>
    </nav>
  );
}
