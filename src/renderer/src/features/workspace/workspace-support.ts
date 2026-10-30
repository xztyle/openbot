import { createMemo } from "solid-js";

/**
 * Whether the workspace shows for the open server. A server that showed it keeps it while its
 * connection comes back: the host's capabilities are not known again until it is online, and the
 * classic layout would show for that time.
 */
export function createWorkspaceSupport(input: {
  /** The workspace is supported now: the host is online and serves it. */
  live: () => boolean;
  /** The open server. Another server starts again from what it serves. */
  serverId: () => string | null | undefined;
  /** The connection is on its way back, not refused. */
  reconnecting: () => boolean;
}): () => boolean {
  let shownFor: string | null = null;
  return createMemo(() => {
    const serverId = input.serverId() ?? null;
    if (input.live()) {
      shownFor = serverId;
      return true;
    }
    return serverId !== null && serverId === shownFor && input.reconnecting();
  });
}
