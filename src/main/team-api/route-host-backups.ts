import { HOST_BACKUPS_CAPABILITY, HOST_BACKUPS_ROUTES } from "@openbot/contracts/team-protocol/host-backups-v1";
import { sourceText } from "@openbot/i18n/source";
import { HostBackupError, type HostBackups } from "../host-backups";
import { HttpError } from "./http-error";
import type { RouteOutcome, TeamApiRequestContext } from "./request-context";
import { readJson, requireAdmin } from "./request-helpers";

const ROUTES: ReadonlySet<string> = new Set(Object.values(HOST_BACKUPS_ROUTES));

/**
 * Server settings > Backups (`host-backups-v1.ts`, under `fork-host-v1`): the host's backup broker.
 * The owner and the admins list, back up and check; only the owner restores, because a restore
 * replaces everyone's data and restarts the host.
 */
export async function routeHostBackups(
  context: TeamApiRequestContext,
  backups: HostBackups | undefined,
): Promise<RouteOutcome> {
  const { method, url, capabilities, request, json, member } = context;
  if (method !== "POST" || !ROUTES.has(url.pathname)) return "unmatched";
  if (!backups || !capabilities.has(HOST_BACKUPS_CAPABILITY))
    throw new HttpError(404, sourceText("error.team.routeNotFound"));
  requireAdmin(member);
  // `readJson` has already run the body through the host-backups wire codec.
  const body = await readJson(request);
  try {
    if (url.pathname === HOST_BACKUPS_ROUTES.overview) return json(200, await backups.overview());
    if (url.pathname === HOST_BACKUPS_ROUTES.create) return json(200, await backups.create());
    const id = typeof body.id === "string" ? body.id : "";
    const spaces = body.spaces === true;
    if (url.pathname === HOST_BACKUPS_ROUTES.check) return json(200, await backups.check(id, spaces));
    if (member.role !== "owner") throw new HttpError(403, sourceText("error.host.backupRestoreOwnerOnly"));
    const confirm = typeof body.confirm === "string" ? body.confirm : "";
    if (confirm !== id) throw new HttpError(400, sourceText("error.host.backupConfirmMismatch"));
    return json(200, await backups.restore(id, confirm, spaces));
  } catch (error) {
    if (error instanceof HostBackupError)
      throw new HttpError(error.status >= 400 && error.status < 600 ? error.status : 502, error.message);
    throw error;
  }
}
