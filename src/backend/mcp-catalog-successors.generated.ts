/**
 * The server signatures that earlier releases of a catalog listing used, and the signature each one
 * moves to.
 *
 * Generated from marketplace/plugin-catalog/ by scripts/build-plugin-catalog.ts.
 * Do not edit by hand.
 */

export type McpCatalogSuccessor =
  | { serverName: string; transport: "http"; from: { url: string }; to: { url: string } }
  | {
      serverName: string;
      transport: "stdio";
      from: { command: string; args: string[] };
      to: { command: string; args: string[] };
    };

export const MCP_CATALOG_SUCCESSORS: readonly McpCatalogSuccessor[] = [];
