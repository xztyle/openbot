// Optional storage hygiene wire contract of this fork, under `fork-host-v1`.
//
// What it adds, recorded here because freezing it makes it permanent. Only an owner or an admin can
// call these routes: the answers name folders of the agents' projects, and a cleanup deletes files.
//
// - `POST /v1/storage-hygiene/state` `{ refresh?, force? }` answers `{ scan: { running, startedAt?,
//   entries? }, cleanup: { running, startedAt? }, report, lastCleanup, webpTool }`. `refresh` starts
//   a scan when the report is old; `force` starts a full scan. The scan runs on the host after the
//   answer, so a client reads the state again while `running` is true.
//   `report` is null or `{ scannedAt, durationMs, entries, incremental, truncated, disk: { totalBytes,
//   freeBytes } (null or a count each), areas (1000), folders (40), items (3000), itemsTruncated }`.
//   An area is `{ id, kind: "project" | "agent", name (255), agentId?, bytes, files, breakdown,
//   complete }`; a folder `{ areaId, path (1024), bytes, breakdown }`; a breakdown `{ real,
//   regenerable, stale, evidence }`; an item `{ id, areaId, rule, path (1024), scope: "path" |
//   "files", bytes, files, modifiedAt, nestedIn?, detail? (200), recommended }`, where `rule` is one
//   of "cargo-target", "node-modules", "godot-cache", "build-output", "repo-copy", "build-export",
//   "stale-worktree", "stale-copy" and "evidence-media".
//   `lastCleanup` is null or `{ startedAt, finishedAt, trigger: "manual" | "automatic", actor? (255),
//   freedBytes, deleted, skipped (200 of `{ path (1024), rule, reason: "busy" | "recent" | "changed" |
//   "missing" | "failed" | "unplanned" }`), skippedCount, converted, convertedSavedBytes }`.
//   `webpTool` is null, "cwebp", "magick" or "convert".
// - `POST /v1/storage-hygiene/apply` `{ itemIds (1 to 3000) }` starts the cleanup of those items of
//   the current report and answers the state. The host checks each item again before it deletes it.
// - `POST /v1/storage-hygiene/settings` `{}` and `/v1/storage-hygiene/settings/update` (the full
//   settings) answer `{ autoPrune, autoPruneDiskPercent (50-99), autoPruneIdleHours (1-720),
//   staleIdleHours (1-720), recentMinutes (5-1440), evidenceConvert, evidenceConvertAfterDays
//   (1-365), evidenceDelete, evidenceDeleteAfterDays (1-3650) }`.
//
// A fork host built before these routes answers 404, so a client fails closed there. The bounds are
// written out: this file must not move with an IPC limit.
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

export const STORAGE_HYGIENE_CAPABILITY = FORK_HOST_CAPABILITY;

export const STORAGE_HYGIENE_ROUTES = {
  state: "/v1/storage-hygiene/state",
  apply: "/v1/storage-hygiene/apply",
  settings: "/v1/storage-hygiene/settings",
  settingsUpdate: "/v1/storage-hygiene/settings/update",
} as const;

type Decoder = (value: unknown) => TeamProtocolV2Json;

const RULES = [
  "cargo-target",
  "node-modules",
  "godot-cache",
  "build-output",
  "repo-copy",
  "build-export",
  "stale-worktree",
  "stale-copy",
  "evidence-media",
];

const ranged =
  (minimum: number, maximum: number): Decoder =>
  (value) => {
    const result = count(value);
    if (typeof result !== "number" || result < minimum || result > maximum)
      throw new Error("Invalid storage hygiene setting.");
    return result;
  };

const itemIds: Decoder = (value) => {
  const result = list(identifier, 3_000)(value);
  if (!Array.isArray(result) || result.length === 0) throw new Error("Invalid storage hygiene cleanup.");
  return result;
};

const breakdown = fields({ real: count, regenerable: count, stale: count, evidence: count });

const report = fields({
  scannedAt: count,
  durationMs: count,
  entries: count,
  incremental: boolean,
  truncated: boolean,
  disk: fields({ totalBytes: nullable(count), freeBytes: nullable(count) }),
  areas: list(
    fields(
      {
        id: identifier,
        kind: oneOf("project", "agent"),
        name: string(255),
        bytes: count,
        files: count,
        breakdown,
        complete: boolean,
      },
      { agentId: identifier },
    ),
    1_000,
  ),
  folders: list(fields({ areaId: identifier, path: string(1_024), bytes: count, breakdown }), 40),
  items: list(
    fields(
      {
        id: identifier,
        areaId: identifier,
        rule: oneOf(...RULES),
        path: string(1_024),
        scope: oneOf("path", "files"),
        bytes: count,
        files: count,
        modifiedAt: count,
        recommended: boolean,
      },
      { nestedIn: identifier, detail: string(200) },
    ),
    3_000,
  ),
  itemsTruncated: boolean,
});

const cleanup = fields(
  {
    startedAt: count,
    finishedAt: count,
    trigger: oneOf("manual", "automatic"),
    freedBytes: count,
    deleted: count,
    skipped: list(
      fields({
        path: string(1_024),
        rule: oneOf(...RULES),
        reason: oneOf("busy", "recent", "changed", "missing", "failed", "unplanned"),
      }),
      200,
    ),
    skippedCount: count,
    converted: count,
    convertedSavedBytes: count,
  },
  { actor: string(255) },
);

const state = fields({
  scan: fields({ running: boolean }, { startedAt: count, entries: count }),
  cleanup: fields({ running: boolean }, { startedAt: count }),
  report: nullable(report),
  lastCleanup: nullable(cleanup),
  webpTool: nullable(oneOf("cwebp", "magick", "convert")),
});

const settings = fields({
  autoPrune: boolean,
  autoPruneDiskPercent: ranged(50, 99),
  autoPruneIdleHours: ranged(1, 720),
  staleIdleHours: ranged(1, 720),
  recentMinutes: ranged(5, 1_440),
  evidenceConvert: boolean,
  evidenceConvertAfterDays: ranged(1, 365),
  evidenceDelete: boolean,
  evidenceDeleteAfterDays: ranged(1, 3_650),
});

export const STORAGE_HYGIENE_CODECS: ReadonlyMap<string, OptionalRouteCodec> = new Map([
  [STORAGE_HYGIENE_ROUTES.state, adminRoute(fields({}, { refresh: boolean, force: boolean }), state)],
  [STORAGE_HYGIENE_ROUTES.apply, adminRoute(fields({ itemIds }), state)],
  [STORAGE_HYGIENE_ROUTES.settings, adminRoute(empty, settings)],
  [STORAGE_HYGIENE_ROUTES.settingsUpdate, adminRoute(settings, settings)],
]);
