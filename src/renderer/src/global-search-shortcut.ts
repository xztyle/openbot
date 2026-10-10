import type { AppTextKey } from "@openbot/i18n";
import type { GlobalSearchShortcut } from "@openbot/ui/components/GlobalSearch";

/**
 * Cmd+K on macOS and Ctrl+K elsewhere, without Alt or Shift, opens and closes the global search. A
 * browser autofill sends a keydown with no `key`, so the key is read with care.
 */
export function isGlobalSearchShortcut(event: KeyboardEvent): boolean {
  return event.key?.toLocaleLowerCase() === "k" && (event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey;
}

type DevicePlatform = "darwin" | "win32" | "linux";

/** A chord as the platform writes it: ⌘K on macOS, Ctrl+K elsewhere. */
function chord(platform: DevicePlatform, key: string, shift = false): string {
  if (platform === "darwin") return `${shift ? "⇧" : ""}⌘${key}`;
  return `Ctrl+${shift ? "Shift+" : ""}${key}`;
}

/** The global search chord, for the hint in the sidebar search field. */
export function globalSearchShortcutLabel(platform: DevicePlatform): string {
  return chord(platform, "K");
}

/**
 * The keyboard shortcuts that this client has, for the list in the search. A shortcut shows here only
 * when code listens for it: the desktop app also has the settings and server shortcuts and the menu's
 * stop-all item, and the web client has the first and the conversation search ones.
 */
export function keyboardShortcuts(
  t: (key: AppTextKey) => string,
  platform: DevicePlatform,
  client: "desktop" | "web",
): GlobalSearchShortcut[] {
  const rows: GlobalSearchShortcut[] = [
    { id: "search", label: t("conversation.globalSearch.title"), keys: chord(platform, "K") },
  ];
  if (client === "desktop")
    rows.push({ id: "settings", label: t("conversation.globalSearch.shortcut.settings"), keys: chord(platform, ",") });
  rows.push(
    { id: "chat-search", label: t("conversation.globalSearch.shortcut.chatSearch"), keys: chord(platform, "F") },
    { id: "next", label: t("chat.search.next"), keys: chord(platform, "G") },
    { id: "previous", label: t("chat.search.previous"), keys: chord(platform, "G", true) },
  );
  if (client === "desktop")
    rows.push(
      { id: "server", label: t("conversation.globalSearch.shortcut.server"), keys: chord(platform, "1–9") },
      { id: "stop", label: t("menu.stopAllAgents"), keys: chord(platform, ".") },
    );
  return rows;
}
