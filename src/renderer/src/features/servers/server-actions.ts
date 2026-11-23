import type { ServerActionCallbacks } from "@openbot/ui/features/servers/ServerActionItems";
import { useSettings } from "../settings/settings-context";
import { useServerSettings } from "./server-settings";
import { useServers } from "./servers-context";

/** What the server menu on the sidebar title does with the server that this app runs on. */
export function useServerActions() {
  const { setServerMuted, setServerNotificationLevel, hostedServerIds, hostedServersLoaded } = useServers();
  const { openServerSettings, requestLeaveServer, requestRestartServer } = useServerSettings();
  const { openHostedServerDelete } = useSettings();

  const callbacks = {
    onSetMuted: (serverId, muted, durationMs) => void setServerMuted(serverId, muted, durationMs),
    onSetNotificationLevel: (serverId, level) => void setServerNotificationLevel(serverId, level),
    onOpenSettings: openServerSettings,
    onLeave: requestLeaveServer,
    // The same confirmation: main removes an owned server from the account instead of leaving it.
    onRemove: requestLeaveServer,
    canRemove: (serverId) => hostedServersLoaded() && !hostedServerIds().has(serverId),
    onDelete: openHostedServerDelete,
    canDelete: (serverId) => hostedServerIds().has(serverId),
    onRestart: requestRestartServer,
    canRestart: (serverId) => hostedServerIds().has(serverId),
  } satisfies ServerActionCallbacks;

  return { callbacks };
}
