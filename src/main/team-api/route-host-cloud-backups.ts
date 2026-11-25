import {
  type CloudConnectInput,
  cloudGroupsOf,
  cloudPlanOf,
  HOST_CLOUD_BACKUPS_CAPABILITY,
  HOST_CLOUD_BACKUPS_ROUTES,
} from "@openbot/contracts/team-protocol/host-cloud-backups-v1";
import { sourceText } from "@openbot/i18n/source";
import { CloudBackupError, type CloudBackups } from "../cloud-backups";
import { HostBackupError } from "../host-backups";
import { HttpError } from "./http-error";
import type { RouteOutcome, TeamApiRequestContext } from "./request-context";
import { readJson, requireAdmin } from "./request-helpers";

const ROUTES: ReadonlySet<string> = new Set(Object.values(HOST_CLOUD_BACKUPS_ROUTES));
/** A drive sign-in is a credential, and a restore writes everyone's data: tier 2, the owner only. */
const OWNER_ONLY: ReadonlySet<string> = new Set([
  HOST_CLOUD_BACKUPS_ROUTES.connect,
  HOST_CLOUD_BACKUPS_ROUTES.disconnect,
  HOST_CLOUD_BACKUPS_ROUTES.plan,
  HOST_CLOUD_BACKUPS_ROUTES.passwordSaved,
  HOST_CLOUD_BACKUPS_ROUTES.restore,
  HOST_CLOUD_BACKUPS_ROUTES.restorePrepare,
  HOST_CLOUD_BACKUPS_ROUTES.folders,
  HOST_CLOUD_BACKUPS_ROUTES.changeFolder,
  HOST_CLOUD_BACKUPS_ROUTES.apply,
]);

const optional = (value: unknown): string | undefined => (typeof value === "string" && value ? value : undefined);

/**
 * Server settings > Backups > Copy in the cloud (`host-cloud-backups-v1.ts`, under `fork-host-v1`).
 * The owner and the admins see the copies, start one and run the restore test; only the owner
 * connects a drive, changes the plan and restores.
 */
export async function routeHostCloudBackups(
  context: TeamApiRequestContext,
  cloud: CloudBackups | undefined,
): Promise<RouteOutcome> {
  const { method, url, capabilities, request, json, member } = context;
  if (method !== "POST" || !ROUTES.has(url.pathname)) return "unmatched";
  if (!cloud || !capabilities.has(HOST_CLOUD_BACKUPS_CAPABILITY))
    throw new HttpError(404, sourceText("error.team.routeNotFound"));
  requireAdmin(member);
  if (OWNER_ONLY.has(url.pathname) && member.role !== "owner")
    throw new HttpError(403, sourceText("error.host.cloudOwnerOnly"));
  // `readJson` has already run the body through the cloud-backups wire codec.
  const body = await readJson(request);
  try {
    switch (url.pathname) {
      case HOST_CLOUD_BACKUPS_ROUTES.overview:
        return json(200, await cloud.overview());
      case HOST_CLOUD_BACKUPS_ROUTES.connect: {
        const twoFactorCode = optional(body.twoFactorCode);
        const mailboxPassword = optional(body.mailboxPassword);
        const repositoryPassword = optional(body.repositoryPassword);
        const input: CloudConnectInput = {
          provider: body.provider === "proton" ? "proton" : body.provider === "onedrive" ? "onedrive" : "google-drive",
          email: optional(body.email) ?? "",
          password: optional(body.password) ?? "",
          ...(twoFactorCode ? { twoFactorCode } : {}),
          ...(mailboxPassword ? { mailboxPassword } : {}),
          ...(repositoryPassword ? { repositoryPassword } : {}),
          ...(optional(body.folder) ? { folder: optional(body.folder) } : {}),
        };
        return json(200, await cloud.connect(input));
      }
      case HOST_CLOUD_BACKUPS_ROUTES.disconnect:
        return json(200, await cloud.disconnect(optional(body.id) ?? ""));
      case HOST_CLOUD_BACKUPS_ROUTES.plan:
        return json(200, await cloud.setPlan(cloudPlanOf(body.plan)));
      case HOST_CLOUD_BACKUPS_ROUTES.passwordSaved:
        return json(200, await cloud.passwordSaved());
      case HOST_CLOUD_BACKUPS_ROUTES.run:
        return json(200, await cloud.runNow(body.kind === "test" ? "test" : "backup"));
      case HOST_CLOUD_BACKUPS_ROUTES.snapshots:
        return json(200, await cloud.snapshots());
      case HOST_CLOUD_BACKUPS_ROUTES.restore:
        return json(
          200,
          await cloud.restore(optional(body.snapshot) ?? "", optional(body.confirm) ?? "", {
            groups: cloudGroupsOf(body.groups),
            paths: Array.isArray(body.paths) ? body.paths.filter((path) => typeof path === "string") : [],
          }),
        );
      case HOST_CLOUD_BACKUPS_ROUTES.browse:
        return json(200, await cloud.browse(optional(body.snapshot) ?? "", optional(body.path) ?? "/"));
      case HOST_CLOUD_BACKUPS_ROUTES.folders:
        return json(200, await cloud.folders(optional(body.path) ?? "", body.create === true));
      case HOST_CLOUD_BACKUPS_ROUTES.changeFolder:
        return json(
          200,
          await cloud.changeFolder(
            optional(body.folder) ?? "",
            body.mode === "move" ? "move" : "use",
            optional(body.repositoryPassword),
          ),
        );
      case HOST_CLOUD_BACKUPS_ROUTES.apply:
        return json(200, await cloud.apply(optional(body.restore) ?? "", optional(body.confirm) ?? ""));
      default:
        return json(200, await cloud.prepareRestore(optional(body.restore) ?? ""));
    }
  } catch (error) {
    if (error instanceof CloudBackupError) throw new HttpError(error.status, error.message);
    if (error instanceof HostBackupError) {
      if (error.status === 409) throw new HttpError(409, sourceText("error.host.cloudBusy"));
      throw new HttpError(error.status >= 400 && error.status < 600 ? error.status : 502, error.message);
    }
    throw error;
  }
}
