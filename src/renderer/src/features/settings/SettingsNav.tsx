import { Button } from "@openbot/ui";
import { useText } from "@openbot/ui/text";
import { For, Show } from "solid-js";
import { SETTINGS_NAV_GROUPS, type SettingsNavItem, sameNavItem } from "./settings-nav";

/**
 * The one list of sections of the Settings page, on desktop and on the web: the account's and the
 * device's items, then the server's, under the group of what each one affects. A tap opens the item;
 * the page shows it on the right (a computer) or over the list (a phone, through `SettingsPageFrame`).
 */
export function SettingsNav(props: {
  items: readonly SettingsNavItem[];
  /** The item whose panel shows, or none while nothing is open. */
  active: Pick<SettingsNavItem, "kind" | "id"> | null;
  onSelect: (item: SettingsNavItem) => void;
  /** The server whose sections the list holds, named in the heading of its first group. */
  serverName?: string | undefined;
}) {
  const { t } = useText();
  return (
    <nav class="settings-modal-nav settings-nav" aria-label={t("settings.sections.label")}>
      <For each={SETTINGS_NAV_GROUPS}>
        {(group) => {
          const items = () => props.items.filter((item) => item.group === group.id);
          return (
            <Show when={items().length > 0}>
              {/* The heading is for the eye: each button names itself. */}
              <span class="settings-modal-nav-heading" aria-hidden="true">
                {t(group.titleKey)}
                <Show when={group.id === "workspace" && props.serverName}>
                  {(name) => <span class="settings-nav-server"> · {name()}</span>}
                </Show>
              </span>
              <For each={items()}>
                {(item) => {
                  const NavIcon = item.icon;
                  return (
                    <Button
                      variant="ghost"
                      type="button"
                      class="settings-modal-nav-item"
                      aria-current={sameNavItem(props.active, item) ? "page" : undefined}
                      onClick={() => props.onSelect(item)}
                    >
                      <NavIcon aria-hidden="true" />
                      <span>{t(item.titleKey)}</span>
                    </Button>
                  );
                }}
              </For>
            </Show>
          );
        }}
      </For>
    </nav>
  );
}
