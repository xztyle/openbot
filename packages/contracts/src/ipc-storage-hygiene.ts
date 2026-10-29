// Storage hygiene: what the agents' shared projects and workspaces take on the host disk, which part
// of it can be made again (build output, caches, repository copies), which part is stale (idle
// worktrees and copies) or old evidence media, and the cleanup of the parts an owner or admin picks.
//
// The host scans in a background process and keeps the last report. Paths are relative to the area
// (a top-level project of the shared folder, or an agent workspace); the host resolves an item from
// its id and never deletes a path that a client sends. Times are epoch milliseconds, sizes are bytes.

import { integerInRange, isBoundedString, isIdentifier } from "./ipc-bounded-values";
import { isBoolean, isDynamicRecord, isOneOf } from "./runtime-values";

/**
 * What a cleanup rule removes. The first six are regenerable: a build or an install makes them
 * again. `stale-*` are idle worktrees and copies; `evidence-media` is old screenshots and recordings.
 */
export const STORAGE_HYGIENE_RULES = [
  "cargo-target",
  "node-modules",
  "godot-cache",
  "build-output",
  "repo-copy",
  "build-export",
  "stale-worktree",
  "stale-copy",
  "evidence-media",
] as const;
export type StorageHygieneRule = (typeof STORAGE_HYGIENE_RULES)[number];

export const STORAGE_HYGIENE_CLASSES = ["real", "regenerable", "stale", "evidence"] as const;
export type StorageHygieneClass = (typeof STORAGE_HYGIENE_CLASSES)[number];

/** The class of the bytes that a rule removes. */
export const STORAGE_HYGIENE_RULE_CLASS = {
  "cargo-target": "regenerable",
  "node-modules": "regenerable",
  "godot-cache": "regenerable",
  "build-output": "regenerable",
  "repo-copy": "regenerable",
  "build-export": "regenerable",
  "stale-worktree": "stale",
  "stale-copy": "stale",
  "evidence-media": "evidence",
} as const satisfies Record<StorageHygieneRule, Exclude<StorageHygieneClass, "real">>;

export const STORAGE_HYGIENE_AREA_KINDS = ["project", "agent"] as const;
export type StorageHygieneAreaKind = (typeof STORAGE_HYGIENE_AREA_KINDS)[number];

export const STORAGE_HYGIENE_SKIP_REASONS = ["busy", "recent", "changed", "missing", "failed", "unplanned"] as const;
/**
 * Why a cleanup kept a planned item. `busy`: a process works inside it. `recent`: a file in it
 * changed in the last minutes. `changed`: it is not what the plan found any more (a worktree with
 * new commits or changes). `missing`: it is gone. `unplanned`: the current plan has no such item.
 */
export type StorageHygieneSkipReason = (typeof STORAGE_HYGIENE_SKIP_REASONS)[number];

export const STORAGE_HYGIENE_WEBP_TOOLS = ["cwebp", "magick", "convert"] as const;
export type StorageHygieneWebpTool = (typeof STORAGE_HYGIENE_WEBP_TOOLS)[number];

export const STORAGE_HYGIENE_LIMITS = {
  areas: 1_000,
  folders: 40,
  items: 3_000,
  skipped: 200,
  path: 1_024,
  name: 255,
  detail: 200,
  actor: 255,
} as const;

export interface StorageHygieneBreakdown {
  real: number;
  regenerable: number;
  stale: number;
  evidence: number;
}

/** A top-level project of the shared folder, or the workspace of one agent. */
export interface StorageHygieneArea {
  id: string;
  kind: StorageHygieneAreaKind;
  /** The folder name of a project. For an agent, its id, which the client names. */
  name: string;
  agentId?: string;
  bytes: number;
  files: number;
  breakdown: StorageHygieneBreakdown;
  /** False when the scan reached its entry limit before it finished this area. */
  complete: boolean;
}

/** One of the largest folders, one or two levels under an area. */
export interface StorageHygieneFolder {
  areaId: string;
  /** Relative to the area, with `/`. */
  path: string;
  bytes: number;
  breakdown: StorageHygieneBreakdown;
}

export interface StorageHygieneItem {
  /** Stable for one path and rule. */
  id: string;
  areaId: string;
  rule: StorageHygieneRule;
  /** Relative to the area, with `/`. `files` items name the folder that holds the files. */
  path: string;
  /** `path`: the folder or file goes. `files`: only the matching files directly in the folder go. */
  scope: "path" | "files";
  bytes: number;
  files: number;
  /** The newest change in it. */
  modifiedAt: number;
  /** The item that holds this one. Removing the outer item removes this one too. */
  nestedIn?: string;
  /** A short host note, such as the branch a worktree is merged into. */
  detail?: string;
  /** Selected at first: true for the regenerable and stale rules, false for evidence media. */
  recommended: boolean;
}

export interface StorageHygieneDisk {
  totalBytes: number | null;
  freeBytes: number | null;
}

export interface StorageHygieneReport {
  scannedAt: number;
  durationMs: number;
  /** Files and folders the scan looked at. */
  entries: number;
  /** The scan used the folder sizes of the scan before for folders that did not change. */
  incremental: boolean;
  /** The scan stopped at its entry limit; the sizes are lower than the real ones. */
  truncated: boolean;
  disk: StorageHygieneDisk;
  areas: StorageHygieneArea[];
  folders: StorageHygieneFolder[];
  /** The largest first. */
  items: StorageHygieneItem[];
  /** The plan had more items than `STORAGE_HYGIENE_LIMITS.items`; the smallest were left out. */
  itemsTruncated: boolean;
}

export interface StorageHygieneSkipped {
  path: string;
  rule: StorageHygieneRule;
  reason: StorageHygieneSkipReason;
}

export interface StorageHygieneCleanupResult {
  startedAt: number;
  finishedAt: number;
  trigger: "manual" | "automatic";
  /** The person who started a manual cleanup. */
  actor?: string;
  freedBytes: number;
  deleted: number;
  /** At most `STORAGE_HYGIENE_LIMITS.skipped`; `skippedCount` counts all. */
  skipped: StorageHygieneSkipped[];
  skippedCount: number;
  /** PNG screenshots converted to WebP by the evidence rule, and the bytes that saved. */
  converted: number;
  convertedSavedBytes: number;
}

export interface StorageHygieneState {
  scan: { running: boolean; startedAt?: number; entries?: number };
  cleanup: { running: boolean; startedAt?: number };
  report: StorageHygieneReport | null;
  lastCleanup: StorageHygieneCleanupResult | null;
  /** The tool the evidence rule converts screenshots with. Null: none is installed, so it only deletes. */
  webpTool: StorageHygieneWebpTool | null;
}

export interface StorageHygieneStateInput {
  /** Scan when the report is missing or older than a few minutes. */
  refresh?: boolean;
  /** Scan every folder again now, without the sizes of the scan before. */
  force?: boolean;
}

export interface StorageHygieneApplyInput {
  /** Items of the current report. The host checks each one again before it deletes it. */
  itemIds: string[];
}

/** The automatic rules and the thresholds of the plan. Both automatic rules are off by default. */
export interface StorageHygieneSettings {
  /** Remove regenerable caches when the disk is fuller than `autoPruneDiskPercent`. */
  autoPrune: boolean;
  autoPruneDiskPercent: number;
  /** Only caches that nothing changed in for this long. */
  autoPruneIdleHours: number;
  /** A worktree or a copy is stale after this long without a change. */
  staleIdleHours: number;
  /** A cleanup keeps anything changed in the last minutes. */
  recentMinutes: number;
  /** Convert PNG screenshots in evidence folders to WebP (quality 80) after this many days. */
  evidenceConvert: boolean;
  evidenceConvertAfterDays: number;
  /** Delete evidence media after this many days. The plan lists older media also when this is off. */
  evidenceDelete: boolean;
  evidenceDeleteAfterDays: number;
}

export const STORAGE_HYGIENE_SETTING_RANGES = {
  autoPruneDiskPercent: [50, 99],
  autoPruneIdleHours: [1, 720],
  staleIdleHours: [1, 720],
  recentMinutes: [5, 1_440],
  evidenceConvertAfterDays: [1, 365],
  evidenceDeleteAfterDays: [1, 3_650],
} as const satisfies Partial<Record<keyof StorageHygieneSettings, readonly [number, number]>>;

export const DEFAULT_STORAGE_HYGIENE_SETTINGS: StorageHygieneSettings = {
  autoPrune: false,
  autoPruneDiskPercent: 85,
  autoPruneIdleHours: 24,
  staleIdleHours: 24,
  recentMinutes: 30,
  evidenceConvert: false,
  evidenceConvertAfterDays: 7,
  evidenceDelete: false,
  evidenceDeleteAfterDays: 30,
};

function invalid(label: string): never {
  throw new Error(`Invalid storage hygiene ${label}.`);
}

function isTime(value: unknown): value is number {
  return integerInRange(value, 0, Number.MAX_SAFE_INTEGER);
}

function isNullableBytes(value: unknown): value is number | null {
  return value === null || isTime(value);
}

function optional(value: unknown, guard: (value: unknown) => boolean): boolean {
  return value === undefined || guard(value);
}

function isPath(value: unknown): value is string {
  return isBoundedString(value, STORAGE_HYGIENE_LIMITS.path);
}

function isBreakdown(value: unknown): value is StorageHygieneBreakdown {
  return (
    isDynamicRecord(value) &&
    isTime(value.real) &&
    isTime(value.regenerable) &&
    isTime(value.stale) &&
    isTime(value.evidence)
  );
}

function isArea(value: unknown): value is StorageHygieneArea {
  return (
    isDynamicRecord(value) &&
    isIdentifier(value.id) &&
    isOneOf(STORAGE_HYGIENE_AREA_KINDS, value.kind) &&
    isBoundedString(value.name, STORAGE_HYGIENE_LIMITS.name) &&
    optional(value.agentId, isIdentifier) &&
    isTime(value.bytes) &&
    isTime(value.files) &&
    isBreakdown(value.breakdown) &&
    isBoolean(value.complete)
  );
}

function isFolder(value: unknown): value is StorageHygieneFolder {
  return (
    isDynamicRecord(value) &&
    isIdentifier(value.areaId) &&
    isPath(value.path) &&
    isTime(value.bytes) &&
    isBreakdown(value.breakdown)
  );
}

function isItem(value: unknown): value is StorageHygieneItem {
  return (
    isDynamicRecord(value) &&
    isIdentifier(value.id) &&
    isIdentifier(value.areaId) &&
    isOneOf(STORAGE_HYGIENE_RULES, value.rule) &&
    isPath(value.path) &&
    isOneOf(["path", "files"] as const, value.scope) &&
    isTime(value.bytes) &&
    isTime(value.files) &&
    isTime(value.modifiedAt) &&
    optional(value.nestedIn, isIdentifier) &&
    optional(value.detail, (detail) => isBoundedString(detail, STORAGE_HYGIENE_LIMITS.detail)) &&
    isBoolean(value.recommended)
  );
}

function list<T>(value: unknown, maximum: number, guard: (item: unknown) => item is T, label: string): T[] {
  if (!Array.isArray(value) || value.length > maximum || !value.every(guard)) invalid(label);
  return value;
}

export function decodeStorageHygieneReport(value: unknown): StorageHygieneReport {
  if (
    !isDynamicRecord(value) ||
    !isTime(value.scannedAt) ||
    !isTime(value.durationMs) ||
    !isTime(value.entries) ||
    !isBoolean(value.incremental) ||
    !isBoolean(value.truncated) ||
    !isDynamicRecord(value.disk) ||
    !isNullableBytes(value.disk.totalBytes) ||
    !isNullableBytes(value.disk.freeBytes) ||
    !isBoolean(value.itemsTruncated)
  )
    invalid("report");
  return {
    scannedAt: value.scannedAt,
    durationMs: value.durationMs,
    entries: value.entries,
    incremental: value.incremental,
    truncated: value.truncated,
    disk: { totalBytes: value.disk.totalBytes, freeBytes: value.disk.freeBytes },
    areas: list(value.areas, STORAGE_HYGIENE_LIMITS.areas, isArea, "areas"),
    folders: list(value.folders, STORAGE_HYGIENE_LIMITS.folders, isFolder, "folders"),
    items: list(value.items, STORAGE_HYGIENE_LIMITS.items, isItem, "items"),
    itemsTruncated: value.itemsTruncated,
  };
}

function isSkipped(value: unknown): value is StorageHygieneSkipped {
  return (
    isDynamicRecord(value) &&
    isPath(value.path) &&
    isOneOf(STORAGE_HYGIENE_RULES, value.rule) &&
    isOneOf(STORAGE_HYGIENE_SKIP_REASONS, value.reason)
  );
}

export function decodeStorageHygieneCleanupResult(value: unknown): StorageHygieneCleanupResult {
  if (
    !isDynamicRecord(value) ||
    !isTime(value.startedAt) ||
    !isTime(value.finishedAt) ||
    !isOneOf(["manual", "automatic"] as const, value.trigger) ||
    !optional(value.actor, (actor) => isBoundedString(actor, STORAGE_HYGIENE_LIMITS.actor)) ||
    !isTime(value.freedBytes) ||
    !isTime(value.deleted) ||
    !isTime(value.skippedCount) ||
    !isTime(value.converted) ||
    !isTime(value.convertedSavedBytes)
  )
    invalid("cleanup result");
  const result: StorageHygieneCleanupResult = {
    startedAt: value.startedAt,
    finishedAt: value.finishedAt,
    trigger: value.trigger,
    freedBytes: value.freedBytes,
    deleted: value.deleted,
    skipped: list(value.skipped, STORAGE_HYGIENE_LIMITS.skipped, isSkipped, "skipped items"),
    skippedCount: value.skippedCount,
    converted: value.converted,
    convertedSavedBytes: value.convertedSavedBytes,
  };
  if (typeof value.actor === "string") result.actor = value.actor;
  return result;
}

export function decodeStorageHygieneState(value: unknown): StorageHygieneState {
  if (!isDynamicRecord(value) || !isDynamicRecord(value.scan) || !isDynamicRecord(value.cleanup)) invalid("state");
  const { scan, cleanup } = value;
  if (
    !isBoolean(scan.running) ||
    !optional(scan.startedAt, isTime) ||
    !optional(scan.entries, isTime) ||
    !isBoolean(cleanup.running) ||
    !optional(cleanup.startedAt, isTime) ||
    !(value.webpTool === null || isOneOf(STORAGE_HYGIENE_WEBP_TOOLS, value.webpTool))
  )
    invalid("state");
  return {
    scan: {
      running: scan.running,
      ...(isTime(scan.startedAt) ? { startedAt: scan.startedAt } : {}),
      ...(isTime(scan.entries) ? { entries: scan.entries } : {}),
    },
    cleanup: { running: cleanup.running, ...(isTime(cleanup.startedAt) ? { startedAt: cleanup.startedAt } : {}) },
    report: value.report === null ? null : decodeStorageHygieneReport(value.report),
    lastCleanup: value.lastCleanup === null ? null : decodeStorageHygieneCleanupResult(value.lastCleanup),
    webpTool: value.webpTool,
  };
}

export function parseStorageHygieneStateInput(value: unknown): StorageHygieneStateInput {
  if (value === undefined || value === null) return {};
  if (!isDynamicRecord(value) || !optional(value.refresh, isBoolean) || !optional(value.force, isBoolean))
    invalid("request");
  return {
    ...(value.refresh === true ? { refresh: true } : {}),
    ...(value.force === true ? { force: true } : {}),
  };
}

export function parseStorageHygieneApplyInput(value: unknown): StorageHygieneApplyInput {
  if (
    !isDynamicRecord(value) ||
    !Array.isArray(value.itemIds) ||
    value.itemIds.length === 0 ||
    value.itemIds.length > STORAGE_HYGIENE_LIMITS.items ||
    !value.itemIds.every(isIdentifier)
  )
    invalid("cleanup request");
  return { itemIds: [...new Set(value.itemIds)] };
}

function setting(value: unknown, key: keyof typeof STORAGE_HYGIENE_SETTING_RANGES): number {
  const [minimum, maximum] = STORAGE_HYGIENE_SETTING_RANGES[key];
  if (!integerInRange(value, minimum, maximum)) invalid(key);
  return value;
}

function flag(value: unknown, key: string): boolean {
  if (!isBoolean(value)) invalid(key);
  return value;
}

/** Decodes the full settings record. A missing or out-of-range value is refused, not clamped. */
export function decodeStorageHygieneSettings(value: unknown): StorageHygieneSettings {
  if (!isDynamicRecord(value)) invalid("settings");
  return {
    autoPrune: flag(value.autoPrune, "autoPrune"),
    autoPruneDiskPercent: setting(value.autoPruneDiskPercent, "autoPruneDiskPercent"),
    autoPruneIdleHours: setting(value.autoPruneIdleHours, "autoPruneIdleHours"),
    staleIdleHours: setting(value.staleIdleHours, "staleIdleHours"),
    recentMinutes: setting(value.recentMinutes, "recentMinutes"),
    evidenceConvert: flag(value.evidenceConvert, "evidenceConvert"),
    evidenceConvertAfterDays: setting(value.evidenceConvertAfterDays, "evidenceConvertAfterDays"),
    evidenceDelete: flag(value.evidenceDelete, "evidenceDelete"),
    evidenceDeleteAfterDays: setting(value.evidenceDeleteAfterDays, "evidenceDeleteAfterDays"),
  };
}

/** The bytes that removing `selected` frees: an item inside another selected item counts once. */
export function storageHygieneSelectedBytes(
  items: readonly StorageHygieneItem[],
  selected: ReadonlySet<string>,
): { bytes: number; count: number } {
  let bytes = 0;
  let count = 0;
  for (const item of items) {
    if (!selected.has(item.id)) continue;
    count += 1;
    if (item.nestedIn && selected.has(item.nestedIn)) continue;
    bytes += item.bytes;
  }
  return { bytes, count };
}
