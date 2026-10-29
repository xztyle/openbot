// Storage hygiene: the scan of the agents' projects, the cleanup and the automatic rules of the
// local host or a joined server. Only an owner or an admin uses it: the user of this computer owns
// the local host, and a joined host checks the role on each storage-hygiene-v1 route. A joined
// server without the routes has no state; a change there is refused.

import {
  decodeStorageHygieneSettings,
  decodeStorageHygieneState,
  parseStorageHygieneApplyInput,
  parseStorageHygieneStateInput,
  type StorageHygieneSettings,
} from "@openbot/contracts/ipc";
import type { TeamCurrentCapability } from "@openbot/contracts/team-protocol/current";
import {
  STORAGE_HYGIENE_CAPABILITY,
  STORAGE_HYGIENE_ROUTES,
} from "@openbot/contracts/team-protocol/storage-hygiene-v1";
import { sourceText } from "@openbot/i18n/source";
import type { Effect } from "effect";
import { runCauseEffect } from "../../backend/effect-boundary";
import type { StorageHygieneService } from "../../backend/storage-hygiene";
import type { ResponseDecoder } from "../remote-host-decoding";
import type { RemoteRequestInit } from "../remote-server-client";
import type { RemoteWorkflowError } from "../remote-service-effects";
import type { StorageHygieneSettingsStore } from "../storage-hygiene-settings-store";
import type { IpcGroupHandlers } from "./define-ipc-group";
import { scopedHandler, scopedQueryHandler } from "./scoped-handler";

interface StorageHygieneRemoteServers {
  supportsCapability(serverId: string, capability: TeamCurrentCapability): boolean;
  request<T>(
    serverId: string,
    path: string,
    decoder: ResponseDecoder<T>,
    init?: RemoteRequestInit,
  ): Effect.Effect<T, RemoteWorkflowError>;
}

export interface StorageHygieneIpcDependencies {
  storageHygiene: Pick<StorageHygieneService, "state" | "apply">;
  settings: StorageHygieneSettingsStore;
  remoteServers: StorageHygieneRemoteServers;
  /** The name of the person at this computer, for the audit file. */
  localActor: () => string | undefined;
}

export function storageHygieneIpcHandlers({
  storageHygiene,
  settings,
  remoteServers,
  localActor,
}: StorageHygieneIpcDependencies): Pick<IpcGroupHandlers, "storageHygiene"> {
  function remote<T>(serverId: string, path: string, body: unknown, decoder: ResponseDecoder<T>): Promise<T> {
    if (!remoteServers.supportsCapability(serverId, STORAGE_HYGIENE_CAPABILITY))
      throw new Error(sourceText("error.storage.hygieneUnsupported"));
    return runCauseEffect(remoteServers.request(serverId, path, decoder, { method: "POST", body }));
  }

  return {
    storageHygiene: {
      getState: scopedHandler(parseStorageHygieneStateInput, {
        local: (input) => runCauseEffect(storageHygiene.state(input)),
        remote: async (input, serverId) => {
          if (!remoteServers.supportsCapability(serverId, STORAGE_HYGIENE_CAPABILITY)) return null;
          return remote(serverId, STORAGE_HYGIENE_ROUTES.state, input, decodeStorageHygieneState);
        },
      }),
      apply: scopedHandler(parseStorageHygieneApplyInput, {
        local: (input) => runCauseEffect(storageHygiene.apply(input, localActor())),
        remote: (input, serverId) => remote(serverId, STORAGE_HYGIENE_ROUTES.apply, input, decodeStorageHygieneState),
      }),
      getSettings: scopedQueryHandler({
        local: () => settings.get(),
        remote: (serverId) => remote(serverId, STORAGE_HYGIENE_ROUTES.settings, {}, decodeStorageHygieneSettings),
      }),
      setSettings: scopedHandler(decodeStorageHygieneSettings, {
        local: (next: StorageHygieneSettings) => runCauseEffect(settings.set(next)),
        remote: (next, serverId) =>
          remote(serverId, STORAGE_HYGIENE_ROUTES.settingsUpdate, next, decodeStorageHygieneSettings),
      }),
    },
  };
}
