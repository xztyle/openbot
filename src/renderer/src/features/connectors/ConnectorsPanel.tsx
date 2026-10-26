import { ConnectorDetailPanel, connectorSummary } from "@openbot/ui/features/connectors/ConnectorDetailPanel";
import { CONNECTOR_LISTINGS } from "@openbot/ui/features/connectors/connector-catalog";
import type { ConnectorId } from "@openbot/ui/features/connectors/connectors";
import { IntegrationsHub, type IntegrationsHubRow } from "@openbot/ui/features/settings/IntegrationsHub";
import { useText } from "@openbot/ui/text";
import { createEffect, createSignal, Show } from "solid-js";
import type { ConnectorEntry, ConnectorRegistry } from "./connector-registry";

/** The integration page on screen, so the dialog header reads `Connectors › GitHub`. */
export interface ConnectorsPanelDetail {
  title: string;
  back: () => void;
}

/**
 * Server settings > Connectors: the list of the server's connectors, and the page of the one the
 * user opens. A connector that only this computer can run shows on a joined server with no action.
 * `hostName` names a joined server.
 */
export function ConnectorsPanel(props: {
  connectors: ConnectorRegistry;
  hostName?: string | undefined;
  /** Reports the open integration page, so the header shows a breadcrumb instead of a back row. */
  onDetailChange?: (detail: ConnectorsPanelDetail | null) => void;
}) {
  const { t } = useText();
  const [view, setView] = createSignal<ConnectorId | null>(null);
  /** The controller of the page on screen: the hub shows when the server can no longer reach it. */
  const page = () => {
    const open = view();
    if (open === null) return undefined;
    const entry = props.connectors.get(open);
    return entry.access === "available" ? entry.controller : undefined;
  };
  // The dialog outlives this panel, so the cleanup clears a header that would name a page that is gone.
  createEffect(
    () => {
      const open = page();
      return open ? t(CONNECTOR_LISTINGS[open.id].title) : null;
    },
    (title) => {
      if (title === null) return;
      props.onDetailChange?.({ title, back: () => setView(null) });
      return () => props.onDetailChange?.(null);
    },
  );
  // Some states change with no event from main, so each available connector is followed while the
  // section shows. A new server gives new controllers, and the effect follows them.
  createEffect(
    () => props.connectors.available(),
    (controllers) => {
      const stops = controllers.map((controller) => controller.watch());
      return () => {
        for (const stop of stops) stop();
      };
    },
  );

  const row = (entry: ConnectorEntry): IntegrationsHubRow[] => {
    const listing = CONNECTOR_LISTINGS[entry.id];
    const base = { id: entry.id, name: t(listing.title), logo: <listing.Mark /> };
    if (entry.access === "local-only")
      return [
        {
          ...base,
          status: "unavailable",
          statusLabel: t("connector.hub.localOnly"),
          summary: t(listing.tagline),
        },
      ];
    if (entry.access !== "available") return [];
    return [{ ...base, ...connectorSummary(entry.controller.detail, t), onOpen: () => setView(entry.id) }];
  };

  return (
    <Show
      when={page()}
      fallback={<IntegrationsHub rows={props.connectors.entries().flatMap(row)} hostName={props.hostName} />}
    >
      {(controller) => (
        <div class="integrations-hub">
          <Show when={controller().ready()}>
            <ConnectorDetailPanel detail={controller().detail} />
          </Show>
        </div>
      )}
    </Show>
  );
}
