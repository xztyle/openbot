import { Match, Switch } from "solid-js";
import type { Brand } from "./faces/agent-hue";

export interface AtelierSymbolProps {
  theme: Brand;
  class?: string;
  /** A name for screen readers. Without it the symbol is decorative. */
  label?: string;
}

/**
 * The Atelier symbol of a workspace theme: the compass A (Craft Studio), the arched door (Modern
 * Atelier) or the A with a registration dot (Riso Press). It takes its ink, its accent and its paper
 * from the theme tokens (`logo.css`), so it follows light and dark, and the sidebar of each theme.
 */
export function AtelierSymbol(props: AtelierSymbolProps) {
  return (
    <svg
      class={["atelier-symbol", props.class]}
      data-theme={props.theme}
      viewBox="0 0 64 64"
      role={props.label ? "img" : undefined}
      aria-label={props.label}
      aria-hidden={props.label ? undefined : "true"}
    >
      <Switch>
        <Match when={props.theme === "craft"}>
          <g fill="none" stroke-linecap="round" stroke-linejoin="round">
            <circle class="atelier-symbol-ink" cx="32" cy="12.5" r="5.6" stroke-width="5" />
            <path class="atelier-symbol-ink" d="M28.8 18L15.5 55.5M35.2 18L48.5 55.5" stroke-width="6.6" />
            <path class="atelier-symbol-accent" d="M19.4 41.2Q32 49.6 44.6 41.2" stroke-width="5.4" />
          </g>
        </Match>
        <Match when={props.theme === "modern"}>
          <path class="atelier-symbol-ink-fill" d="M9 58V31a23 23 0 0 1 46 0v27H41V40.5a9 9 0 0 0-18 0V58Z" />
          <path class="atelier-symbol-accent-fill" d="M23 58V40.5a9 9 0 0 1 18 0V58Z" />
        </Match>
        <Match when={props.theme === "riso"}>
          <g fill="none" stroke-linecap="round" stroke-linejoin="round">
            <path class="atelier-symbol-ink" d="M15.5 55L32 10.5L48.5 55" stroke-width="7.4" />
            <circle class="atelier-symbol-accent-fill atelier-symbol-overprint" cx="33.6" cy="40.4" r="8.2" />
            <path class="atelier-symbol-paper" d="M33.6 29.6v21.6M22.8 40.4h21.6" stroke-width="1.5" />
            <circle class="atelier-symbol-paper" cx="33.6" cy="40.4" r="4.4" stroke-width="1.5" />
          </g>
        </Match>
      </Switch>
    </svg>
  );
}
