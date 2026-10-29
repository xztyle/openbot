import {
  decodeStorageHygieneSettings,
  parseStorageHygieneApplyInput,
  parseStorageHygieneStateInput,
} from "@openbot/contracts/ipc";
import {
  STORAGE_HYGIENE_CAPABILITY,
  STORAGE_HYGIENE_ROUTES,
} from "@openbot/contracts/team-protocol/storage-hygiene-v1";
import { sourceText } from "@openbot/i18n/source";
import { runCauseEffect } from "../../backend/effect-boundary";
import { StorageHygieneBusyError } from "../../backend/storage-hygiene";
import type { TeamApiStorageHygiene } from "./dependencies";
import { HttpError } from "./http-error";
import type { RouteOutcome, TeamApiRequestContext } from "./request-context";
import { readJson, requireAdmin } from "./request-helpers";

function parsed<T>(parse: (value: unknown) => T, value: unknown): T {
  try {
    return parse(value);
  } catch {
    throw new HttpError(400, "Invalid storage hygiene request.");
  }
}

/**
 * The storage hygiene routes of this fork (`storage-hygiene-v1.ts`, under `fork-host-v1`). Every
 * route needs an owner or an admin: the answers name project folders, and a cleanup deletes files.
 * The audit file names the member who started a cleanup.
 */
export async function routeStorageHygiene(
  context: TeamApiRequestContext,
  hygiene: TeamApiStorageHygiene | undefined,
): Promise<RouteOutcome> {
  const { method, url, capabilities, member, request, json } = context;
  if (method !== "POST" || !Object.values(STORAGE_HYGIENE_ROUTES).some((route) => route === url.pathname))
    return "unmatched";
  if (!hygiene || !capabilities.has(STORAGE_HYGIENE_CAPABILITY))
    throw new HttpError(400, sourceText("error.team.storageUnsupported"));
  requireAdmin(member);
  // `readJson` has already run the body through the storage-hygiene wire codec.
  const body = await readJson(request);
  switch (url.pathname) {
    case STORAGE_HYGIENE_ROUTES.state:
      return json(200, await runCauseEffect(hygiene.service.state(parsed(parseStorageHygieneStateInput, body))));
    case STORAGE_HYGIENE_ROUTES.apply:
      try {
        return json(
          200,
          await runCauseEffect(
            hygiene.service.apply(parsed(parseStorageHygieneApplyInput, body), member.name ?? member.username),
          ),
        );
      } catch (error) {
        if (error instanceof StorageHygieneBusyError) throw new HttpError(409, error.message);
        throw error;
      }
    case STORAGE_HYGIENE_ROUTES.settings:
      return json(200, hygiene.settings.get());
    default:
      return json(200, await runCauseEffect(hygiene.settings.set(parsed(decodeStorageHygieneSettings, body))));
  }
}
