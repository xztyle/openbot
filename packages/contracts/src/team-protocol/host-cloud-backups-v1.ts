// Optional cloud-copies wire contract of this fork, under `fork-host-v1`.
//
// What it grants, recorded here because freezing it makes it permanent: the owner and the admins of
// a server see the host's copies to a cloud drive (Proton Drive today; Google Drive and OneDrive use
// the same shapes later), start one, run the restore test and list the copies. Only the owner
// connects or disconnects a drive, changes the plan, and restores: a drive sign-in is a credential,
// and a restore writes a copy of everyone's data to the server's disk.
//
// - `POST /v1/admin/host/cloud-backups` `{}` answers the overview. A host whose backup broker is not
//   set up answers `{ available: false }`.
// - `POST /v1/admin/host/cloud-backups/connect` `{ provider, email, password, twoFactorCode?,
//   mailboxPassword?, repositoryPassword? }` (owner) signs in and opens or makes the encrypted
//   repository. It answers `{ ok: true, overview, repositoryPassword? }`: the password of a new
//   repository is answered this once, for the owner's password manager. A failed sign-in answers
//   `{ ok: false, problem }`, where `problem` names what the owner must do.
// - `.../disconnect` `{ id }` (owner), `.../plan` `{ plan }` (owner), `.../password-saved` `{}` (owner).
// - `.../run` `{ kind: "backup" | "test" }` answers the overview.
// - `.../snapshots` `{}` answers `{ ok, snapshots, problem? }`.
// - `.../restore` `{ snapshot, confirm }` (owner) restores the whole copy into its own folder on the
//   server; live data is never touched. `.../restore-prepare` `{ restore }` (owner) turns that folder
//   into a backup that Backups > Restore can put back, with its safety copy and typed confirmation.
//
// A host built before these routes answers 404, and a client shows no cloud section there.
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

export const HOST_CLOUD_BACKUPS_CAPABILITY = FORK_HOST_CAPABILITY;

export const HOST_CLOUD_BACKUPS_ROUTES = {
  overview: "/v1/admin/host/cloud-backups",
  connect: "/v1/admin/host/cloud-backups/connect",
  disconnect: "/v1/admin/host/cloud-backups/disconnect",
  plan: "/v1/admin/host/cloud-backups/plan",
  passwordSaved: "/v1/admin/host/cloud-backups/password-saved",
  run: "/v1/admin/host/cloud-backups/run",
  snapshots: "/v1/admin/host/cloud-backups/snapshots",
  restore: "/v1/admin/host/cloud-backups/restore",
  restorePrepare: "/v1/admin/host/cloud-backups/restore-prepare",
} as const;

/** The drives. Only `proton` connects today; the others are named so the wire needs no change. */
export const CLOUD_PROVIDERS = ["proton", "google-drive", "onedrive"] as const;
export type CloudProvider = (typeof CLOUD_PROVIDERS)[number];
export const CLOUD_GROUPS = ["database", "conversations", "agents", "settings", "motion", "work"] as const;
export type CloudGroup = (typeof CLOUD_GROUPS)[number];
export const CLOUD_INTERVALS = ["15m", "1h", "6h", "daily"] as const;
export type CloudInterval = (typeof CLOUD_INTERVALS)[number];
/**
 * What went wrong, for a sentence in the owner's words:
 * - `two-factor`: the account asks for its 2FA code; `mailbox-password`: its second password;
 * - `credentials`: the email or password is wrong; `verification`: the drive wants a human check that
 *   only its own app or site can do; `rate-limited`: the drive asks to wait before signing in again;
 * - `relogin`: the session ended, the owner signs in again; `repository-password`: the copies on the
 *   drive were made with another password;
 * - `drive-full`, `network`, `busy` (another copy or a restore runs), `restore-test` (the restore test
 *   found a damaged file), `unavailable` (backups are not set up on the server), `other`.
 */
export const CLOUD_PROBLEMS = [
  "two-factor",
  "mailbox-password",
  "credentials",
  "verification",
  "rate-limited",
  "relogin",
  "repository-password",
  "drive-full",
  "network",
  "busy",
  "restore-test",
  "unavailable",
  "other",
] as const;
export type CloudProblem = (typeof CLOUD_PROBLEMS)[number];
export const CLOUD_WARNINGS = ["drive-nearly-full", "stale", "relogin", "password-not-saved", "test-failed"] as const;
export type CloudWarning = (typeof CLOUD_WARNINGS)[number];

export interface CloudRetention {
  /** Every copy of the last hours is kept. */
  allWithinHours: number;
  daily: number;
  weekly: number;
  monthly: number;
}

export interface CloudPlan {
  enabled: boolean;
  interval: CloudInterval;
  /** "HH:MM" in `timezone`, for `daily`. */
  dailyTime: string;
  timezone: string;
  groups: Record<CloudGroup, boolean>;
  retention: CloudRetention;
  /** Files in finished work larger than this stay out of the copy; 0 keeps all. */
  largeFileMb: number;
}

export interface CloudSpace {
  usedBytes: number;
  freeBytes: number | null;
  totalBytes: number | null;
  checkedAt: string;
}

export interface CloudDestination {
  id: string;
  provider: CloudProvider;
  /** The account's email, as the owner typed it. */
  account: string;
  status: "ok" | "relogin";
  connectedAt: string;
  space: CloudSpace | null;
}

export interface CloudRun {
  startedAt: string;
  finishedAt: string;
  ok: boolean;
  seconds: number;
  /** What this run sent to the drive, after dedup and compression. */
  addedBytes: number;
  /** What the copy holds. */
  totalBytes: number;
  problem: CloudProblem | null;
  /** The technical reason, behind "technical details". */
  detail: string | null;
}

export interface CloudRestore {
  id: string;
  snapshot: string;
  status: "ok" | "failed";
  finishedAt: string;
  bytes: number;
  /** The backup that Backups > Restore can put back, once prepared. */
  preparedAs: string | null;
}

export interface CloudSnapshot {
  id: string;
  time: string;
  bytes: number;
  files: number;
}

export type HostCloudBackupsOverview =
  | { available: false }
  | {
      available: true;
      destinations: CloudDestination[];
      plan: CloudPlan;
      running: { kind: "backup" | "test" | "restore"; startedAt: string; phase: string } | null;
      lastBackup: CloudRun | null;
      lastSuccessAt: string | null;
      nextRunAt: string | null;
      lastTest: CloudRun | null;
      /** The median of the recent successful runs. */
      typical: { seconds: number; addedBytes: number; runs: number } | null;
      sizes: { group: CloudGroup; bytes: number }[];
      warnings: CloudWarning[];
      restores: CloudRestore[];
    };

export interface CloudConnectInput {
  provider: CloudProvider;
  email: string;
  password: string;
  twoFactorCode?: string;
  mailboxPassword?: string;
  /** The password of copies that already exist on the drive (a second server, or after a disconnect). */
  repositoryPassword?: string;
}

export type CloudConnectResult =
  | { ok: true; overview: HostCloudBackupsOverview; repositoryPassword?: string }
  | { ok: false; problem: CloudProblem };

export type CloudSnapshotsResult =
  | { ok: true; snapshots: CloudSnapshot[] }
  | { ok: false; problem: CloudProblem; snapshots: CloudSnapshot[] };

const TEXT = 600;
const problem = oneOf(...CLOUD_PROBLEMS);
const groupFlags = fields(Object.fromEntries(CLOUD_GROUPS.map((group) => [group, boolean])));
const retention = fields({ allWithinHours: count, daily: count, weekly: count, monthly: count });
const plan = fields({
  enabled: boolean,
  interval: oneOf(...CLOUD_INTERVALS),
  dailyTime: string(5),
  timezone: string(64),
  groups: groupFlags,
  retention,
  largeFileMb: count,
});
const space = fields({
  usedBytes: count,
  freeBytes: nullable(count),
  totalBytes: nullable(count),
  checkedAt: string(64),
});
const destination = fields({
  id: identifier,
  provider: oneOf(...CLOUD_PROVIDERS),
  account: string(320),
  status: oneOf("ok", "relogin"),
  connectedAt: string(64),
  space: nullable(space),
});
const runRow = fields({
  startedAt: string(64),
  finishedAt: string(64),
  ok: boolean,
  seconds: count,
  addedBytes: count,
  totalBytes: count,
  problem: nullable(problem),
  detail: nullable(string(TEXT)),
});
const restoreRow = fields({
  id: identifier,
  snapshot: string(64),
  status: oneOf("ok", "failed"),
  finishedAt: string(64),
  bytes: count,
  preparedAs: nullable(identifier),
});
const snapshotRow = fields({ id: string(64), time: string(64), bytes: count, files: count });
const overview = (value: unknown): TeamProtocolV2Json => {
  if (isDynamicRecord(value) && value.available === false) return fields({ available: boolean })(value);
  return fields({
    available: boolean,
    destinations: list(destination, 10),
    plan,
    running: nullable(fields({ kind: oneOf("backup", "test", "restore"), startedAt: string(64), phase: string(64) })),
    lastBackup: nullable(runRow),
    lastSuccessAt: nullable(string(64)),
    nextRunAt: nullable(string(64)),
    lastTest: nullable(runRow),
    typical: nullable(fields({ seconds: count, addedBytes: count, runs: count })),
    sizes: list(fields({ group: oneOf(...CLOUD_GROUPS), bytes: count }), CLOUD_GROUPS.length),
    warnings: list(oneOf(...CLOUD_WARNINGS), CLOUD_WARNINGS.length),
    restores: list(restoreRow, 20),
  })(value);
};
const connectResult = (value: unknown): TeamProtocolV2Json =>
  isDynamicRecord(value) && value.ok === false
    ? fields({ ok: boolean, problem })(value)
    : fields({ ok: boolean, overview }, { repositoryPassword: string(256) })(value);
const snapshotsResult = fields({ ok: boolean, snapshots: list(snapshotRow, 500) }, { problem });

export const HOST_CLOUD_BACKUPS_CODECS: ReadonlyMap<string, OptionalRouteCodec> = new Map([
  [HOST_CLOUD_BACKUPS_ROUTES.overview, adminRoute(empty, overview)],
  [
    HOST_CLOUD_BACKUPS_ROUTES.connect,
    adminRoute(
      fields(
        { provider: oneOf(...CLOUD_PROVIDERS), email: string(320), password: string(1024) },
        { twoFactorCode: string(16), mailboxPassword: string(1024), repositoryPassword: string(256) },
      ),
      connectResult,
    ),
  ],
  [HOST_CLOUD_BACKUPS_ROUTES.disconnect, adminRoute(fields({ id: identifier }), overview)],
  [HOST_CLOUD_BACKUPS_ROUTES.plan, adminRoute(fields({ plan }), overview)],
  [HOST_CLOUD_BACKUPS_ROUTES.passwordSaved, adminRoute(empty, overview)],
  [HOST_CLOUD_BACKUPS_ROUTES.run, adminRoute(fields({ kind: oneOf("backup", "test") }), overview)],
  [HOST_CLOUD_BACKUPS_ROUTES.snapshots, adminRoute(empty, snapshotsResult)],
  [HOST_CLOUD_BACKUPS_ROUTES.restore, adminRoute(fields({ snapshot: string(64), confirm: string(64) }), overview)],
  [
    HOST_CLOUD_BACKUPS_ROUTES.restorePrepare,
    adminRoute(fields({ restore: identifier }), fields({ backupId: identifier })),
  ],
]);

type Json = DynamicRecord;
const text = (value: unknown, limit = TEXT): string => (typeof value === "string" ? value.slice(0, limit) : "");
const textOrNull = (value: unknown, limit = TEXT): string | null =>
  typeof value === "string" ? value.slice(0, limit) : null;
const whole = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.round(value) : 0;
const wholeOrNull = (value: unknown): number | null => (typeof value === "number" ? whole(value) : null);
const records = (value: unknown): Json[] => (Array.isArray(value) ? value.filter(isDynamicRecord) : []);
function pick<T extends string>(value: unknown, choices: readonly T[], fallback: T): T {
  return choices.find((choice) => choice === value) ?? fallback;
}
const record = (value: unknown): Json => (isDynamicRecord(value) ? value : {});

export const DEFAULT_CLOUD_PLAN: CloudPlan = {
  enabled: true,
  interval: "1h",
  dailyTime: "03:30",
  timezone: "America/Bogota",
  groups: { database: true, conversations: true, agents: true, settings: true, motion: true, work: true },
  retention: { allWithinHours: 48, daily: 14, weekly: 8, monthly: 12 },
  largeFileMb: 200,
};

export function cloudPlanOf(value: unknown): CloudPlan {
  const row = record(value);
  const groups = record(row.groups);
  const kept = record(row.retention);
  const time = text(row.dailyTime, 5);
  const flag = (group: CloudGroup): boolean => groups[group] !== false;
  return {
    enabled: row.enabled !== false,
    interval: pick(row.interval, CLOUD_INTERVALS, DEFAULT_CLOUD_PLAN.interval),
    dailyTime: /^([01]\d|2[0-3]):[0-5]\d$/u.test(time) ? time : DEFAULT_CLOUD_PLAN.dailyTime,
    timezone: text(row.timezone, 64) || DEFAULT_CLOUD_PLAN.timezone,
    groups: {
      database: flag("database"),
      conversations: flag("conversations"),
      agents: flag("agents"),
      settings: flag("settings"),
      motion: flag("motion"),
      work: flag("work"),
    },
    retention: {
      allWithinHours: Math.min(24 * 30, typeof kept.allWithinHours === "number" ? whole(kept.allWithinHours) : 48),
      daily: Math.min(365, typeof kept.daily === "number" ? whole(kept.daily) : 14),
      weekly: Math.min(260, typeof kept.weekly === "number" ? whole(kept.weekly) : 8),
      monthly: Math.min(120, typeof kept.monthly === "number" ? whole(kept.monthly) : 12),
    },
    largeFileMb: Math.min(100_000, typeof row.largeFileMb === "number" ? whole(row.largeFileMb) : 200),
  };
}

function runOf(value: unknown): CloudRun | null {
  if (!isDynamicRecord(value)) return null;
  return {
    startedAt: text(value.startedAt, 64),
    finishedAt: text(value.finishedAt, 64),
    ok: value.ok === true,
    seconds: whole(value.seconds),
    addedBytes: whole(value.addedBytes),
    totalBytes: whole(value.totalBytes),
    problem: value.ok === true ? null : pick(value.problem, CLOUD_PROBLEMS, "other"),
    detail: textOrNull(value.detail),
  };
}

function spaceOf(value: unknown): CloudSpace | null {
  if (!isDynamicRecord(value)) return null;
  return {
    usedBytes: whole(value.usedBytes),
    freeBytes: wholeOrNull(value.freeBytes),
    totalBytes: wholeOrNull(value.totalBytes),
    checkedAt: text(value.checkedAt, 64),
  };
}

/** An overview (from the host, or from the wire after its codec), cut to the `host-cloud-backups-v1` shape. */
export function hostCloudBackupsOverviewOf(value: unknown): HostCloudBackupsOverview {
  if (!isDynamicRecord(value) || value.available !== true) return { available: false };
  const running = isDynamicRecord(value.running) ? value.running : null;
  const typical = isDynamicRecord(value.typical) ? value.typical : null;
  return {
    available: true,
    destinations: records(value.destinations)
      .slice(0, 10)
      .map((row) => ({
        id: text(row.id, 128),
        provider: pick(row.provider, CLOUD_PROVIDERS, "proton"),
        account: text(row.account, 320),
        status: row.status === "relogin" ? ("relogin" as const) : ("ok" as const),
        connectedAt: text(row.connectedAt, 64),
        space: spaceOf(row.space),
      }))
      .filter((row) => row.id),
    plan: cloudPlanOf(value.plan),
    running: running
      ? {
          kind: pick(running.kind, ["backup", "test", "restore"] as const, "backup"),
          startedAt: text(running.startedAt, 64),
          phase: text(running.phase, 64),
        }
      : null,
    lastBackup: runOf(value.lastBackup),
    lastSuccessAt: textOrNull(value.lastSuccessAt, 64),
    nextRunAt: textOrNull(value.nextRunAt, 64),
    lastTest: runOf(value.lastTest),
    typical: typical
      ? { seconds: whole(typical.seconds), addedBytes: whole(typical.addedBytes), runs: whole(typical.runs) }
      : null,
    sizes: records(value.sizes)
      .filter((row) => CLOUD_GROUPS.some((group) => group === row.group))
      .slice(0, CLOUD_GROUPS.length)
      .map((row) => ({ group: pick(row.group, CLOUD_GROUPS, "database"), bytes: whole(row.bytes) })),
    warnings: (Array.isArray(value.warnings) ? value.warnings : [])
      .filter((item): item is CloudWarning => CLOUD_WARNINGS.some((warning) => warning === item))
      .slice(0, CLOUD_WARNINGS.length),
    restores: records(value.restores)
      .slice(-20)
      .map((row) => ({
        id: text(row.id, 128),
        snapshot: text(row.snapshot, 64),
        status: row.status === "ok" ? ("ok" as const) : ("failed" as const),
        finishedAt: text(row.finishedAt, 64),
        bytes: whole(row.bytes),
        preparedAs: textOrNull(row.preparedAs, 128),
      }))
      .filter((row) => row.id),
  };
}

export function decodeHostCloudBackupsOverview(value: unknown): HostCloudBackupsOverview {
  return hostCloudBackupsOverviewOf(overview(value));
}

export function decodeCloudConnectResult(value: unknown): CloudConnectResult {
  const decoded = record(connectResult(value));
  if (decoded.ok !== true) return { ok: false, problem: pick(decoded.problem, CLOUD_PROBLEMS, "other") };
  return {
    ok: true,
    overview: hostCloudBackupsOverviewOf(decoded.overview),
    ...(typeof decoded.repositoryPassword === "string" ? { repositoryPassword: decoded.repositoryPassword } : {}),
  };
}

export function decodeCloudSnapshotsResult(value: unknown): CloudSnapshotsResult {
  const decoded = record(snapshotsResult(value));
  const snapshots = records(decoded.snapshots).map((row) => ({
    id: text(row.id, 64),
    time: text(row.time, 64),
    bytes: whole(row.bytes),
    files: whole(row.files),
  }));
  return decoded.ok === true
    ? { ok: true, snapshots }
    : { ok: false, problem: pick(decoded.problem, CLOUD_PROBLEMS, "other"), snapshots };
}

export function decodeCloudRestorePrepared(value: unknown): { backupId: string } {
  return { backupId: text(record(fields({ backupId: identifier })(value)).backupId, 128) };
}
