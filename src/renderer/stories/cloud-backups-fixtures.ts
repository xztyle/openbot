import {
  DEFAULT_CLOUD_PLAN,
  type HostCloudBackupsOverview,
} from "@openbot/contracts/team-protocol/host-cloud-backups-v1";

/** The cloud backups of a host, as the stories and the settings harness show them. */
export const GB = 1024 ** 3;
export const MB = 1024 ** 2;

export type CloudReady = Extract<HostCloudBackupsOverview, { available: true }>;

export const CLOUD_EMPTY: CloudReady = {
  available: true,
  destinations: [],
  plan: DEFAULT_CLOUD_PLAN,
  running: null,
  lastBackup: null,
  lastSuccessAt: null,
  nextRunAt: null,
  lastTest: null,
  typical: null,
  sizes: [],
  warnings: [],
  restores: [],
};

export const CLOUD_CONNECTED: CloudReady = {
  ...CLOUD_EMPTY,
  destinations: [
    {
      id: "proton",
      provider: "proton",
      account: "owner@proton.me",
      status: "ok",
      connectedAt: "2026-11-25T08:00:00Z",
      folder: "Atelier Backups/Delynith",
      space: { usedBytes: 6.2 * GB, freeBytes: 493 * GB, totalBytes: 500 * GB, checkedAt: "2026-11-25T14:00:00Z" },
    },
  ],
  lastBackup: {
    startedAt: "2026-11-25T14:00:00Z",
    finishedAt: "2026-11-25T14:00:41Z",
    ok: true,
    seconds: 41,
    addedBytes: 24 * MB,
    totalBytes: 11.2 * GB,
    problem: null,
    detail: null,
  },
  lastSuccessAt: "2026-11-25T14:00:41Z",
  nextRunAt: "2026-11-25T15:00:00Z",
  lastTest: {
    startedAt: "2026-11-23T09:00:00Z",
    finishedAt: "2026-11-23T09:12:00Z",
    ok: true,
    seconds: 720,
    addedBytes: 0,
    totalBytes: 0,
    problem: null,
    detail: null,
  },
  typical: { seconds: 44, addedBytes: 21 * MB, runs: 24 },
  restores: [
    {
      id: "cloud-restore-20261125-150000-a1b2c3",
      snapshot: "7ee1041943923f17",
      status: "ok",
      finishedAt: "2026-11-25T15:05:00Z",
      bytes: 11.2 * GB,
      preparedAs: null,
      partial: false,
    },
  ],
  sizes: [
    { group: "database", bytes: 2.3 * GB },
    { group: "conversations", bytes: 1.9 * GB },
    { group: "agents", bytes: 1.1 * GB },
    { group: "settings", bytes: 0.4 * GB },
    { group: "motion", bytes: 0.2 * GB },
    { group: "work", bytes: 5.3 * GB },
  ],
};
