import {
  DEFAULT_STORAGE_HYGIENE_SETTINGS,
  decodeStorageHygieneSettings,
  type OpenBotDesktopApi,
  type StorageHygieneBreakdown,
  type StorageHygieneCleanupResult,
  type StorageHygieneItem,
  type StorageHygieneReport,
  type StorageHygieneSettings,
  type StorageHygieneState,
  storageHygieneSelectedBytes,
} from "@openbot/contracts/ipc";

const GB = 1024 ** 3;
const HOUR = 3_600_000;

function breakdown(real: number, regenerable: number, stale: number, evidence: number): StorageHygieneBreakdown {
  return { real: real * GB, regenerable: regenerable * GB, stale: stale * GB, evidence: evidence * GB };
}

function item(
  id: string,
  areaId: string,
  rule: StorageHygieneItem["rule"],
  path: string,
  gigabytes: number,
  extra: Partial<StorageHygieneItem> = {},
): StorageHygieneItem {
  return {
    id,
    areaId,
    rule,
    path,
    scope: rule === "build-export" || rule === "evidence-media" ? "files" : "path",
    bytes: Math.round(gigabytes * GB),
    files: Math.round(gigabytes * 900),
    modifiedAt: Date.now() - 3 * 24 * HOUR,
    recommended: rule !== "evidence-media",
    ...extra,
  };
}

/** A server whose shared projects hold the junk of the storage incident: target folders, copies, evidence. */
function sampleReport(): StorageHygieneReport {
  const items: StorageHygieneItem[] = [
    ...["a", "b", "c", "d", "e", "f"].map((clone) =>
      item(`target-${clone}`, "piks", "cargo-target", `clones/${clone}/target`, 19),
    ),
    item("main-target", "piks", "cargo-target", "main-clone/target", 14),
    item("repo-copy", "cakemaker", "repo-copy", "notes/2026-10-12/game-copy/.git", 4.2),
    item("exports", "cakemaker", "build-export", "notes/2026-10-12/builds", 3.1),
    item("godot", "cakemaker", "godot-cache", "work/level-3/.godot", 1.4, { nestedIn: "wt-level-3" }),
    item("wt-level-3", "cakemaker", "stale-worktree", "work/level-3", 2.6, { detail: "main" }),
    item("copy-menu", "cakemaker", "stale-copy", "work/menu-copy", 1.8),
    item("media", "cakemaker", "evidence-media", "notes/2026-09-20/screenshots", 2.4, { detail: "30d" }),
    item("node", "chief", "node-modules", "site/node_modules", 0.6),
  ];
  return {
    scannedAt: Date.now() - 4 * 60_000,
    durationMs: 48_000,
    entries: 1_240_000,
    incremental: true,
    truncated: false,
    disk: { totalBytes: 512 * GB, freeBytes: 61 * GB },
    areas: [
      {
        id: "piks",
        kind: "project",
        name: "piks",
        bytes: 142 * GB,
        files: 410_000,
        breakdown: breakdown(14, 128, 0, 0),
        complete: true,
      },
      {
        id: "cakemaker",
        kind: "project",
        name: "cakemaker",
        bytes: 96 * GB,
        files: 520_000,
        breakdown: breakdown(31, 40, 17, 8),
        complete: true,
      },
      {
        id: "chief",
        kind: "agent",
        name: "chief",
        agentId: "chief",
        bytes: 3 * GB,
        files: 18_000,
        breakdown: breakdown(2.4, 0.6, 0, 0),
        complete: true,
      },
    ],
    folders: [
      { areaId: "piks", path: "clones", bytes: 120 * GB, breakdown: breakdown(6, 114, 0, 0) },
      { areaId: "cakemaker", path: "work", bytes: 41 * GB, breakdown: breakdown(8, 16, 17, 0) },
      { areaId: "cakemaker", path: "notes", bytes: 37 * GB, breakdown: breakdown(5, 24, 0, 8) },
      { areaId: "piks", path: "main-clone", bytes: 22 * GB, breakdown: breakdown(8, 14, 0, 0) },
      { areaId: "cakemaker", path: "game", bytes: 18 * GB, breakdown: breakdown(18, 0, 0, 0) },
    ],
    items,
    itemsTruncated: false,
  };
}

/** The storage hygiene of one preview server: a cleanup removes the chosen items and frees their bytes. */
export function createMockStorageHygiene(): OpenBotDesktopApi["storageHygiene"] {
  let report = sampleReport();
  let lastCleanup: StorageHygieneCleanupResult | null = null;
  let settings: StorageHygieneSettings = { ...DEFAULT_STORAGE_HYGIENE_SETTINGS };
  const state = (): StorageHygieneState =>
    structuredClone({
      scan: { running: false },
      cleanup: { running: false },
      report,
      lastCleanup,
      webpTool: "cwebp" as const,
    });
  return {
    getState: async (input) => {
      if (input?.force) report = { ...sampleReport(), incremental: false, scannedAt: Date.now() };
      return state();
    },
    apply: async ({ itemIds }) => {
      const selected = new Set(itemIds);
      const freed = storageHygieneSelectedBytes(report.items, selected);
      const now = Date.now();
      lastCleanup = {
        startedAt: now - 42_000,
        finishedAt: now,
        trigger: "manual",
        actor: "Preview",
        freedBytes: freed.bytes,
        deleted: freed.count,
        skipped: [],
        skippedCount: 0,
        converted: 0,
        convertedSavedBytes: 0,
      };
      report = {
        ...report,
        disk: { ...report.disk, freeBytes: (report.disk.freeBytes ?? 0) + freed.bytes },
        items: report.items.filter(
          (entry) => !selected.has(entry.id) && !(entry.nestedIn && selected.has(entry.nestedIn)),
        ),
      };
      return state();
    },
    getSettings: async () => ({ ...settings }),
    setSettings: async (next) => {
      settings = decodeStorageHygieneSettings(next);
      return { ...settings };
    },
  };
}
