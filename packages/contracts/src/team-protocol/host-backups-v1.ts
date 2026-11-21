// Optional host-backups wire contract of this fork, under `fork-host-v1`.
//
// What it grants, recorded here because freezing it makes it permanent: the owner and the admins of
// a server see the host's backups (made by the host's backup broker, outside OpenBot), start one,
// and run a restore dry run. Only the owner may start a restore, and only with the backup's name typed
// as `confirm`; the host stops, restores and starts again, so every client is disconnected for a while.
//
// - `POST /v1/admin/host/backups` `{}` and `/v1/admin/host/backups/create` `{}` answer the overview.
//   A host whose broker is not set up answers `{ available: false, reason }` and nothing else.
// - `POST /v1/admin/host/backups/check` `{ id, spaces? }` answers the dry run. Nothing changes.
// - `POST /v1/admin/host/backups/restore` `{ id, confirm, spaces? }` answers `{ started: true }`.
//
// A fork host built before these routes answers 404, so a client shows no Backups section there.
// Widening any of it needs a new route.
import { type DynamicRecord, isDynamicRecord } from "../runtime-values";
import {
  adminRoute,
  boolean,
  count,
  empty,
  fields,
  identifier,
  list,
  nullable,
  type OptionalRouteCodec,
  oneOf,
  string,
} from "./admin-wire";
import { FORK_HOST_CAPABILITY } from "./fork-host-v1";
import type { TeamProtocolV2Json } from "./v2";

export const HOST_BACKUPS_CAPABILITY = FORK_HOST_CAPABILITY;

export const HOST_BACKUPS_ROUTES = {
  overview: "/v1/admin/host/backups",
  create: "/v1/admin/host/backups/create",
  check: "/v1/admin/host/backups/check",
  restore: "/v1/admin/host/backups/restore",
} as const;

export const HOST_BACKUP_REASONS = ["nightly", "manual", "pre-restore", "other"] as const;
export type HostBackupReason = (typeof HOST_BACKUP_REASONS)[number];
export const HOST_BACKUP_STATUSES = ["ok", "partial", "failed", "running"] as const;
export type HostBackupStatus = (typeof HOST_BACKUP_STATUSES)[number];
export const HOST_RESTORE_STATUSES = ["starting", "running", "restored", "ok", "failed"] as const;
export type HostRestoreStatus = (typeof HOST_RESTORE_STATUSES)[number];

export const HOST_BACKUPS_LIMIT = 40;
const TEXT = 500;

export interface HostBackupComponent {
  /** `core`, `workspace:<folder>`, `space:<name>`, `motion-files` or `host-config`. */
  name: string;
  status: "ok" | "skipped" | "failed";
  reason?: string;
}

export interface HostBackup {
  id: string;
  createdAt: string;
  reason: HostBackupReason;
  status: HostBackupStatus;
  /** What the backup holds, uncompressed files plus the compressed databases. */
  bytes: number;
  /** What it added on disk: files that changed since the backup before it, and the databases. */
  newBytes: number;
  schema: number | null;
  seconds: number | null;
  error?: string;
  components: HostBackupComponent[];
  offsite: "ok" | "failed" | null;
}

export interface HostBackupJob {
  kind: "backup" | "restore" | "staging" | "offsite";
  id: string;
  phase: string;
  startedAt: string;
}

export interface HostRestoreReport {
  id: string;
  status: HostRestoreStatus;
  startedAt: string;
  finishedAt?: string;
  safetyBackup?: string;
  error?: string;
  steps: { at: string; text: string }[];
}

export type HostBackupsOverview =
  | { available: false; reason: string }
  | {
      available: true;
      backups: HostBackup[];
      running: HostBackupJob | null;
      lastRestore: HostRestoreReport | null;
      /** "HH:MM" on the host's clock. */
      nightly: string;
      retention: { daily: number; weekly: number };
      disk: { freeBytes: number; totalBytes: number };
      offsite: boolean;
    };

export interface HostRestoreCheck {
  ok: boolean;
  /** Each blocks the restore. */
  problems: string[];
  warnings: string[];
  backup: { id: string; createdAt: string; schema: number | null };
  current: { schema: number | null };
  /** What a restore would put back, in order. */
  restore: string[];
  counts: { table: string; now: number; backup: number }[];
  /** The text that `confirm` must be. */
  confirm: string;
}

const component = fields({ name: string(160), status: oneOf("ok", "skipped", "failed") }, { reason: string(TEXT) });
const backup = fields(
  {
    id: identifier,
    createdAt: string(64),
    reason: oneOf(...HOST_BACKUP_REASONS),
    status: oneOf(...HOST_BACKUP_STATUSES),
    bytes: count,
    newBytes: count,
    schema: nullable(count),
    seconds: nullable(count),
    components: list(component, 200),
    offsite: nullable(oneOf("ok", "failed")),
  },
  { error: string(TEXT) },
);
const job = fields({
  kind: oneOf("backup", "restore", "staging", "offsite"),
  id: identifier,
  phase: string(160),
  startedAt: string(64),
});
const restoreReport = fields(
  {
    id: identifier,
    status: oneOf(...HOST_RESTORE_STATUSES),
    startedAt: string(64),
    steps: list(fields({ at: string(64), text: string(TEXT) }), 100),
  },
  { finishedAt: string(64), safetyBackup: identifier, error: string(TEXT) },
);
const overview = (value: unknown): TeamProtocolV2Json => {
  if (isDynamicRecord(value) && value.available === false)
    return fields({ available: boolean, reason: string(TEXT) })(value);
  return fields({
    available: boolean,
    backups: list(backup, HOST_BACKUPS_LIMIT),
    running: nullable(job),
    lastRestore: nullable(restoreReport),
    nightly: string(5),
    retention: fields({ daily: count, weekly: count }),
    disk: fields({ freeBytes: count, totalBytes: count }),
    offsite: boolean,
  })(value);
};
const restoreCheck = fields({
  ok: boolean,
  problems: list(string(TEXT), 20),
  warnings: list(string(TEXT), 20),
  backup: fields({ id: identifier, createdAt: string(64), schema: nullable(count) }),
  current: fields({ schema: nullable(count) }),
  restore: list(string(160), 200),
  counts: list(fields({ table: string(128), now: count, backup: count }), 20),
  confirm: identifier,
});

export const HOST_BACKUPS_CODECS: ReadonlyMap<string, OptionalRouteCodec> = new Map([
  [HOST_BACKUPS_ROUTES.overview, adminRoute(empty, overview)],
  [HOST_BACKUPS_ROUTES.create, adminRoute(empty, overview)],
  [HOST_BACKUPS_ROUTES.check, adminRoute(fields({ id: identifier }, { spaces: boolean }), restoreCheck)],
  [
    HOST_BACKUPS_ROUTES.restore,
    adminRoute(fields({ id: identifier, confirm: identifier }, { spaces: boolean }), fields({ started: boolean })),
  ],
]);

type Json = DynamicRecord;

const text = (value: unknown, limit = 500): string => (typeof value === "string" ? value.slice(0, limit) : "");
const whole = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.round(value) : 0;
const wholeOrNull = (value: unknown): number | null => (typeof value === "number" ? whole(value) : null);
const records = (value: unknown): Json[] => (Array.isArray(value) ? value.filter(isDynamicRecord) : []);
function pick<T extends string>(value: unknown, choices: readonly T[], fallback: T): T {
  return choices.find((choice) => choice === value) ?? fallback;
}

function backupOf(row: Json): HostBackup {
  return {
    id: text(row.id, 128),
    createdAt: text(row.createdAt, 64),
    reason: pick(row.reason, HOST_BACKUP_REASONS, "other"),
    status: pick(row.status, HOST_BACKUP_STATUSES, "failed"),
    bytes: whole(row.bytes),
    newBytes: whole(row.newBytes),
    schema: wholeOrNull(row.schema),
    seconds: wholeOrNull(row.seconds),
    ...(typeof row.error === "string" && row.error ? { error: text(row.error) } : {}),
    components: records(row.components)
      .slice(0, 200)
      .map(
        (item): HostBackupComponent => ({
          name: text(item.name, 160),
          status: pick(item.status, ["ok", "skipped", "failed"] as const, "failed"),
          ...(typeof item.reason === "string" ? { reason: text(item.reason) } : {}),
        }),
      ),
    offsite: row.offsite === "ok" || row.offsite === "failed" ? row.offsite : null,
  };
}

function jobOf(value: unknown): HostBackupJob | null {
  if (!isDynamicRecord(value) || typeof value.id !== "string") return null;
  return {
    kind: pick(value.kind, ["backup", "restore", "staging", "offsite"] as const, "backup"),
    id: text(value.id, 128),
    phase: text(value.phase, 160),
    startedAt: text(value.startedAt, 64),
  };
}

function restoreOf(value: unknown): HostRestoreReport | null {
  if (!isDynamicRecord(value) || typeof value.id !== "string") return null;
  return {
    id: text(value.id, 128),
    status: pick(value.status, HOST_RESTORE_STATUSES, "failed"),
    startedAt: text(value.startedAt, 64),
    ...(typeof value.finishedAt === "string" ? { finishedAt: text(value.finishedAt, 64) } : {}),
    ...(typeof value.safetyBackup === "string" ? { safetyBackup: text(value.safetyBackup, 128) } : {}),
    ...(typeof value.error === "string" ? { error: text(value.error) } : {}),
    steps: records(value.steps)
      .slice(-100)
      .map((step) => ({ at: text(step.at, 64), text: text(step.text) })),
  };
}

/** The broker's answers (and the wire values), cut to the `host-backups-v1` shapes. */
export function hostBackupsOverviewOf(value: unknown): HostBackupsOverview {
  if (!isDynamicRecord(value)) return { available: false, reason: "The backup service gave no answer." };
  if (value.available === false) return { available: false, reason: text(value.reason) };
  const retention = isDynamicRecord(value.retention) ? value.retention : {};
  const disk = isDynamicRecord(value.disk) ? value.disk : {};
  return {
    available: true,
    backups: records(value.backups)
      .slice(0, 40)
      .map(backupOf)
      .filter((row) => row.id),
    running: jobOf(value.running),
    lastRestore: restoreOf(value.lastRestore),
    nightly: /^\d{2}:\d{2}$/u.test(text(value.nightly, 5)) ? text(value.nightly, 5) : "03:30",
    retention: { daily: whole(retention.daily), weekly: whole(retention.weekly) },
    disk: { freeBytes: whole(disk.freeBytes), totalBytes: whole(disk.totalBytes) },
    offsite: value.offsite === true,
  };
}

export function hostRestoreCheckOf(value: unknown): HostRestoreCheck {
  if (!isDynamicRecord(value)) throw new Error("The backup service gave no answer.");
  const strings = (list: unknown, limit: number) =>
    (Array.isArray(list) ? list : [])
      .filter((item) => typeof item === "string")
      .slice(0, limit)
      .map((item) => text(item));
  const backup = isDynamicRecord(value.backup) ? value.backup : {};
  const current = isDynamicRecord(value.current) ? value.current : {};
  return {
    ok: value.ok === true,
    problems: strings(value.problems, 20),
    warnings: strings(value.warnings, 20),
    backup: { id: text(backup.id, 128), createdAt: text(backup.createdAt, 64), schema: wholeOrNull(backup.schema) },
    current: { schema: wholeOrNull(current.schema) },
    restore: strings(value.restore, 200).map((item) => item.slice(0, 160)),
    counts: records(value.counts)
      .slice(0, 20)
      .map((row) => ({ table: text(row.table, 128), now: whole(row.now), backup: whole(row.backup) })),
    confirm: text(value.confirm, 128),
  };
}

/** The overview as the clients use it, after the wire codec checked each field. */
export function decodeHostBackupsOverview(value: unknown): HostBackupsOverview {
  return hostBackupsOverviewOf(overview(value));
}

export function decodeHostRestoreCheck(value: unknown): HostRestoreCheck {
  return hostRestoreCheckOf(restoreCheck(value));
}

export function decodeHostRestoreStarted(value: unknown): { started: boolean } {
  const decoded = fields({ started: boolean })(value);
  return { started: isDynamicRecord(decoded) && decoded.started === true };
}
