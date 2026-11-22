import { isConnectorId } from "@openbot/ui/features/connectors/connectors";
import { MARKETPLACE_PLUGIN_SLUGS } from "../settings/marketplace-plugin-slugs";

/**
 * True when this client can draw a card for the app: a catalog plugin, or a connector. It reads the
 * slugs only, so the timeline can ask without loading the card and the catalog.
 */
export function marketplaceSuggestionKnown(appId: string): boolean {
  return isConnectorId(appId) || MARKETPLACE_PLUGIN_SLUGS.includes(appId);
}
