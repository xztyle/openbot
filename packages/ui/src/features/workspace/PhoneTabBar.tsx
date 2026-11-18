import type { JSX } from "@solidjs/web";
import { For, Show } from "solid-js";
import { Button } from "../../button";
import { cx } from "../../utils";

/** One tab of the phone's bottom bar. */
export interface PhoneTab {
  id: string;
  label: string;
  icon: JSX.Element;
  /** A number on the icon, such as unread DMs. Zero shows nothing. */
  count?: number | undefined;
  /** A dot on the icon when there is no count. */
  dot?: boolean | undefined;
  /** What the count or the dot means, for a screen reader, such as "3 unread". */
  badgeLabel?: string | undefined;
}

export interface PhoneTabBarProps {
  tabs: readonly PhoneTab[];
  active: string;
  /** A tap on a tab. A tap on the tab that shows goes back to its start. */
  onSelect: (id: string) => void;
  /** The accessible name of the bar. */
  label: string;
  /** The bar steps aside, such as while the on-screen keyboard is open. */
  hidden?: boolean | undefined;
  class?: string;
}

/** The count shows up to this number. */
const MAX_COUNT = 99;

/**
 * The bottom tab bar of the phone workspace, as Slack's: Home, DMs, Activity and More. The tab that
 * shows is the current page; a tab with news has a count or a dot. It keeps clear of the home
 * indicator (the bottom safe-area inset).
 */
export function PhoneTabBar(props: PhoneTabBarProps): JSX.Element {
  return (
    <nav class={cx("ws-phone-tabs", props.class)} aria-label={props.label} hidden={props.hidden}>
      <div class="ws-phone-tabs-list">
        <For each={props.tabs} keyed={(tab) => tab.id}>
          {(tab) => {
            const active = () => props.active === tab().id;
            const count = () => Math.max(0, tab().count ?? 0);
            return (
              <Button
                variant="ghost"
                class="ws-phone-tab"
                data-active={active() ? "" : undefined}
                aria-current={active() ? "page" : undefined}
                aria-label={[tab().label, count() > 0 || tab().dot ? (tab().badgeLabel ?? "") : ""]
                  .filter(Boolean)
                  .join(", ")}
                onClick={() => props.onSelect(tab().id)}
              >
                <span class="ws-phone-tab-icon" aria-hidden="true">
                  {tab().icon}
                  <Show when={count() > 0} fallback={<Show when={tab().dot}>{<span class="ws-phone-tab-dot" />}</Show>}>
                    <span class="ws-phone-tab-count">{count() > MAX_COUNT ? `${MAX_COUNT}+` : count()}</span>
                  </Show>
                </span>
                <span class="ws-phone-tab-label" aria-hidden="true">
                  {tab().label}
                </span>
              </Button>
            );
          }}
        </For>
      </div>
    </nav>
  );
}
