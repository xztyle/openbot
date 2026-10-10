import { MCP_SERVERS_CAPABILITY, type ServerSummary } from "@openbot/contracts/ipc";
import { serverHasStorage } from "../files/storage-usage";
import type { ServerSettingsSection } from "./ServerSettingsModal";
import { remoteUpdateServer, serverCanAdminister, serverSupportsCapability } from "./server-capabilities";

/** Every section of the server settings dialog, in the order of its navigation. */
export const SERVER_SETTINGS_SECTIONS: readonly ServerSettingsSection[] = [
  "general",
  "members",
  "desktop",
  "mcp",
  "storage",
  "sites",
  "providers",
  "updates",
  "import",
  "routines",
  "connectors",
];

/**
 * The sections that the desktop dialog shows for the selected server `server`. It mirrors what
 * `WorkspaceOverlays` and `ServerSettingsOverlay` pass to the dialog, which shows a section only when
 * its caller supplies that section's options, so a search result never opens General instead.
 *
 * `providers` is whether the provider state of this window belongs to `server`: this computer, or the
 * joined host that the account administers over `providers-v1`.
 */
export function availableServerSettingsSections(
  server: ServerSummary,
  options: { platform: "darwin" | "win32" | "linux" | undefined; providers: boolean },
): ServerSettingsSection[] {
  return SERVER_SETTINGS_SECTIONS.filter((section) => hasSection(server, section, options));
}

function hasSection(
  server: ServerSummary,
  section: ServerSettingsSection,
  options: { platform: "darwin" | "win32" | "linux" | undefined; providers: boolean },
): boolean {
  switch (section) {
    case "general":
    case "members":
      return true;
    case "desktop":
      return options.platform === "darwin";
    case "mcp":
      return serverCanAdminister(server, MCP_SERVERS_CAPABILITY);
    case "storage":
      return serverHasStorage(server);
    case "sites":
      return serverSupportsCapability(server, "hosted-sites-v1");
    case "providers":
      return options.providers;
    case "updates":
      return remoteUpdateServer(server) !== undefined;
    case "import":
      return serverSupportsCapability(server, "agent-import-v1");
    // The feed and the connectors belong to this computer.
    case "routines":
    case "connectors":
      return server.kind === "local";
  }
}
