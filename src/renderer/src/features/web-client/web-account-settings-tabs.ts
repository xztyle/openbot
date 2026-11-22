// The tabs of the account settings, apart from the page itself, which loads on demand.

export const WEB_ACCOUNT_SETTINGS_TABS = ["profile", "appearance", "notifications"] as const;
export type WebAccountSettingsTab = (typeof WEB_ACCOUNT_SETTINGS_TABS)[number];

/**
 * The tab that an address's `section` names. `preferences` is the one tab that held both the look and
 * the notifications before they split, so old links open the look.
 */
export function webAccountSettingsTabOf(section: string | null): WebAccountSettingsTab | null {
  if (section === "preferences") return "appearance";
  return WEB_ACCOUNT_SETTINGS_TABS.find((tab) => tab === section) ?? null;
}

/** Where the other settings tasks live: the settings of the open server, or its Trust view. */
export type WebAccountSettingsShortcut = "agents" | "money" | "connections" | "server";
