import type { ServerSummary } from "@openbot/contracts/ipc";
import { FORK_HOST_CAPABILITY } from "@openbot/contracts/team-protocol/fork-host-v1";
import type { TeamApiRequest } from "@openbot/team-client/team-api-requests";
import { serverCanAdminister } from "./server-capabilities";

/**
 * The owner routes of a joined fork host, as the browser client's `TeamApiRequest` sends them: main
 * sends each on (`forkRoutes`), and the route's own codec decodes the answer here. Read on each call:
 * tests and stories replace `window.openbot` per case.
 */
export function desktopForkRequest(serverId: () => string): TeamApiRequest {
  return async (_method, path, decode, body) =>
    decode(await window.openbot.forkRoutes.request({ path, body: body ?? {} }, serverId()));
}

/** Only an owner or an admin of a joined fork host: this computer's own host has no such routes. */
export function serverHasForkOwnerRoutes(server: ServerSummary | undefined): server is ServerSummary {
  return server?.kind === "remote" && serverCanAdminister(server, FORK_HOST_CAPABILITY);
}
