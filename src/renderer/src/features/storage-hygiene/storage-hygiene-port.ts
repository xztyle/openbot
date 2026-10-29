import {
  decodeStorageHygieneSettings,
  decodeStorageHygieneState,
  type ServerSummary,
  type StorageHygieneApplyInput,
  type StorageHygieneSettings,
  type StorageHygieneState,
  type StorageHygieneStateInput,
} from "@openbot/contracts/ipc";
import {
  STORAGE_HYGIENE_CAPABILITY,
  STORAGE_HYGIENE_ROUTES,
} from "@openbot/contracts/team-protocol/storage-hygiene-v1";
import type { TeamApiRequest } from "@openbot/team-client/team-api-requests";
import { serverCanAdminister } from "../servers/server-capabilities";

/**
 * The storage hygiene calls of one server: the scan state, the cleanup and the automatic rules.
 * The desktop reaches them through main; the browser client sends the storage-hygiene-v1 routes.
 */
export interface StorageHygieneCalls {
  /** Null: the host has no storage hygiene routes. */
  getState(input: StorageHygieneStateInput): Promise<StorageHygieneState | null>;
  apply(input: StorageHygieneApplyInput): Promise<StorageHygieneState>;
  getSettings(): Promise<StorageHygieneSettings>;
  setSettings(settings: StorageHygieneSettings): Promise<StorageHygieneSettings>;
}

/** Only an owner or an admin, of this computer or of a fork host that serves the routes. */
export function serverHasStorageHygiene(server: ServerSummary | undefined): server is ServerSummary {
  return serverCanAdminister(server, STORAGE_HYGIENE_CAPABILITY);
}

/** Read on each call: tests and stories replace `window.openbot` per case. */
export function desktopStorageHygieneCalls(serverId: () => string): StorageHygieneCalls {
  return {
    getState: (input) => window.openbot.storageHygiene.getState(input, serverId()),
    apply: (input) => window.openbot.storageHygiene.apply(input, serverId()),
    getSettings: () => window.openbot.storageHygiene.getSettings(serverId()),
    setSettings: (settings) => window.openbot.storageHygiene.setSettings(settings, serverId()),
  };
}

/** The routes of the connected host, for the browser client. A host that is not connected rejects. */
export function hostStorageHygieneCalls(request: () => TeamApiRequest): StorageHygieneCalls {
  return {
    getState: async (input) => request()("POST", STORAGE_HYGIENE_ROUTES.state, decodeStorageHygieneState, { ...input }),
    apply: async (input) =>
      request()("POST", STORAGE_HYGIENE_ROUTES.apply, decodeStorageHygieneState, { itemIds: [...input.itemIds] }),
    getSettings: async () => request()("POST", STORAGE_HYGIENE_ROUTES.settings, decodeStorageHygieneSettings, {}),
    setSettings: async (settings) =>
      request()("POST", STORAGE_HYGIENE_ROUTES.settingsUpdate, decodeStorageHygieneSettings, { ...settings }),
  };
}
