import type { AppTextKey } from "@openbot/i18n";

// The server settings' sections and groups, apart from the modal: the workspace reads an address's
// section when it starts, and the modal is a chunk that loads when it opens.

export type ServerSettingsSection =
  | "general"
  | "vault"
  | "members"
  | "roles"
  | "workspace"
  | "desktop"
  | "mcp"
  | "storage"
  | "sites"
  | "providers"
  | "updates"
  | "backups"
  | "import"
  | "transfer"
  | "routines"
  | "browser-profiles"
  | "connectors";

/** The task groups of the navigation, in order. A group id also names its first section in an address. */
export type ServerSettingsGroup = "agents" | "connections" | "server";
/** What an opener may ask for: a section, or a group's first section. */
export type ServerSettingsTarget = ServerSettingsSection | ServerSettingsGroup;
export type ServerSettingsShortcut = "money" | "notifications" | "appearance";

/**
 * The sections by what the owner wants to do, not by how the server is built. Every section is in
 * exactly one group.
 */
export const SERVER_SETTINGS_GROUPS = [
  {
    id: "agents",
    title: "server.settings.group.agents",
    sections: ["providers", "workspace", "roles", "routines", "import"],
  },
  {
    id: "connections",
    title: "server.settings.group.connections",
    sections: ["vault", "connectors", "mcp", "browser-profiles", "sites", "desktop"],
  },
  {
    id: "server",
    title: "server.settings.group.server",
    sections: ["general", "members", "storage", "updates", "backups", "transfer"],
  },
] as const satisfies readonly {
  id: ServerSettingsGroup;
  title: AppTextKey;
  sections: readonly ServerSettingsSection[];
}[];

export function isServerSettingsSection(value: string): value is ServerSettingsSection {
  return SERVER_SETTINGS_GROUPS.some((group) => group.sections.some((section) => section === value));
}

/** Whether an address's `section` names a section or a group of the server settings. */
export function serverSettingsTargetOf(value: string | null): ServerSettingsTarget | null {
  if (!value) return null;
  if (isServerSettingsSection(value)) return value;
  return SERVER_SETTINGS_GROUPS.find((group) => group.id === value)?.id ?? null;
}
